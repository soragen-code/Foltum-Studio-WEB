import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { startVideoPrediction, startImagePrediction, getPredictionState, cancelVideoPrediction } from "@/lib/replicate";
import { translateDialogue, detectSpokenLanguage } from "@/lib/voiceover";
import { uploadRemoteToS3, uploadBufferToS3 } from "@/lib/s3-upload";
import { extractLastFrameBuffer } from "@/lib/ffmpeg";
import { normalizeVideoModel, videoModelSlug } from "@/lib/ai-models";
import { getBucketConfig } from "@/lib/aws-config";
import { VISUAL_STYLE_ID } from "@/lib/visual-style";
import { buildScenePrompt } from "@/lib/scene-prompt";
import { GenerationAttempt, safeProviderError, classifyProviderError, logAttempt, safeDiagnosticInput } from "@/lib/generation-diagnostics";
import { updateJob, heartbeatJob, runInBackground, isCancelRequested, markCanceled } from "@/lib/jobs";
import { moderationHints } from "@/lib/sanitize-prompt";

export interface VideoJobParams {
  jobId: string;
  sceneId: string;
  projectId: string;
  userId?: string;
  cost?: number;
  duration?: number;
  resolution?: string;
  /** "seedance" (2.5, default, native audio) or "seedance-2.0" (native audio, max 15s). */
  provider?: "seedance" | "seedance-2.0";
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
  /** Everything needed to resubmit the same scene with a softer prompt. */
  retry?: ModerationRetryInput;
}

export interface ModerationRetryInput {
  /** Level-1 sanitized core prompt (visual + speech + pace), WITHOUT the [ImageN] notes. */
  basePrompt: string;
  /** Replicate Seedance slug to resubmit on (2.5 default or 2.0). */
  model: string;
  duration: number;
  resolution: string;
  /** Adjacent last frame (image-to-video), if the first attempt used one. */
  image?: string;
  /** Reference set of the first attempt. */
  refs: { url: string; kind: string; note: string }[];
  /** Reduced set for the last retry: speaking characters + one location angle. */
  fallbackRefs: { url: string; kind: string; note: string }[];
}
/** Up to 2 automatic LLM-sanitized resubmissions on Seedance, all within the same charge. */
export const MAX_MODERATION_RETRIES = 2;

const POLL_INTERVAL_MS = 8_000;
/** Typical Seedance time — only used to animate the progress bar while waiting. */
const EXPECTED_VIDEO_MS = Number(process.env.SEEDANCE_EXPECTED_MS ?? 10 * 60 * 1000);
/** Hard cap for waiting on Replicate. */
// End-to-end budget, not an invocation timer. Check provider terminal state BEFORE enforcing it.
export const VIDEO_DEADLINE_MS = 30 * 60 * 1000;
const CHECK_LEASE_MS = 60_000;
/** Seedance 2.5 accepts up to 30 reference images ([Image1]..[ImageN] in the prompt). */
export { MAX_REFERENCE_IMAGES } from "@/lib/scene-prompt";
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

/** Progress 5 → 55 while the video model works, based on elapsed time. */
function waitingProgress(startedAt: number): number {
  const ratio = Math.min(1, (Date.now() - startedAt) / EXPECTED_VIDEO_MS);
  return 5 + Math.round(ratio * 50);
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

  const diagnostics: GenerationAttempt[] = [];
  let state: VideoJobState | null = null;
  const persist = () => updateJob(jobId, { resultData: JSON.stringify({ ...state, diagnostics }) });
  try {
    const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
    if (!scene?.videoPrompt) throw new Error("Scene has no video prompt");
    // Stage 11: if cancellation was requested before we submitted any prediction, stop now —
    // no Replicate call is made, the scene is reset and the reserved credits are refunded.
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
    const links = await prisma.sceneCharacter.findMany({ where: { sceneId }, include: { character: true } });
    const previous = scene.number > 1 ? await prisma.scene.findFirst({
      where: { episodeId: scene.episodeId, number: scene.number - 1 },
      select: { id: true, number: true, locationDesc: true, lastFrameUrl: true },
    }) : null;
    const episodeLoc = await prisma.episode.findUnique({ where: { id: scene.episodeId }, select: { location: { select: { id: true, name: true, imageUrl: true, imageReverse: true, imageDetail: true } } } });

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
    const built = buildScenePrompt({
      scene,
      characters: links.map(l => ({ characterId: l.characterId, name: l.character.name, tier: l.character.tier, imageFront: l.character.imageFront })),
      location: episodeLoc?.location ?? null,
      previous,
      provider: params.provider,
      resolvedDialogueEn: dialogueEn,
    });
    let prompt = built.prompt;
    const basePrompt = built.basePrompt;
    const fallbackRefs = built.fallbackRefs;
    const image = built.image;
    let referenceImages = built.referenceImages;
    let retryRefs = built.retryRefs;
    let reference = built.reference;

    if (built.newSceneReference) {
      // One new scene composition (no chain, no references): generate an original still (Flux) and
      // substitute its real URL. The prompt text — including the [Image1] note — already comes from
      // the pure builder, so the submitted prompt stays byte-identical to the preview.
      const referencePrompt = built.referencePrompt!;
      const attempt: GenerationAttempt = {
        jobId, sceneId, attempt: 1, model: "black-forest-labs/flux-1.1-pro", phase: "reference",
        status: "submitting", style: VISUAL_STYLE_ID,
        input: safeDiagnosticInput({ prompt: referencePrompt, aspect_ratio: "9:16", safety_tolerance: 2, source: "original_scene_description" }),
      };
      diagnostics.push(attempt); await persist(); logAttempt(attempt);
      attempt.predictionId = await startImagePrediction({ prompt: referencePrompt, aspect_ratio: "9:16" });
      attempt.status = "processing"; await persist(); logAttempt(attempt);
      const started = Date.now();
      let referenceUrl = "";
      while (!referenceUrl) {
        const prediction = await getPredictionState(attempt.predictionId);
        if (prediction.status === "succeeded" && prediction.url) {
          referenceUrl = prediction.url; attempt.status = "succeeded"; await persist(); logAttempt(attempt); break;
        }
        if (prediction.status === "failed" || prediction.status === "canceled") {
          attempt.status = prediction.status;
          throw new Error(prediction.error || "Reference model failed");
        }
        if (Date.now() - started > 180_000) throw new Error("Reference model timed out; no automatic resubmission");
        await heartbeatJob(jobId); await sleep(POLL_INTERVAL_MS);
      }
      const { folderPrefix } = getBucketConfig();
      // Seedream reference is PNG (keeps its C2PA content-credentials watermark on purpose).
      const key = `${folderPrefix}public/references/${projectId}/${VISUAL_STYLE_ID}/${sceneId}-${jobId}.png`;
      const stored = await uploadRemoteToS3(referenceUrl, key, "image/png");
      referenceImages = [stored];
      reference = { ...reference, referencePredictionId: attempt.predictionId };
      retryRefs = [{ url: stored, kind: "scene", note: built.newSceneReferenceNote! }];
    }
    // One paid video attempt. Copyright, general moderation, E003 and timeout remain distinct;
    // none silently trigger another generation or switch the audio off.
    // Both providers are Seedance (native audio); Seedance 2.0 is a different Replicate slug
    // and renders at most 15 s per clip (2.5 goes up to 30 s).
    const provider = normalizeVideoModel(params.provider);
    const modelSlug = videoModelSlug(provider);
    let predictionId: string;
    let attempt: GenerationAttempt;
    let submitMessage: string;
    // Extra state persisted alongside the prediction (moderation auto-recovery).
    const pipelineExtra: Partial<VideoJobState> = {};

    // Seedance 2.0 caps at 15 s per clip; 2.5 keeps the planned duration (already ≤30 s upstream).
    const clipDuration = provider === "seedance-2.0"
      ? Math.min(15, Number(params.duration ?? 5))
      : Number(params.duration ?? 5);
    const input = {
      prompt, model: modelSlug, duration: clipDuration, resolution: String(params.resolution ?? "480p"),
      aspect_ratio: image ? "adaptive" : "9:16", generate_audio: true, watermark: false,
    };
    attempt = {
      jobId, sceneId, attempt: 1, model: modelSlug, phase: "video", status: "submitting",
      style: VISUAL_STYLE_ID, language: scene.language || "en", input: safeDiagnosticInput({ ...input, reference }),
    };
    diagnostics.push(attempt); await persist(); logAttempt(attempt);
    predictionId = await startVideoPrediction({ ...input, ...(image ? { image } : { reference_images: referenceImages }) });
    submitMessage = "Submitted to Seedance; checking the same prediction...";
    // Retry plan is still persisted for diagnostics, but moderation is now fail-fast:
    // no automatic rewrite/resubmit happens (see resumeVideoJob). The user edits the prompt manually.
    pipelineExtra.retry = {
      basePrompt, model: modelSlug, duration: input.duration, resolution: input.resolution, image, refs: retryRefs, fallbackRefs,
    };
    pipelineExtra.moderationRetries = 0;
    attempt.predictionId = predictionId; attempt.status = "processing";
    state = { predictionId, sceneId, projectId, userId, cost, startedAt: Date.now(), diagnostics, ...pipelineExtra };
    // This checkpoint MUST succeed: never swallow the prediction ID write.
    await prisma.generationJob.update({ where: { id: jobId }, data: {
      resultData: JSON.stringify(state), message: submitMessage,
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
  // Publish scene and completed job together. A stale lease holder cannot publish or refund.
  await prisma.$transaction(async tx => {
    const result = await tx.generationJob.updateMany({ where: owned(jobId, state), data: {
      status: "completed", progress: 100, message: "Video ready", error: null,
      resultData: JSON.stringify({ ...state, leaseUntil: 0, finalizing: false, videoUrl }),
    } });
    if (!result.count) return;
    await tx.scene.update({ where: { id: state.sceneId }, data: {
      videoUrl, audioUrl: null, status: "generated", lastFrameUrl, subtitled: false,
      // Persist the model that actually succeeded (set only when the auto-fallback switched models).
      ...(state.videoModel ? { videoModel: state.videoModel } : {}),
    } });
  });
}

/** Status transition and refund are atomic and happen only once. */
async function handleFailure(jobId: string, ctx: { sceneId: string; userId?: string; cost?: number }, error: unknown, state?: VideoJobState) {
  const kind = classifyProviderError(error);
  let message = `[${kind}] ${safeProviderError(error)}`;
  if (kind === "moderation") {
    // Shown verbatim in the UI (job.error). Tell the user what to change instead of the raw provider code.
    const scene = await prisma.scene.findUnique({ where: { id: ctx.sceneId }, select: { videoPrompt: true, dialogueEn: true, dialogue: true, action: true } }).catch(() => null);
    const hints = moderationHints([scene?.videoPrompt, scene?.action, scene?.dialogueEn, scene?.dialogue].filter(Boolean).join("\n"));
    // Fail-fast: no automatic rewrite. Tell the user to edit the prompt manually and retry.
    message = `[moderation] Сцена не прошла модерацию провайдера. Отредактируйте промпт вручную: скопируйте его кнопкой «Копировать промпт», исправьте и запустите генерацию заново.` +
      (hints.length ? ` Вероятные триггеры: ${hints.map(h => `«${h}»`).join(", ")}.` : "") +
      ` Код провайдера: ${safeProviderError(error)}`;
  }
  console.error("[video-job] failed:", { jobId, sceneId: ctx.sceneId, error: message });
  await prisma.$transaction(async tx => {
    const result = await tx.generationJob.updateMany({
      where: state ? owned(jobId, state) : { id: jobId, status: { in: ["pending", "processing"] } },
      data: { status: "failed", error: message, message: "Failed", ...(state ? { resultData: JSON.stringify({ ...state, leaseUntil: 0 }) } : {}) },
    });
    if (!result.count) return;
    await tx.scene.update({ where: { id: ctx.sceneId }, data: { status: "pending" } });
    if (ctx.userId && Number(ctx.cost) > 0) {
      await tx.user.update({ where: { id: ctx.userId }, data: { credits: { increment: Number(ctx.cost) } } });
      await tx.creditTransaction.create({ data: { userId: ctx.userId, amount: Number(ctx.cost), description: `Refund: video generation failed (${jobId})` } });
    }
  });
}

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
    let prediction = await getPredictionState(state.predictionId);
    // Deadline only applies to NON-terminal predictions. Late success still gets saved.
    if (["starting", "processing"].includes(prediction.status) && Date.now() - state.startedAt >= VIDEO_DEADLINE_MS) {
      await cancelVideoPrediction(state.predictionId);
      prediction = await getPredictionState(state.predictionId);
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
    if (prediction.status === "succeeded" && prediction.url) {
      state.finalizing = true;
      state.finalizeAttempts = (state.finalizeAttempts ?? 0) + 1;
      if (state.finalizeAttempts > 3) {
        await handleFailure(job.id, state, new Error("Storage finalization failed after three recovery attempts"), state);
        return true;
      }
      state.leaseUntil = Date.now() + FINALIZE_LEASE_MS;
      if (!await saveOwned(job.id, state, { progress: 60, message: "Video ready. Uploading to storage..." })) return false;
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
    await saveOwned(job.id, state, { progress: waitingProgress(state.startedAt), message: prediction.status === "starting" ? "Queued at Seedance; checking the same prediction..." : "Seedance is processing; waiting for the result..." });
    return true;
  } catch (error) {
    // A failed status GET is NOT a failed generation. Leave it recoverable, without a refund.
    state.leaseUntil = 0;
    await saveOwned(job.id, state, { message: "Provider status temporarily unavailable; checking again", error: safeProviderError(error) });
    return true;
  }
}
