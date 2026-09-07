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

  const output = await replicate.run("bytedance/seedance-2.5", {
    input: {
      prompt: input.prompt,
      duration: input.duration ?? 5,
      resolution: input.resolution ?? "720p",
      aspect_ratio: input.aspect_ratio ?? "9:16", // vertical drama format
      generate_audio: input.generate_audio ?? true,
      watermark: input.watermark ?? false,
      output_format: "mp4",
      ...(input.image ? { image: input.image } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    },
  });

  // Output is typically a URL string or an array with one URL
  if (typeof output === "string") return output;
  if (Array.isArray(output) && output.length > 0) return String(output[0]);
  // FileOutput object with .url()
  if (output && typeof (output as any).url === "function") return (output as any).url();
  if (output && typeof output === "object" && "url" in (output as any)) return String((output as any).url);
  throw new Error("Unexpected Seedance output format");
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
 * Returns the URL of the generated image.
 */
export async function generateImage(input: FluxInput): Promise<string> {
  const replicate = getReplicate();

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

  if (typeof output === "string") return output;
  if (Array.isArray(output) && output.length > 0) return String(output[0]);
  if (output && typeof (output as any).url === "function") return (output as any).url();
  if (output && typeof output === "object" && "url" in (output as any)) return String((output as any).url);
  throw new Error("Unexpected FLUX output format");
}
