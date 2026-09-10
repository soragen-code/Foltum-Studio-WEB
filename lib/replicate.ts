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
/*  Seedance 2.5 — video generation                                  */
/* ------------------------------------------------------------------ */

export interface SeedanceInput {
  prompt: string;
  /** Duration in seconds, 1-30 or -1 for auto. Default 5. */
  duration?: number;
  /** "480p" | "720p". Default "720p". */
  resolution?: string;
  /** "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9" | "adaptive" */
  aspect_ratio?: string;
  /** Generate synchronized audio. Default true. */
  generate_audio?: boolean;
  /** First-frame image URL (image-to-video). */
  image?: string;
  /** Character/style references; mutually exclusive with first-frame image. */
  reference_images?: string[];
  /** Add watermark. Default false. */
  watermark?: boolean;
  seed?: number;
}

/**
 * Generate a video using Seedance 2.5 via Replicate.
 * Returns the URL of the generated mp4 video.
 */
export async function generateVideo(input: SeedanceInput): Promise<string> {
  const replicate = getReplicate();
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const output = await replicate.run("bytedance/seedance-2.5", {
        input: {
          prompt: input.prompt,
          duration: input.duration ?? 5,
          resolution: input.resolution ?? "720p",
          aspect_ratio: input.aspect_ratio ?? "9:16",
          generate_audio: true,
          watermark: input.watermark ?? false,
          output_format: "mp4",
          ...(input.image ? { image: input.image } : { reference_images: input.reference_images ?? [] }),
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
    ...(input.image ? { image: input.image } : { reference_images: input.reference_images ?? [] }),
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
    model: "bytedance/seedance-2.5",
    input: seedanceInput(input),
  });
  return prediction.id;
}

/* ------------------------------------------------------------------ */
/*  Kling v2.1 — alternative image-to-video provider                   */
/*  Real schema (kwaivgi/kling-v2.1): required prompt + start_image;   */
/*  duration enum [5,10] (NO 15s); mode 'standard'(720p)/'pro'(1080p); */
/*  optional end_image, negative_prompt; NO native audio (silent).     */
/* ------------------------------------------------------------------ */

/** Pinned version id of kwaivgi/kling-v2.1 (image-to-video). */
const KLING_MODEL_ID = "kwaivgi/kling-v2.1";
const KLING_VERSION_ID =
  process.env.REPLICATE_KLING_VERSION ??
  "daad218feb714b03e2a1ac445986aebb9d05243cd00da2af17be2e4049f48f69";

export interface KlingInput {
  prompt: string;
  /** REQUIRED first frame (image-to-video only). */
  start_image: string;
  /** Duration in seconds; Kling supports ONLY 5 or 10. Default 10. */
  duration?: number;
  /** 'standard' (720p) | 'pro' (1080p). Default 'standard'. */
  mode?: "standard" | "pro";
  /** Optional last frame for continuity (requires pro mode when set). */
  end_image?: string;
  negative_prompt?: string;
}

/** Model id string exported so callers/diagnostics can tag Kling attempts. */
export const KLING_MODEL = KLING_MODEL_ID;

/** Build the Kling input payload; clamps duration to the supported enum. */
function klingInput(input: KlingInput) {
  const dur = input.duration === 5 ? 5 : 10; // enum [5,10]
  const mode = input.mode ?? "standard";
  return {
    prompt: input.prompt,
    start_image: input.start_image,
    duration: dur,
    mode,
    ...(input.end_image ? { end_image: input.end_image } : {}),
    ...(input.negative_prompt ? { negative_prompt: input.negative_prompt } : {}),
  };
}

/**
 * Start a Kling v2.1 prediction WITHOUT waiting. Returns the prediction id so the
 * caller reuses the SAME polling/finalize path as Seedance (standard Replicate
 * prediction id + mp4 output). Kling REQUIRES start_image and has NO audio.
 */
export async function startKlingPrediction(input: KlingInput): Promise<string> {
  if (!input.start_image) throw new Error("Kling requires a start_image (image-to-video only)");
  const prediction = await getReplicate().predictions.create({
    version: KLING_VERSION_ID,
    input: klingInput(input),
  });
  return prediction.id;
}

/* ------------------------------------------------------------------ */
/*  sync/lipsync-2 — overlay speech onto a video's lips                 */
/*  Real schema: required video (.mp4) + audio (.wav); sync_mode        */
/*  ['loop','bounce','cut_off','silence','remap'] handles a duration    */
/*  mismatch between audio and video WITHOUT time-stretching speech;    */
/*  temperature 0-1 (expressiveness); output = single video URL.        */
/* ------------------------------------------------------------------ */

const LIPSYNC_VERSION_ID =
  process.env.REPLICATE_LIPSYNC_VERSION ??
  "4f8dc3cfda4ff844a6158ac347d21fcd025210f6dad4b16265fc53074ee4f77f"; // sync/lipsync-2
/** Model id string exported so callers/diagnostics can tag lipsync attempts. */
export const LIPSYNC_MODEL = "sync/lipsync-2";

export interface LipsyncInput {
  /** Silent (or any) video whose lips will be re-synced. */
  video: string;
  /** Speech audio track to sync the lips to. */
  audio: string;
  /**
   * How to reconcile a duration mismatch. "silence" keeps the FULL video length
   * and pads shorter speech with silence — no pitch/speed distortion of the voice.
   */
  sync_mode?: "loop" | "bounce" | "cut_off" | "silence" | "remap";
  /** Expressiveness 0-1. Default 0.5. */
  temperature?: number;
}

/**
 * Start a sync/lipsync-2 prediction WITHOUT waiting. Returns the prediction id so the
 * caller reuses the SAME polling/finalize path (standard Replicate prediction id + mp4).
 */
export async function startLipsyncPrediction(input: LipsyncInput): Promise<string> {
  if (!input.video || !input.audio) throw new Error("Lipsync requires both a video and an audio URL");
  const prediction = await getReplicate().predictions.create({
    version: LIPSYNC_VERSION_ID,
    input: {
      video: input.video,
      audio: input.audio,
      sync_mode: input.sync_mode ?? "silence",
      temperature: input.temperature ?? 0.5,
    },
  });
  return prediction.id;
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
}

/** Fetch the current state of a prediction. */
export async function getPredictionState(id: string): Promise<PredictionState> {
  const p = await getReplicate().predictions.get(id, { signal: AbortSignal.timeout(20_000) });
  const status = p.status as PredictionState["status"];
  const times = { startedAt: p.started_at, completedAt: p.completed_at };
  if (status === "succeeded") return { status, ...times, url: extractUrl(p.output) };
  if (status === "failed" || status === "canceled") return { status, ...times, error: p.error ? String(p.error) : undefined };
  return { status, ...times };
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
export async function generateImage(input: FluxInput, context: { jobId?: string; characterId?: string; imageModel?: string } = {}): Promise<string> {
  const { imageModel, ...logContext } = context;
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
      const p = await getPredictionState(attempt.predictionId);
      if (p.status === "succeeded" && p.url) {
        attempt.status = "succeeded"; logAttempt(attempt); return p.url;
      }
      if (p.status === "failed" || p.status === "canceled") throw new Error(p.error || "Image model failed");
      if (Date.now() - started > 180_000) throw new Error("Image model timed out; no automatic resubmission");
      await sleep(2_000);
    }
  } catch (error) {
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

export async function cancelVideoPrediction(id: string): Promise<void> {
  await getReplicate().predictions.cancel(id, { signal: AbortSignal.timeout(20_000) });
}
