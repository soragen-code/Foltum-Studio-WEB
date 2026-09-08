import { prisma } from "@/lib/db";
import { startVideoPrediction, startImagePrediction, getPredictionState } from "@/lib/replicate";
import { buildNativeAudioPrompt, translateDialogue, detectSpokenLanguage, languageName } from "@/lib/voiceover";
import { uploadRemoteToS3, uploadBufferToS3 } from "@/lib/s3-upload";
import { extractLastFrameBuffer } from "@/lib/ffmpeg";
import { getBucketConfig } from "@/lib/aws-config";
import { VISUAL_STYLE_ID, styledVisualPrompt, isStyledAsset, canChainFrame } from "@/lib/visual-style";
import { GenerationAttempt, safeProviderError, classifyProviderError, logAttempt, safeDiagnosticInput } from "@/lib/generation-diagnostics";
import { updateJob, completeJob, failJob, heartbeatJob, runInBackground } from "@/lib/jobs";

export interface VideoJobParams {
  jobId: string;
  sceneId: string;
  projectId: string;
  userId?: string;
  cost?: number;
  duration?: number;
  resolution?: string;
}

/** Persisted in GenerationJob.resultData while the job is running, so it can be resumed. */
interface VideoJobState {
  predictionId: string;
  sceneId: string;
  projectId: string;
  userId?: string;
  cost?: number;
  startedAt: number;
  diagnostics?: GenerationAttempt[];
  /** set once finalization (upload) has begun, to avoid running it twice */
  finalizing?: boolean;
}

const POLL_INTERVAL_MS = 8_000;
/** Typical Seedance time — only used to animate the progress bar while waiting. */
const EXPECTED_VIDEO_MS = Number(process.env.SEEDANCE_EXPECTED_MS ?? 5 * 60 * 1000);
/** Hard cap for waiting on Replicate. */
const MAX_WAIT_MS = Math.min(Number(process.env.SEEDANCE_MAX_WAIT_MS ?? 9 * 60 * 1000), 9 * 60 * 1000);

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
 * 2. Poll Replicate, heart-beating the job (progress 5→55) so it is never marked stale
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
    await updateJob(jobId, { status: "processing", progress: 5, message: "Preparing softly stylized visual references..." });
    const links = await prisma.sceneCharacter.findMany({ where: { sceneId }, include: { character: true } });
    const visualPrompt = styledVisualPrompt(scene.videoPrompt, links.map(l => l.character.name));
    const targetLanguage = languageName(scene.language) || "English";
    let dialogue = scene.dialogue;
    if (dialogue && detectSpokenLanguage(dialogue) !== targetLanguage) {
      dialogue = await translateDialogue(dialogue, targetLanguage);
    }
    // Sanitize visual descriptions BEFORE adding speech: never rewrite scripted dialogue.
    let prompt = buildNativeAudioPrompt(visualPrompt, dialogue, links.map(l => l.character), targetLanguage);

    const previous = scene.number > 1 ? await prisma.scene.findFirst({
      where: { episodeId: scene.episodeId, number: scene.number - 1 },
      select: { id: true, number: true, locationDesc: true, lastFrameUrl: true },
    }) : null;
    let image: string | undefined;
    let referenceImages: string[] = [];
    let reference: Record<string, unknown>;
    if (canChainFrame(scene, previous)) {
      image = previous!.lastFrameUrl!;
      reference = { mode: "adjacent_frame", sceneId: previous!.id };
    } else {
      const compatible = links.filter(l => isStyledAsset(l.character.imageFront));
      if (compatible.length && compatible.length === links.length) {
        referenceImages = compatible.map(l => l.character.imageFront!);
        reference = { mode: "character_references", characterIds: compatible.map(l => l.characterId) };
        prompt += "\n" + compatible.map((l, i) => `[Image${i + 1}] defines ${l.character.name}'s appearance and soft illustration treatment; use the scene's staging and camera.`).join("\n");
      } else {
        // One new scene composition, never overwrite the user's old portraits or frames.
        // This is original text-to-image design, not a way to bypass a provider refusal.
        const referencePrompt = `${visualPrompt}\nSingle still establishing the described scene with the same characters, clothing and setting. No text or subtitles.`;
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
        const key = `${folderPrefix}public/references/${projectId}/${VISUAL_STYLE_ID}/${sceneId}-${jobId}.webp`;
        const stored = await uploadRemoteToS3(referenceUrl, key, "image/webp");
        referenceImages = [stored];
        reference = { mode: "new_scene_reference", sceneId, referencePredictionId: attempt.predictionId };
        prompt += "\n[Image1] defines the scene's original character designs, clothing, environment and soft illustration treatment. Preserve those designs while performing the scripted action.";
      }
    }
    // One paid video attempt. Copyright, general moderation, E003 and timeout remain distinct;
    // none silently trigger another generation or switch the audio off.
    const input = {
      prompt, duration: Number(params.duration ?? 5), resolution: String(params.resolution ?? "480p"),
      aspect_ratio: image ? "adaptive" : "9:16", generate_audio: true, watermark: false,
    };
    const attempt: GenerationAttempt = {
      jobId, sceneId, attempt: 1, model: "bytedance/seedance-2.5", phase: "video", status: "submitting",
      style: VISUAL_STYLE_ID, language: scene.language || "en", input: safeDiagnosticInput({ ...input, reference }),
    };
    diagnostics.push(attempt); await persist(); logAttempt(attempt);
    const predictionId = await startVideoPrediction({ ...input, ...(image ? { image } : { reference_images: referenceImages }) });
    attempt.predictionId = predictionId; attempt.status = "processing";
    state = { predictionId, sceneId, projectId, userId, cost, startedAt: Date.now(), diagnostics };
    await persist(); logAttempt(attempt);
    await updateJob(jobId, { message: "Generating softly stylized video with dialogue and ambience..." });
    const videoUrl = await waitForPrediction(jobId, state);
    await finalizeVideoJob(jobId, state, videoUrl);
  } catch (err: unknown) {
    const attempt = diagnostics[diagnostics.length - 1];
    if (attempt && attempt.status !== "succeeded") {
      attempt.error = safeProviderError(err); attempt.errorKind = classifyProviderError(err);
      if (attempt.status !== "failed" && attempt.status !== "canceled") attempt.status = attempt.errorKind === "timeout" ? "timeout" : "failed";
      logAttempt(attempt);
    }
    await persist();
    await handleFailure(jobId, { sceneId, userId, cost }, err);
  }
}

/** Keep diagnostics across provider completion, worker resumption and upload. */
async function recordPredictionStatus(jobId: string, state: VideoJobState, status: string, error?: string) {
  const attempt = state.diagnostics?.find(a => a.predictionId === state.predictionId);
  if (attempt) {
    attempt.status = status;
    if (error) { attempt.error = safeProviderError(error); attempt.errorKind = classifyProviderError(error); }
    await updateJob(jobId, { resultData: JSON.stringify(state) });
    logAttempt(attempt);
  }
}

/** Poll Replicate until the prediction settles; heartbeats the job on every tick. */
async function waitForPrediction(jobId: string, state: VideoJobState): Promise<string> {
  while (true) {
    const p = await getPredictionState(state.predictionId);
    if (p.status === "succeeded" && p.url) {
      await recordPredictionStatus(jobId, state, p.status);
      return p.url;
    }
    if (p.status === "failed" || p.status === "canceled") {
      await recordPredictionStatus(jobId, state, p.status, p.error);
      throw new Error(p.error || "Video model failed");
    }
    if (Date.now() - state.startedAt > MAX_WAIT_MS) throw new Error("Video model timed out");

    await updateJob(jobId, { progress: waitingProgress(state.startedAt) });
    await heartbeatJob(jobId);
    await sleep(POLL_INTERVAL_MS);
  }
}

/** Upload + scene update. Idempotent guard via state.finalizing. */
async function finalizeVideoJob(jobId: string, state: VideoJobState, replicateVideoUrl: string): Promise<void> {
  const { sceneId, projectId } = state;
  await updateJob(jobId, {
    progress: 60,
    message: "Video ready. Uploading to storage...",
    resultData: JSON.stringify({ ...state, finalizing: true }),
  });

  const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
  if (!scene) throw new Error("Scene not found");

  // Speech and ambient sound are baked into the Seedance clip — no external audio overlay.
  await updateJob(jobId, { progress: 80, message: "Uploading to storage..." });

  const { folderPrefix } = getBucketConfig();
  const baseKey = `${folderPrefix}public/videos/${projectId}/${scene.episodeId}/${VISUAL_STYLE_ID}/scene-${scene.number}-${Date.now()}`;
  const videoUrl = await uploadRemoteToS3(replicateVideoUrl, `${baseKey}.mp4`, "video/mp4");

  await updateJob(jobId, { progress: 95, message: "Saving scene..." });

  const updated = await prisma.scene.update({
    where: { id: sceneId },
    data: { videoUrl, audioUrl: null, status: "generated", lastFrameUrl: null },
  });

  // One-take frame-chaining: capture this scene's LAST FRAME so the NEXT scene can start
  // from it. Best-effort — never fail the job over a thumbnail.
  try {
    const frame = await extractLastFrameBuffer(videoUrl);
    const lastFrameUrl = await uploadBufferToS3(frame, `${baseKey}-lastframe.jpg`, "image/jpeg");
    await prisma.scene.update({ where: { id: sceneId }, data: { lastFrameUrl } });
    console.log(`[video-job] scene ${scene.number}: stored last frame for chaining`);
  } catch (frameErr: any) {
    console.warn("[video-job] last-frame extraction failed (non-fatal):", safeProviderError(frameErr));
  }

  await completeJob(jobId, { ...state, finalizing: false, videoUrl, scene: updated }, "Video ready");
}

async function handleFailure(
  jobId: string,
  ctx: { sceneId: string; userId?: string; cost?: number },
  err: any
): Promise<void> {
  console.error("[video-job] failed:", { jobId, sceneId: ctx.sceneId, kind: classifyProviderError(err), error: safeProviderError(err) });
  const cost = Number(ctx.cost ?? 0);
  try {
    await prisma.scene.update({ where: { id: ctx.sceneId }, data: { status: "pending" } });
  } catch {}
  try {
    if (ctx.userId && cost > 0) {
      await prisma.user.update({ where: { id: ctx.userId }, data: { credits: { increment: cost } } });
      await prisma.creditTransaction.create({
        data: { userId: ctx.userId, amount: cost, description: "Refund: video generation failed" },
      });
    }
  } catch {}
  await failJob(jobId, `[${classifyProviderError(err)}] ${safeProviderError(err)}`);
}

/**
 * Called from the polling endpoint for a "processing" video job whose function may have died.
 * Returns true if the job was touched (resumed / heart-beaten / failed) — i.e. the caller
 * should re-read it — or false if there is nothing to resume.
 */
export async function resumeVideoJob(job: {
  id: string;
  type: string;
  status: string;
  resultData: string | null;
  updatedAt: Date;
}): Promise<boolean> {
  if (job.type !== "video" || job.status !== "processing") return false;
  const state = parseState(job.resultData);
  if (!state) return false;

  // Only step in when the worker has gone quiet (no heartbeat for > 1 poll interval x3)
  if (Date.now() - job.updatedAt.getTime() < POLL_INTERVAL_MS * 3) return false;

  try {
    if (state.finalizing) {
      // Finalization died (upload). It's cheap to redo — restart it.
      const p = await getPredictionState(state.predictionId);
      if (["succeeded", "failed", "canceled"].includes(p.status)) await recordPredictionStatus(job.id, state, p.status, p.error);
      if (p.status === "succeeded" && p.url) {
        await heartbeatJob(job.id);
        runInBackground(() => finalizeVideoJob(job.id, state, p.url!).catch((e) => handleFailure(job.id, state, e)));
        return true;
      }
    }

    const p = await getPredictionState(state.predictionId);
    if (["succeeded", "failed", "canceled"].includes(p.status)) await recordPredictionStatus(job.id, state, p.status, p.error);
    if (p.status === "succeeded" && p.url) {
      await heartbeatJob(job.id);
      runInBackground(() => finalizeVideoJob(job.id, state, p.url!).catch((e) => handleFailure(job.id, state, e)));
      return true;
    }
    if (p.status === "failed" || p.status === "canceled") {
      await handleFailure(job.id, state, new Error(p.error || "Video model failed"));
      return true;
    }
    if (Date.now() - state.startedAt > MAX_WAIT_MS) {
      await recordPredictionStatus(job.id, state, "timeout", "Video model timed out");
      await handleFailure(job.id, state, new Error("Video model timed out"));
      return true;
    }
    // Still rendering — keep the job alive from the poller side
    await updateJob(job.id, { progress: waitingProgress(state.startedAt) });
    await heartbeatJob(job.id);
    return true;
  } catch (e) {
    console.error("[video-job] resume error:", safeProviderError(e));
    return false;
  }
}
