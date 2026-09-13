export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { buildScenePrompt } from "@/lib/scene-prompt";
import { normalizePromptOverride } from "@/lib/prompt-override";

/**
 * GET /api/ai/scenes/[id]/prompt
 *
 * Returns the FINAL Seedance prompt for the scene EXACTLY as the video worker assembles it
 * (both go through the same lib/scene-prompt.ts), with two deliberate differences that make this a
 * safe read-only preview:
 *   - no LLM dialogue translation is run (the stored dialogueEn / dialogue is voiced verbatim);
 *   - no real reference image is generated or exposed — references appear only as the
 *     `[Image1]…[ImageN]` placeholders the worker itself writes into the prompt.
 *
 * Response: { prompt, model, hasOverride, skipReferences, referenceKind } where referenceKind is
 * character_references | new_scene_reference | text_only (Stage 36: no first-frame mode anymore).
 * Ownership: scene → episode → season → project → userId.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });

  const limited = rateLimitByUser(request, "ai:scene-prompt", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;

  // Ownership is enforced in the query: a scene of another user's project simply returns null.
  const scene = await prisma.scene.findFirst({
    where: { id, episode: { season: { project: { userId: session.user.id } } } },
    include: {
      characters: { include: { character: true } },
      episode: { select: { id: true, sceneMode: true, location: { select: { id: true, name: true, imageUrl: true, imageReverse: true, imageDetail: true, imageExtra: true } }, season: { select: { project: { select: { isTest: true } } } } } },
    },
  });
  if (!scene) return NextResponse.json({ error: "Сцена не найдена" }, { status: 404 });
  if (!scene.videoPrompt) return NextResponse.json({ error: "У сцены ещё нет видео-промпта" }, { status: 400 });

  // Stage 38: the previous scene's frame is never sent as a reference. Stage 40: its END STATE
  // (actual last-frame description in chain mode, otherwise the scripted «Финал кадра») opens the prompt.
  const previous = scene.number > 1 ? await prisma.scene.findFirst({
    where: { episodeId: scene.episode.id, number: scene.number - 1 },
    select: { id: true, number: true, locationDesc: true, lastFrameUrl: true, endState: true, endStateActual: true },
  }) : null;
  const built = buildScenePrompt({
    scene,
    characters: scene.characters.map(l => ({ characterId: l.characterId, name: l.character.name, tier: l.character.tier, imageFront: l.character.imageFront, imageProfile: l.character.imageProfile, imageFull: l.character.imageFull, imageExtra: l.character.imageExtra, appearance: l.character.appearance, age: l.character.age })),
    location: scene.episode.location ?? null,
    previous,
    // Stage 33: always Seedance 2.5 (legacy stored ids are normalized the same way in the worker).
    provider: scene.videoModel,
    textOnlyWhenNoReferences: Boolean(scene.episode.season?.project?.isTest),
    // Stage 64: storyboard mode → the (approved) frame is Image1 and the previous last frame is not sent.
    sceneMode: scene.episode.sceneMode === "storyboard" ? "storyboard" : "text",
    storyboardUrl: scene.episode.sceneMode === "storyboard" ? scene.storyboardUrl : null,
  });

  return NextResponse.json({
    prompt: built.prompt,
    model: built.model,
    hasOverride: !!(scene.promptOverride ?? "").trim(),
    // Stage 33: the per-scene "no reference images" toggle and the resolved reference strategy.
    skipReferences: !!scene.skipReferences,
    referenceKind: built.referenceKind,
    // Stage 40: the end-state hand-off actually used (null for scene 1 / location change / new sequence).
    openingState: built.openingState,
  });
}

/**
 * PUT /api/ai/scenes/[id]/prompt
 *
 * Save (or reset) the scene's manual final-prompt override and/or the "send without reference
 * images" toggle. Body: { prompt?: string, skipReferences?: boolean } — each field is updated only
 * when present. (A legacy `skipPreviousFrame` field is accepted and IGNORED since Stage 38 — the
 * previous scene's frame is never sent any more.)
 *   - prompt non-empty  → normalized (Stage 36, see lib/prompt-override.ts: Markdown fences and any
 *                         chatty preamble before the first `[SECTION]` header are stripped) and used as
 *                         the final prompt TEXT on the next generation(s) of this scene, until changed;
 *   - prompt empty / whitespace (after normalization) → resets to null, so the auto prompt is used again;
 *   - skipReferences (Stage 36) → persisted per scene; when true the video is submitted text-only for
 *                         ANY scene (no portraits, no location angles).
 *
 * The override changes only the TEXT — the reference image set is always recomputed at generation time.
 * Response: { ok: true, hasOverride: boolean, skipReferences: boolean, prompt: string | null } where
 * `prompt` is the normalized text actually saved (null after a reset). Same ownership chain as GET.
 */
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });

  const limited = rateLimitByUser(request, "ai:scene-prompt", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
  }
  const raw = (body as { prompt?: unknown } | null)?.prompt;
  if (raw !== undefined && typeof raw !== "string") {
    return NextResponse.json({ error: "Некорректный промпт" }, { status: 400 });
  }
  const rawSkip = (body as { skipReferences?: unknown } | null)?.skipReferences;
  if (rawSkip !== undefined && typeof rawSkip !== "boolean") {
    return NextResponse.json({ error: "Некорректное значение skipReferences" }, { status: 400 });
  }
  if (raw === undefined && rawSkip === undefined) {
    return NextResponse.json({ error: "Нечего сохранять" }, { status: 400 });
  }
  const normalized = normalizePromptOverride((raw ?? "").toString());
  const promptOverride = normalized.length ? normalized : null;

  // Ownership is enforced in the query: a scene of another user's project simply returns null.
  const scene = await prisma.scene.findFirst({
    where: { id, episode: { season: { project: { userId: session.user.id } } } },
    select: { id: true, promptOverride: true, skipReferences: true },
  });
  if (!scene) return NextResponse.json({ error: "Сцена не найдена" }, { status: 404 });

  const updated = await prisma.scene.update({
    where: { id: scene.id },
    data: {
      ...(raw !== undefined ? { promptOverride } : {}),
      ...(rawSkip !== undefined ? { skipReferences: rawSkip } : {}),
    },
    select: { promptOverride: true, skipReferences: true },
  });

  return NextResponse.json({
    ok: true,
    hasOverride: !!(updated.promptOverride ?? "").trim(),
    skipReferences: updated.skipReferences,
    // Stage 36: what was actually saved, so the modal can show the normalized text.
    prompt: raw !== undefined ? promptOverride : undefined,
  });
}
