import Replicate from "replicate";

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
          generate_audio: input.generate_audio ?? true,
          watermark: input.watermark ?? false,
          output_format: "mp4",
          ...(input.image ? { image: input.image } : {}),
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
    generate_audio: input.generate_audio ?? true,
    watermark: input.watermark ?? false,
    output_format: "mp4",
    ...(input.image ? { image: input.image } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  };
}

/**
 * Start a Seedance prediction WITHOUT waiting for it. Returns the prediction id,
 * so the caller can poll (and survive a serverless function restart).
 */
export async function startVideoPrediction(input: SeedanceInput): Promise<string> {
  const replicate = getReplicate();
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const prediction = await replicate.predictions.create({
        model: "bytedance/seedance-2.5",
        input: seedanceInput(input),
      });
      return prediction.id;
    } catch (err: any) {
      const is429 = err?.message?.includes("429") || err?.response?.status === 429;
      if (is429 && attempt < maxRetries) {
        await sleep((attempt + 1) * 15_000);
        continue;
      }
      throw err;
    }
  }
  throw new Error("startVideoPrediction: exhausted retries");
}

export interface PredictionState {
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  /** Output URL when succeeded */
  url?: string;
  error?: string;
}

/** Fetch the current state of a prediction. */
export async function getPredictionState(id: string): Promise<PredictionState> {
  const p = await getReplicate().predictions.get(id);
  const status = p.status as PredictionState["status"];
  if (status === "succeeded") return { status, url: extractUrl(p.output) };
  if (status === "failed" || status === "canceled") return { status, error: String(p.error ?? status) };
  return { status };
}

/* ------------------------------------------------------------------ */
/*  FLUX 1.1 Pro — image generation (character portraits)            */
/* ------------------------------------------------------------------ */

export interface FluxInput {
  prompt: string;
  /** "1:1" | "3:4" | "4:3" | "16:9" | "9:16" etc. Default "3:4" for portraits. */
  aspect_ratio?: string;
  /** 1-4, lower = more creative. Default 3.5. */
  prompt_strength?: number;
  /** Number of inference steps. Default 28. */
  num_inference_steps?: number;
  seed?: number;
}

/**
 * Generate an image using FLUX 1.1 Pro via Replicate.
 * Returns the URL of the generated image. Includes retry logic for rate limits.
 */
export async function generateImage(input: FluxInput): Promise<string> {
  const replicate = getReplicate();
  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const output = await replicate.run("black-forest-labs/flux-1.1-pro", {
        input: {
          prompt: input.prompt,
          aspect_ratio: input.aspect_ratio ?? "3:4",
          output_format: "webp",
          output_quality: 90,
          safety_tolerance: 2,
          prompt_upsampling: true,
          ...(input.seed !== undefined ? { seed: input.seed } : {}),
        },
      });
      return extractUrl(output);
    } catch (err: any) {
      const is429 = err?.message?.includes("429") || err?.response?.status === 429;
      if (is429 && attempt < maxRetries) {
        const delay = (attempt + 1) * 12_000; // 12s, 24s, 36s
        console.log(`FLUX rate-limited, retry ${attempt + 1}/${maxRetries} in ${delay / 1000}s`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw new Error("generateImage: exhausted retries");
}


/* ------------------------------------------------------------------ */
/*  FFmpeg (Replicate) — concatenate scene videos into an episode     */
/* ------------------------------------------------------------------ */

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
