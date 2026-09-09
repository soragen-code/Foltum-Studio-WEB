export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { chatJSON } from "@/lib/ai";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { normalizeLanguage } from "@/lib/idea";
import { sceneReviseSchema, sceneReviseSystemPrompt, renderScriptFromScenes, estimateDurationSec, ensureEnglishDialogue } from "@/lib/season";

/**
 * POST /api/ai/scenes/[id]/revise { instruction }
 * LLM rewrites one scene (shot / action / dialogue / videoPrompt) by the instruction. Text only —
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
  if (instruction.length < 3) return NextResponse.json({ error: "Опишите, что изменить в сцене" }, { status: 400 });

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
  const prevCont = prev ? `\n  presence(end): ${prev.presence ?? "—"} | entrances: ${prev.entrances ?? "—"} | link: ${prev.continuesFrom ?? "—"}` : "";
  const nextCont = next ? `\n  presence(start): ${next.presence ?? "—"} | link: ${next.continuesFrom ?? "—"}` : "";
  const user = `EPISODE ${scene.episode.number} «${scene.episode.title}»: ${scene.episode.logline}\nLOCATION: ${scene.episode.locationName} — ${scene.episode.locationDesc}\nCHARACTERS IN SCENE: ${scene.characters.map((c) => `${c.character.name}: ${c.character.appearance ?? ""}`).join("; ")}\n\nPREVIOUS SHOT: ${prev ? `${prev.action}\n${prev.dialogue}${prevCont}` : "(none)"}\nNEXT SHOT: ${next ? `${next.action}\n${next.dialogue}${nextCont}` : "(none)"}\n\nCURRENT SCENE #${scene.number}\nshotType: ${scene.shotType}\ndurationSec: ${scene.durationSec ?? 15}\nlocationDesc: ${scene.locationDesc}\naction: ${scene.action}\npresence: ${scene.presence ?? "—"}\nentrances: ${scene.entrances ?? "—"}\ncontinuesFrom: ${scene.continuesFrom ?? "—"}\ndialogue:\n${scene.dialogue}\nvideoPrompt:\n${scene.videoPrompt}\n\nINSTRUCTION: ${instruction}`;
  try {
    const raw0 = sceneReviseSchema.parse(await chatJSON(sceneReviseSystemPrompt(language), user, { temperature: 0.6, maxTokens: 3000 }));
    // Seedance voices `dialogue` → guarantee English (swap swapped fields / translate).
    const ensured = await ensureEnglishDialogue({ visualIdentity: "", scenes: [{ ...raw0, number: scene.number, sceneKind: "dialogue" as const, characters: scene.characters.map((c) => c.character.name) }] }, chatJSON);
    const raw = { ...raw0, dialogue: ensured.scenes[0].dialogue, dialogueLocal: ensured.scenes[0].dialogueLocal };
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
    };
    const updated = await prisma.scene.update({ where: { id: scene.id }, data: { ...parsed, status: "pending" } });
    const scenes = scene.episode.scenes.map((s) => (s.id === scene.id ? { ...s, ...parsed } : s));
    await prisma.episode.update({ where: { id: scene.episode.id }, data: { script: renderScriptFromScenes(scene.episode, scene.episode.characters.map((c) => c.character.name), scenes) } });
    return NextResponse.json({ ok: true, scene: updated });
  } catch (err) {
    console.error("[scene revise]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Revision failed" }, { status: 500 });
  }
}
