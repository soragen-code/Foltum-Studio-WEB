import type { GenerationProvider } from "@/lib/validations";
import { startImagePrediction, getPredictionState, cancelPrediction, type FluxInput } from "@/lib/replicate";
import { generateImageSync, modelArkImageSize } from "@/lib/modelark";

/* ------------------------------------------------------------------ */
/*  Stage 73: reference-image generation provider layer (transport).    */
/*  replicate  — the existing lib/replicate.ts path, byte-for-byte.     */
/*  wavespeed  — Seedream 5.0 Lite on WaveSpeed (t2i, or /edit when     */
/*               reference images are present; max 10 refs).           */
/*  modelark   — Seedream 5.0 on ModelArk, synchronous; the result is  */
/*               parked in-memory under a synthetic id so the shared   */
/*               start → poll → done flow stays identical.             */
/* ------------------------------------------------------------------ */

export interface ImageGenerationInput extends FluxInput {
  /** What the image is for (diagnostics only; does not change the request). */
  kind?: "character" | "location" | "scene_still";
}

export interface ImageGenerationState {
  status: "running" | "succeeded" | "failed";
  outputUrl?: string;
  error?: string;
}

const WAVESPEED_BASE = "https://api.wavespeed.ai/api/v3";
/** WaveSpeed Seedream 5.0 Lite endpoints (text-to-image / multi-reference edit). */
export const WAVESPEED_SEEDREAM_T2I = "bytedance/seedream-v5.0-lite";
export const WAVESPEED_SEEDREAM_EDIT = "bytedance/seedream-v5.0-lite/edit";
const WAVESPEED_IMAGE_MAX_REFS = 10;

function wavespeedKey(): string {
  const key = process.env.WAVESPEED_API_KEY;
  if (!key) throw new Error("Не задан ключ провайдера WaveSpeed (WAVESPEED_API_KEY)");
  return key;
}

/** Pure body/slug builder for the WaveSpeed Seedream request (exported for tests). */
export function buildWaveSpeedImageRequest(input: ImageGenerationInput): { slug: string; body: Record<string, unknown> } {
  const refs = (input.image_input ?? []).filter((u) => typeof u === "string" && u.length > 0).slice(0, WAVESPEED_IMAGE_MAX_REFS);
  const size = modelArkImageSize(input.aspect_ratio).replace("x", "*");
  const body: Record<string, unknown> = { prompt: input.prompt, size, output_format: "png", enable_sync_mode: false };
  if (refs.length) {
    body.images = refs;
    return { slug: WAVESPEED_SEEDREAM_EDIT, body };
  }
  return { slug: WAVESPEED_SEEDREAM_T2I, body };
}

function wsUnwrap(body: any): any {
  return body && typeof body === "object" && body.data && typeof body.data === "object" ? body.data : body;
}
function wsError(body: any, httpStatus?: number): string {
  const parts: string[] = [];
  if (httpStatus !== undefined) parts.push(`HTTP ${httpStatus}`);
  const code = body?.code ?? body?.data?.code;
  if (code !== undefined && code !== null) parts.push(`code ${code}`);
  const msg = body?.message ?? body?.data?.error ?? body?.error;
  if (msg) parts.push(String(msg));
  return parts.length ? parts.join(" — ") : "unknown WaveSpeed error";
}

async function wavespeedStart(input: ImageGenerationInput): Promise<string> {
  const { slug, body } = buildWaveSpeedImageRequest(input);
  let res: Response;
  try {
    res = await fetch(`${WAVESPEED_BASE}/${slug}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${wavespeedKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: any) {
    throw new Error(`WaveSpeed image submit failed: ${err?.message || String(err)}`);
  }
  let json: any = null;
  try { json = await res.json(); } catch { /* handled below */ }
  if (!res.ok) throw new Error(`WaveSpeed image submit failed: ${wsError(json, res.status)}`);
  const id = wsUnwrap(json)?.id;
  if (!id) throw new Error(`WaveSpeed image submit returned no task id: ${wsError(json, res.status)}`);
  return String(id);
}

async function wavespeedState(id: string): Promise<ImageGenerationState> {
  const res = await fetch(`${WAVESPEED_BASE}/predictions/${id}/result`, {
    headers: { Authorization: `Bearer ${wavespeedKey()}` },
    signal: AbortSignal.timeout(20_000),
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* handled below */ }
  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) return { status: "running" };
    throw new Error(`WaveSpeed image result failed: ${wsError(json, res.status)}`);
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

/* ModelArk: synchronous call parked under a synthetic id. */
const modelArkResults = new Map<string, { promise: Promise<string>; done?: ImageGenerationState }>();
let modelArkSeq = 0;

function modelArkStart(input: ImageGenerationInput): string {
  const id = `modelark-img-${Date.now()}-${++modelArkSeq}`;
  const entry: { promise: Promise<string>; done?: ImageGenerationState } = { promise: generateImageSync(input) };
  entry.promise.then(
    (url) => { entry.done = { status: "succeeded", outputUrl: url }; },
    (err) => { entry.done = { status: "failed", error: err?.message || String(err) }; },
  );
  modelArkResults.set(id, entry);
  return id;
}

function modelArkState(id: string): ImageGenerationState {
  const entry = modelArkResults.get(id);
  if (!entry) return { status: "failed", error: "ModelArk image task not found in this process" };
  if (entry.done) { modelArkResults.delete(id); return entry.done; }
  return { status: "running" };
}

/** Submit an image generation on the given provider; returns the provider task id. */
export async function startImageGeneration(provider: GenerationProvider, input: ImageGenerationInput, imageModel?: string): Promise<{ id: string; provider: GenerationProvider }> {
  if (provider === "wavespeed") return { id: await wavespeedStart(input), provider };
  if (provider === "modelark") return { id: modelArkStart(input), provider };
  return { id: await startImagePrediction(input, imageModel), provider: "replicate" };
}

/** Current state of an image generation, normalised across providers. */
export async function getImageGenerationState(provider: GenerationProvider, id: string): Promise<ImageGenerationState> {
  if (provider === "wavespeed") return wavespeedState(id);
  if (provider === "modelark") return modelArkState(id);
  const p = await getPredictionState(id);
  if (p.status === "succeeded") return p.url ? { status: "succeeded", outputUrl: p.url } : { status: "failed", error: "Replicate returned no output image" };
  if (p.status === "failed" || p.status === "canceled") return { status: "failed", error: p.error };
  return { status: "running" };
}

/** Best-effort cancel (Replicate only has a real cancel API; others are no-ops). */
export async function cancelImageGeneration(provider: GenerationProvider, id: string): Promise<void> {
  if (provider === "replicate") { await cancelPrediction(id).catch(() => {}); return; }
  if (provider === "modelark") { modelArkResults.delete(id); return; }
  try {
    await fetch(`${WAVESPEED_BASE}/predictions/${id}/cancel`, { method: "POST", headers: { Authorization: `Bearer ${wavespeedKey()}` }, signal: AbortSignal.timeout(15_000) });
  } catch { /* best-effort */ }
}
