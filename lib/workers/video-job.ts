import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
// Stage 73: scene video and scene-still transports are routed through the per-project provider layer
// (WaveSpeed only since Stage 104). Prompt building, refs and chain logic are unchanged.
import { startVideoGeneration, getVideoGenerationState, cancelVideoGeneration } from "@/lib/providers/video-provider";
import { resolveVideoPredecessor, assertPredecessorReady, buildReangleRequest } from "@/lib/reangle";
// Stage 122: lazily resolve/generate the scene's REGION PLATE (env plate of this part of the location),
// reused across scenes in the same region via the Location.regionPlates cache; non-blocking (null on failure).
import { ensureSceneRegionPlate } from "@/lib/workers/region-plate-job";
import { ensureReangle } from "@/lib/reangle-store";
import { finalVideoPrompt } from "@/lib/video-prompt-final";
import { translateDialogue, detectSpokenLanguage } from "@/lib/voiceover";
import { uploadRemoteToS3, uploadBufferToS3 } from "@/lib/s3-upload";
import { extractLastFrameBuffer } from "@/lib/ffmpeg";
import { normalizeVideoModel, videoModelSlug } from "@/lib/ai-models";
import type { PredictionState } from "@/lib/wavespeed";
import { getBucketConfig } from "@/lib/aws-config";
import { VISUAL_STYLE_ID } from "@/lib/visual-style";
import { buildScenePrompt, resolveOpeningState, type SceneReference } from "@/lib/scene-prompt";
import { rewriteSceneLook, parseLookCache } from "@/lib/character-look";
import { buildPropRegistry, parsePropRegistry } from "@/lib/prop-registry";
import { GenerationAttempt, safeProviderError, classifyProviderError, logAttempt, safeDiagnosticInput } from "@/lib/generation-diagnostics";
import { updateJob, heartbeatJob, runInBackground, isCancelRequested, markCanceled } from "@/lib/jobs";
import { moderationHints } from "@/lib/sanitize-prompt";
import { downscaleReferences, REFERENCE_WIDTH } from "@/lib/reference-downscale";
import { describeLastFrame, isRefusal } from "@/lib/frame-state";
import { nextChainScene, chainStopMessage, CHAIN_INSUFFICIENT_CREDITS } from "@/lib/chain-run";
import { resolvePowerTier, SCENE_RESOLUTION } from "@/lib/power-tier";
import { sceneProgressStage, SCENE_STAGE_PROGRESS, SCENE_STAGE_MESSAGE } from "@/lib/scene-progress";
import { sceneClipSeconds, sceneClipCost } from "@/lib/season";
import { stripPreviousCameraLine, type Continuity } from "@/lib/prompt-seam";

export interface VideoJobParams {
  jobId: string;
  sceneId: string;
  projectId: string;
  userId?: string;
  cost?: number;
  duration?: number;
  resolution?: string;
  /** Legacy field, accepted and ignored: every job renders on Seedance 2.5 (see normalizeVideoModel). */
  provider?: string | null;
}

/** Persisted in GenerationJob.resultData while the job is running, so it can be resumed. */
export interface VideoJobState {
  predictionId: string;
  sceneId: string;
  projectId: string;
  userId?: string;
  cost?: number;
  startedAt: number;
  diagnostics?: GenerationAttempt[];
  /** Stage 46B-1: set when the live-look rewrite fell back to the original scene text. */
  lookWarning?: string;
  /** set once finalization (upload) has begun, to avoid running it twice */
  finalizing?: boolean;
  leaseToken?: string;
  leaseUntil?: number;
  finalizeAttempts?: number;
  providerStatus?: string;
  providerStartedAt?: string | null;
  providerCompletedAt?: string | null;
  /* --- Seedance moderation (E005) auto-recovery, no extra credit charge --- */
  /** How many LLM-sanitized resubmissions were already made on Seedance (max MAX_MODERATION_RETRIES). */
  moderationRetries?: number;
  /** Model that actually produced the final video, persisted to scene.videoModel on success. */
  videoModel?: string;
  /** Stage 73: generation provider the video was submitted to (always "wavespeed" since Stage 104). Legacy rows carry "seedance" (= WaveSpeed since Stage 70). */
  provider?: string;
  /** Everything needed to resubmit the same scene with a softer prompt. */
  retry?: ModerationRetryInput;
  /* --- Stage 33/36: what was ACTUALLY submitted, for honest moderation diagnostics --- */
  /** Exact prompt text sent to the provider. */
  submittedPrompt?: string;
  /** true when submittedPrompt is the producer's manual override (Stage 31). */
  hasOverride?: boolean;
  /** character_references | new_scene_reference | text_only */
  referenceKind?: string;
  /** Counts of the reference images actually sent (Stage 38: `chained` is always false — the previous frame is never sent; kept for old state records). */
  refCounts?: { characters: number; location: number; crowd: number; scene: number; reangle?: number; chained: boolean };
  /** Width the references were downscaled to before submission. */
  referenceWidth?: number;
  /** Stage 36: the exact ordered list of reference images sent (768px URLs), for UI previews. */
  submittedReferences?: { url: string; kind: string }[];
  /** Stage 36 legacy: id of the previous scene whose last frame was sent as a reference (Stage 38: always null). */
  previousFrameSceneId?: string | null;
  /** Stage 78: how this scene was tied to the previous one (last frame image / text only / none). */
  continuity?: Continuity;
  reangle?: { cacheId: string; cacheHit: boolean; sourceSceneId: string; camera: string };

}

export interface ModerationRetryInput {
  /** Level-1 sanitized core prompt (visual + speech + pace), WITHOUT the [ImageN] notes. */
  basePrompt: string;
  /** WaveSpeed Seedance slug the attempt was submitted on (always Seedance 2.5). */
  model: string;
  duration: number;
  resolution: string;
  /** Reference set of the first attempt (portraits, location angles, crowd; Stage 38: never the previous scene's frame). */
  refs: { url: string; kind: string; note: string }[];
  /** Reduced set for the last retry: speaking characters + one location angle. */
  fallbackRefs: { url: string; kind: string; note: string }[];
}
/** Up to 2 automatic LLM-sanitized resubmissions on Seedance, all within the same charge. */
export const MAX_MODERATION_RETRIES = 2;

const POLL_INTERVAL_MS = 8_000;
/** Typical Seedance time — only used to animate the progress bar while waiting. */
/** Hard cap for waiting on the provider. */
// End-to-end budget, not an invocation timer. Check provider terminal state BEFORE enforcing it.
export const VIDEO_DEADLINE_MS = 30 * 60 * 1000;
const CHECK_LEASE_MS = 60_000;
/** Stage 36: reference mode for every scene — at most REFERENCE_IMAGE_CAP images ([Image1]..[ImageN] in the prompt). */
export { MAX_REFERENCE_IMAGES, REFERENCE_IMAGE_CAP } from "@/lib/scene-prompt";
const FINALIZE_LEASE_MS = 12 * 60 * 1000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseState(resultData: string | null | undefined): VideoJobState | null {
  if (!resultData) return null;
  try {
    const s = JSON.parse(resultData);
    return s && typeof s.predictionId === "string" ? (s as VideoJobState) : null;
  } catch {
    return null;
  }
}

/**
 * Background video job (runs inside the same serverless invocation via `after()`).
 *
 * 1. Start Seedance prediction (generate_audio: true — speech + ambience baked in), persist predictionId
 * 2. Return; authenticated GET polling checks this same prediction with a database lease
 * 3. finalize(): S3 upload (80%) → Scene update (95%) → completed
 * On failure: scene status reset, credits refunded, job marked failed.
 *
 * If the function dies mid-way, GET /api/jobs/[id] calls `resumeVideoJob()` which
 * picks the prediction up by id and finishes the work.
 */
export async function runVideoJob(params: VideoJobParams): Promise<void> {
  const { jobId, sceneId, projectId, userId } = params;
  const cost = Number(params.cost ?? 0);

  const claimed = await prisma.generationJob.updateMany({ where: { id: jobId, status: { in: ["pending", "processing"] }, resultData: null },
    data: { resultData: JSON.stringify({ preparing: true }), status: "processing" } });
  if (!claimed.count) return;
  const diagnostics: GenerationAttempt[] = [];
  let state: VideoJobState | null = null;
  const persist = () => updateJob(jobId, { resultData: JSON.stringify({ ...state, diagnostics }) });
  try {
    const scene = await prisma.scene.findUnique({ where: { id: sceneId }, include: { location: true } }); // Stage 162: per-scene location (null → fall back to the episode location)
    if (!scene?.videoPrompt) throw new Error("Scene has no video prompt");
    // Stage 11: if cancellation was requested before we submitted any prediction, stop now —
    // no provider call is made, the scene is reset and the reserved credits are refunded.
    if (await isCancelRequested(jobId)) {
      await prisma.$transaction(async tx => {
        await tx.scene.update({ where: { id: sceneId }, data: { status: "pending" } }).catch(() => {});
        if (userId && cost > 0) {
          await tx.user.update({ where: { id: userId }, data: { credits: { increment: cost } } });
          await tx.creditTransaction.create({ data: { userId, amount: cost, description: `Refund: video generation canceled (${jobId})` } });
        }
      });
      await markCanceled(jobId);
      return;
    }
    await updateJob(jobId, { status: "processing", progress: 5, message: "Preparing photorealistic visual references..." });
    // Stage 40: a (re)generation invalidates the previously described actual end-state of this scene.
    if (scene.endStateActual) await prisma.scene.update({ where: { id: sceneId }, data: { endStateActual: null } }).catch(() => {});
    const links = await prisma.sceneCharacter.findMany({ where: { sceneId }, include: { character: true }, orderBy: { characterId: "asc" } });
    // Stage 40: the previous scene's end-state (actual description of its last frame in chain mode,
    // otherwise the scripted "Final frame") opens this scene's prompt. Its image is never sent.
    const previousRow = await resolveVideoPredecessor(prisma, scene);
    assertPredecessorReady(previousRow);
    // Stage 102: a refusal-looking vision answer ("I'm sorry, I can't help…", legacy rows) is treated as absent;
    // the raw description keeps its "CAMERA OF THIS FRAME" line for the anti-example, the OPENING STATE text does not.
    const previousEndStateRaw = previousRow && !isRefusal(previousRow.endStateActual) ? previousRow.endStateActual : null;
    const previous = previousRow ? { ...previousRow, endStateActual: previousEndStateRaw ? stripPreviousCameraLine(previousEndStateRaw) || null : null } : null;
    const episodeLoc = await prisma.episode.findUnique({ where: { id: scene.episodeId }, select: {
      id: true,
      script: true, // Stage 54: source text the prop registry is extracted from
      propRegistry: true, // Stage 54: cached registry JSON ({hash, props}) reused across the episode's scenes
      location: { select: { id: true, name: true, imageUrl: true, imageReverse: true, imageDetail: true, imageExtra: true, setInventory: true, regionPlates: true } },
      season: { select: { project: { select: { isTest: true } } } },
    } });
    // Stage 73: per-project generation providers (transport only).

    // Stage 4: speech is ALWAYS English. `dialogueEn` holds the voiced lines; legacy scenes written in
    // another language are translated once HERE (worker-only, network) and the translation is saved.
    // This is the only step the prompt PREVIEW skips — everything else comes from the shared builder.
    const isNarration = scene.sceneKind === "narration" && !!(scene.voiceover ?? "").trim();
    let dialogueEn = isNarration ? "" : ((scene.dialogueEn ?? "").trim() || scene.dialogue || "");
    if (!isNarration && dialogueEn && detectSpokenLanguage(dialogueEn) !== "English") {
      dialogueEn = await translateDialogue(dialogueEn, "English");
      await prisma.scene.update({ where: { id: sceneId }, data: { dialogueEn, language: "en" } }).catch(() => {});
    }

    // Stage 27c: single source of truth — the exact final prompt + reference plan is assembled by the
    // pure buildScenePrompt (lib/scene-prompt.ts), shared with the "show full prompt" preview so the
    // preview can never drift from what is actually submitted.
    // Stage 46B-1: rewrite the scene text (all 9 prompt lines, start/end state, resolved opening state and a
    // manual override) to the CURRENT character look — one gpt-4o call per scene, cached in Scene.lookCache.
    // On failure the original text is used (the [CHARACTER] line is still refreshed by buildScenePrompt).
    const lookChars = links.map(l => ({ characterId: l.characterId, name: l.character.name, age: l.character.age, appearance: l.character.appearance }));
    const originalOpening = resolveOpeningState(scene, previous);
    const overrideText = (scene.promptOverride ?? "").trim();
    const look = await rewriteSceneLook(lookChars, {
      videoPrompt: overrideText || scene.videoPrompt,
      startState: scene.startState ?? null,
      endState: scene.endState ?? null,
      openingState: originalOpening,
    }, parseLookCache(scene.lookCache));
    const lookWarning = look.warning;
    if (lookWarning) console.warn(`[video-job] ${sceneId}: ${lookWarning}`);
    if (look.cache && !look.fromCache) await prisma.scene.update({ where: { id: sceneId }, data: { lookCache: JSON.stringify(look.cache) } }).catch(() => {});
    const lookScene = {
      ...scene,
      videoPrompt: overrideText ? scene.videoPrompt : look.texts.videoPrompt,
      promptOverride: overrideText ? look.texts.videoPrompt : scene.promptOverride,
      startState: look.texts.openingState ?? scene.startState,
      endState: look.texts.endState ?? scene.endState,
    };
    // The rewritten opening state replaces the previous scene's stored states so resolveOpeningState picks it.
    // Stage 54: EPISODE PROP REGISTRY — canonical descriptions of the key recurring props, extracted once
    // from the episode script and cached on Episode.propRegistry (keyed by a hash of the script, exactly
    // like Scene.lookCache). The first scene of the episode that regenerates extracts it; every later
    // scene reuses the cache. Best-effort: on any failure the registry is empty and scenes fall back to
    // their own text. matchPropsInText inside buildScenePrompt then substitutes each shown prop VERBATIM.
    let episodeProps: { id: string; name: string; description: string }[] = [];
    if (episodeLoc?.id) {
      const propBuild = await buildPropRegistry(episodeLoc.script ?? "", parsePropRegistry(episodeLoc.propRegistry));
      if (propBuild.warning) console.warn(`[video-job] ${sceneId}: ${propBuild.warning}`);
      episodeProps = propBuild.registry.props;
      if (!propBuild.fromCache) {
        await prisma.episode.update({ where: { id: episodeLoc.id }, data: { propRegistry: JSON.stringify(propBuild.registry) } }).catch(() => {});
      }
    }
    const isTestProject = Boolean(episodeLoc?.season?.project?.isTest);
    const characters = links.map(l => ({ characterId: l.characterId, name: l.character.name, tier: l.character.tier,
      imageFront: l.character.imageFront, imageFull: l.character.imageFull, appearance: l.character.appearance, age: l.character.age }));
    const forbiddenReferenceUrls = [scene.keyframeUrl, previousRow?.lastFrameUrl, (previousRow as any)?.keyframeUrl].filter((u): u is string => !!u);
    const support = buildScenePrompt({ scene, characters, location: scene.location ?? episodeLoc?.location ?? null, previous,
      forbiddenReferenceUrls }).retryRefs;
    // Stage 122: resolve (or lazily generate once, reusing the Location.regionPlates cache) this scene's REGION
    // PLATE — the authoritative environment reference for this part of the location. Non-blocking: null → the
    // scene falls back to the Stage 121 master-plate + re-angle path. It is the PRIMARY geometry/background
    // reference passed to both the re-angle and the scene prompt; the re-angle stays for people/motion continuity.
    const regionPlateUrl = await ensureSceneRegionPlate({ sceneId, jobId, imageModel: undefined }).catch(() => null);
    let reangleUrl: string | null = null;
    let reangleInfo: VideoJobState["reangle"];
    let reangleRequest: ReturnType<typeof buildReangleRequest> | null = null;
    if (previousRow) {
      if (!episodeLoc?.location?.imageUrl || !episodeLoc.location.imageReverse)
        throw new Error("Add the location's mandatory wide and layout views before generating this transition.");
      await updateJob(jobId, { progress: 8, message: "Re-angling the previous video's last frame (Seedream camera edit)..." });
      reangleRequest = buildReangleRequest({ sceneId, number: scene.number, startState: scene.startState,
        videoPrompt: scene.videoPrompt, promptOverride: scene.promptOverride, previous: previousRow, refs: support, castState: characters,
        regionPlateUrl });
      const edited = await ensureReangle(reangleRequest, { jobId, sceneId, projectId });
      reangleUrl = edited.url;
      reangleInfo = { cacheId: reangleRequest.cacheId, cacheHit: edited.cacheHit, sourceSceneId: previousRow.id, camera: reangleRequest.camera };
    }
    const built = buildScenePrompt({
      scene: lookScene,
      reangleUrl, regionPlateUrl, forbiddenReferenceUrls,
      characters: links.map(l => ({ characterId: l.characterId, name: l.character.name, tier: l.character.tier, imageFront: l.character.imageFront, imageProfile: l.character.imageProfile, imageFull: l.character.imageFull, imageExtra: l.character.imageExtra, appearance: l.character.appearance, age: l.character.age })),
      location: scene.location ?? episodeLoc?.location ?? null,
      previous,
      provider: params.provider,
      resolvedDialogueEn: dialogueEn,
      props: episodeProps, // Stage 54: canonical episode props, substituted VERBATIM per scene
      // Stage 40: a test episode has no linked characters/location → plain text-to-video, no Flux still.
      textOnlyWhenNoReferences: isTestProject,
      // Stage 100: parallel mode removed — generation is always chain, so the previous scene's last
      // frame is always a continuity reference for same-location continuations.
      chainMode: "chain",
    });
    const prompt = finalVideoPrompt(built);
    const continuity = reangleUrl ? "reangled_frame" : "none";
    const basePrompt = built.basePrompt;
    const fallbackRefs = built.fallbackRefs;
    let referenceImages = built.referenceImages;
    let retryRefs: SceneReference[] = built.retryRefs;
    let reference = built.reference;

    // One paid video attempt. Copyright, general moderation, E003 and timeout remain distinct;
    // none silently trigger another generation or switch the audio off.
    // Stage 33: Seedance 2.5 is the only video model (native audio, up to 30 s per clip).
    const provider = normalizeVideoModel(params.provider);
    const modelSlug = videoModelSlug(provider);
    let predictionId: string;
    let attempt: GenerationAttempt;
    let submitMessage: string;
    // Extra state persisted alongside the prediction (moderation auto-recovery).
    const pipelineExtra: Partial<VideoJobState> = { reangle: reangleInfo };

    // The planned duration is already ≤30 s upstream (Seedance 2.5 limit); no per-model cap.
    const clipDuration = Number(params.duration ?? 5);

    // Stage 36: every scene is submitted in reference mode (or text-only). Every image actually sent
    // (portraits, all location angles, crowds, the previous scene's last frame, the new-scene still)
    // is a 768px-wide JPEG — the whole ordered list goes through one downscale pass. Fail-safe:
    // originals on error. The first-frame `image` path no longer exists.
    if (built.referenceKind === "text_only") {
      // Producer asked for text-only submission: no images at all, plain text-to-video.
      referenceImages = [];
      retryRefs = [];
    } else if (referenceImages.length) {
      referenceImages = await downscaleReferences(referenceImages, projectId);
    }
    const refCounts = {
      characters: retryRefs.filter(r => r.kind === "character").length,
      location: retryRefs.filter(r => r.kind === "location").length,
      crowd: retryRefs.filter(r => r.kind === "crowd").length,
      scene: retryRefs.filter(r => r.kind === "scene").length,
      reangle: retryRefs.filter(r => r.kind === "reangle").length,
      chained: false, // Stage 38: the previous scene's last frame is never sent as a reference.
    };
    // Exact submitted list (downscaled URLs, same order as [ImageN]) for the scene-card previews.
    const submittedReferences = referenceImages.map((url, i) => ({ url, kind: retryRefs[i]?.kind ?? "reference" }));
    const submission = {
      hasOverride: built.hasOverride, referenceKind: built.referenceKind, refCounts,
      referenceWidth: REFERENCE_WIDTH, referenceImageCount: referenceImages.length,
      previousFrameSceneId: built.previousFrameSceneId, continuity,
    };
    // Stage 46B: scenes are always rendered at 480p — the requested `params.resolution` is ignored.
    const input = {
      prompt, model: modelSlug, duration: clipDuration, resolution: SCENE_RESOLUTION,
      aspect_ratio: "9:16", generate_audio: true, watermark: false,
    };
    attempt = {
      jobId, sceneId, attempt: 1, model: input.model, phase: "video", status: "submitting",
      style: VISUAL_STYLE_ID, language: scene.language || "en",
      input: safeDiagnosticInput({ ...input, reference, ...submission, reangle: reangleInfo }),
    };
    diagnostics.push(attempt); await persist(); logAttempt(attempt);
    // Stage 40: `reference_images` is omitted entirely for text-only submissions (never sent as []).
    // Re-read the actual source just before submission: a concurrently regenerated predecessor invalidates the edit.
    const freshScene = await prisma.scene.findUnique({ where: { id: sceneId }, include: {
      characters: { include: { character: true }, orderBy: { characterId: "asc" } }, episode: { include: { location: true } }, location: true, // Stage 162: per-scene location (null → episode location)
    } });
    if (!freshScene) throw new Error("Scene was removed during preprocessing.");
    const currentPrevious = await resolveVideoPredecessor(prisma, freshScene);
    assertPredecessorReady(currentPrevious);
    const freshCharacters = freshScene.characters.map(l => ({ characterId: l.characterId, name: l.character.name,
      tier: l.character.tier, imageFront: l.character.imageFront, imageFull: l.character.imageFull,
      appearance: l.character.appearance, age: l.character.age }));
    const freshRefs = buildScenePrompt({ scene: freshScene, characters: freshCharacters, location: freshScene.location ?? freshScene.episode.location,
      previous: currentPrevious, forbiddenReferenceUrls }).retryRefs;
    if (reangleRequest && (!currentPrevious || buildReangleRequest({ sceneId, number: freshScene.number,
      startState: freshScene.startState, videoPrompt: freshScene.videoPrompt, promptOverride: freshScene.promptOverride,
      previous: currentPrevious, refs: freshRefs, castState: freshCharacters, regionPlateUrl }).hash !== reangleRequest.hash))
      throw new Error("The previous video, camera or references changed during preprocessing. Retry this scene to use the current inputs.");
    if (await isCancelRequested(jobId)) throw new Error("Video generation canceled before submission");
    if (referenceImages.some(u => forbiddenReferenceUrls.includes(u))) throw new Error("Forbidden source frame in video references");
    predictionId = await startVideoGeneration({ ...input, ...(referenceImages.length ? { reference_images: referenceImages } : {}) });
    pipelineExtra.provider = "wavespeed";
    // Stage 46B: "Queued" until the provider reports processing; Stage 78: in chain mode without the
    // previous last frame the card says once that the scene is generated from the description only.
    submitMessage = SCENE_STAGE_MESSAGE.queued;
    // Retry plan is still persisted for diagnostics, but moderation is now fail-fast:
    // no automatic rewrite/resubmit happens (see resumeVideoJob). The user edits the prompt manually.
    pipelineExtra.retry = {
      basePrompt, model: modelSlug, duration: input.duration, resolution: input.resolution, refs: retryRefs, fallbackRefs,
    };
    pipelineExtra.moderationRetries = 0;
    // What was ACTUALLY submitted — handleFailure builds its moderation message from this, never
    // from the scene's stored text (which may differ from a manual override).
    pipelineExtra.submittedPrompt = prompt;
    pipelineExtra.hasOverride = built.hasOverride;
    pipelineExtra.referenceKind = built.referenceKind;
    pipelineExtra.refCounts = refCounts;
    pipelineExtra.referenceWidth = REFERENCE_WIDTH;
    // Stage 111: the exact ordered reference list (camera-edit output first when present) — the card shows it as sent.
    pipelineExtra.submittedReferences = submittedReferences;
    pipelineExtra.previousFrameSceneId = built.previousFrameSceneId;
    pipelineExtra.continuity = continuity;
    attempt.predictionId = predictionId; attempt.status = "processing";
    state = { predictionId, sceneId, projectId, userId, cost, startedAt: Date.now(), diagnostics, ...(lookWarning ? { lookWarning } : {}), ...pipelineExtra };
    // This checkpoint MUST succeed: never swallow the prediction ID write.
    await prisma.generationJob.update({ where: { id: jobId }, data: {
      resultData: JSON.stringify(state), message: submitMessage, progress: SCENE_STAGE_PROGRESS.queued,
    } });
    logAttempt(attempt);
    // Release the serverless invocation immediately. Polling inspects the persisted prediction,
    // including after browser reload; it never starts a replacement prediction.

  } catch (err: unknown) {
    const attempt = diagnostics[diagnostics.length - 1];
    if (attempt && attempt.status !== "succeeded") {
      attempt.error = safeProviderError(err); attempt.errorKind = classifyProviderError(err);
      if (attempt.status !== "failed" && attempt.status !== "canceled") attempt.status = attempt.errorKind === "timeout" ? "timeout" : "failed";
      logAttempt(attempt);
    }
    await persist();
    // If submission succeeded, never convert a checkpoint/network failure into a refund
    // and a second generation. Keep the known prediction for recovery.
    if (state?.predictionId) {
      console.error("[video-job] prediction checkpoint needs recovery:", { jobId, predictionId: state.predictionId, error: safeProviderError(err) });
      return;
    }
    await handleFailure(jobId, { sceneId, userId, cost }, err);
  }
}

/** Guard all recovery writes with an expiring compare-and-swap lease. */
function owned(jobId: string, state: VideoJobState) {
  return { id: jobId, status: "processing", resultData: { contains: `"leaseToken":"${state.leaseToken}"` } };
}
async function saveOwned(jobId: string, state: VideoJobState, data: Record<string, unknown> = {}) {
  const result = await prisma.generationJob.updateMany({ where: owned(jobId, state), data: {
    ...data, resultData: JSON.stringify(state),
  } });
  return result.count === 1;
}

async function finalizeVideoJob(jobId: string, state: VideoJobState, source: string) {
  const scene = await prisma.scene.findUnique({ where: { id: state.sceneId } });
  if (!scene) throw new Error("Scene not found");
  const { folderPrefix } = getBucketConfig();
  // Deterministic object names: recovery never creates duplicate published outputs.
  const key = `${folderPrefix}public/videos/${state.projectId}/${scene.episodeId}/${VISUAL_STYLE_ID}/${jobId}`;
  // The Seedance clip is published as-is (native speech, no burned-in subtitles).
  const videoUrl = await uploadRemoteToS3(source, `${key}.mp4`, "video/mp4");
  let lastFrameUrl: string | null = null;
  try {
    const frame = await extractLastFrameBuffer(videoUrl);
    lastFrameUrl = await uploadBufferToS3(frame, `${key}-lastframe.jpg`, "image/jpeg");
  } catch (error) { console.warn("[video-job] frame:", safeProviderError(error)); }
  // Stage 40 — chain mode: describe the ACTUAL last frame (vision) for the next scene's OPENING STATE.
  const episode = await prisma.episode.findUnique({ where: { id: scene.episodeId }, select: { id: true, chainRunActive: true } }).catch(() => null);
  let endStateActual: string | null = null;
  // Stage 100: generation is always chain — always describe the ACTUAL last frame for the next scene.
  if (lastFrameUrl) {
    const links = await prisma.sceneCharacter.findMany({ where: { sceneId: scene.id }, select: { character: { select: { name: true } } } }).catch(() => []);
    endStateActual = await describeLastFrame(lastFrameUrl, { ...scene, endState: scene.endState ?? null }, links.map(l => ({ name: l.character.name })));
  }
  // Stage 46B: "Checking" 95 % — the clip is stored, the scene is about to be published.
  await saveOwned(jobId, state, { progress: SCENE_STAGE_PROGRESS.verifying, message: SCENE_STAGE_MESSAGE.verifying });
  // Publish scene and completed job together. A stale lease holder cannot publish or refund.
  const published = await prisma.$transaction(async tx => {
    const result = await tx.generationJob.updateMany({ where: owned(jobId, state), data: {
      status: "completed", progress: 100, message: SCENE_STAGE_MESSAGE.done, error: null,
      resultData: JSON.stringify({ ...state, leaseUntil: 0, finalizing: false, videoUrl }),
    } });
    if (!result.count) return false;
    await tx.scene.update({ where: { id: state.sceneId }, data: {
      videoUrl, audioUrl: null, status: "generated", lastFrameUrl, subtitled: false, endStateActual,
      // Stage 46B-1: the new clip renders the current look — clear the stale marker.
      lookStale: false,
      // Persist the model that actually succeeded (set only when the auto-fallback switched models).
      ...(state.videoModel ? { videoModel: state.videoModel } : {}),
    } });
    return true;
  });
  // Stage 40 — chain run: this scene is done, start the next pending scene (charged now).
  if (published && episode?.chainRunActive) {
    await continueChainRun(episode.id, scene.number).catch(err => console.error("[chain-run] continue failed:", safeProviderError(err)));
  }
}

/**
 * Stage 40 — chain mode. After a scene of an active chain run is published, charge and start the
 * next scene (lowest number without a video). When no scene is left the run ends; when the balance
 * cannot cover the next scene the run stops with a note on the episode.
 */
async function continueChainRun(episodeId: string, finishedSceneNumber: number): Promise<void> {
  const episode = await prisma.episode.findUnique({
    where: { id: episodeId },
    include: { season: { include: { project: true } }, scenes: { orderBy: { number: "asc" } } },
  });
  if (!episode || !episode.chainRunActive) return;
  const project = episode.season.project;
  const next = nextChainScene(episode.scenes, finishedSceneNumber);
  if (!next) {
    await prisma.episode.update({ where: { id: episodeId }, data: { chainRunActive: false } });
    return;
  }
  const active = await prisma.generationJob.findFirst({ where: { sceneId: next.id, type: "video", status: { in: ["pending", "processing"] } } });
  if (active) return; // already running (e.g. started manually) — its own finalize continues the chain
  const tier = resolvePowerTier(project);
  const duration = sceneClipSeconds(tier.id, next.durationSec);
  const cost = sceneClipCost(tier.id, duration);
  const charged = await prisma.user.updateMany({ where: { id: project.userId, credits: { gte: cost } }, data: { credits: { decrement: cost } } });
  if (charged.count !== 1) {
    await prisma.episode.update({ where: { id: episodeId }, data: { chainRunActive: false, chainRunNote: chainStopMessage(next.number, CHAIN_INSUFFICIENT_CREDITS) } });
    return;
  }
  await prisma.creditTransaction.create({ data: { userId: project.userId, amount: -cost, description: `Episode ${episode.number}, scene ${next.number} — video generation via chain (${tier.id})` } });
  await prisma.scene.update({ where: { id: next.id }, data: { status: "generating", language: "en", videoModel: normalizeVideoModel(null) } });
  const job = await prisma.generationJob.create({ data: { type: "video", status: "processing", progress: 2, message: "Chain: starting next scene...", projectId: project.id, sceneId: next.id } });
  runInBackground(() => runVideoJob({ jobId: job.id, sceneId: next.id, projectId: project.id, userId: project.userId, cost, duration, resolution: tier.resolution }));
}

/** Stage 40 — chain mode: a failed/canceled scene stops the active chain run with a Russian note. */
async function stopChainRun(sceneId: string, error: string): Promise<void> {
  const scene = await prisma.scene.findUnique({ where: { id: sceneId }, select: { number: true, episode: { select: { id: true, chainRunActive: true } } } }).catch(() => null);
  if (!scene?.episode?.chainRunActive) return;
  await prisma.episode.update({ where: { id: scene.episode.id }, data: { chainRunActive: false, chainRunNote: chainStopMessage(scene.number, error) } }).catch(() => {});
}

/**
 * Stage 33/36 — honest moderation diagnostics. Shown verbatim in the UI (job.error).
 * The hints are computed from the prompt that was ACTUALLY submitted (persisted in the job state at
 * submit time), not from the scene's stored text. The message lists exactly what was sent — portraits,
 * location angles, crowd groups and whether the previous scene's last frame was included — and, when
 * the text is a manual override without textual triggers, names the images as the likely cause and
 * points to the scene prompt editor. Fail-fast: no automatic rewrite or resubmission.
 */
async function moderationMessage(sceneId: string, error: unknown, state?: VideoJobState): Promise<string> {
  let submitted = state?.submittedPrompt ?? "";
  if (!submitted) {
    // Pre-submit failure or legacy state without the submitted text: fall back to the scene fields.
    const scene = await prisma.scene.findUnique({ where: { id: sceneId }, select: { videoPrompt: true, dialogueEn: true, dialogue: true, action: true, promptOverride: true } }).catch(() => null);
    submitted = (scene?.promptOverride ?? "").trim() || [scene?.videoPrompt, scene?.action, scene?.dialogueEn, scene?.dialogue].filter(Boolean).join("\n");
  }
  const hints = moderationHints(submitted);
  const counts = state?.refCounts;
  // Stage 38: the previous scene's frame is never sent, so the message lists only portraits / location angles / crowd.
  const imagesSent = counts ? counts.characters + counts.location + counts.crowd + counts.scene : null;
  const countsText = counts
    ? ` Images sent: ${imagesSent} — portraits: ${counts.characters}, location angles: ${counts.location}, extras: ${counts.crowd}${counts.scene ? `, scene frame: ${counts.scene}` : ""}.`
    : "";
  let message: string;
  if (state?.hasOverride && !hints.length && state.referenceKind !== "text_only") {
    message = `[moderation] The scene failed provider moderation. The prompt text is manual (override); no text triggers were found. The likely cause is reference images (character portraits, location angles, extras).${countsText} Try "Send without reference images (text only)" in the "View prompt" window or edit the prompt.`;
  } else {
    message = `[moderation] The scene failed provider moderation. Edit the prompt manually: open it with the "View prompt" button, fix it, save your version, and start generation again.` +
      (hints.length ? ` Likely triggers: ${hints.map(h => `«${h}»`).join(", ")}.` : "") +
      (state?.referenceKind === "text_only" ? " Reference images were not sent (text only)." : countsText + " If reference images are blocked (portraits, location angles, extras) — use the 'Send without reference images (text only)' option in the 'View prompt' window.");
  }
  message += ` Provider code: ${safeProviderError(error)}`;
  return message;
}

/** Status transition and refund are atomic and happen only once. */
async function handleFailure(jobId: string, ctx: { sceneId: string; userId?: string; cost?: number }, error: unknown, state?: VideoJobState) {
  const kind = classifyProviderError(error);
  let message = `[${kind}] ${safeProviderError(error)}`;
  if (kind === "moderation") {
    message = await moderationMessage(ctx.sceneId, error, state);
  }
  console.error("[video-job] failed:", { jobId, sceneId: ctx.sceneId, error: message });
  const applied = await prisma.$transaction(async tx => {
    const result = await tx.generationJob.updateMany({
      where: state ? owned(jobId, state) : { id: jobId, status: { in: ["pending", "processing"] } },
      data: { status: "failed", error: message, message: "Failed", ...(state ? { resultData: JSON.stringify({ ...state, leaseUntil: 0 }) } : {}) },
    });
    if (!result.count) return false;
    await tx.scene.update({ where: { id: ctx.sceneId }, data: { status: "pending" } });
    if (ctx.userId && Number(ctx.cost) > 0) {
      await tx.user.update({ where: { id: ctx.userId }, data: { credits: { increment: Number(ctx.cost) } } });
      await tx.creditTransaction.create({ data: { userId: ctx.userId, amount: Number(ctx.cost), description: `Refund: video generation failed (${jobId})` } });
    }
    return true;
  });
  // Stage 40: in chain mode a failed scene stops the run (later scenes are not charged or started).
  if (applied) await stopChainRun(ctx.sceneId, `[${kind}] ${safeProviderError(error)}`);
}

/** Succeeded predictions whose output is missing for longer than this are treated as expired at the provider. */
const EXPIRED_OUTPUT_GRACE_MS = 3 * 60_000;

/** One short provider check per poll, no sleeping invocation and no new prediction. */
export async function resumeVideoJob(job: { id: string; type: string; status: string; resultData: string | null; updatedAt: Date }): Promise<boolean> {
  if (job.type !== "video" || job.status !== "processing") return false;
  // Fresh read matters: callers may have read the job before a concurrent finalization/refund.
  const fresh = await prisma.generationJob.findUnique({ where: { id: job.id } });
  if (!fresh || fresh.status !== "processing") return false;
  const state = parseState(fresh.resultData);
  if (!state || (state.leaseUntil ?? 0) > Date.now()) return false;
  if (state.providerStatus && Date.now() - fresh.updatedAt.getTime() < POLL_INTERVAL_MS) return false;
  state.leaseToken = randomUUID(); state.leaseUntil = Date.now() + CHECK_LEASE_MS;
  const claim = await prisma.generationJob.updateMany({
    where: { id: job.id, status: "processing", resultData: fresh.resultData },
    data: { resultData: JSON.stringify(state) },
  });
  if (!claim.count) return false;
  try {
    // "Cancel generation" — check the flag BEFORE the provider status GET, so a cancel goes through even
    // while the provider is unreachable or its status read keeps failing (otherwise the card spun forever).
    // Stage 73: poll/cancel on the provider the job was submitted to (legacy "seedance" rows = WaveSpeed).
    const getState = (s: VideoJobState): Promise<PredictionState> => getVideoGenerationState(s.predictionId);
    const cancelState = (s: VideoJobState): Promise<void> => cancelVideoGeneration(s.predictionId);
    if (fresh.cancelRequested === true || await isCancelRequested(job.id)) {
      await cancelState(state).catch(() => {});
      await handleFailure(job.id, state, new Error("Generation canceled by the author"), state);
      await markCanceled(job.id);
      return true;
    }
    let prediction = await getState(state);
    // Deadline only applies to NON-terminal predictions. Late success still gets saved.
    if (["starting", "processing"].includes(prediction.status) && Date.now() - state.startedAt >= VIDEO_DEADLINE_MS) {
      await cancelState(state);
      prediction = await getState(state);
    }
    state.providerStatus = prediction.status;
    state.providerStartedAt = prediction.startedAt;
    state.providerCompletedAt = prediction.completedAt;
    const attempt = state.diagnostics?.find(a => a.predictionId === state.predictionId);
    if (attempt) {
      attempt.status = prediction.status;
      if (prediction.error) { attempt.error = safeProviderError(prediction.error); attempt.errorKind = classifyProviderError(prediction.error); }
      logAttempt(attempt);
    }
    if (prediction.status === "failed" || prediction.status === "canceled") {
      const reason = prediction.error || (Date.now() - state.startedAt >= VIDEO_DEADLINE_MS ? "Prediction timed out at the 30-minute application deadline (cancellation confirmed)" : "Prediction canceled by provider");
      // Stage 11: the author canceled — never start a NEW prediction (moderation retry). Refund and stop.
      if (await isCancelRequested(job.id)) {
        await handleFailure(job.id, state, new Error(reason), state);
        await markCanceled(job.id);
        return true;
      }
      // Seedance moderation (E005) is now fail-fast: no automatic prompt rewrite/resubmit.
      // The refusal goes straight to handleFailure like any other provider error, and the user
      // edits the prompt manually (copy → fix → regenerate) via the scene card.
      await handleFailure(job.id, state, new Error(reason), state);
      return true;
    }
    // Succeeded, but the output file is already gone: the provider keeps outputs ~1 hour after completion and
    // nobody polled this job in time (no server-side cron — polling runs only while the episode page is
    // open). Retrying the GET forever is pointless — fail with a refund and a clear Russian explanation.
    if (prediction.status === "succeeded" && !prediction.url) {
      const completedAt = prediction.completedAt ? Date.parse(prediction.completedAt) : NaN;
      if (!Number.isFinite(completedAt) || Date.now() - completedAt > EXPIRED_OUTPUT_GRACE_MS) {
        await handleFailure(job.id, state, new Error("The finished video was not retrieved in time: the provider has already deleted the file (it is stored for about an hour after completion). Credits have been refunded. Keep the episode tab open until generation finishes or return to it within an hour."), state);
        return true;
      }
    }
    if (prediction.status === "succeeded" && prediction.url) {
      state.finalizing = true;
      state.finalizeAttempts = (state.finalizeAttempts ?? 0) + 1;
      if (state.finalizeAttempts > 3) {
        await handleFailure(job.id, state, new Error("Storage finalization failed after three recovery attempts"), state);
        return true;
      }
      state.leaseUntil = Date.now() + FINALIZE_LEASE_MS;
      if (!await saveOwned(job.id, state, { progress: SCENE_STAGE_PROGRESS.uploading, message: SCENE_STAGE_MESSAGE.uploading })) return false;
      runInBackground(async () => {
        try { await finalizeVideoJob(job.id, state, prediction.url!); }
        catch (error) {
          // Network/storage failures are recoverable; keep the same successful prediction.
          state.leaseUntil = 0;
          await saveOwned(job.id, state, { message: "Upload interrupted; retrying storage on the next check", error: safeProviderError(error) });
        }
      });
      return true;
    }
    state.leaseUntil = 0;
    // Stage 46B: stage-based progress — "Queued" 5 % / "Rendering video (Seedance)… mm:ss" 40 % (elapsed
    // since the model actually started; a model-reported percent is used when the logs carry one).
    const renderStart = prediction.startedAt ? Date.parse(prediction.startedAt) : NaN;
    const elapsedMs = Date.now() - (Number.isFinite(renderStart) ? renderStart : state.startedAt);
    const stage = sceneProgressStage(prediction.status, elapsedMs, prediction.logs);
    await saveOwned(job.id, state, { progress: stage.progress, message: stage.message });
    return true;
  } catch (error) {
    // A failed status GET is NOT a failed generation. Leave it recoverable, without a refund.
    state.leaseUntil = 0;
    await saveOwned(job.id, state, { message: "Provider status temporarily unavailable; checking again", error: safeProviderError(error) });
    return true;
  }
}
