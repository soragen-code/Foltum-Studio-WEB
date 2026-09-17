export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { resolveOpeningState } from "@/lib/scene-prompt";
import { resolveVideoPredecessor, assertPredecessorReady, buildReangleRequest } from "@/lib/reangle";
import { readReangleCache } from "@/lib/reangle-store";
import { finalVideoPrompt } from "@/lib/video-prompt-final";
import { parseLookCache, lookHash } from "@/lib/character-look";
import { parsePropRegistry } from "@/lib/prop-registry";
import { buildScenePrompt } from "@/lib/scene-prompt";
import { isRefusal } from "@/lib/frame-state";
import { stripPreviousCameraLine } from "@/lib/prompt-seam";
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
  if (!session?.user?.id) return NextResponse.json({ error: "Login required" }, { status: 401 });

  const limited = rateLimitByUser(request, "ai:scene-prompt", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;

  // Ownership is enforced in the query: a scene of another user's project simply returns null.
  const scene = await prisma.scene.findFirst({
    where: { id, episode: { season: { project: { userId: session.user.id } } } },
    include: {
      characters: { include: { character: true }, orderBy: { characterId: "asc" } },
      episode: { select: { id: true, propRegistry: true, location: { select: { id: true, name: true, imageUrl: true, imageReverse: true, imageDetail: true, imageExtra: true, setInventory: true } }, season: { select: { project: { select: { isTest: true } } } } } },
    },
  });
  if (!scene) return NextResponse.json({ error: "Scene not found" }, { status: 404 });
  if (!scene.videoPrompt) return NextResponse.json({ error: "The scene doesn't have a video prompt yet" }, { status: 400 });

  // Read-only: resolve the SAME predecessor and cache key as the video worker; never run an edit in preview.
  let previousRow;
  try { previousRow = await resolveVideoPredecessor(prisma, scene); assertPredecessorReady(previousRow); }
  catch (error: any) { return NextResponse.json({ error: error.message, preprocessing: "blocked" }, { status: 409 }); }
  const previousEndStateRaw = previousRow && !isRefusal(previousRow.endStateActual) ? previousRow.endStateActual : null;
  const previous = previousRow ? { ...previousRow, endStateActual: previousEndStateRaw ? stripPreviousCameraLine(previousEndStateRaw) || null : null } : null;
  const characters = scene.characters.map(l => ({ characterId: l.characterId, name: l.character.name, tier: l.character.tier,
    imageFront: l.character.imageFront, imageFull: l.character.imageFull, appearance: l.character.appearance, age: l.character.age }));
  const forbiddenReferenceUrls = [scene.keyframeUrl, previousRow?.lastFrameUrl, (previousRow as any)?.keyframeUrl].filter((u): u is string => !!u);
  const support = buildScenePrompt({ scene, characters, location: scene.episode.location, previous, forbiddenReferenceUrls }).retryRefs;
  let reangleUrl: string | null = null;
  let preprocessing = "not_required";
  if (previousRow) {
    if (!scene.episode.location?.imageUrl || !scene.episode.location.imageReverse)
      return NextResponse.json({ error: "Add the location's mandatory wide and layout views before generating this transition.", preprocessing: "blocked" }, { status: 409 });
    const request = buildReangleRequest({ sceneId: scene.id, number: scene.number, startState: scene.startState,
      videoPrompt: scene.videoPrompt, promptOverride: scene.promptOverride, previous: previousRow, refs: support, castState: characters });
    const cache = await readReangleCache(request);
    // Placeholder is only an internal descriptor, never returned or submitted as a URL.
    reangleUrl = cache?.phase === "ready" && cache.url ? cache.url : "pending:camera-edit";
    preprocessing = cache?.phase === "ready" ? "cached" : "required_before_video";
  }
  const original = { videoPrompt: scene.promptOverride?.trim() || scene.videoPrompt, startState: scene.startState,
    endState: scene.endState, openingState: resolveOpeningState(scene, previous) };
  const cachedLook = parseLookCache(scene.lookCache);
  const look = cachedLook?.hash === lookHash(characters, original) ? cachedLook : null;
  const lookedScene = look ? { ...scene, videoPrompt: scene.promptOverride?.trim() ? scene.videoPrompt : look.videoPrompt,
    promptOverride: scene.promptOverride?.trim() ? look.videoPrompt : scene.promptOverride,
    startState: look.openingState ?? scene.startState, endState: look.endState ?? scene.endState } : scene;
  const built = buildScenePrompt({ scene: lookedScene, characters, location: scene.episode.location, previous,
    forbiddenReferenceUrls, reangleUrl, props: parsePropRegistry(scene.episode.propRegistry)?.props ?? [], provider: scene.videoModel });
  const prompt = finalVideoPrompt(built);
  const continuity = reangleUrl ? "reangled_frame" : "none";
  return NextResponse.json({
    prompt, preprocessing,
    referenceKinds: built.retryRefs.map(r => r.kind),
    previewNote: look ? "Uses cached look text" : "Read-only plan; worker may refresh look text and translate legacy non-English dialogue before submission",
    // Stage 78: last_frame | text_only | none — how the scene is tied to the previous one.
    continuity,
    model: built.model,
    hasOverride: !!(scene.promptOverride ?? "").trim(),
    // Stage 33: the per-scene "no reference images" toggle and the resolved reference strategy.
    skipReferences: false,
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
  if (!session?.user?.id) return NextResponse.json({ error: "Login required" }, { status: 401 });

  const limited = rateLimitByUser(request, "ai:scene-prompt", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const raw = (body as { prompt?: unknown } | null)?.prompt;
  if (raw !== undefined && typeof raw !== "string") {
    return NextResponse.json({ error: "Invalid prompt" }, { status: 400 });
  }
  const rawSkip = (body as { skipReferences?: unknown } | null)?.skipReferences;
  if (rawSkip !== undefined && typeof rawSkip !== "boolean") {
    return NextResponse.json({ error: "Invalid skipReferences value" }, { status: 400 });
  }
  if (raw === undefined && rawSkip === undefined) {
    return NextResponse.json({ error: "Nothing to save" }, { status: 400 });
  }
  if (rawSkip === true) return NextResponse.json({ error: "Reference-free generation is no longer supported. Character/location references and required camera continuity are automatic." }, { status: 400 });
  const normalized = normalizePromptOverride((raw ?? "").toString());
  const promptOverride = normalized.length ? normalized : null;

  // Ownership is enforced in the query: a scene of another user's project simply returns null.
  const scene = await prisma.scene.findFirst({
    where: { id, episode: { season: { project: { userId: session.user.id } } } },
    select: { id: true, promptOverride: true, skipReferences: true },
  });
  if (!scene) return NextResponse.json({ error: "Scene not found" }, { status: 404 });

  // Stage 150 — reset-to-auto must REBUILD from scratch via the live buildScenePrompt rules, never reuse a
  // stored/cached prompt. Clearing promptOverride already forces a fresh auto assembly, but the character-look
  // rewrite is memoised in `lookCache` (hash-keyed by the effective prompt) and gated by `lookStale`. On a reset
  // we drop that cache too, so the next read/generation recomputes the look on top of the freshly rebuilt auto
  // prompt (reflecting the current rules) instead of a value cached against the old manual override.
  const isReset = raw !== undefined && promptOverride === null;
  const updated = await prisma.scene.update({
    where: { id: scene.id },
    data: {
      ...(raw !== undefined ? { promptOverride } : {}),
      ...(rawSkip !== undefined ? { skipReferences: rawSkip } : {}),
      ...(isReset ? { lookCache: null, lookStale: false } : {}),
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
