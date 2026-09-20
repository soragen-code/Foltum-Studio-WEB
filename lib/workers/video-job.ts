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
import { translateDialogue, detectSpokenLanguage } from "@/lib/voiceover";
import { uploadRemoteToS3, uploadBufferToS3 } from "@/lib/s3-upload";
import { extractLastFrameBuffer, extractFirstFrameBuffer } from "@/lib/ffmpeg";
import { normalizeVideoModel, videoModelSlug } from "@/lib/ai-models";
import type { PredictionState } from "@/lib/wavespeed";
import { getBucketConfig } from "@/lib/aws-config";
import { VISUAL_STYLE_ID, VISUAL_STYLE } from "@/lib/visual-style";
// Stage 167 — SHOT pipeline: per-shot prompt assembly + shot chain + concat/continuity helpers + the
// terminal assembly worker. Every runtime job renders ONE Shot at a time (see runShotVideoJob); the
// legacy scene generation path has been removed.
import { assembleShotPrompt } from "@/lib/prompts/shot";
import { buildConcatPlan, compareShotKeyframesVLM, type ShotVisionFn } from "@/lib/shot-pipeline";
import { runAssemblyJob } from "@/lib/workers/assembly-job";
import { getDialogueLanguage } from "@/lib/dialogue-language";
import { getOpenAI } from "@/lib/ai";
import { REFERENCE_IMAGE_CAP as SHOT_REFERENCE_IMAGE_CAP } from "@/lib/scene-prompt";
import type { PlannedShot } from "@/lib/prompts/shot-plan";
import type { ShotCharacterLike } from "@/lib/prompts/shot";
import { rewriteSceneLook, parseLookCache } from "@/lib/character-look";
import { buildPropRegistry, parsePropRegistry } from "@/lib/prop-registry";
import { GenerationAttempt, safeProviderError, classifyProviderError, logAttempt, safeDiagnosticInput } from "@/lib/generation-diagnostics";
import { updateJob, heartbeatJob, runInBackground, isCancelRequested, markCanceled } from "@/lib/jobs";
import { moderationHints } from "@/lib/sanitize-prompt";
import { downscaleReferences, REFERENCE_WIDTH } from "@/lib/reference-downscale";
import { describeLastFrame, isRefusal } from "@/lib/frame-state";
import { nextSequentialShot, chainStopMessage, CHAIN_INSUFFICIENT_CREDITS } from "@/lib/chain-run";
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
  /**
   * Stage 167 — when set, this job renders ONE SHOT (the atomic unit of generation) instead of a whole
   * scene: the prompt is assembled from the Shot's blocks (assembleShotPrompt), the per-shot videoUrl is
   * persisted on the Shot row, and the shot chain (not the scene chain) drives the next unit. `sceneId`
   * still carries the shot's parent scene (used by stopChainRun and the shared claim/refund plumbing).
   */
  shotId?: string | null;
}

/** Persisted in GenerationJob.resultData while the job is running, so it can be resumed. */
export interface VideoJobState {
  predictionId: string;
  sceneId: string;
  /** Stage 167 — set when this job renders a single SHOT; drives the shot finalize + shot chain path. */
  shotId?: string | null;
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
  // Stage 167 — every runtime job renders ONE SHOT. A job that arrives without a shotId belongs to the
  // removed legacy scene path: it cannot produce a valid clip, so it fails loudly and refunds instead of
  // silently falling back to scene generation.
  if (params.shotId) return runShotVideoJob(params);
  return failVideoJobNoShot(params);
}

/**
 * Stage 167 — a job with no shotId targets the removed legacy scene path. Fail the job loudly, refund the
 * charged credits (if any) and reset the scene so nothing is left half-started. Never generates a clip.
 */
async function failVideoJobNoShot(params: VideoJobParams): Promise<void> {
  const { jobId, sceneId, userId } = params;
  const cost = Number(params.cost ?? 0);
  const message =
    "Legacy scene video generation has been removed — regenerate the shot plan for this episode.";
  console.error("[video-job] rejected legacy scene job (no shotId):", { jobId, sceneId });
  await prisma.$transaction(async tx => {
    const result = await tx.generationJob.updateMany({
      where: { id: jobId, status: { in: ["pending", "processing"] } },
      data: { status: "failed", error: message, message: "Failed" },
    });
    if (!result.count) return;
    await tx.scene.update({ where: { id: sceneId }, data: { status: "pending" } }).catch(() => {});
    if (userId && cost > 0) {
      await tx.user.update({ where: { id: userId }, data: { credits: { increment: cost } } });
      await tx.creditTransaction.create({ data: { userId, amount: cost, description: `Refund: legacy scene generation removed (${jobId})` } });
    }
  });
  await stopChainRun(sceneId, message);
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
  // Stage 167 — every runtime job renders a SHOT and finalizes onto the Shot row. The legacy scene
  // finalize path (and its chain continuation) has been removed; a job without a shotId can no longer
  // reach finalization.
  if (!state.shotId) throw new Error("Legacy scene finalize has been removed — job has no shotId");
  return finalizeShotVideoJob(jobId, state, source);
}

/** Stage 40 — chain mode: a failed/canceled scene stops the active chain run with a Russian note. */
async function stopChainRun(sceneId: string, error: string): Promise<void> {
  const scene = await prisma.scene.findUnique({ where: { id: sceneId }, select: { number: true, episode: { select: { id: true, chainRunActive: true } } } }).catch(() => null);
  if (!scene?.episode?.chainRunActive) return;
  await prisma.episode.update({ where: { id: scene.episode.id }, data: { chainRunActive: false, chainRunNote: chainStopMessage(scene.number, error) } }).catch(() => {});
}

/* ─────────────────────────── Stage 167 — SHOT pipeline ─────────────────────────── */

/**
 * Stage 167 — flatten an episode's shots into strict episode-global order: primary key the parent
 * scene number, secondary key the 0-based Shot.index within that scene (shots span 1–2 scenes).
 */
function orderEpisodeShots<S extends { id: string; index: number; sceneId: string }>(
  scenes: readonly { id: string; number: number }[],
  shots: readonly S[],
): (S & { sceneNumber: number })[] {
  const numberById = new Map(scenes.map(s => [s.id, s.number]));
  return shots
    .map(s => ({ ...s, sceneNumber: numberById.get(s.sceneId) ?? 0 }))
    .sort((a, b) => a.sceneNumber - b.sceneNumber || a.index - b.index);
}

/**
 * Stage 167 (req 4) — real VLM keyframe-continuity check. Injected into compareShotKeyframesVLM so it
 * compares the previous shot's LAST frame with the next shot's FIRST frame (gpt-4o-mini vision). Returns
 * a soft {consistent, reason}; a mismatch is logged, never a hard failure.
 */
const shotVisionFn: ShotVisionFn = async ({ prevFrameUrl, nextFrameUrl, question }) => {
  try {
    const res = await getOpenAI().chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a film continuity checker. Compare two consecutive video keyframes and decide whether the visual continuity holds (same setting, lighting, wardrobe, character identity and camera logic). Reply with strict JSON: {\"consistent\": boolean, \"reason\": string}." },
        { role: "user", content: [
          { type: "text", text: question || "Does the second frame continue the first with no continuity break?" },
          { type: "image_url", image_url: { url: prevFrameUrl, detail: "high" } },
          { type: "image_url", image_url: { url: nextFrameUrl, detail: "high" } },
        ] },
      ],
      response_format: { type: "json_object" },
      max_tokens: 300,
    });
    const raw = res.choices?.[0]?.message?.content ?? "";
    try {
      const parsed = JSON.parse(raw);
      return { consistent: Boolean(parsed.consistent), reason: String(parsed.reason ?? "").slice(0, 500) };
    } catch {
      // Heuristic fallback if the model did not return clean JSON.
      const consistent = !/inconsistent|mismatch|different|break|discontinu/i.test(raw);
      return { consistent, reason: raw.slice(0, 500) || "unparseable vision response" };
    }
  } catch (error) {
    return { consistent: true, reason: `continuity check skipped: ${safeProviderError(error)}` };
  }
};

/**
 * Stage 167 — SHOT job. Renders ONE shot of an episode. Unlike the legacy scene path, the prompt is
 * assembled from the Shot's own blocks (assembleShotPrompt). Reference images are
 * the in-frame characters' portraits plus the location wide view. On success finalizeShotVideoJob stores
 * the per-shot videoUrl, and continueShotChain starts the next shot (or triggers the assembly job).
 */
async function runShotVideoJob(params: VideoJobParams): Promise<void> {
  const { jobId, sceneId, projectId, userId, shotId } = params;
  const cost = Number(params.cost ?? 0);
  const claimed = await prisma.generationJob.updateMany({ where: { id: jobId, status: { in: ["pending", "processing"] }, resultData: null },
    data: { resultData: JSON.stringify({ preparing: true }), status: "processing" } });
  if (!claimed.count) return;
  const diagnostics: GenerationAttempt[] = [];
  let state: VideoJobState | null = null;
  const persist = () => updateJob(jobId, { resultData: JSON.stringify({ ...state, diagnostics }) });
  try {
    const shot = await prisma.shot.findUnique({ where: { id: shotId! }, include: {
      scene: { include: {
        location: true,
        characters: { include: { character: true }, orderBy: { characterId: "asc" } },
        episode: { include: { location: true, season: { include: { project: true } } } },
      } },
    } });
    if (!shot) throw new Error("Shot not found");
    const scene = shot.scene;
    const episode = scene.episode;
    const project = episode.season.project;
    // Stage 11: honour a cancel requested before any provider call — reset the shot, refund the credits.
    if (await isCancelRequested(jobId)) {
      await prisma.$transaction(async tx => {
        await tx.shot.update({ where: { id: shot.id }, data: { status: "pending" } }).catch(() => {});
        if (userId && cost > 0) {
          await tx.user.update({ where: { id: userId }, data: { credits: { increment: cost } } });
          await tx.creditTransaction.create({ data: { userId, amount: cost, description: `Refund: shot generation canceled (${jobId})` } });
        }
      });
      await markCanceled(jobId);
      return;
    }
    await updateJob(jobId, { status: "processing", progress: 5, message: "Preparing shot references..." });

    // Reconstruct the PlannedShot from the persisted Shot row. The Shot model has no `camera` column —
    // an empty camera makes assembleShotPrompt fall back to the per-shot-type default technique.
    const plannedShot: PlannedShot = {
      index: shot.index,
      sceneNumber: scene.number,
      shotType: (shot.shotType || "dialogue") as PlannedShot["shotType"],
      size: (shot.size || "MS") as PlannedShot["size"],
      duration: Number(shot.duration ?? 3),
      camera: "",
      speakerId: shot.speakerId ?? null,
      line: shot.line ?? null,
      reactionOfId: shot.reactionOfId ?? null,
      escalationBeat: (shot.escalationBeat ?? "") as PlannedShot["escalationBeat"],
      postFx: (shot.postFx || "none") as PlannedShot["postFx"],
      matchCutIn: shot.matchCutIn ?? "",
      matchCutOut: shot.matchCutOut ?? "",
    };
    const characters: ShotCharacterLike[] = scene.characters.map(l => ({
      characterId: l.characterId, name: l.character.name, tier: l.character.tier, appearance: l.character.appearance,
    }));
    // Stage 167 (req 2) — prompt from the SHOT blocks.
    const built = assembleShotPrompt({
      style: VISUAL_STYLE,
      locationName: scene.location?.name ?? episode.location?.name ?? null,
      characters,
      shot: plannedShot,
      dialogueLanguage: getDialogueLanguage(project),
      isSceneFirst: shot.index === 0,
      isSceneLast: false,
    });
    const prompt = built.prompt;

    // Reference images: portraits of the shot's in-frame characters (speaker + reaction) plus the
    // location's wide view. Capped and downscaled exactly like the scene path.
    const inFrameIds = new Set([shot.speakerId, shot.reactionOfId].filter(Boolean) as string[]);
    const portraitUrls = scene.characters
      .filter(l => inFrameIds.size === 0 || inFrameIds.has(l.characterId))
      .map(l => l.character.imageFront)
      .filter((u): u is string => !!u);
    const locationUrl = scene.location?.imageUrl ?? episode.location?.imageUrl ?? null;
    let referenceImages = [...portraitUrls, ...(locationUrl ? [locationUrl] : [])]
      .filter((u, i, a) => a.indexOf(u) === i)
      .slice(0, SHOT_REFERENCE_IMAGE_CAP);
    if (referenceImages.length) referenceImages = await downscaleReferences(referenceImages, projectId);

    const provider = normalizeVideoModel(params.provider);
    const modelSlug = videoModelSlug(provider);
    const input = {
      prompt, model: modelSlug, duration: Math.max(4, Math.round(Number(params.duration ?? shot.duration ?? 3))),
      resolution: SCENE_RESOLUTION, aspect_ratio: "9:16", generate_audio: true, watermark: false,
    };
    const attempt: GenerationAttempt = {
      jobId, sceneId, attempt: 1, model: input.model, phase: "video", status: "submitting",
      style: VISUAL_STYLE_ID, language: "en",
      input: safeDiagnosticInput({ ...input, shotId: shot.id }),
    };
    diagnostics.push(attempt); await persist(); logAttempt(attempt);
    if (await isCancelRequested(jobId)) throw new Error("Shot generation canceled before submission");
    const predictionId = await startVideoGeneration({ ...input, ...(referenceImages.length ? { reference_images: referenceImages } : {}) });
    attempt.predictionId = predictionId; attempt.status = "processing";
    state = { predictionId, sceneId, shotId: shot.id, projectId, userId, cost, startedAt: Date.now(), diagnostics, provider: "wavespeed", submittedPrompt: prompt, continuity: "none" };
    // This checkpoint MUST succeed: never swallow the prediction ID write.
    await prisma.generationJob.update({ where: { id: jobId }, data: {
      resultData: JSON.stringify(state), message: SCENE_STAGE_MESSAGE.queued, progress: SCENE_STAGE_PROGRESS.queued,
    } });
    logAttempt(attempt);
  } catch (err: unknown) {
    const attempt = diagnostics[diagnostics.length - 1];
    if (attempt && attempt.status !== "succeeded") {
      attempt.error = safeProviderError(err); attempt.errorKind = classifyProviderError(err);
      if (attempt.status !== "failed" && attempt.status !== "canceled") attempt.status = attempt.errorKind === "timeout" ? "timeout" : "failed";
      logAttempt(attempt);
    }
    await persist();
    if (state?.predictionId) {
      console.error("[video-job] shot prediction checkpoint needs recovery:", { jobId, predictionId: state.predictionId, error: safeProviderError(err) });
      return;
    }
    await handleFailure(jobId, { sceneId, userId, cost, shotId }, err, state ?? undefined);
  }
}

/**
 * Stage 167 — finalize a SHOT job: upload the clip, store the per-shot videoUrl + last frame, run the
 * real keyframe-continuity check against the previous shot, then advance the shot chain.
 */
async function finalizeShotVideoJob(jobId: string, state: VideoJobState, source: string): Promise<void> {
  const shot = await prisma.shot.findUnique({ where: { id: state.shotId! }, include: { scene: { select: { id: true, number: true, episodeId: true } } } });
  if (!shot) throw new Error("Shot not found");
  const episodeId = shot.scene.episodeId;
  const { folderPrefix } = getBucketConfig();
  // Deterministic object names: recovery never creates duplicate published outputs.
  const key = `${folderPrefix}public/videos/${state.projectId}/${episodeId}/${VISUAL_STYLE_ID}/shot-${jobId}`;
  const videoUrl = await uploadRemoteToS3(source, `${key}.mp4`, "video/mp4");
  let lastFrameUrl: string | null = null;
  try {
    const frame = await extractLastFrameBuffer(videoUrl);
    lastFrameUrl = await uploadBufferToS3(frame, `${key}-lastframe.jpg`, "image/jpeg");
  } catch (error) { console.warn("[video-job] shot frame:", safeProviderError(error)); }

  // Stage 167 (req 4) — REAL keyframe continuity: compare the PREVIOUS shot's last frame with THIS
  // shot's first frame. Non-fatal — a mismatch is logged, the chain still proceeds.
  try {
    const [scenes, shots] = await Promise.all([
      prisma.scene.findMany({ where: { episodeId }, select: { id: true, number: true }, orderBy: { number: "asc" } }),
      prisma.shot.findMany({ where: { scene: { episodeId } }, select: { id: true, index: true, sceneId: true, lastFrameUrl: true } }),
    ]);
    const ordered = orderEpisodeShots(scenes, shots);
    const pos = ordered.findIndex(s => s.id === shot.id);
    const prev = pos > 0 ? ordered[pos - 1] : null;
    if (prev?.lastFrameUrl) {
      const firstBuf = await extractFirstFrameBuffer(videoUrl);
      const firstFrameUrl = await uploadBufferToS3(firstBuf, `${key}-firstframe.jpg`, "image/jpeg");
      const continuity = await compareShotKeyframesVLM(prev.lastFrameUrl, firstFrameUrl, shotVisionFn);
      console.log("[shot-continuity]", { episodeId, shotId: shot.id, consistent: continuity.consistent, reason: continuity.reason });
    }
  } catch (error) { console.warn("[shot-continuity] check failed:", safeProviderError(error)); }

  await saveOwned(jobId, state, { progress: SCENE_STAGE_PROGRESS.verifying, message: SCENE_STAGE_MESSAGE.verifying });
  const published = await prisma.$transaction(async tx => {
    const result = await tx.generationJob.updateMany({ where: owned(jobId, state), data: {
      status: "completed", progress: 100, message: SCENE_STAGE_MESSAGE.done, error: null,
      resultData: JSON.stringify({ ...state, leaseUntil: 0, finalizing: false, videoUrl }),
    } });
    if (!result.count) return false;
    await tx.shot.update({ where: { id: shot.id }, data: { videoUrl, lastFrameUrl, status: "generated", error: null } });
    return true;
  });
  // Stage 167 — this shot is done: start the next ungenerated shot, or (last shot) trigger assembly.
  if (published) {
    await continueShotChain(episodeId).catch(err => console.error("[shot-chain] continue failed:", safeProviderError(err)));
  }
}

/**
 * Stage 167 — SHOT chain. After a shot is published, generate the next ungenerated shot in strict
 * episode-global order (nextSequentialShot). When every shot has a clip the episode is complete: run
 * the assembly job (buildConcatPlan → concat → music → Episode.videoUrl; no subtitles).
 */
async function continueShotChain(episodeId: string): Promise<void> {
  const episode = await prisma.episode.findUnique({
    where: { id: episodeId },
    include: {
      season: { include: { project: true } },
      scenes: { select: { id: true, number: true }, orderBy: { number: "asc" } },
    },
  });
  if (!episode || !episode.chainRunActive) return;
  const project = episode.season.project;
  const shots = await prisma.shot.findMany({ where: { scene: { episodeId } }, select: { id: true, index: true, sceneId: true, videoUrl: true, status: true, duration: true, postFx: true } });
  const ordered = orderEpisodeShots(episode.scenes, shots);
  const next = nextSequentialShot(ordered.map(s => ({ id: s.id, sceneNumber: s.sceneNumber, index: s.index, videoUrl: s.videoUrl, status: s.status })));
  if (!next) {
    // Every shot has a clip (or the earliest gap is still generating). When the plan is fully ready,
    // assemble the terminal artifact; buildConcatPlan is the readiness gate (also enforced in runAssemblyJob).
    const plan = buildConcatPlan(ordered.map((s, i) => ({ index: i, videoUrl: s.videoUrl ?? null, duration: Number(s.duration ?? 3), postFx: (s.postFx || "none") as PlannedShot["postFx"] })));
    if (plan.ready) {
      await runAssemblyJob(episodeId).catch(err => console.error("[assembly-job] failed:", safeProviderError(err)));
    }
    return;
  }
  const nextShot = shots.find(s => s.id === next.id)!;
  const active = await prisma.generationJob.findFirst({ where: { sceneId: nextShot.sceneId, type: "video", status: { in: ["pending", "processing"] } } });
  if (active) return; // already running — its own finalize continues the chain
  const tier = resolvePowerTier(project);
  const shotDuration = Math.max(1, Math.round(Number(nextShot.duration ?? 3)));
  const duration = sceneClipSeconds(tier.id, shotDuration);
  const cost = sceneClipCost(tier.id, duration);
  const charged = await prisma.user.updateMany({ where: { id: project.userId, credits: { gte: cost } }, data: { credits: { decrement: cost } } });
  if (charged.count !== 1) {
    await prisma.episode.update({ where: { id: episodeId }, data: { chainRunActive: false, chainRunNote: chainStopMessage(next.sceneNumber, CHAIN_INSUFFICIENT_CREDITS) } });
    return;
  }
  await prisma.creditTransaction.create({ data: { userId: project.userId, amount: -cost, description: `Episode ${episode.number}, scene ${next.sceneNumber}, shot ${next.index + 1} — video generation via chain (${tier.id})` } });
  await prisma.shot.update({ where: { id: next.id }, data: { status: "generating", error: null } });
  const job = await prisma.generationJob.create({ data: { type: "video", status: "processing", progress: 2, message: "Chain: starting next shot...", projectId: project.id, sceneId: nextShot.sceneId } });
  runInBackground(() => runVideoJob({ jobId: job.id, sceneId: nextShot.sceneId, shotId: next.id, projectId: project.id, userId: project.userId, cost, duration, resolution: tier.resolution }));
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
async function handleFailure(jobId: string, ctx: { sceneId: string; userId?: string; cost?: number; shotId?: string | null }, error: unknown, state?: VideoJobState) {
  const kind = classifyProviderError(error);
  let message = `[${kind}] ${safeProviderError(error)}`;
  if (kind === "moderation") {
    message = await moderationMessage(ctx.sceneId, error, state);
  }
  console.error("[video-job] failed:", { jobId, sceneId: ctx.sceneId, error: message });
  // Stage 167 — the failing unit may be a SHOT even before any state was persisted (pre-submission
  // error): the shotId then comes from the call context rather than the persisted job state.
  const failShotId = state?.shotId ?? ctx.shotId ?? null;
  const applied = await prisma.$transaction(async tx => {
    const result = await tx.generationJob.updateMany({
      where: state ? owned(jobId, state) : { id: jobId, status: { in: ["pending", "processing"] } },
      data: { status: "failed", error: message, message: "Failed", ...(state ? { resultData: JSON.stringify({ ...state, leaseUntil: 0 }) } : {}) },
    });
    if (!result.count) return false;
    // Stage 167 — a failed SHOT resets that Shot row to "error" (the parent scene keeps its other shots);
    // a failed SCENE resets the scene as before. Either way the refund + chain-stop below are identical.
    if (failShotId) {
      await tx.shot.update({ where: { id: failShotId }, data: { status: "error", error: message } }).catch(() => {});
    } else {
      await tx.scene.update({ where: { id: ctx.sceneId }, data: { status: "pending" } });
    }
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
