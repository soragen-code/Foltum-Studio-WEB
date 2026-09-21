export const dynamic = "force-dynamic";
// The scene rewrite (which writes a new videoPrompt) is written by gpt-4o (the fast model) — give the
// route generous headroom anyway; a single gpt-4o edit finishes well under the ~300 s synchronous limit.
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { chatJSON, EPISODE_SCRIPT_MODEL } from "@/lib/ai";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { normalizeLanguage } from "@/lib/idea";
import { sceneReviseSchema, sceneReviseSystemPrompt, renderScriptFromScenes, clampSceneDuration, ensureEnglishDialogue } from "@/lib/season";
import { requireFeature } from "@/lib/entitlements";

/**
 * POST /api/ai/scenes/[id]/revise { instruction }
 * LLM rewrites one scene (kind / shot / action / dialogue / videoPrompt) by the instruction. Text only —
 * the paid clip regeneration is a separate, confirmed step (POST /api/ai/generate-video).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:scene-revise", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  // Feature gate: revising a scene by instruction ("scene_prompt_edit") requires an active Basic+ subscription.
  const gateUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { subscriptionTier: true, subscriptionExpiresAt: true },
  });
  const denied = requireFeature(gateUser, "scene_prompt_edit");
  if (denied) return NextResponse.json(denied, { status: 403 });

  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  const instruction = String(body?.instruction ?? "").trim();
  if (instruction.length < 3) return NextResponse.json({ error: "Describe what to change in the scene" }, { status: 400 });

  const scene = await prisma.scene.findFirst({
    where: { id, episode: { season: { project: { userId: session.user.id } } } },
    include: { characters: { include: { character: true } }, episode: { include: { characters: { include: { character: true } } , scenes: { orderBy: { number: "asc" } }, season: { include: { project: true } } } } },
  });
  if (!scene) return NextResponse.json({ error: "Scene not found" }, { status: 404 });
  const project = scene.episode.season.project;
  const language = normalizeLanguage(project.language, project.synopsis ?? "");
  const prev = scene.episode.scenes.find((s) => s.number === scene.number - 1);
  const next = scene.episode.scenes.find((s) => s.number === scene.number + 1);
  // Stage 11 — give the model the neighbours' continuity so the rewritten shot still starts from the
  // previous shot's ending and hands off cleanly into the next (no teleporting / vanishing characters).
  const prevCont = prev ? `\n  presence(end): ${prev.presence ?? "—"} | entrances: ${prev.entrances ?? "—"} | link: ${prev.continuesFrom ?? "—"}\n  endState (this shot must OPEN from it): ${(prev.endStateActual ?? prev.endState) ?? "—"}` : "";
  const nextCont = next ? `\n  presence(start): ${next.presence ?? "—"} | link: ${next.continuesFrom ?? "—"}` : "";
  const user = `EPISODE ${scene.episode.number} «${scene.episode.title}»: ${scene.episode.logline}\nLOCATION: ${scene.episode.locationName} — ${scene.episode.locationDesc}\nCHARACTERS IN SCENE: ${scene.characters.map((c) => `${c.character.name}: ${c.character.appearance ?? ""}`).join("; ")}\n\nPREVIOUS SHOT: ${prev ? `${prev.action}\n${prev.dialogue}${prevCont}` : "(none)"}\nNEXT SHOT: ${next ? `${next.action}\n${next.dialogue}${nextCont}` : "(none)"}\n\nCURRENT SCENE #${scene.number}\nshotType: ${scene.shotType}\ndurationSec: ${scene.durationSec ?? 15}\nlocationDesc: ${scene.locationDesc}\naction: ${scene.action}\npresence: ${scene.presence ?? "—"}\nentrances: ${scene.entrances ?? "—"}\ncontinuesFrom: ${scene.continuesFrom ?? "—"}\nstartState: ${scene.startState ?? "—"}\nendState: ${scene.endState ?? "—"}\ndialogue:\n${scene.dialogue}\nvideoPrompt:\n${scene.videoPrompt}\n\nINSTRUCTION: ${instruction}`;
  try {
    // Scene edit (it produces the new videoPrompt) is written by gpt-4o (EPISODE_SCRIPT_MODEL) — the
    // FAST model: a scene rewrite is a small, well-shaped edit, so the reasoning model is unnecessary and
    // much slower. gpt-4o is non-reasoning → temperature + max_tokens path (reasoningEffort is ignored).
    // A LOW temperature (0.3) keeps the edit close to the author's text — minimal, verbatim changes with no
    // drift/softening. maxTokens 8000 stays well under the gpt-4o 16 384 cap and keeps the JSON from truncating.
    const raw0 = sceneReviseSchema.parse(await chatJSON(sceneReviseSystemPrompt(language), user, { model: EPISODE_SCRIPT_MODEL, temperature: 0.3, maxTokens: 8000 }));
    // Seedance voices `dialogue` → guarantee English (swap swapped fields / translate).
    // Stage 38: the model may switch the kind ("make this scene a fight" → "action"); a narration scene
    // never changes kind here, otherwise keep the stored kind when the model omits it.
    const currentKind = scene.sceneKind === "narration" ? "narration" : (scene.sceneKind === "action" ? "action" : "dialogue");
    const sceneKind = currentKind === "narration" ? "narration" : (raw0.sceneKind ?? currentKind);
    const ensured = await ensureEnglishDialogue({ visualIdentity: "", scenes: [{ ...raw0, number: scene.number, sceneKind, characters: scene.characters.map((c) => c.character.name) }] }, chatJSON);
    const raw = { ...raw0, sceneKind, dialogue: ensured.scenes[0].dialogue, dialogueLocal: ensured.scenes[0].dialogueLocal };
    const { dialogueLocal, ...rest } = raw;
    // Speech is always English (`dialogueEn`); `dialogue` keeps the story-language text for the UI display.
    // NOTE: `Scene.subtitled` is DEPRECATED/inactive (subtitles removed) — no longer written here.
    const parsed = {
      ...rest,
      durationSec: clampSceneDuration(raw.durationSec),
      dialogue: (dialogueLocal ?? "").trim() || raw.dialogue,
      dialogueEn: raw.dialogue,
      language: "en",
      videoUrl: null,
      // Stage 40 — the revised scene has a new scripted end state; any vision-described actual state is stale.
      endState: raw.endState.trim(),
      // Stage 41 — the revised scene's scripted first frame.
      startState: raw.startState.trim(),
      endStateActual: null,
    };
    // Stage 60: one-step undo — snapshot the fields this edit overwrites (text + video),
    // so undo can restore the previous scene text and the previously rendered clip.
    const prevSnapshot = {
      kind: "scene",
      dialogue: scene.dialogue,
      dialogueEn: scene.dialogueEn,
      action: scene.action,
      videoPrompt: scene.videoPrompt,
      videoUrl: scene.videoUrl,
      startState: scene.startState,
      endState: scene.endState,
      endStateActual: scene.endStateActual,
      durationSec: scene.durationSec,
      status: scene.status,
      sceneKind: scene.sceneKind,
      language: scene.language,
      // `Scene.subtitled` is DEPRECATED/inactive (subtitles removed) — not snapshotted for undo.
    };
    const updated = await prisma.scene.update({ where: { id: scene.id }, data: { ...parsed, status: "pending", prevSnapshot } });
    const scenes = scene.episode.scenes.map((s) => (s.id === scene.id ? { ...s, ...parsed } : s));
    await prisma.episode.update({ where: { id: scene.episode.id }, data: { script: renderScriptFromScenes(scene.episode, scene.episode.characters.map((c) => c.character.name), scenes) } });
    return NextResponse.json({ ok: true, scene: updated });
  } catch (err) {
    console.error("[scene revise]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Revision failed" }, { status: 500 });
  }
}
