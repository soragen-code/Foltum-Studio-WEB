/* ------------------------------------------------------------------ */
/*  WaveSpeed — the ONLY media provider of the app (Stage 104).         */
/*                                                                     */
/*  - Seedance 2.5 scene video: text-to-video (reference images) and   */
/*    image-to-video (first / last frame = scene keyframes).           */
/*  - Seedream 5.0 Pro images live in lib/providers/image-provider.ts  */
/*    and reuse the generic transport exported here.                    */
/*  - ACE-Step 1.5 background music lives in lib/music.ts.              */
/*  Every task follows the same contract: ONE POST that returns a task  */
/*  id, then GET /predictions/{id}/result polling — no paid blind       */
/*  retries; on a dropped connection the caller polls by id.            */
/* ------------------------------------------------------------------ */

export const WAVESPEED_BASE = "https://api.wavespeed.ai/api/v3";
export const SEEDANCE_T2V_SLUG = "bytedance/seedance-2.5/text-to-video";
export const SEEDANCE_I2V_SLUG = "bytedance/seedance-2.5/image-to-video";

/** Shared task-state shape used by every polling loop in the app (video, image, keyframe, music). */
export interface PredictionState {
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  /** Output URL when succeeded */
  url?: string;
  error?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  /** Provider logs tail (parsed for a render percent when the model reports one). */
  logs?: string | null;
}

/** Seedance 2.5 text-to-video (reference-image mode) input. */
export interface SeedanceInput {
  prompt: string;
  /** Ignored — the endpoint is fixed (kept for call-site compatibility). */
  model?: string;
  /** Duration in seconds, 1-30 or -1 for auto. Default 5. */
  duration?: number;
  /** "480p" | "720p". Default "720p". */
  resolution?: string;
  /** "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9" | "adaptive" */
  aspect_ratio?: string;
  /** Generate synchronized audio. Default true. */
  generate_audio?: boolean;
  /** Character / location / style references, referenced in the prompt as [Image1]...[ImageN]. */
  reference_images?: string[];
  /** Add watermark. Default false. */
  watermark?: boolean;
  seed?: number;
}

/** Seedance 2.5 image-to-video input: first frame (+ optional last frame). */
export interface SeedanceImageToVideoInput {
  prompt: string;
  /** First frame (scene keyframe). */
  image: string;
  /** Optional last frame (next scene's keyframe). */
  last_image?: string;
  /** "480p" | "720p". Default "720p". */
  resolution?: string;
  /** Duration in seconds (clamped to 4–30). Default 5. */
  duration?: number;
  /** Always true for scenes (native speech). */
  generate_audio?: boolean;
}

/** Read the WaveSpeed API key from the environment (never hard-coded). */
export function getWaveSpeedKey(): string {
  const key = process.env.WAVESPEED_API_KEY;
  if (!key) throw new Error("WAVESPEED_API_KEY is not set");
  return key;
}
const getKey = getWaveSpeedKey;

/** WaveSpeed sometimes nests the payload under `data`; accept either shape. */
function unwrap(body: any): any {
  if (body && typeof body === "object" && "data" in body && body.data && typeof body.data === "object") {
    return body.data;
  }
  return body;
}

/** Compose a concise "code + message" error string (never includes the key). */
export function wavespeedErrorText(body: any, httpStatus?: number): string {
  const parts: string[] = [];
  if (httpStatus !== undefined) parts.push(`HTTP ${httpStatus}`);
  const code = body?.code ?? body?.data?.code;
  if (code !== undefined && code !== null) parts.push(`code ${code}`);
  const msg = body?.message ?? body?.data?.error ?? body?.error ?? body?.data?.message;
  if (msg) parts.push(String(msg));
  return parts.length ? parts.join(" — ") : "unknown WaveSpeed error";
}
const providerErrorText = wavespeedErrorText;

/* ------------------------------------------------------------------ */
/*  Generic transport: submit a task to any model slug, poll its result */
/* ------------------------------------------------------------------ */

/** POST `${WAVESPEED_BASE}/${slug}` with `body`; returns the task id. */
export async function wavespeedSubmit(slug: string, body: Record<string, unknown>, label = "WaveSpeed"): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${WAVESPEED_BASE}/${slug}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: any) {
    throw new Error(`${label} submit request failed: ${err?.message || String(err)}`);
  }

  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body handled below */
  }

  if (!res.ok) {
    throw new Error(`${label} submit failed: ${providerErrorText(json, res.status)}`);
  }

  const data = unwrap(json);
  const id = data?.id;
  if (!id) {
    throw new Error(`${label} submit returned no task id: ${providerErrorText(json, res.status)}`);
  }
  return String(id);
}

/**
 * Fetch the current state of a WaveSpeed task, mapped into the shared PredictionState.
 * - created/queued → starting, processing → processing (still running)
 * - completed → succeeded, url = outputs[0] (no url if outputs empty, so the upper layer
 *   honestly fails + refunds)
 * - failed/timeout/deleted → failed; cancelled → canceled (with error text)
 * - 5xx / 429 on the GET → reported as processing so the loop simply retries
 */
export async function wavespeedResult(id: string, label = "WaveSpeed"): Promise<PredictionState> {
  const res = await fetch(`${WAVESPEED_BASE}/predictions/${id}/result`, {
    method: "GET",
    headers: { Authorization: `Bearer ${getKey()}` },
    signal: AbortSignal.timeout(20_000),
  });

  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* handled below */
  }

  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) return { status: "processing", logs: null };
    throw new Error(`${label} result failed: ${providerErrorText(json, res.status)}`);
  }

  const data = unwrap(json);
  const status = String(data?.status ?? "").toLowerCase();
  const logs = typeof data?.logs === "string" ? data.logs.slice(-2000) : null;

  if (status === "completed" || status === "succeeded") {
    const outputs = data?.outputs;
    let url: string | undefined;
    if (Array.isArray(outputs) && outputs.length > 0) {
      const first = outputs[0];
      url = typeof first === "string" ? first : (first?.url ? String(first.url) : undefined);
    }
    return { status: "succeeded", url };
  }

  if (status === "failed" || status === "timeout" || status === "deleted") {
    return { status: "failed", error: data?.error ? String(data.error) : (json?.message ? String(json.message) : undefined) };
  }
  if (status === "cancelled" || status === "canceled") {
    return { status: "canceled", error: data?.error ? String(data.error) : undefined };
  }

  const mapped: PredictionState["status"] = status === "created" || status === "queued" ? "starting" : "processing";
  return { status: mapped, logs };
}

/** Best-effort cancellation of a WaveSpeed task (any error / 404 is swallowed). */
export async function wavespeedCancel(id: string): Promise<void> {
  try {
    await fetch(`${WAVESPEED_BASE}/predictions/${id}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getKey()}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    /* no-op: cancellation is best-effort */
  }
}

/**
 * Poll a task until it is terminal. Throws on failure / cancel / timeout / empty output.
 * `shouldCancel` is checked between polls; when it reports true the task is cancelled
 * best-effort and an Error("canceled") is thrown.
 */
export async function wavespeedWait(
  id: string,
  opts: { timeoutMs?: number; pollMs?: number; label?: string; shouldCancel?: () => Promise<boolean> } = {},
): Promise<string> {
  const label = opts.label ?? "WaveSpeed";
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const pollMs = opts.pollMs ?? 3_000;
  const started = Date.now();
  for (;;) {
    if (opts.shouldCancel && (await opts.shouldCancel())) {
      await wavespeedCancel(id);
      throw new Error(`${label} canceled`);
    }
    const st = await wavespeedResult(id, label);
    if (st.status === "succeeded") {
      if (st.url) return st.url;
      throw new Error(`${label} returned no output`);
    }
    if (st.status === "failed" || st.status === "canceled") throw new Error(st.error || `${label} ${st.status}`);
    if (Date.now() - started > timeoutMs) throw new Error(`${label} timed out; no automatic resubmission`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/* ------------------------------------------------------------------ */
/*  Seedance 2.5 — scene video                                          */
/* ------------------------------------------------------------------ */

/**
 * Start a Seedance 2.5 text-to-video generation. `reference_images` is sent ONLY when
 * non-empty. Returns the task id so the caller can poll (and survive a function restart).
 */
export async function startVideoPrediction(input: SeedanceInput): Promise<string> {
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    aspect_ratio: input.aspect_ratio ?? "9:16",
    resolution: input.resolution ?? "720p",
    duration: input.duration ?? 5,
    generate_audio: true,
  };
  if (input.reference_images?.length) body.reference_images = input.reference_images;
  return wavespeedSubmit(SEEDANCE_T2V_SLUG, body, "WaveSpeed");
}

/** Allowed keys of the Seedance image-to-video body (guarded by tests). */
export const SEEDANCE_I2V_BODY_KEYS = ["prompt", "image", "last_image", "resolution", "duration", "generate_audio"] as const;
export const SEEDANCE_I2V_MIN_DURATION = 4;
export const SEEDANCE_I2V_MAX_DURATION = 30;

/** Pure body builder for Seedance 2.5 image-to-video (exported for tests). */
export function buildSeedanceImageToVideoBody(input: SeedanceImageToVideoInput): Record<string, unknown> {
  const rawDuration = Number.isFinite(input.duration as number) ? Math.round(input.duration as number) : 5;
  const duration = Math.max(SEEDANCE_I2V_MIN_DURATION, Math.min(SEEDANCE_I2V_MAX_DURATION, rawDuration));
  const body: Record<string, unknown> = {
    prompt: input.prompt,
    image: input.image,
    resolution: input.resolution ?? "720p",
    duration,
    generate_audio: input.generate_audio ?? true,
  };
  if (input.last_image) body.last_image = input.last_image;
  return body;
}

/** Start a Seedance 2.5 image-to-video generation (first / last frame). Returns the task id. */
export async function generateSeedanceImageToVideo(input: SeedanceImageToVideoInput): Promise<string> {
  return wavespeedSubmit(SEEDANCE_I2V_SLUG, buildSeedanceImageToVideoBody(input), "WaveSpeed");
}

/** Poll a scene video task (shared PredictionState). */
export async function getVideoPredictionState(id: string): Promise<PredictionState> {
  return wavespeedResult(id, "WaveSpeed");
}

/** Best-effort cancel of a scene video task. */
export async function cancelVideoPrediction(id: string): Promise<void> {
  return wavespeedCancel(id);
}
