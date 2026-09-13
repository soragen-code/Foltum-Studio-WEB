import type { PredictionState, SeedanceInput } from "@/lib/replicate";

/* ------------------------------------------------------------------ */
/*  WaveSpeed — Seedance 2.5 scene VIDEO generation (transport only)   */
/*                                                                     */
/*  Stage 70: scene video generation migrates off Replicate onto       */
/*  WaveSpeed's official Seedance 2.5 text-to-video endpoint. Replicate */
/*  layered its own moderation on top of Seedance and returned E005     */
/*  ("input or output was flagged as sensitive") where the official     */
/*  model passes. Everything else (images, music, ffmpeg/FILM) stays on */
/*  Replicate — this module ONLY covers the scene video transport.      */
/* ------------------------------------------------------------------ */

const WAVESPEED_BASE = "https://api.wavespeed.ai/api/v3";
const SEEDANCE_ENDPOINT = `${WAVESPEED_BASE}/bytedance/seedance-2.5/text-to-video`;

/** Read the WaveSpeed API key from the environment (never hard-coded). */
function getKey(): string {
  const key = process.env.WAVESPEED_API_KEY;
  if (!key) throw new Error("WAVESPEED_API_KEY is not set");
  return key;
}

/** WaveSpeed sometimes nests the payload under `data`; accept either shape. */
function unwrap(body: any): any {
  if (body && typeof body === "object" && "data" in body && body.data && typeof body.data === "object") {
    return body.data;
  }
  return body;
}

/** Compose a concise "code + message" error string (never includes the key). */
function providerErrorText(body: any, httpStatus?: number): string {
  const parts: string[] = [];
  if (httpStatus !== undefined) parts.push(`HTTP ${httpStatus}`);
  const code = body?.code ?? body?.data?.code;
  if (code !== undefined && code !== null) parts.push(`code ${code}`);
  const msg = body?.message ?? body?.data?.error ?? body?.error ?? body?.data?.message;
  if (msg) parts.push(String(msg));
  return parts.length ? parts.join(" — ") : "unknown WaveSpeed error";
}

/**
 * Start a Seedance 2.5 scene-video generation on WaveSpeed. Returns the task id
 * so the caller can poll (and survive a serverless function restart). ONE
 * submission per job — no paid blind retries; on a dropped connection the caller
 * polls by id rather than re-POSTing.
 *
 * `input.model` is ignored (the endpoint is fixed). `reference_images` is sent
 * ONLY when non-empty (an empty array is never sent, matching the Replicate path).
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

  let res: Response;
  try {
    res = await fetch(SEEDANCE_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: any) {
    throw new Error(`WaveSpeed submit request failed: ${err?.message || String(err)}`);
  }

  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body handled below */
  }

  if (!res.ok) {
    throw new Error(`WaveSpeed submit failed: ${providerErrorText(json, res.status)}`);
  }

  const data = unwrap(json);
  const id = data?.id;
  if (!id) {
    throw new Error(`WaveSpeed submit returned no task id: ${providerErrorText(json, res.status)}`);
  }
  return String(id);
}

/**
 * Fetch the current state of a WaveSpeed task, mapped into the shared
 * PredictionState type so the video worker's polling loop is unchanged.
 * - created/processing/queued → processing (still running)
 * - completed → succeeded, url = data.outputs[0] (no url if outputs empty, so
 *   the upper layer honestly fails + refunds — mirrors the Replicate version)
 * - failed/cancelled/timeout/deleted → failed | canceled with error text
 */
export async function getVideoPredictionState(id: string): Promise<PredictionState> {
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
    // Treat a transient GET failure as "still processing" is unsafe; surface it as failed
    // only for clearly terminal HTTP. For 5xx/timeouts, report processing so the loop retries.
    if (res.status >= 500 || res.status === 429) return { status: "processing", logs: null };
    throw new Error(`WaveSpeed result failed: ${providerErrorText(json, res.status)}`);
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

  // created / processing / queued (and anything unknown-but-non-terminal)
  const mapped: PredictionState["status"] = status === "created" || status === "queued" ? "starting" : "processing";
  return { status: mapped, logs };
}

/**
 * Best-effort cancellation of a WaveSpeed task. Unlike Replicate (where cancel
 * was mandatory for the refund path), WaveSpeed may not support cancellation, so
 * any error/404 is swallowed — the caller's cancel flow must never break.
 */
export async function cancelVideoPrediction(id: string): Promise<void> {
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
