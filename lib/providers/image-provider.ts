import { GenerationAttempt, safeDiagnosticInput, safeProviderError, classifyProviderError, logAttempt } from "@/lib/generation-diagnostics";
import { VISUAL_STYLE_ID } from "@/lib/visual-style";
import { WAVESPEED_BASE, getWaveSpeedKey, wavespeedErrorText } from "@/lib/wavespeed";
import { ensureEnglishPrompt } from "@/lib/english-prompt";
import { heartbeatJob } from "@/lib/jobs";

/* ------------------------------------------------------------------ */
/*  Reference-image generation — GPT Image 2.0 on WaveSpeed ONLY.       */
/*  (Stage 104: the per-project provider switch was removed; every      */
/*  image goes through WaveSpeed t2i, or /edit when reference images    */
/*  are present; max 10 refs.)                                          */
/* ------------------------------------------------------------------ */

/** Reference-image request (character portraits, location plates, scene stills, keyframes). */
export interface FluxInput {
  prompt: string;
  /** "1:1" | "3:4" | "4:3" | "16:9" | "9:16" etc. Default "9:16" for vertical. */
  aspect_ratio?: string;
  /** Unused by Seedream — kept for call-site compatibility. */
  prompt_strength?: number;
  /** Unused by Seedream — kept for call-site compatibility. */
  num_inference_steps?: number;
  seed?: number;
  /** Seedream multi-reference input (1-10 URLs): the output keeps the place/light of these images. */
  image_input?: string[];
  /** GPT Image 2.0 resolution tier. Default "2k"; the 5×5 storyboard sheet asks for "4k" so sliced panels stay usable. */
  resolution?: "1k" | "2k" | "4k";
}

export interface ImageGenerationInput extends FluxInput {
  /** What the image is for (diagnostics only; does not change the request). */
  kind?: "character" | "location" | "scene_still" | "keyframe";
}

export interface ImageGenerationState {
  status: "running" | "succeeded" | "failed";
  outputUrl?: string;
  error?: string;
}

/** WaveSpeed GPT Image 2.0 endpoints (text-to-image / multi-reference edit). */
export const WAVESPEED_GPT_IMAGE_T2I = "openai/gpt-image-2/text-to-image";
export const WAVESPEED_GPT_IMAGE_EDIT = "openai/gpt-image-2/edit";
/**
 * Backward-compat aliases. The whole codebase imports these SEEDREAM_* symbols
 * (keyframe / reangle / region-plate / sub-location / storyboard / visual-style);
 * pointing them at the GPT Image 2.0 slugs switches every image worker to the new
 * model in one place without churning every call site.
 */
export const WAVESPEED_SEEDREAM_T2I = WAVESPEED_GPT_IMAGE_T2I;
export const WAVESPEED_SEEDREAM_EDIT = WAVESPEED_GPT_IMAGE_EDIT;
export const WAVESPEED_IMAGE_MAX_REFS = 10;
/** Model name recorded in generation diagnostics. */
export const SEEDREAM_MODEL = WAVESPEED_GPT_IMAGE_T2I;

/** Explicit pixel size closest to the requested aspect ratio (2K class) as "W*H". */
export function seedreamImageSize(aspect?: string): string {
  switch ((aspect ?? "9:16").trim()) {
    case "1:1": return "2048*2048";
    case "16:9": return "2560*1440";
    case "4:3": return "2304*1728";
    case "3:4": return "1728*2304";
    case "3:2": return "2496*1664";
    case "2:3": return "1664*2496";
    case "21:9": return "3024*1296";
    case "9:16":
    default: return "1440*2560";
  }
}

/** Pure body/slug builder for the WaveSpeed GPT Image 2.0 request (exported for tests). */
export function buildWaveSpeedImageRequest(input: ImageGenerationInput): { slug: string; body: Record<string, unknown> } {
  const refs = (input.image_input ?? []).filter((u) => typeof u === "string" && u.length > 0).slice(0, WAVESPEED_IMAGE_MAX_REFS);
  // GPT Image 2.0 (text-to-image / edit) take `aspect_ratio` + `resolution` (1k/2k/4k) + `quality`.
  const aspect_ratio = (input.aspect_ratio ?? "9:16").trim() || "9:16";
  // `quality: "high"` = best fidelity tier; `resolution: "2k"` keeps parity with the previous 2K plates.
  // NOTE: GPT Image 2.0 has NO `seed` parameter, so the caller-supplied seed is intentionally dropped
  // (extra keys are silently ignored by the API — output is provider-random).
  const resolution = input.resolution === "1k" || input.resolution === "4k" ? input.resolution : "2k";
  const body: Record<string, unknown> = { prompt: input.prompt, aspect_ratio, resolution, quality: "high", output_format: "png", enable_sync_mode: false };
  if (refs.length) {
    body.images = refs;
    return { slug: WAVESPEED_GPT_IMAGE_EDIT, body };
  }
  return { slug: WAVESPEED_GPT_IMAGE_T2I, body };
}

function wsUnwrap(body: any): any {
  return body && typeof body === "object" && body.data && typeof body.data === "object" ? body.data : body;
}

async function wavespeedStart(input: ImageGenerationInput): Promise<string> {
  // English-only guarantee: translate/romanise the prompt before dispatch so no Cyrillic
  // (from Location.visualPrompt/name, Character.appearance, scene-still text, etc.) reaches Seedream.
  const prompt = await ensureEnglishPrompt(input.prompt);
  const { slug, body } = buildWaveSpeedImageRequest({ ...input, prompt });
  let res: Response;
  try {
    res = await fetch(`${WAVESPEED_BASE}/${slug}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getWaveSpeedKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: any) {
    throw new Error(`WaveSpeed image submit failed: ${err?.message || String(err)}`);
  }
  let json: any = null;
  try { json = await res.json(); } catch { /* handled below */ }
  if (!res.ok) throw new Error(`WaveSpeed image submit failed: ${wavespeedErrorText(json, res.status)}`);
  const id = wsUnwrap(json)?.id;
  if (!id) throw new Error(`WaveSpeed image submit returned no task id: ${wavespeedErrorText(json, res.status)}`);
  return String(id);
}

async function wavespeedState(id: string): Promise<ImageGenerationState> {
  const res = await fetch(`${WAVESPEED_BASE}/predictions/${id}/result`, {
    headers: { Authorization: `Bearer ${getWaveSpeedKey()}` },
    signal: AbortSignal.timeout(20_000),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* handled below */ }
  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) return { status: "running" };
    throw new Error(`WaveSpeed image result failed: ${wavespeedErrorText(json, res.status)}`);
  }
  const data = wsUnwrap(json);
  const status = String(data?.status ?? "").toLowerCase();
  if (status === "completed" || status === "succeeded") {
    const first = Array.isArray(data?.outputs) ? data.outputs[0] : undefined;
    const outputUrl = typeof first === "string" ? first : first?.url ? String(first.url) : undefined;
    return outputUrl ? { status: "succeeded", outputUrl } : { status: "failed", error: "WaveSpeed returned no output image" };
  }
  if (status === "failed" || status === "timeout" || status === "deleted" || status === "cancelled" || status === "canceled") {
    return { status: "failed", error: data?.error ? String(data.error) : json?.message ? String(json.message) : `WaveSpeed task ${status}` };
  }
  return { status: "running" };
}

/** Submit an image generation; returns the WaveSpeed task id. */
export async function startImageGeneration(input: ImageGenerationInput): Promise<{ id: string }> {
  return { id: await wavespeedStart(input) };
}

/** Current state of an image generation. */
export async function getImageGenerationState(id: string): Promise<ImageGenerationState> {
  return wavespeedState(id);
}

/** Best-effort cancel of an image generation. */
export async function cancelImageGeneration(id: string): Promise<void> {
  try {
    await fetch(`${WAVESPEED_BASE}/predictions/${id}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${getWaveSpeedKey()}` }, signal: AbortSignal.timeout(15_000) });
  } catch { /* best-effort */ }
}

/* ------------------------------------------------------------------ */
/*  High-level: generate one image (start → poll → url) with           */
/*  diagnostics + user-cancel support. Used by every image worker.      */
/* ------------------------------------------------------------------ */

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** Thrown by generateImage when `shouldCancel` reports a user cancellation mid-generation. */
export class GenerationCanceledError extends Error {
  constructor(message = "Generation canceled by the user") { super(message); this.name = "GenerationCanceledError"; }
}

export interface GenerateImageContext {
  jobId?: string;
  characterId?: string;
  /** Ignored (the model is fixed); kept so existing call sites compile. */
  imageModel?: string;
  shouldCancel?: () => Promise<boolean>;
  /** Poll budget in ms (default 180 s). Large multi-reference renders (the 5×5 storyboard sheet) need more. */
  timeoutMs?: number;
}

/**
 * Generate a photorealistic reference image (Seedream 5.0 Pro on WaveSpeed).
 * Returns the URL of the generated image. Logs each attempt; no paid automatic retries.
 */
export async function generateImage(input: FluxInput, context: GenerateImageContext = {}): Promise<string> {
  const { imageModel: _ignored, shouldCancel, timeoutMs, ...logContext } = context;
  const pollBudgetMs = timeoutMs && timeoutMs > 0 ? timeoutMs : 180_000;
  void _ignored;
  // Cancel is checked BEFORE the task is created so a canceled job never pays for a new one.
  if (shouldCancel && (await shouldCancel())) throw new GenerationCanceledError();
  const attempt: GenerationAttempt = {
    ...logContext, attempt: 1, phase: "reference", model: SEEDREAM_MODEL,
    status: "submitting", style: VISUAL_STYLE_ID,
    input: safeDiagnosticInput({ prompt: input.prompt, aspect_ratio: input.aspect_ratio ?? "9:16", size: "2K", provider: "wavespeed" }),
  };
  logAttempt(attempt);
  try {
    attempt.predictionId = (await startImageGeneration(input)).id;
    attempt.status = "processing"; logAttempt(attempt);
    const started = Date.now();
    while (true) {
      // User cancel (cancelRequested on the job): stop the task and bail out — the caller
      // discards the result, refunds and marks the job canceled.
      if (shouldCancel && (await shouldCancel())) {
        await cancelImageGeneration(attempt.predictionId).catch(() => {});
        attempt.status = "canceled"; logAttempt(attempt);
        throw new GenerationCanceledError();
      }
      // Heartbeat: the provider poll can run for up to ~3 min with no other job write. Without touching
      // the job's updatedAt on every tick, failStaleJobs (fired by the boards GET poll, the frame POST and
      // the cron) crosses the STALE_JOB_MS boundary and falsely fails a still-live render with
      // "Generation timed out (worker stopped responding)". A cheap per-tick heartbeat keeps it fresh.
      if (logContext.jobId) await heartbeatJob(logContext.jobId);
      const st = await getImageGenerationState(attempt.predictionId);
      if (st.status === "succeeded" && st.outputUrl) { attempt.status = "succeeded"; logAttempt(attempt); return st.outputUrl; }
      if (st.status === "failed") throw new Error(st.error || "Image model failed");
      if (Date.now() - started > pollBudgetMs) throw new Error("Image model timed out; no automatic resubmission");
      await sleep(2_000);
    }
  } catch (error) {
    if (error instanceof GenerationCanceledError) throw error;
    attempt.error = safeProviderError(error); attempt.errorKind = classifyProviderError(error);
    attempt.status = attempt.errorKind === "timeout" ? "timeout" : "failed";
    logAttempt(attempt); throw new Error(attempt.error);
  }
}
