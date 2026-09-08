import { prisma } from "@/lib/db";
import { startVideoPrediction, getPredictionState } from "@/lib/replicate";
import { renderSceneVoiceover, buildNativeAudioPrompt, translateDialogue, detectSpokenLanguage, languageName } from "@/lib/voiceover";
import { uploadRemoteToS3, uploadBufferToS3 } from "@/lib/s3-upload";
import { extractLastFrameBuffer } from "@/lib/ffmpeg";
import { getBucketConfig } from "@/lib/aws-config";
import { sanitizeVideoPrompt } from "@/lib/sanitize-prompt";
import { updateJob, completeJob, failJob, heartbeatJob, runInBackground } from "@/lib/jobs";

/**
 * DEFAULT is FALSE: the video model generates SILENT clips (generate_audio:false) and the
 * dialogue is a separate ElevenLabs voiceover laid on top. This is deliberate — Seedance's
 * copyright/moderation filter is most often tripped by the model's IMPROVISED SOUNDTRACK, not
 * the visuals, so dropping generated audio removes almost all copyright blocks and the wasted
 * retries → generation succeeds first time and is much faster.
 * Set NATIVE_SCENE_AUDIO=true to re-enable in-clip native voices (legacy, block-prone).
 */
const NATIVE_AUDIO = (process.env.NATIVE_SCENE_AUDIO ?? "false").toLowerCase() === "true";

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
 * 1. Start Seedance prediction (silent — generate_audio: false), persist predictionId
 * 2. Poll Replicate, heart-beating the job (progress 5→55) so it is never marked stale
 * 3. finalize(): human voiceover via ElevenLabs (60%) → S3 upload (80%) → Scene update (95%) → completed
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
      message: NATIVE_AUDIO
        ? "Generating cinematic video with in-scene voices (this takes ~3-5 min)..."
        : "Generating video with Seedance (this takes ~3-5 min)...",
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
      const silentFallback = NATIVE_AUDIO && attempt === MAX_ATTEMPTS;
      if (silentFallback) {
        await updateJob(jobId, { message: "Final attempt: generating without model audio (copyright-safe)..." });
      }
      const predictionId = await startVideoPrediction({
        prompt: attemptPrompt,
        duration: Number(params.duration ?? 5),
        resolution: String(params.resolution ?? "480p"),
        aspect_ratio: "9:16",
        generate_audio: NATIVE_AUDIO && !silentFallback, // characters speak in-clip; legacy path adds ElevenLabs later
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

/** Append an "original, non-infringing content" instruction that steers the model
 *  away from outputs its filter would flag. Stronger wording on retries. */
function withCopyrightSafety(prompt: string, attempt = 1): string {
  const base =
    "All characters, settings and elements are entirely original and fictional. " +
    "No real people, no celebrity likenesses, no brand names, no logos, no trademarks, " +
    "no copyrighted or well-known franchise characters, and no on-screen text or watermarks.";
  const strong =
    attempt > 1
      ? " Generic, everyday appearance and wardrobe; a neutral, non-branded environment; " +
        "nothing resembling any existing film, show, game or public figure."
      : "";
  return `${prompt}\n\n[Content: ${base}${strong}]`;
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

/** TTS + upload + scene update. Idempotent guard via state.finalizing. */
async function finalizeVideoJob(jobId: string, state: VideoJobState, replicateVideoUrl: string): Promise<void> {
  const { sceneId, projectId } = state;
  await updateJob(jobId, {
    progress: 60,
    message: NATIVE_AUDIO ? "Video ready. Finalizing..." : "Video ready. Recording voiceover...",
    resultData: JSON.stringify({ ...state, finalizing: true }),
  });

  const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
  if (!scene) throw new Error("Scene not found");

  // Native-audio mode: speech + ambience are already baked into the clip — no overlay.
  // Legacy mode: render per-character ElevenLabs voiceover (labels/directions never read aloud).
  let audioBuffer: Buffer | null = null;
  if (!NATIVE_AUDIO && (scene.dialogue ?? "").trim()) {
    try {
      const links = await prisma.sceneCharacter.findMany({ where: { sceneId }, include: { character: true } });
      audioBuffer = await renderSceneVoiceover(scene.dialogue, links.map((l) => l.character));
    } catch (ttsErr: any) {
      console.error("[video-job] ElevenLabs failed (video kept without audio):", ttsErr?.message ?? ttsErr);
    }
  }
  await updateJob(jobId, { progress: 80, message: "Uploading to storage..." });

  const { folderPrefix } = getBucketConfig();
  const baseKey = `${folderPrefix}public/videos/${projectId}/${scene.episodeId}/scene-${scene.number}-${Date.now()}`;
  const videoUrl = await uploadRemoteToS3(replicateVideoUrl, `${baseKey}.mp4`, "video/mp4");
  let audioUrl: string | null = null;
  if (audioBuffer) {
    try {
      audioUrl = await uploadBufferToS3(audioBuffer, `${baseKey}.mp3`, "audio/mpeg");
    } catch (upErr: any) {
      console.error("[video-job] audio upload failed:", upErr?.message ?? upErr);
    }
  }
  await updateJob(jobId, { progress: 95, message: "Saving scene..." });

  const updated = await prisma.scene.update({
    where: { id: sceneId },
    data: { videoUrl, audioUrl, status: "generated" },
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

  await completeJob(jobId, { videoUrl, audioUrl, scene: updated }, "Video ready");
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
