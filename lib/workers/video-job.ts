import { prisma } from "@/lib/db";
import { startVideoPrediction, getPredictionState } from "@/lib/replicate";
import { buildNativeAudioPrompt, translateDialogue, detectSpokenLanguage, languageName } from "@/lib/voiceover";
import { uploadRemoteToS3, uploadBufferToS3 } from "@/lib/s3-upload";
import { extractLastFrameBuffer } from "@/lib/ffmpeg";
import { getBucketConfig } from "@/lib/aws-config";
import { sanitizeVideoPrompt } from "@/lib/sanitize-prompt";
import { updateJob, completeJob, failJob, heartbeatJob, runInBackground } from "@/lib/jobs";

/**
 * Always use Seedance native audio: characters speak and ambient sound is baked into the clip.
 * Attempts 1–2: generate_audio=true (voices in-clip).
 * Attempt 3 (last retry): generate_audio=false as a silent fallback in case audio triggers the
 * copyright filter — a silent-but-valid clip is better than a hard failure.
 */
const NATIVE_AUDIO = true;

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
  /** set once finalization (TTS + upload) has begun, to avoid running it twice */
  finalizing?: boolean;
}

const POLL_INTERVAL_MS = 8_000;
/** Typical Seedance time — only used to animate the progress bar while waiting. */
const EXPECTED_VIDEO_MS = Number(process.env.SEEDANCE_EXPECTED_MS ?? 5 * 60 * 1000);
/** Hard cap for waiting on Replicate. */
const MAX_WAIT_MS = Number(process.env.SEEDANCE_MAX_WAIT_MS ?? 12 * 60 * 1000);

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

  try {
    const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
    if (!scene?.videoPrompt) throw new Error("Scene has no video prompt");

    await updateJob(jobId, {
      status: "processing",
      progress: 5,
      message: "Generating video with Seedance native audio (this takes ~3-5 min)...",
    });

    // In native-audio mode, embed the spoken dialogue into the prompt so the
    // characters actually speak on camera (lip-synced) with diegetic ambient sound.
    let prompt = scene.videoPrompt;
    const links = await prisma.sceneCharacter.findMany({ where: { sceneId }, include: { character: true } });
    if (NATIVE_AUDIO) {
      // Per-scene spoken language chosen in the UI ("en" default / "ru").
      const targetLangName = languageName((scene as any).language) || "English";
      // Speak the dialogue in the selected language — translate it if it isn't already.
      let dialogue = scene.dialogue;
      if (dialogue && detectSpokenLanguage(dialogue) !== targetLangName) {
        dialogue = await translateDialogue(dialogue, targetLangName);
      }
      prompt = buildNativeAudioPrompt(scene.videoPrompt, dialogue, links.map((l) => l.character), targetLangName);
    }

    // Strip anything that trips the model's copyright filter (real people, brands, films,
    // "in the style of …"). The ORIGINAL videoPrompt stays untouched in the DB; only the
    // text sent to the model is rewritten. Project character names are never rewritten.
    const sanitized = sanitizeVideoPrompt(prompt, { keep: links.map((l) => l.character.name) });
    if (sanitized.changed) {
      console.warn(`[video-job] scene ${sceneId}: sanitized prompt —`, sanitized.changes.join(" | "));
    }
    prompt = sanitized.prompt;

    // Steer the model away from anything its output-moderation flags as copyrighted.
    const basePrompt = withCopyrightSafety(prompt);

    // ── One-take frame-chaining ────────────────────────────────────────────────
    // Feed the LAST FRAME of the previous scene as the FIRST FRAME of this one, so the
    // clip literally starts where the last one ended and the episode reads as a single
    // continuous take instead of separate shots glued together.
    let chainImage: string | undefined;
    if (scene.number > 1) {
      const prev = await prisma.scene.findFirst({
        where: { episodeId: scene.episodeId, number: { lt: scene.number }, lastFrameUrl: { not: null } },
        orderBy: { number: "desc" },
        select: { lastFrameUrl: true, number: true },
      });
      if (prev?.lastFrameUrl) {
        chainImage = prev.lastFrameUrl;
        console.log(`[video-job] scene ${scene.number}: chaining from scene ${prev.number}'s last frame`);
      }
    }

    // 1-2. Start + wait, retrying automatically if the OUTPUT is rejected by the
    // model's copyright/moderation filter (that check is partly non-deterministic —
    // a fresh generation with stronger "original content" framing usually passes).
    const MAX_ATTEMPTS = 3;
    let videoUrl = "";
    let state: VideoJobState | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Escalate the anti-copyright framing on each retry.
      const attemptPrompt = attempt === 1 ? basePrompt : withCopyrightSafety(prompt, attempt);
      // The filter judges the OUTPUT (video + generated soundtrack), not the prompt. A clip
      // with fully generic visuals can still be rejected because the model's improvised
      // score/ambience resembles existing music. On the last attempt drop generated audio
      // so a silent-but-valid clip beats a hard failure (audio can be re-added later).
      const silentFallback = attempt === MAX_ATTEMPTS;
      if (silentFallback) {
        await updateJob(jobId, { message: "Final attempt: generating without model audio (copyright-safe)..." });
      }
      const predictionId = await startVideoPrediction({
        prompt: attemptPrompt,
        duration: Number(params.duration ?? 5),
        resolution: String(params.resolution ?? "480p"),
        aspect_ratio: "9:16",
        generate_audio: !silentFallback, // Seedance native speech+ambience; last retry drops audio to avoid copyright filter
        watermark: false,
        ...(chainImage ? { image: chainImage } : {}), // one-take continuity: start from previous scene's last frame
      });
      state = { predictionId, sceneId, projectId, userId, cost, startedAt: Date.now() };
      await updateJob(jobId, { resultData: JSON.stringify(state) });

      try {
        videoUrl = await waitForPrediction(jobId, state);
        break; // success
      } catch (err: any) {
        const last = attempt >= MAX_ATTEMPTS;
        if (isCopyrightError(err) && !last) {
          await updateJob(jobId, {
            progress: 5,
            message: `Output flagged by copyright filter — retrying with adjusted prompt (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`,
          });
          continue;
        }
        // Not a copyright issue, or we're out of retries → surface a clear message.
        throw isCopyrightError(err)
          ? new Error(
              "The video model's copyright filter blocked the result after several attempts. " +
                "Try rephrasing the scene prompt to avoid references to real people, brands, logos or well-known films/characters."
            )
          : err;
      }
    }

    // 3. Finalize
    await finalizeVideoJob(jobId, state!, videoUrl);
  } catch (err: any) {
    await handleFailure(jobId, { sceneId, userId, cost }, err);
  }
}

/** Does this error come from the model's copyright / content-moderation filter? */
function isCopyrightError(err: any): boolean {
  const m = String(err?.message ?? err ?? "").toLowerCase();
  return (
    m.includes("copyright") ||
    m.includes("content policy") ||
    m.includes("moderation") ||
    m.includes("flagged") ||
    m.includes("sensitive")
  );
}

/**
 * Prefix the prompt with an "original content" declaration so the model's output-filter
 * sees it before any scene description. On retries: escalate the declaration AND strip
 * cinematic style vocabulary that pushes the model toward copyrighted visual styles.
 *
 * Bracket semantics (Seedance 2.5): {text} = speech, (text) = music cue.
 * Round brackets are intentionally absent from all prompt text so no music is generated.
 */
function withCopyrightSafety(prompt: string, attempt = 1): string {
  const ORIGINAL =
    "Entirely original, non-copyrighted fictional content. " +
    "No real people, no celebrity likenesses, no brand names or logos, " +
    "no copyrighted or recognizable franchise characters, no trademarks, no watermarks, " +
    "no on-screen text. Generic everyday appearance and neutral setting. " +
    "NO background music. NO score. NO soundtrack. Dialogue and ambient sound only.";
  const extra =
    attempt > 1
      ? " Nothing resembling any existing film, show, game, music video or public figure."
      : "";
  const safePrompt = attempt > 1 ? stripStyleReferences(prompt) : prompt;
  return `[ORIGINAL CONTENT: ${ORIGINAL}${extra}]\n${safePrompt}`;
}

/** Remove cinematic style vocabulary that steers the model toward copyrighted visual/audio styles. */
function stripStyleReferences(prompt: string): string {
  return prompt
    .replace(/\b(?:cinematic(?:ally)?|film[- ]?like|movie[- ]?like)\b/gi, "")
    .replace(/\bfilm\s+noir\b/gi, "high-contrast shadows")
    .replace(/\bnoir(?:\s+(?:style|aesthetic|look|vibe|mood|atmosphere|tone))?\b/gi, "shadowy")
    .replace(/\b(?:blockbuster|oscar[- ]?(?:worthy|winning|caliber)|award[- ]?winning|iconic)\b/gi, "")
    .replace(/\b(?:dramatic|haunting|tense|moody|soaring|swelling|building|rising|melancholic)\s+(?:score|music|soundtrack|melody|theme)\b/gi, "ambient sound")
    .replace(/\b(?:film|movie|cinematic|orchestral|symphonic|sweeping|lush|epic)\s+(?:score|soundtrack)\b/gi, "ambient sound")
    .replace(/\bscore\s+(?:builds?|swells?|rises?|soars?|crescendos?)\b/gi, "tension builds")
    .replace(/\bchiaroscuro\b/gi, "strong directional lighting")
    .replace(/\b(?:v[eé]rit[eé]|cinema\s+v[eé]rit[eé])\b/gi, "observational")
    .replace(/\s{2,}/g, " ")
    .replace(/,\s*,/g, ",")
    .trim();
}

/** Poll Replicate until the prediction settles; heartbeats the job on every tick. */
async function waitForPrediction(jobId: string, state: VideoJobState): Promise<string> {
  while (true) {
    const p = await getPredictionState(state.predictionId);
    if (p.status === "succeeded" && p.url) return p.url;
    if (p.status === "failed" || p.status === "canceled") throw new Error(p.error || "Video model failed");
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
  const baseKey = `${folderPrefix}public/videos/${projectId}/${scene.episodeId}/scene-${scene.number}-${Date.now()}`;
  const videoUrl = await uploadRemoteToS3(replicateVideoUrl, `${baseKey}.mp4`, "video/mp4");

  await updateJob(jobId, { progress: 95, message: "Saving scene..." });

  const updated = await prisma.scene.update({
    where: { id: sceneId },
    data: { videoUrl, audioUrl: null, status: "generated" },
  });

  // One-take frame-chaining: capture this scene's LAST FRAME so the NEXT scene can start
  // from it. Best-effort — never fail the job over a thumbnail.
  try {
    const frame = await extractLastFrameBuffer(videoUrl);
    const lastFrameUrl = await uploadBufferToS3(frame, `${baseKey}-lastframe.jpg`, "image/jpeg");
    await prisma.scene.update({ where: { id: sceneId }, data: { lastFrameUrl } });
    console.log(`[video-job] scene ${scene.number}: stored last frame for chaining`);
  } catch (frameErr: any) {
    console.warn("[video-job] last-frame extraction failed (non-fatal):", frameErr?.message ?? frameErr);
  }

  await completeJob(jobId, { videoUrl, scene: updated }, "Video ready");
}

async function handleFailure(
  jobId: string,
  ctx: { sceneId: string; userId?: string; cost?: number },
  err: any
): Promise<void> {
  console.error("[video-job] failed:", err);
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
  await failJob(jobId, err?.message ?? "Video generation failed");
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
      // Finalization died (TTS/upload). It's cheap to redo — restart it.
      const p = await getPredictionState(state.predictionId);
      if (p.status === "succeeded" && p.url) {
        await heartbeatJob(job.id);
        runInBackground(() => finalizeVideoJob(job.id, state, p.url!).catch((e) => handleFailure(job.id, state, e)));
        return true;
      }
    }

    const p = await getPredictionState(state.predictionId);
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
      await handleFailure(job.id, state, new Error("Video model timed out"));
      return true;
    }
    // Still rendering — keep the job alive from the poller side
    await updateJob(job.id, { progress: waitingProgress(state.startedAt) });
    await heartbeatJob(job.id);
    return true;
  } catch (e) {
    console.error("[video-job] resume error:", e);
    return false;
  }
}
