export const dynamic = "force-dynamic";
// Stage 92: the scene rewrite (which writes a new videoPrompt) is written by gpt-6-astra — give the
// route the long-job budget (a single small reasoning call still finishes well under the ~300 s
// synchronous limit, but the extra headroom removes any risk).
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { chatJSON, SCRIPT_MODEL } from "@/lib/ai";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { normalizeLanguage } from "@/lib/idea";
import { sceneReviseSchema, sceneReviseSystemPrompt, renderScriptFromScenes, estimateDurationSec, ensureEnglishDialogue } from "@/lib/season";

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
    // Stage 92: the scene rewrite (it produces the new videoPrompt) is written by gpt-6-astra
    // (SCRIPT_MODEL) with reasoningEffort "low" — a single small reasoning call finishes well under the
    // synchronous limit while writing a stronger prompt. maxTokens 8000 (was 4096): reasoning tokens
    // count toward the output budget, so the extra room keeps the JSON from truncating
    // ("Unterminated string …"). temperature is dropped — reasoning models ignore it.
    const raw0 = sceneReviseSchema.parse(await chatJSON(sceneReviseSystemPrompt(language), user, { model: SCRIPT_MODEL, reasoningEffort: "low", maxTokens: 8000 }));
    // Seedance voices `dialogue` → guarantee English (swap swapped fields / translate).
    // Stage 38: the model may switch the kind ("make this scene a fight" → "action"); a narration scene
    // never changes kind here, otherwise keep the stored kind when the model omits it.
    const currentKind = scene.sceneKind === "narration" ? "narration" : (scene.sceneKind === "action" ? "action" : "dialogue");
    const sceneKind = currentKind === "narration" ? "narration" : (raw0.sceneKind ?? currentKind);
    const ensured = await ensureEnglishDialogue({ visualIdentity: "", scenes: [{ ...raw0, number: scene.number, sceneKind, characters: scene.characters.map((c) => c.character.name) }] }, chatJSON);
    const raw = { ...raw0, sceneKind, dialogue: ensured.scenes[0].dialogue, dialogueLocal: ensured.scenes[0].dialogueLocal };
    const { dialogueLocal, ...rest } = raw;
    // Speech is always English (`dialogueEn`); `dialogue` keeps the story-language text for the UI / subtitles.
    const parsed = {
      ...rest,
      durationSec: estimateDurationSec(raw.dialogue, raw.action),
      dialogue: (dialogueLocal ?? "").trim() || raw.dialogue,
      dialogueEn: raw.dialogue,
      language: "en",
      subtitled: false,
      videoUrl: null,
      // Stage 40 — the revised scene has a new scripted end state; any vision-described actual state is stale.
      endState: raw.endState.trim(),
      // Stage 41 — the revised scene's scripted first frame.
      startState: raw.startState.trim(),
      endStateActual: null,
      // Stage 104 — the revised scene opens differently: its keyframe is stale and is rendered anew.
      keyframeUrl: null, keyframePrompt: null, keyframeStatus: null, keyframeError: null,
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
      subtitled: scene.subtitled,
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
