import Replicate from "replicate";
import { GenerationAttempt, safeDiagnosticInput, safeProviderError, classifyProviderError, logAttempt } from "@/lib/generation-diagnostics";
import { VISUAL_STYLE_ID } from "@/lib/visual-style";

let _client: Replicate | null = null;

export function getReplicate(): Replicate {
  if (!_client) {
    const auth = process.env.REPLICATE_API_TOKEN;
    if (!auth) throw new Error("REPLICATE_API_TOKEN is not set");
    _client = new Replicate({ auth });
  }
  return _client;
}

/** Small helper: pause for ms milliseconds */
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** Extract a URL string from various Replicate output shapes */
function extractUrl(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output) && output.length > 0) return String(output[0]);
  if (output && typeof (output as any).url === "function") return String((output as any).url());
  if (output && typeof output === "object" && "url" in (output as any)) return String((output as any).url);
  throw new Error("Cannot extract URL from Replicate output: " + JSON.stringify(output).slice(0, 200));
}

/* ------------------------------------------------------------------ */
/*  Seedance 2.5 — video generation (synchronized native audio)        */
/*  Single model: "bytedance/seedance-2.5" — up to 30s per clip.       */
/* ------------------------------------------------------------------ */

/** Default Seedance Replicate slug when a caller does not specify `model`. */
export const SEEDANCE_MODEL = "bytedance/seedance-2.5";

export interface SeedanceInput {
  prompt: string;
  /** Replicate model slug (always "bytedance/seedance-2.5"). */
  model?: string;
  /** Duration in seconds, 1-30 or -1 for auto. Default 5. */
  duration?: number;
  /** "480p" | "720p". Default "720p". */
  resolution?: string;
  /** "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9" | "adaptive" */
  aspect_ratio?: string;
  /** Generate synchronized audio. Default true. */
  generate_audio?: boolean;
  /**
   * Character / location / style references (up to 30), referenced in the prompt as [Image1]…[ImageN].
   * Stage 36: the only image input the app uses — the first-frame `image` mode was removed because
   * the provider forbids combining it with reference images.
   */
  reference_images?: string[];
  /** Add watermark. Default false. */
  watermark?: boolean;
  seed?: number;
}

/**
 * Generate a video using Seedance 2.5 on Replicate (reference-image mode).
 * Returns the URL of the generated mp4 video.
 */
export async function generateVideo(input: SeedanceInput): Promise<string> {
  const replicate = getReplicate();
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const output = await replicate.run((input.model ?? SEEDANCE_MODEL) as `${string}/${string}`, {
        input: {
          prompt: input.prompt,
          duration: input.duration ?? 5,
          resolution: input.resolution ?? "720p",
          aspect_ratio: input.aspect_ratio ?? "9:16",
          generate_audio: true,
          watermark: input.watermark ?? false,
          output_format: "mp4",
          // Stage 40: omitted entirely for text-only submissions (an empty array is never sent).
          ...(input.reference_images?.length ? { reference_images: input.reference_images } : {}),
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
        },
      });
      return extractUrl(output);
    } catch (err: any) {
      const is429 = err?.message?.includes("429") || err?.response?.status === 429;
      if (is429 && attempt < maxRetries) {
        const delay = (attempt + 1) * 15_000;
        console.log(`Seedance rate-limited, retry ${attempt + 1}/${maxRetries} in ${delay / 1000}s`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw new Error("generateVideo: exhausted retries");
}

/** Build the Seedance input payload (shared by run and create). */
function seedanceInput(input: SeedanceInput) {
  return {
    prompt: input.prompt,
    duration: input.duration ?? 5,
    resolution: input.resolution ?? "720p",
    aspect_ratio: input.aspect_ratio ?? "9:16",
    generate_audio: true,
    watermark: input.watermark ?? false,
    output_format: "mp4",
    // Stage 40: omitted entirely for text-only submissions (an empty array is never sent).
    ...(input.reference_images?.length ? { reference_images: input.reference_images } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  };
}

/**
 * Start a Seedance prediction WITHOUT waiting for it. Returns the prediction id,
 * so the caller can poll (and survive a serverless function restart).
 */
export async function startVideoPrediction(input: SeedanceInput): Promise<string> {
  // One submission per job. Provider/moderation refusals require review, not paid blind retries.
  const prediction = await getReplicate().predictions.create({
    model: (input.model ?? SEEDANCE_MODEL) as `${string}/${string}`,
    input: seedanceInput(input),
  });
  return prediction.id;
}

/* ------------------------------------------------------------------ */
/*  FILM — frame interpolation (seamless scene-seam bridging)          */
/*  Google FILM synthesizes REAL intermediate frames between the last   */
/*  frame of scene N and the first frame of scene N+1, so every seam    */
/*  in an assembled episode reads as one continuous motion instead of   */
/*  a hard cut. Output is a short mp4 of (2^t + 1) frames @ 30fps.      */
/* ------------------------------------------------------------------ */

/** Real Replicate slug + pinned version for Google FILM (verified via API). */
export const FILM_INTERPOLATION_MODEL = "google-research/frame-interpolation";
const FILM_INTERPOLATION_VERSION =
  (process.env.REPLICATE_FILM_VERSION as string | undefined) ??
  "4f88a16a13673a8b589c18866e540556170a5bcb2ccdc12de556e800e9456d3d";

/** Encode a frame (raw Buffer, or an already-usable URL/data-URI string) for Replicate. */
function toDataUri(frame: string | Buffer, mime = "image/jpeg"): string {
  if (typeof frame === "string") return frame;
  return `data:${mime};base64,${frame.toString("base64")}`;
}

export interface FrameInterpolationInput {
  /** First (source) frame — the LAST frame of scene N. */
  frame1: string | Buffer;
  /** Second (target) frame — the FIRST frame of scene N+1. */
  frame2: string | Buffer;
  /**
   * Interpolation depth. FILM emits 2^t + 1 frames @ 30fps.
   * Default 3 → 9 frames ≈ 0.3s bridge (7 synthesized intermediate frames).
   */
  timesToInterpolate?: number;
}

/**
 * Run Google FILM frame interpolation between two frames and return the URL of the
 * resulting short bridge mp4. Polls exactly like generateImage; ONE submission per
 * call (no paid automatic retries), 180s timeout. Callers treat any thrown error as
 * "no bridge for this seam" and fall back to a plain cut/crossfade.
 */
export async function runFrameInterpolation(input: FrameInterpolationInput): Promise<string> {
  const times = Math.max(1, Math.min(8, Math.round(input.timesToInterpolate ?? 3)));
  const prediction = await getReplicate().predictions.create({
    version: FILM_INTERPOLATION_VERSION,
    input: {
      frame1: toDataUri(input.frame1),
      frame2: toDataUri(input.frame2),
      times_to_interpolate: times,
    },
  });
  const started = Date.now();
  while (true) {
    const p = await getPredictionState(prediction.id);
    if (p.status === "succeeded" && p.url) return p.url;
    if (p.status === "failed" || p.status === "canceled") throw new Error(p.error || "FILM interpolation failed");
    if (Date.now() - started > 180_000) throw new Error("FILM interpolation timed out; no automatic resubmission");
    await sleep(2_000);
  }
}

/* ------------------------------------------------------------------ */
/*  Seedream 5.0 Lite — photorealistic reference image generation     */
/* ------------------------------------------------------------------ */

/** Real Replicate slug + pinned version for Seedream 5.0 Lite (verified via API). */
export const SEEDREAM_MODEL = "bytedance/seedream-5-lite";
const SEEDREAM_VERSION_ID =
  (process.env.REPLICATE_SEEDREAM_VERSION as string | undefined) ??
  "eeb2857d94c49a5bcbc9d6c6057416e1d3b1a2735a16e08e4def9bf7ee22ec71";

/**
 * Start a Seedream 5.0 Lite image prediction (photorealistic references).
 * Seedream has NO watermark-disable parameter — its PNG output carries a C2PA
 * content-credentials watermark in metadata (no visible pixel logo). We KEEP that
 * watermark: marking the reference as AI-generated content can help the downstream
 * video model's moderation accept it. Output is uploaded as-is (image/png).
 * Note: Seedream's only image output format is png/jpeg (no webp) and it has no seed input.
 */
export async function startImagePrediction(input: FluxInput, model?: string): Promise<string> {
  // Only Seedream 5.0 Lite is wired for image generation. `model` is accepted so the whole
  // reference pipeline (routes → workers → here) carries the producer's picked image model;
  // any other/unknown id resolves to Seedream. Add a branch here to support more models.
  void model;
  const prediction = await getReplicate().predictions.create({
    version: SEEDREAM_VERSION_ID,
    input: {
      prompt: input.prompt,
      aspect_ratio: input.aspect_ratio ?? "9:16",
      size: "2K",
      output_format: "png",
      ...(input.image_input?.length ? { image_input: input.image_input } : {}),
    },
  });
  return prediction.id;
}

export interface PredictionState {
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  /** Output URL when succeeded */
  url?: string;
  error?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  /** Provider logs tail (Stage 46B: parsed for a render percent when the model reports one). */
  logs?: string | null;
}

/** Fetch the current state of a prediction. */
export async function getPredictionState(id: string): Promise<PredictionState> {
  const p = await getReplicate().predictions.get(id, { signal: AbortSignal.timeout(20_000) });
  const status = p.status as PredictionState["status"];
  const times = { startedAt: p.started_at, completedAt: p.completed_at };
  // A succeeded prediction whose output is already gone (Replicate deletes output files about an hour
  // after completion) is reported WITHOUT a url instead of throwing — callers decide what to do; the
  // video worker fails the job with a refund rather than retrying the status GET forever.
  if (status === "succeeded") { let url: string | undefined; try { url = extractUrl(p.output); } catch { url = undefined; } return { status, ...times, url }; }
  if (status === "failed" || status === "canceled") return { status, ...times, error: p.error ? String(p.error) : undefined };
  return { status, ...times, logs: typeof p.logs === "string" ? p.logs.slice(-2000) : null };
}

/* ------------------------------------------------------------------ */
/*  Image generation (character portraits + scene references)         */
/*  Backed by Seedream 5.0 Lite (photorealistic) via startImagePrediction. */
/* ------------------------------------------------------------------ */

export interface FluxInput {
  prompt: string;
  /** "1:1" | "3:4" | "4:3" | "16:9" | "9:16" etc. Default "9:16" for vertical. */
  aspect_ratio?: string;
  /** 1-4, lower = more creative. Default 3.5. (unused by Seedream) */
  prompt_strength?: number;
  /** Number of inference steps. Default 28. (unused by Seedream) */
  num_inference_steps?: number;
  seed?: number;
  /** Seedream multi-reference input (1-14 URLs): the output keeps the place/light of these images. */
  image_input?: string[];
}

/**
 * Generate a photorealistic reference image (Seedream 5.0 Lite) via Replicate.
 * Returns the URL of the generated image. Logs each prediction; no paid automatic retries.
 */
/** Thrown by generateImage when `shouldCancel` reports a user cancellation mid-prediction. */
export class GenerationCanceledError extends Error {
  constructor(message = "Генерация отменена пользователем") { super(message); this.name = "GenerationCanceledError"; }
}

export async function generateImage(input: FluxInput, context: { jobId?: string; characterId?: string; imageModel?: string; shouldCancel?: () => Promise<boolean> } = {}): Promise<string> {
  const { imageModel, shouldCancel, ...logContext } = context;
  // Cancel is checked BEFORE the prediction is created so a canceled job never pays for a new one.
  if (shouldCancel && (await shouldCancel())) throw new GenerationCanceledError();
  const attempt: GenerationAttempt = {
    ...logContext, attempt: 1, phase: "reference", model: SEEDREAM_MODEL,
    status: "submitting", style: VISUAL_STYLE_ID,
    input: safeDiagnosticInput({ prompt: input.prompt, aspect_ratio: input.aspect_ratio ?? "9:16", size: "2K" }),
  };
  logAttempt(attempt);
  try {
    attempt.predictionId = await startImagePrediction(input, imageModel);
    attempt.status = "processing"; logAttempt(attempt);
    const started = Date.now();
    while (true) {
      // User cancel (cancelRequested on the job): stop the provider prediction and bail out — the caller
      // discards the result, refunds and marks the job canceled.
      if (shouldCancel && (await shouldCancel())) {
        await cancelPrediction(attempt.predictionId).catch(() => {});
        attempt.status = "canceled"; logAttempt(attempt);
        throw new GenerationCanceledError();
      }
      const p = await getPredictionState(attempt.predictionId);
      if (p.status === "succeeded" && p.url) {
        attempt.status = "succeeded"; logAttempt(attempt); return p.url;
      }
      if (p.status === "failed" || p.status === "canceled") throw new Error(p.error || "Image model failed");
      if (Date.now() - started > 180_000) throw new Error("Image model timed out; no automatic resubmission");
      await sleep(2_000);
    }
  } catch (error) {
    if (error instanceof GenerationCanceledError) throw error;
    attempt.error = safeProviderError(error); attempt.errorKind = classifyProviderError(error);
    attempt.status = attempt.errorKind === "timeout" ? "timeout" : "failed";
    logAttempt(attempt); throw new Error(attempt.error);
  }
}


/* ------------------------------------------------------------------ */
/*  FFmpeg (Replicate) — mux voiceover into a scene, concat episodes   */
/* ------------------------------------------------------------------ */

/** Command-capable ffmpeg model (accepts file1..file4 + a raw `command`). */
const FFMPEG_CMD_MODEL =
  (process.env.REPLICATE_FFMPEG_CMD_MODEL as `${string}/${string}:${string}` | undefined) ??
  "magpai-app/cog-ffmpeg:efd0b79b577bcd58ae7d035bce9de5c4659a59e09faafac4d426d61c04249251";

/** Pull the first output URL from the command-ffmpeg model's response shape. */
function extractCmdUrl(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output) && output.length > 0) return extractCmdUrl(output[0]);
  if (output && typeof (output as any).url === "function") return String((output as any).url());
  if (output && typeof output === "object") {
    const o = output as any;
    if ("url" in o) return String(o.url);
    // model returns { files: [...] } / { output1: ... }
    if (Array.isArray(o.files) && o.files.length) return extractCmdUrl(o.files[0]);
    if (o.output1) return extractCmdUrl(o.output1);
  }
  throw new Error("Cannot extract URL from ffmpeg-command output: " + JSON.stringify(output).slice(0, 200));
}

/**
 * Produce a scene clip that CARRIES ITS AUDIO, so a concatenated episode has sound.
 * - With `audioUrl`: muxes the voiceover onto the (silent) Seedance video.
 * - Without `audioUrl`: attaches a silent stereo track, so every clip fed to the
 *   concatenator has a uniform video+audio stream layout (mixed audio/no-audio
 *   inputs make the concat step drop audio or fail).
 * The video is stream-copied (fast, lossless); audio is (re)encoded to AAC.
 * Returns the output mp4 URL.
 */
export async function muxAudioIntoVideo(videoUrl: string, audioUrl?: string | null): Promise<string> {
  const replicate = getReplicate();
  const command = audioUrl
    ? // real voiceover: map video from file1, audio from file2, end at shortest
      "ffmpeg -y -i file1 -i file2 -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -shortest output1"
    : // no dialogue: synthesize a silent track for the full video duration
      "ffmpeg -y -i file1 -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -shortest output1";

  const input: Record<string, unknown> = {
    file1: videoUrl,
    command,
    output1: "output1.mp4",
  };
  if (audioUrl) input.file2 = audioUrl;

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const output = await replicate.run(FFMPEG_CMD_MODEL, { input });
      return extractCmdUrl(output);
    } catch (err: any) {
      const is429 = err?.message?.includes("429") || err?.response?.status === 429;
      if (is429 && attempt < maxRetries) {
        await sleep((attempt + 1) * 12_000);
        continue;
      }
      throw err;
    }
  }
  throw new Error("muxAudioIntoVideo: exhausted retries");
}

/**
 * Concatenate multiple videos (in order) into one mp4 via the
 * `foixasoftware/ffmpeg` model on Replicate. Returns the output URL.
 * Model version can be overridden via REPLICATE_FFMPEG_MODEL env var.
 */
export async function concatVideos(videoUrls: string[]): Promise<string> {
  if (videoUrls.length === 0) throw new Error("No videos to concatenate");
  const replicate = getReplicate();

  const model =
    (process.env.REPLICATE_FFMPEG_MODEL as `${string}/${string}:${string}` | undefined) ??
    "foixasoftware/ffmpeg:94f358189c0f452ae3e2be1bef374a497fc2c749a48ab61fe4e8b6319d1e561c";

  const output = await replicate.run(model, { input: { videos: videoUrls } });

  if (typeof output === "string") return output;
  if (Array.isArray(output) && output.length > 0) return String(output[0]);
  if (output && typeof (output as any).url === "function") return (output as any).url();
  if (output && typeof output === "object" && "url" in (output as any)) return String((output as any).url);
  throw new Error("Unexpected ffmpeg output format");
}

/** Cancel any Replicate prediction (video or image) by id. */
export async function cancelPrediction(id: string): Promise<void> {
  await getReplicate().predictions.cancel(id, { signal: AbortSignal.timeout(20_000) });
}
export const cancelVideoPrediction = cancelPrediction;
