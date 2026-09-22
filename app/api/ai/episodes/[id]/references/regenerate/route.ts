export const dynamic = "force-dynamic";
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runCharacterImagesJob } from "@/lib/workers/character-images-job";
import { startLocationImageJob } from "@/lib/location-refs";
import { CHARACTER_REFERENCE_COST, LOCATION_SET_COST } from "@/lib/power-tier";
import { normalizeImageModel } from "@/lib/ai-models";
import { episodeCastFromScenes } from "@/lib/episode-cast";
import { planEpisodeLocations, planManualEpisodeLocations, episodeHasMultipleLocations } from "@/lib/season";

/**
 * POST /api/ai/episodes/[id]/references/regenerate → { charJobId, locationJobId, characterIds, locationIds }
 *
 * "Перегенерировать референсы по сценарию" (regenerate references from the script). This re-derives the
 * episode's reference SET strictly and only from the CURRENT episode script — the persisted scenes are the
 * authoritative parse of that script (they are rebuilt on every script change / manual paste), so we read
 * their character links and their final locationDesc rather than any cached client-side list:
 *   1. Re-extract the episode CAST as the union of characters actually present across the current scenes
 *      (episodeCastFromScenes) and rewrite EpisodeCharacter to match exactly — adds missing, drops extra.
 *   2. Re-extract the episode LOCATIONS from the scenes (planEpisodeLocations): create any location the
 *      script now needs, bind every scene to its location, and set the episode's primary location.
 *   3. Force a fresh regeneration of the references so they match the current script — the character
 *      full-body references reuse the EXISTING generation pipeline (runCharacterImagesJob → the 18+,
 *      9:16, ~50 mm, frontal-neutral, grey-background full-body prompt) and the locations reuse the
 *      EXISTING startLocationImageJob pipeline. Nothing about the composition comes from any other source.
 *
 * This reuses the same underlying generation jobs (and the same per-reference pricing) as the first-time
 * reference generation — it only re-derives WHAT to generate from the current script and re-runs it.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.email || !session.user.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:episode-refs-regenerate", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;
    const { id } = await ctx.params;

    const body = await request.json().catch(() => ({}));
    const imageModel = normalizeImageModel(body?.imageModel);

    const episode = await prisma.episode.findFirst({
      where: { id, season: { project: { userId: session.user.id } } },
      include: {
        characters: { select: { characterId: true } },
        scenes: {
          orderBy: { number: "asc" },
          select: { id: true, title: true, subLocation: true, locationDesc: true, characters: { select: { characterId: true } } },
        },
        season: { select: { projectId: true, project: { select: { id: true } } } },
      },
    });
    if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
    if (!episode.scenes.length) return NextResponse.json({ error: "В сценарии ещё нет сцен — сначала сгенерируйте сценарий." }, { status: 400 });
    const projectId = episode.season.projectId;

    const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { id: true, credits: true } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    // A running reference job would clash with the fresh regeneration → refuse while one is active.
    await failStaleJobs({ projectId, type: "characters" });
    await failStaleJobs({ projectId, type: "location_image" });
    const activeRef = await prisma.generationJob.findFirst({
      where: { projectId, type: { in: ["characters", "location_image", "location_extra_image"] }, status: { in: ["pending", "processing"] } },
      select: { id: true },
    });
    if (activeRef) return NextResponse.json({ error: "Генерация референсов уже выполняется — дождитесь её завершения." }, { status: 409 });

    const project = await prisma.project.findUnique({ where: { id: projectId }, include: { locations: { orderBy: { createdAt: "asc" } } } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    // ---- 1) Re-extract the episode CAST strictly from the CURRENT scenes ----
    const sceneCastIds = episode.scenes.map((s) => s.characters.map((c) => c.characterId));
    const declaredIds = episode.characters.map((c) => c.characterId); // fallback only (episode named cast)
    const castIds = episodeCastFromScenes(sceneCastIds, declaredIds);

    // ---- 2) Re-extract the episode LOCATIONS strictly from the CURRENT scenes ----
    // Stage 171 — a MANUAL (author) script keeps distinct SPOTS (sub-locations) inside one top-level place, and
    // each authored spot must get its OWN location reference card. The manual scenes are deterministically marked
    // by the Stage 169 title "<location> — <sub-location>" (dash surrounded by spaces) + a populated subLocation.
    // When that marker is present (or the script spans 2+ top-level places), use the MANUAL planner that keys on
    // the full "<location> — <sub-location>" name → one card per spot. Auto (LLM) scripts stay single-location.
    const sceneRows = episode.scenes.map((s) => ({ id: s.id, title: s.title, subLocation: s.subLocation, locationDesc: s.locationDesc }));
    const manualSpotScenes = sceneRows.filter((s) => /\s[—–]\s/.test((s.title ?? "").trim()) && (s.subLocation ?? "").trim().length > 0);
    const isManualScript = manualSpotScenes.length >= 2 || episodeHasMultipleLocations(sceneRows);
    const plan = isManualScript
      ? planManualEpisodeLocations(sceneRows, project.locations.map((l) => ({ id: l.id, name: l.name })))
      : planEpisodeLocations(
          sceneRows.map((s) => ({ id: s.id, locationDesc: s.locationDesc })),
          project.locations.map((l) => ({ id: l.id, name: l.name })),
        );
    const idByName = new Map(project.locations.map((l) => [l.name.toLowerCase(), l.id]));
    const newLocationIds: string[] = [];
    for (const c of plan.create) {
      const created = await prisma.location.create({ data: { projectId, name: c.name, description: c.name, visualPrompt: c.visualPrompt, visualPromptAuto: c.visualPrompt } });
      idByName.set(created.name.toLowerCase(), created.id);
      newLocationIds.push(created.id);
    }
    // Bind every scene to its location (grouped → one updateMany per location).
    const sceneIdsByLoc = new Map<string, string[]>();
    for (const b of plan.bindings) {
      const locId = idByName.get(b.locationName.toLowerCase());
      if (!locId) continue;
      const arr = sceneIdsByLoc.get(locId) ?? [];
      arr.push(b.sceneId);
      sceneIdsByLoc.set(locId, arr);
    }
    for (const [locId, sceneIds] of sceneIdsByLoc) {
      await prisma.scene.updateMany({ where: { id: { in: sceneIds } }, data: { locationId: locId } });
    }
    // Primary = the location bound to the FIRST scene (robust to fuzzy name→canonical mismatches);
    // fall back to the raw first distinct name lookup.
    const firstSceneId = episode.scenes[0]?.id;
    let primaryId: string | null = null;
    for (const [locId, sceneIds] of sceneIdsByLoc) { if (firstSceneId && sceneIds.includes(firstSceneId)) { primaryId = locId; break; } }
    if (!primaryId && plan.primaryName) primaryId = idByName.get(plan.primaryName.toLowerCase()) ?? null;
    // The episode's location SET = every distinct location its scenes now use, primary first.
    const locationIds = Array.from(new Set([primaryId, ...sceneIdsByLoc.keys()].filter((x): x is string => !!x)));

    // ---- 3) Rewrite EpisodeCharacter to match the current script exactly (add missing, drop extra) ----
    await prisma.$transaction(async (tx) => {
      await tx.episodeCharacter.deleteMany({ where: { episodeId: id } });
      if (castIds.length) await tx.episodeCharacter.createMany({ data: castIds.map((characterId) => ({ episodeId: id, characterId })), skipDuplicates: true });
      if (primaryId) await tx.episode.update({ where: { id }, data: { locationId: primaryId } });
    });

    // Nothing referenced by the script → nothing to regenerate.
    if (castIds.length === 0 && locationIds.length === 0) {
      return NextResponse.json({ charJobId: null, locationJobId: null, characterIds: [], locationIds: [], creditsRemaining: user.credits ?? 0 });
    }

    // ---- Upfront credit check for the WHOLE regeneration (characters + locations) ----
    const cost = castIds.length * CHARACTER_REFERENCE_COST + locationIds.length * LOCATION_SET_COST;
    if ((user.credits ?? 0) < cost) {
      return NextResponse.json({ error: `Недостаточно кредитов: нужно ${cost}, доступно ${user.credits ?? 0}.` }, { status: 402 });
    }

    // ---- Force a FRESH set: clear the existing reference images for the episode's cast/locations so the
    // existing generation jobs regenerate every one of them from the current script (update changed). ----
    let charJobId: string | null = null;
    let creditsRemaining = user.credits ?? 0;
    if (castIds.length) {
      await prisma.character.updateMany({ where: { id: { in: castIds }, projectId }, data: { imageFront: "", imageProfile: "", imageFull: "", imageExtra: null, status: "approved" } });
      const charCost = castIds.length * CHARACTER_REFERENCE_COST;
      if (charCost > 0) {
        await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: charCost } } });
        await prisma.creditTransaction.create({ data: { userId: user.id, amount: -charCost, description: `Регенерация референсов персонажей: ${castIds.length} шт.` } });
        creditsRemaining -= charCost;
      }
      const charJob = await prisma.generationJob.create({
        data: { type: "characters", status: "processing", progress: 5, message: `Регенерация референсов ${castIds.length} персонажей...`, projectId },
      });
      charJobId = charJob.id;
      runInBackground(async () => {
        await runCharacterImagesJob({ jobId: charJob.id, projectId, characterIds: castIds, imageModel });
        try {
          // Refund the charged characters whose full-body photo never landed (mirrors /characters/references).
          const after = await prisma.character.findMany({ where: { id: { in: castIds } }, select: { id: true, name: true, imageFront: true, imageFull: true } });
          const none = after.filter((c) => !c.imageFull && !c.imageFront);
          if (none.length) {
            const refund = none.length * CHARACTER_REFERENCE_COST;
            await prisma.user.update({ where: { id: user.id }, data: { credits: { increment: refund } } });
            await prisma.creditTransaction.create({ data: { userId: user.id, amount: refund, description: `Возврат: референсы не сгенерированы (${none.map((c) => c.name).join(", ")})` } });
          }
        } catch (e) { console.error("[episodes/references/regenerate] character refund check failed:", e); }
      });
    }

    // ---- Locations: reuse the EXISTING startLocationImageJob pipeline (it snapshots + charges + refunds). ----
    let locationJobId: string | null = null;
    if (locationIds.length) {
      // Snapshot for one-step undo, then clear so the master frame is regenerated from the current script.
      const locs = await prisma.location.findMany({ where: { id: { in: locationIds } }, select: { id: true, imageUrl: true, imageReverse: true, imageDetail: true, imageExtra: true } });
      for (const l of locs) {
        await prisma.location.update({
          where: { id: l.id },
          data: {
            prevSnapshot: { kind: "location", imageUrl: l.imageUrl, imageReverse: l.imageReverse, imageDetail: l.imageDetail, imageExtra: l.imageExtra },
            imageUrl: null, imageReverse: null, imageDetail: null, imageExtra: null,
          },
        });
      }
      const started = await startLocationImageJob({ user: { id: user.id, credits: creditsRemaining }, projectId, locationIds, imageModel });
      if ("error" in started) return NextResponse.json(started, { status: started.status });
      locationJobId = started.jobId ?? null;
      if (typeof started.creditsRemaining === "number") creditsRemaining = started.creditsRemaining;
    }

    return NextResponse.json({ charJobId, locationJobId, characterIds: castIds, locationIds, newLocationIds, creditsRemaining });
  } catch (err: any) {
    console.error("Episode references regenerate error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
