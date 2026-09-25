export const dynamic = "force-dynamic";
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { startLocationImageJob } from "@/lib/location-refs";
import { normalizeImageModel } from "@/lib/ai-models";
import { planEpisodeLocations, planManualEpisodeLocations } from "@/lib/season";

/**
 * References step — "Generate locations". POST /api/ai/episodes/[id]/locations
 * Derives the episode's Location rows FROM its persisted scenes (same planner the season job uses), creates the
 * missing rows, binds every scene (scene.locationId) and the episode's primary location, then starts the existing
 * "location_image" job for every episode location that has no master frame yet.
 * Body: { imageModel? }. Returns { jobId | null, resumed?, created, bound, locationIds, creditsRemaining? }.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:episode-locations", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;
    const { id } = await ctx.params;
    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const episode = await prisma.episode.findFirst({
      where: { id, season: { project: { userId: user.id } } },
      include: {
        season: { select: { projectId: true } },
        scenes: { orderBy: { number: "asc" }, select: { id: true, locationDesc: true, title: true, subLocation: true, locationId: true } },
      },
    });
    if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
    const projectId = episode.season.projectId;
    const body = await request.json().catch(() => ({}));
    const imageModel = normalizeImageModel(body?.imageModel);

    const existing = await prisma.location.findMany({ where: { projectId }, select: { id: true, name: true, imageUrl: true } });
    // Manual (author) scripts carry an authored sub-location per scene → one card per authored spot.
    const manual = episode.scenes.some((s) => (s.subLocation ?? "").trim().length > 0);
    const plan = manual ? planManualEpisodeLocations(episode.scenes, existing) : planEpisodeLocations(episode.scenes, existing);
    const idByName = new Map(existing.map((l) => [l.name.toLowerCase(), l.id]));
    let created = 0;
    for (const c of plan.create) {
      if (idByName.has(c.name.toLowerCase())) continue;
      const row = await prisma.location.create({ data: { projectId, name: c.name, description: c.name, visualPrompt: c.visualPrompt, visualPromptAuto: c.visualPrompt } });
      idByName.set(row.name.toLowerCase(), row.id);
      created++;
    }
    const sceneIdsByLoc = new Map<string, string[]>();
    for (const b of plan.bindings) {
      const locId = idByName.get(b.locationName.toLowerCase());
      if (!locId) continue;
      const arr = sceneIdsByLoc.get(locId) ?? [];
      arr.push(b.sceneId);
      sceneIdsByLoc.set(locId, arr);
    }
    let bound = 0;
    for (const [locId, sceneIds] of sceneIdsByLoc) {
      const r = await prisma.scene.updateMany({ where: { id: { in: sceneIds } }, data: { locationId: locId } });
      bound += r.count;
    }
    const primaryId = plan.primaryName ? idByName.get(plan.primaryName.toLowerCase()) ?? null : null;
    if (primaryId && episode.locationId !== primaryId) await prisma.episode.update({ where: { id }, data: { locationId: primaryId } });

    // Every location this episode now uses (bound + primary + previously bound scenes).
    const episodeLocIds = new Set<string>(sceneIdsByLoc.keys());
    if (primaryId) episodeLocIds.add(primaryId);
    for (const s of episode.scenes) if (s.locationId) episodeLocIds.add(s.locationId);
    if (episodeLocIds.size === 0) return NextResponse.json({ error: "No locations found in the episode scenes" }, { status: 400 });
    const rows = await prisma.location.findMany({ where: { id: { in: Array.from(episodeLocIds) } }, select: { id: true, imageUrl: true } });
    const needImage = rows.filter((l) => !l.imageUrl).map((l) => l.id);
    if (needImage.length === 0) {
      return NextResponse.json({ jobId: null, created, bound, locationIds: Array.from(episodeLocIds), creditsRemaining: user.credits });
    }
    const res = await startLocationImageJob({ user: { id: user.id, credits: user.credits }, projectId, locationIds: needImage, imageModel });
    if ("error" in res) return NextResponse.json({ error: res.error, created, bound }, { status: res.status });
    return NextResponse.json({ jobId: res.jobId, resumed: (res as { resumed?: boolean }).resumed ?? false, created, bound, locationIds: needImage, creditsRemaining: (res as { creditsRemaining?: number }).creditsRemaining ?? user.credits });
  } catch (error) {
    console.error("[episode-locations] error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to generate locations" }, { status: 500 });
  }
}
