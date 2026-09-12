import type { PredictionState } from "@/lib/replicate";

/**
 * Stage 47 — Kling 3.0 video client (Kling Open Platform, bearer API key).
 *
 * Endpoint choice (verified against https://kling.ai/document-api/api/video/3-0-omni, tab «Omni Video Generation»):
 *   POST {base}/omni-video/kling-3.0-omni — the only Kling 3.0 endpoint that accepts SEVERAL reference images
 *   (`contents[].type = "refer_image"`, up to KLING_MAX_REFERENCE_IMAGES when no reference video is sent).
 *   The legacy `/v1/videos/multi-image2video` route is kling-v1-6 only (retired 2026-09-15) and
 *   `/image-to-video/kling-3.0` takes a single first/last frame — neither fits our multi-reference pipeline.
 *   GET {base}/tasks?task_ids=<id> — status: submitted | processing | succeeded | failed, outputs[type=video].url.
 *   No cancel endpoint is documented → cancelKlingTask is a no-op.
 *
 * Every field name lives in the constants below (single place to adjust if the API changes).
 * The new-generation routes are served from api-singapore.klingai.com (api.klingai.com → 404 for /tasks);
 * override with KLING_API_BASE if Kling moves them.
 */
export const KLING_API_BASE_DEFAULT = "https://api-singapore.klingai.com";
export const KLING_CREATE_PATH = "/omni-video/kling-3.0-omni";
export const KLING_TASKS_PATH = "/tasks";
/** Persisted to Scene.videoModel / job state `model`. */
export const KLING_MODEL_NAME = "kling-v3";
export const KLING_ASPECT_RATIO = "9:16";
/** Cheapest Kling 3.0 output; Kling has no 480p tier. */
export const KLING_RESOLUTION = "720p";
/** Native speech + ambience baked in (same policy as Seedance generate_audio:true). */
export const KLING_AUDIO = "native";
/** Kling 3.0 duration enum: integers 3..15 s. */
export const KLING_MIN_DURATION = 3;
export const KLING_MAX_DURATION = 15;
/** «No reference video + only images»: reference images ≤ 7 (docs). */
export const KLING_MAX_REFERENCE_IMAGES = 7;

export const KLING_MISSING_KEY_MESSAGE = "Kling API key не настроен";

export interface KlingStartInput {
  prompt: string;
  negativePrompt?: string;
  /** Ordered list from buildScenePrompt ([Image1]..[ImageN]); the tail beyond the cap is dropped. */
  referenceImages: string[];
  durationSeconds: number;
  /** Kept for API symmetry; Kling 3.0 Omni has no std/pro switch (resolution selects the tier). */
  mode?: "std" | "pro";
}

export interface KlingContent {
  type: "prompt" | "refer_image";
  text?: string;
  url?: string;
  id?: string;
}

export interface KlingCreatePayload {
  contents: KlingContent[];
  settings: {
    aspect_ratio: string;
    duration: number;
    audio: string;
    resolution: string;
    multi_shot: boolean;
  };
  options: { watermark_info: { enabled: boolean } };
}

/** Clamp a planned clip length to Kling's integer 3..15 s enum. */
export function clampKlingDuration(seconds: number): number {
  const n = Math.round(Number.isFinite(seconds) ? seconds : KLING_MIN_DURATION);
  return Math.min(KLING_MAX_DURATION, Math.max(KLING_MIN_DURATION, n));
}

/** Russian note for the job state / UI when the scene was longer than Kling allows (null otherwise). */
export function klingDurationNote(requestedSeconds: number): string | null {
  const clamped = clampKlingDuration(requestedSeconds);
  return Math.round(requestedSeconds) > clamped ? `Kling: длительность ограничена ${clamped} с` : null;
}

/**
 * Stage 48 — Kling rejects prompts over 3072 characters (`contents[0].text: size must be between 0 and 3072`).
 * Our scene prompts are 12–14k chars, so the Kling branch compresses them to KLING_PROMPT_MAX_CHARS before
 * submission. The compression is pure SHORTENING: nothing is censored, softened or rephrased for policy —
 * every "[Image N]" mention and mapping, the beat order, all actions and every line of dialogue stay verbatim.
 * lib/scene-prompt.ts is untouched; the full prompt remains the source of truth for Seedance.
 */
export const KLING_PROMPT_MAX_CHARS = 3000;
/** Second (stricter) LLM target when the first pass still overshoots. */
export const KLING_PROMPT_RETRY_CHARS = 2700;
export const KLING_PROMPT_COMPRESSED_NOTE = `Kling: промпт сжат до ${KLING_PROMPT_MAX_CHARS} символов`;

export type KlingLlmFn = (system: string, user: string) => Promise<string>;

/**
 * Character budget handed to the LLM for the free text: the total limit minus the verbatim [ImageN] block,
 * with a 10 % safety margin because models overshoot character counts (observed in the Stage 48 probe).
 */
export function klingBodyLimit(totalLimit: number, reservedChars: number): number {
  return Math.max(500, Math.floor((totalLimit - reservedChars) * 0.9));
}

export interface KlingPromptFit {
  prompt: string;
  /** true when the LLM shortened the text (or truncation kicked in). */
  compressed: boolean;
  /** true when the sentence-boundary hard cut was needed. */
  truncated: boolean;
  /** Russian note for the job state / UI; undefined when the prompt was already short enough. */
  note?: string;
  originalChars: number;
}

function klingCompressionSystem(limit: number): string {
  return [
    "You shorten a video-generation prompt so it fits a strict character limit. You are an editor, not a censor.",
    `Rewrite the user's prompt in English as ONE compact paragraph of at most ${Math.max(4, Math.floor(limit / 160))} sentences, no more than ${Math.floor(limit / 8)} words and ${limit} characters in total (including spaces). This is a hard cap enforced by the video API: anything longer is rejected, so stay well below it.`,
    "Keep only what the camera must show: who is where, what they do in order, what they say, the place, light and mood.",
    "Rules:",
    "- Keep EVERY \"[Image N]\" mention and what each image refers to (character/location mapping) exactly as written.",
    "- Keep the order of beats/shots and every action; keep ALL dialogue lines verbatim, word for word, in quotes.",
    "- Condense camera and lighting descriptions; drop repetition and boilerplate; merge sentences.",
    "- Do NOT censor, soften, tone down, moralize or rephrase anything for policy reasons — only shorten.",
    "- No markdown, no headings, no bullet lists, no commentary — output ONLY the shortened prompt text.",
  ].join("\n");
}

/**
 * Hard cut at the last sentence boundary (. ! ? or newline) within `max` characters; falls back to a word
 * boundary and finally to a raw slice. Keeps a trailing "[Image N]" reference intact because the cut never
 * happens inside a sentence.
 */
export function truncateAtSentence(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  let cut = -1;
  for (const re of [/[.!?]["”)]?(?=\s)/g, /\n/g]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(head)) !== null) cut = Math.max(cut, m.index + m[0].length);
  }
  if (cut < max * 0.5) {
    const ws = head.lastIndexOf(" ");
    cut = ws > max * 0.5 ? ws : max;
  }
  return head.slice(0, cut).trim();
}

/**
 * Split the prompt into the free text and the trailing reference block buildScenePrompt appends
 * (`[Image1] …` lines, optionally followed by the location note). The block is never given to the LLM —
 * it is re-attached verbatim so the [ImageN] ↔ reference mapping can't drift or be cut off.
 * `imageCount` (Kling sends at most 7 references) drops the notes for images that are not submitted.
 */
export function splitKlingReferenceBlock(text: string, imageCount?: number): { body: string; refBlock: string } {
  const lines = text.trim().split("\n");
  const first = lines.findIndex((l) => /^\[Image\d+\]/.test(l.trim()));
  if (first < 0) return { body: text.trim(), refBlock: "" };
  const tail = lines.slice(first).filter((l) => {
    const m = /^\[Image(\d+)\]/.exec(l.trim());
    return !m || imageCount === undefined || Number(m[1]) <= imageCount;
  });
  return { body: lines.slice(0, first).join("\n").trim(), refBlock: tail.join("\n").trim() };
}

function joinKling(body: string, refBlock: string): string {
  return refBlock ? `${body.trim()}\n${refBlock}` : body.trim();
}

/**
 * Fit a prompt into Kling's limit. Injectable `llm` (system, user) → text so the logic is unit-testable.
 *   1. already ≤ KLING_PROMPT_MAX_CHARS → unchanged, no note;
 *   2. the free text is shortened by the LLM to fit next to the verbatim [ImageN] block (target ≤ 3000 total);
 *      if still too long → one retry on the LLM's own output asking for ≤ 2700 total;
 *   3. still too long (or LLM failed) → truncateAtSentence on the body, [ImageN] block re-attached, + note.
 */
export async function fitKlingPrompt(text: string, llm: KlingLlmFn, opts: { imageCount?: number } = {}): Promise<KlingPromptFit> {
  const original = text.trim();
  const originalChars = original.length;
  if (originalChars <= KLING_PROMPT_MAX_CHARS) return { prompt: original, compressed: false, truncated: false, originalChars };
  const { body, refBlock } = splitKlingReferenceBlock(original, opts.imageCount);
  const reserved = refBlock ? refBlock.length + 1 : 0;
  let candidate = "";
  let source = body;
  for (const limit of [KLING_PROMPT_MAX_CHARS, KLING_PROMPT_RETRY_CHARS]) {
    const bodyLimit = klingBodyLimit(limit, reserved);
    try {
      const out = (await llm(klingCompressionSystem(bodyLimit), source)).trim();
      if (out) {
        const joined = joinKling(out, refBlock);
        if (joined.length <= KLING_PROMPT_MAX_CHARS) {
          return { prompt: joined, compressed: true, truncated: false, note: KLING_PROMPT_COMPRESSED_NOTE, originalChars };
        }
        if (!candidate || out.length < candidate.length) candidate = out;
        source = out; // the retry shortens the LLM's own (already shorter) text further
      }
    } catch (e) {
      console.warn("[kling] prompt compression failed:", e instanceof Error ? e.message : String(e));
    }
  }
  // Hard cut on the body (the shortest LLM output we got, otherwise the original); the reference block stays whole.
  const prompt = joinKling(truncateAtSentence(candidate || body, KLING_PROMPT_MAX_CHARS - reserved), refBlock);
  return { prompt, compressed: true, truncated: true, note: KLING_PROMPT_COMPRESSED_NOTE, originalChars };
}

/** Keep buildScenePrompt's order, truncate the tail at the documented cap. */
export function capKlingReferences(urls: string[]): string[] {
  return urls.filter((u) => typeof u === "string" && u.trim()).slice(0, KLING_MAX_REFERENCE_IMAGES);
}

/**
 * Pure request-body builder (unit-tested). Reference ids are «Image1».. «ImageN» so they line up with the
 * [ImageN] notes buildScenePrompt already writes into the prompt; the prompt text itself is sent unchanged.
 * A negative prompt is appended as a second sentence because the Omni API carries positive and negative
 * descriptions inside the single prompt content.
 */
export function buildKlingPayload(input: KlingStartInput): KlingCreatePayload {
  const refs = capKlingReferences(input.referenceImages);
  const negative = (input.negativePrompt ?? "").trim();
  const text = negative ? `${input.prompt}\n\nAvoid: ${negative}` : input.prompt;
  return {
    contents: [
      { type: "prompt", text },
      ...refs.map((url, i) => ({ type: "refer_image" as const, url, id: `Image${i + 1}` })),
    ],
    settings: {
      aspect_ratio: KLING_ASPECT_RATIO,
      duration: clampKlingDuration(input.durationSeconds),
      audio: KLING_AUDIO,
      resolution: KLING_RESOLUTION,
      multi_shot: false,
    },
    options: { watermark_info: { enabled: false } },
  };
}

/** Kling task status → the PredictionState status the polling code already understands. */
export function mapKlingStatus(status: unknown): PredictionState["status"] {
  switch (String(status ?? "").toLowerCase()) {
    case "submitted": return "starting";
    case "processing": return "processing";
    case "succeed":
    case "succeeded": return "succeeded";
    case "failed": return "failed";
    default: return "processing";
  }
}

/**
 * Kling failure text → job error text. Platform «risk control» refusals are phrased so that
 * classifyProviderError() (lib/generation-diagnostics) files them under `moderation`, which routes them
 * into the existing provider-agnostic moderation message (no automatic rewrite, no extra filtering).
 */
export function mapKlingFailure(message: unknown): string {
  const text = String(message ?? "").trim() || "Kling task failed";
  if (/risk control|risk-control|content review|audit|moderation|sensitive|violat/i.test(text)) {
    return `Kling content moderation: ${text}`;
  }
  return `Kling: ${text}`;
}

/** Shape of the pieces of GET /tasks we read (the rest is ignored). */
export interface KlingTaskRecord {
  id?: string;
  status?: string;
  message?: string;
  create_time?: number;
  update_time?: number;
  outputs?: { type?: string; url?: string; duration?: string }[];
}

/** Pure mapper of one task record onto PredictionState (unit-tested). */
export function klingTaskToPredictionState(task: KlingTaskRecord | null | undefined): PredictionState {
  if (!task) return { status: "processing" };
  const status = mapKlingStatus(task.status);
  const video = (task.outputs ?? []).find((o) => o?.type === "video" && typeof o.url === "string" && o.url);
  const iso = (ms?: number) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  return {
    status,
    ...(status === "succeeded" && video?.url ? { url: video.url } : {}),
    ...(status === "failed" ? { error: mapKlingFailure(task.message) } : {}),
    startedAt: iso(task.create_time),
    completedAt: status === "succeeded" || status === "failed" ? iso(task.update_time) : null,
  };
}

/* ------------------------------------------------------------------------------------------------ */

function apiBase(): string {
  return (process.env.KLING_API_BASE ?? "").trim().replace(/\/+$/, "") || KLING_API_BASE_DEFAULT;
}

function apiKey(): string {
  const key = (process.env.KLING_API_KEY ?? "").trim();
  if (!key) throw new Error(KLING_MISSING_KEY_MESSAGE);
  return key;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Kling business codes that mean «retry later» (rate limit / concurrency / busy), on top of HTTP 429 & 5xx. */
const RETRYABLE_CODES = new Set([1302, 1303, 1304, 5000, 5001, 5002]);
const MAX_ATTEMPTS = 4;

interface KlingEnvelope<T> { code?: number; message?: string; request_id?: string; data?: T }

/** fetch + JSON envelope + exponential backoff on 429 / 5xx / retryable business codes. */
async function klingRequest<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const url = `${apiBase()}${path}`;
  const key = apiKey();
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt) await sleep(1500 * 2 ** (attempt - 1));
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      lastError = new Error(`Kling: сеть недоступна (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const text = await res.text();
    let json: KlingEnvelope<T> | null = null;
    try { json = JSON.parse(text) as KlingEnvelope<T>; } catch { json = null; }
    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`Kling HTTP ${res.status}: ${json?.message ?? (text.slice(0, 200) || "temporary error")}`);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Kling HTTP ${res.status}: ${json?.message ?? text.slice(0, 200)}`);
    }
    if (!json) throw new Error(`Kling: неожиданный ответ (${text.slice(0, 200)})`);
    if (json.code !== 0) {
      const msg = `Kling error ${json.code}: ${json.message ?? "unknown"}`;
      if (typeof json.code === "number" && RETRYABLE_CODES.has(json.code)) { lastError = new Error(msg); continue; }
      if (json.code === 1000 || json.code === 1001 || json.code === 1002 || json.code === 1003 || json.code === 1004) {
        throw new Error(`Kling: ключ API отклонён (${json.code}: ${json.message ?? ""})`);
      }
      throw new Error(msg);
    }
    return json.data as T;
  }
  throw lastError ?? new Error("Kling: запрос не удался");
}

/** Submit a Kling 3.0 Omni multi-reference video task → task id. */
export async function startKlingVideo(input: KlingStartInput): Promise<string> {
  const payload = buildKlingPayload(input);
  const data = await klingRequest<{ id?: string; task_id?: string; status?: string }>("POST", KLING_CREATE_PATH, payload);
  const id = data?.id ?? data?.task_id;
  if (!id) throw new Error("Kling: ответ без id задачи");
  return String(id);
}

/** Poll one task; mapped onto PredictionState so video-job.ts shares its Replicate polling loop. */
export async function getKlingTaskState(taskId: string): Promise<PredictionState> {
  const data = await klingRequest<KlingTaskRecord[] | KlingTaskRecord>("GET", `${KLING_TASKS_PATH}?task_ids=${encodeURIComponent(taskId)}`);
  const task = Array.isArray(data) ? data.find((t) => String(t?.id) === String(taskId)) ?? data[0] : data;
  if (!task) throw new Error("Kling: задача не найдена");
  return klingTaskToPredictionState(task);
}

/** The Kling Open Platform documents no cancel endpoint — nothing to do; the job is abandoned locally. */
export async function cancelKlingTask(_taskId: string): Promise<void> {
  return;
}
