import type { PredictionState, SeedanceInput } from "@/lib/replicate";

/* ------------------------------------------------------------------ */
/*  ModelArk (BytePlus) — Seedream 5.0 images + Seedance 2.5 videos    */
/*                                                                     */
/*  Stage 73: third selectable generation provider. Transport only:    */
/*  prompts, references and pipeline logic are built by the callers.   */
/*  Images: POST /images/generations (synchronous; the result is kept  */
/*  in-memory under a synthetic id so the shared start/poll flow works).*/
/*  Videos: POST /contents/generations/tasks + GET /tasks/{id} polling. */
/* ------------------------------------------------------------------ */

export const MODELARK_BASE = "https://ark.ap-southeast.bytepluses.com/api/v3";
export const MODELARK_IMAGE_MODEL = "seedream-5-0-260128";
export const MODELARK_VIDEO_MODEL = "dreamina-seedance-2-5-260628";
/** ModelArk Seedream accepts at most 14 reference images. */
export const MODELARK_IMAGE_MAX_REFS = 14;
/** ModelArk Seedance accepts at most 30 reference images. */
export const MODELARK_VIDEO_MAX_REFS = 30;

/** Read the ModelArk API key from the environment (never hard-coded, never logged). */
function getKey(): string {
  const key = process.env.MODELARK_API_KEY;
  if (!key) throw new Error("Не задан ключ провайдера ModelArk (MODELARK_API_KEY)");
  return key;
}

/** Compose a concise "code + message" error string (never includes the key). */
function providerErrorText(body: any, httpStatus?: number): string {
  const parts: string[] = [];
  if (httpStatus !== undefined) parts.push(`HTTP ${httpStatus}`);
  const err = body?.error ?? body;
  const code = err?.code;
  if (code !== undefined && code !== null) parts.push(`code ${code}`);
  const msg = err?.message ?? body?.message;
  if (msg) parts.push(String(msg));
  return parts.length ? parts.join(" — ") : "unknown ModelArk error";
}

async function arkFetch(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ res: Response; json: any }> {
  const { timeoutMs = 30_000, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${MODELARK_BASE}${path}`, {
      ...rest,
      headers: { Authorization: `Bearer ${getKey()}`, "Content-Type": "application/json", ...(rest.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    throw new Error(`ModelArk request failed: ${err?.message || String(err)}`);
  }
  let json: any = null;
  try { json = await res.json(); } catch { /* non-JSON body handled by callers */ }
  return { res, json };
}

/* ------------------------------ images ------------------------------ */

export interface ModelArkImageInput {
  prompt: string;
  /** "9:16" | "1:1" | "16:9" | "3:4" | "4:3" ... (default "9:16"). */
  aspect_ratio?: string;
  /** Reference images (trimmed to MODELARK_IMAGE_MAX_REFS, tail dropped). */
  image_input?: string[];
}

/** Explicit pixel size closest to the requested aspect ratio (2K class), as ModelArk expects "WxH". */
export function modelArkImageSize(aspect?: string): string {
  switch ((aspect ?? "9:16").trim()) {
    case "1:1": return "2048x2048";
    case "16:9": return "2560x1440";
    case "4:3": return "2304x1728";
    case "3:4": return "1728x2304";
    case "3:2": return "2496x1664";
    case "2:3": return "1664x2496";
    case "21:9": return "3024x1296";
    case "9:16":
    default: return "1440x2560";
  }
}

/** Pure request body builder for POST /images/generations (exported for tests). */
export function buildModelArkImageBody(input: ModelArkImageInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: MODELARK_IMAGE_MODEL,
    prompt: input.prompt,
    size: modelArkImageSize(input.aspect_ratio),
    response_format: "url",
    watermark: false,
    sequential_image_generation: "disabled",
  };
  const refs = (input.image_input ?? []).filter((u) => typeof u === "string" && u.length > 0).slice(0, MODELARK_IMAGE_MAX_REFS);
  if (refs.length) body.image = refs;
  return body;
}

/** Synchronous image generation; returns the output URL. */
export async function generateImageSync(input: ModelArkImageInput): Promise<string> {
  const { res, json } = await arkFetch("/images/generations", { method: "POST", body: JSON.stringify(buildModelArkImageBody(input)), timeoutMs: 170_000 });
  if (!res.ok) throw new Error(`ModelArk image failed: ${providerErrorText(json, res.status)}`);
  const first = Array.isArray(json?.data) ? json.data[0] : undefined;
  const url = first?.url ? String(first.url) : undefined;
  if (!url) throw new Error(`ModelArk image returned no url: ${providerErrorText(json, res.status)}`);
  return url;
}

/* ------------------------------ videos ------------------------------ */

/** Pure request body builder for POST /contents/generations/tasks (exported for tests). */
export function buildModelArkVideoBody(input: SeedanceInput): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: input.prompt }];
  const refs = (input.reference_images ?? []).filter((u) => typeof u === "string" && u.length > 0).slice(0, MODELARK_VIDEO_MAX_REFS);
  for (const url of refs) content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
  return {
    model: MODELARK_VIDEO_MODEL,
    content,
    ratio: input.aspect_ratio && input.aspect_ratio !== "adaptive" ? input.aspect_ratio : "9:16",
    resolution: input.resolution ?? "720p",
    duration: input.duration ?? 5,
    generate_audio: input.generate_audio ?? true,
    watermark: input.watermark ?? false,
  };
}

/** Submit a Seedance 2.5 video task; returns the task id for polling. ONE submission, no blind retries. */
export async function startVideoTask(input: SeedanceInput): Promise<string> {
  const { res, json } = await arkFetch("/contents/generations/tasks", { method: "POST", body: JSON.stringify(buildModelArkVideoBody(input)) });
  if (!res.ok) throw new Error(`ModelArk submit failed: ${providerErrorText(json, res.status)}`);
  const id = json?.id;
  if (!id) throw new Error(`ModelArk submit returned no task id: ${providerErrorText(json, res.status)}`);
  return String(id);
}

/**
 * Pure mapper of a ModelArk task payload into the shared PredictionState (exported for tests).
 * queued → starting; running → processing; succeeded → succeeded (url = content.video_url);
 * failed | expired → failed; cancelled → canceled.
 */
export function mapModelArkTaskState(task: any): PredictionState {
  const status = String(task?.status ?? "").toLowerCase();
  const errText = task?.error?.message ? String(task.error.message) : task?.error ? String(typeof task.error === "string" ? task.error : JSON.stringify(task.error)) : undefined;
  if (status === "succeeded") {
    const url = task?.content?.video_url ? String(task.content.video_url) : undefined;
    return { status: "succeeded", url };
  }
  if (status === "failed" || status === "expired") return { status: "failed", error: errText ?? (status === "expired" ? "ModelArk task expired" : undefined) };
  if (status === "cancelled" || status === "canceled") return { status: "canceled", error: errText };
  if (status === "queued") return { status: "starting", logs: null };
  return { status: "processing", logs: null };
}

/** Poll a video task. Transient 5xx/429 are reported as still processing so the loop retries. */
export async function getVideoTaskState(id: string): Promise<PredictionState> {
  const { res, json } = await arkFetch(`/contents/generations/tasks/${encodeURIComponent(id)}`, { method: "GET", timeoutMs: 20_000 });
  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) return { status: "processing", logs: null };
    throw new Error(`ModelArk task status failed: ${providerErrorText(json, res.status)}`);
  }
  return mapModelArkTaskState(json);
}

/** Best-effort cancellation (DELETE task); errors are swallowed so the cancel flow never breaks. */
export async function cancelVideoTask(id: string): Promise<void> {
  try {
    await arkFetch(`/contents/generations/tasks/${encodeURIComponent(id)}`, { method: "DELETE", timeoutMs: 15_000 });
  } catch {
    /* no-op */
  }
}
