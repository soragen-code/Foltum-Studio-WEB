import OpenAI from "openai";

let _client: OpenAI | null = null;

/**
 * All LLM traffic runs through WaveSpeed's OpenAI-compatible gateway
 * (https://llm.wavespeed.ai/v1) authenticated with WAVESPEED_API_KEY. OpenAI is no longer used
 * directly — the `OpenAI` SDK is kept only as an OpenAI-compatible HTTP client pointed at WaveSpeed.
 */
export function getOpenAI(): OpenAI {
  if (!_client) {
    const apiKey = process.env.WAVESPEED_API_KEY;
    if (!apiKey) throw new Error("WAVESPEED_API_KEY is not set");
    _client = new OpenAI({ apiKey, baseURL: "https://llm.wavespeed.ai/v1" });
  }
  return _client;
}

/**
 * Hard per-request time cap. Without this the OpenAI SDK falls back to its 10-minute default
 * timeout, so a single stalled generation can sit "processing" for ~600 s (the mini-trailer bug:
 * one hung call reaching the default timeout, the progress bar frozen). A generous 4-minute cap
 * still comfortably fits every real gpt-4o generation while turning a hang into a fast, clear failure.
 */
const DEFAULT_TIMEOUT_MS = 240_000;
/** One retry on transient errors (down from the SDK default of 2) — fail fast instead of stacking long waits. */
const DEFAULT_MAX_RETRIES = 1;

/** Default (fast) model for utility calls: voiceover, translation, idea, frame-state, artifact images (vision). */
const MODEL = "anthropic/claude-opus-5";
/**
 * Model used for SCRIPT generation (season structure, episode scripts, full story, scene breakdown).
 * Per user decision all script/plot writing is done by Claude Opus 5 via WaveSpeed. Anthropic models
 * REQUIRE `max_tokens` on every request (always sent by the chat/stream helpers below); they are NOT a
 * reasoning-family model in the OpenAI sense (isReasoningModel → false), so they take `temperature` + `max_tokens`.
 * The model may wrap JSON answers in ```json fences — safeJsonParse strips them.
 */
export const SCRIPT_MODEL = "anthropic/claude-opus-5";
/**
 * EPISODE SCRIPTS are also written by Claude Opus 5 (same model as SCRIPT_MODEL). Uses `temperature` +
 * `max_tokens`; the large budget keeps the shooting-script JSON from truncating.
 */
export const EPISODE_SCRIPT_MODEL = "anthropic/claude-opus-5";
/** Completion budget for one episode script on EPISODE_SCRIPT_MODEL. */
export const EPISODE_SCRIPT_MAX_TOKENS = 32000;
/** Sampling temperature for episode scripts. */
export const EPISODE_SCRIPT_TEMPERATURE = 0.7;

/**
 * Reasoning-family models (gpt-5*, gpt-6*, o*) use a different parameter set (max_completion_tokens,
 * no temperature). None of the current WaveSpeed models are reasoning-family, so this returns false for
 * anthropic/claude-opus-5 (the only model in use) — kept for forward-compatibility if a reasoning model is added.
 */
export function isReasoningModel(model: string): boolean {
  return /(^|\/)(gpt-6|gpt-5|o\d)/.test(model);
}

/** Default reasoning effort for SCRIPT generation (chat() and background responses). */
export const SCRIPT_REASONING_EFFORT: "low" | "medium" | "high" = "medium";

/** Token usage of the last chat() call — for diagnostics / smoke tests only. */
export let lastChatUsage: { model: string; promptTokens: number; completionTokens: number; totalTokens: number } | null = null;

export type ChatOptions = {
  /** Model override (default gpt-4o). Use SCRIPT_MODEL for long-form script writing. */
  model?: string;
  /** Sampling temperature — ignored (omitted) for reasoning models, which only accept the default. */
  temperature?: number;
  /** Completion budget: sent as `max_tokens` for gpt-4o, as `max_completion_tokens` for reasoning models
   *  (where reasoning tokens count toward it — give scripts a large budget). */
  maxTokens?: number;
  /** Reasoning effort for reasoning models (default "medium"); ignored for gpt-4o. */
  reasoningEffort?: "low" | "medium" | "high";
  json?: boolean;
  /** Per-request time cap in ms (overrides DEFAULT_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Per-request retry count (overrides DEFAULT_MAX_RETRIES). */
  maxRetries?: number;
};

/**
 * Generic chat completion helper.
 * Returns the text content of the first choice.
 */
export async function chat(
  system: string,
  user: string,
  opts?: ChatOptions
): Promise<string> {
  const openai = getOpenAI();
  const model = opts?.model ?? MODEL;
  const reasoning = isReasoningModel(model);
  const budget = opts?.maxTokens ?? 4096;
  const res = await openai.chat.completions.create(
    {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // Reasoning models: no temperature, `max_completion_tokens`, explicit reasoning effort.
      ...(reasoning
        ? { max_completion_tokens: budget, reasoning_effort: opts?.reasoningEffort ?? SCRIPT_REASONING_EFFORT }
        : { temperature: opts?.temperature ?? 0.85, max_tokens: budget }),
      ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
    },
    { timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxRetries: opts?.maxRetries ?? DEFAULT_MAX_RETRIES },
  );
  if (res.usage) {
    lastChatUsage = {
      model,
      promptTokens: res.usage.prompt_tokens,
      completionTokens: res.usage.completion_tokens,
      totalTokens: res.usage.total_tokens,
    };
  }
  return res.choices[0]?.message?.content?.trim() ?? "";
}

/**
 * JSON chat — parses the response automatically.
 */
export async function chatJSON<T = any>(
  system: string,
  user: string,
  opts?: ChatOptions
): Promise<T> {
  const raw = await chat(system, user, { ...opts, json: true });
  return safeJsonParse<T>(raw);
}

/** Some models wrap JSON in ```json fences even in json mode — strip them before parsing. */
export function stripJsonFences(raw: string): string {
  const m = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1] : raw;
}

/**
 * Attempt to repair a TRUNCATED JSON blob — the usual failure when a model hits its token cap and the
 * output stops mid-string ("Unterminated string in JSON at position …"). Walks the text tracking string
 * state and open braces/brackets, closes a dangling string, drops a trailing partial key/value/comma,
 * and closes every still-open structure. Returns the repaired text, or null when it does not look like JSON.
 */
export function repairTruncatedJson(input: string): string | null {
  let str = input.trim();
  if (!str || !/^[[{]/.test(str)) return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inString) str += '"'; // close the string the model was cut off in
  str = str.replace(/,\s*$/, ""); // drop a dangling comma left after the last complete item
  // If we're right after a "key": with no value, drop that partial pair so the object stays valid.
  str = str.replace(/,?\s*"[^"]*"\s*:\s*$/, "");
  while (stack.length) str += stack.pop();
  return str;
}

/**
 * Parse a model's JSON answer robustly. Strips ``` fences, then on a parse failure tries ONCE to repair a
 * truncated blob before giving up with a short, human-readable error (never the raw "Unterminated string …"
 * exception, which would otherwise reach the user verbatim). Callers still validate the shape with Zod.
 */
export function safeJsonParse<T = any>(raw: string): T {
  const cleaned = stripJsonFences(raw);
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const repaired = repairTruncatedJson(cleaned);
    if (repaired !== null) {
      try {
        return JSON.parse(repaired) as T;
      } catch {
        /* fall through to the friendly error */
      }
    }
    throw new Error(`The model returned an incomplete response (truncated JSON, ${cleaned.length} characters). Please try again.`);
  }
}

/**
 * Streaming chat completion — accumulates the delta chunks into the full text and returns it.
 * Streaming is used for LONG generations (script/plot writing) because a non-streaming request for a
 * multi-minute completion trips the Node undici headers timeout (~300 s) before the body arrives; a
 * streaming request keeps receiving chunks and never hits that wall. `max_tokens` is ALWAYS sent
 * (Anthropic models on WaveSpeed reject a request without it).
 */
export async function streamChatText(
  system: string,
  user: string,
  opts?: ChatOptions,
): Promise<string> {
  const openai = getOpenAI();
  const model = opts?.model ?? MODEL;
  const reasoning = isReasoningModel(model);
  const budget = opts?.maxTokens ?? 4096;
  const stream = await openai.chat.completions.create(
    {
      model,
      stream: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(reasoning
        ? { max_completion_tokens: budget, reasoning_effort: opts?.reasoningEffort ?? SCRIPT_REASONING_EFFORT }
        : { temperature: opts?.temperature ?? 0.85, max_tokens: budget }),
      ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
    },
    { timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxRetries: opts?.maxRetries ?? DEFAULT_MAX_RETRIES },
  );
  let text = "";
  for await (const chunk of stream) {
    text += chunk.choices[0]?.delta?.content ?? "";
  }
  return text.trim();
}

// ---------------------------------------------------------------------------
// Background (asynchronous) JSON generation.
//
// SCRIPT_MODEL / EPISODE_SCRIPT_MODEL (Claude Opus 5) spend minutes on the season structure / scene
// breakdown / episode script. WaveSpeed's gateway does NOT support the OpenAI Responses API
// (POST /v1/responses → HTTP 500), so there is no server-side background job to poll. Instead the
// "start" runs the full generation synchronously via STREAMING chat.completions (which survives the
// multi-minute wait, unlike a non-streaming call) and returns the completed JSON TEXT as the opaque
// "id"; the "poll" simply parses that stored text and reports completion immediately. The id/text is
// persisted between advances (see lib/workers/season-script-job.ts), so a later poll parses it instantly.
// The signatures are kept so callers written for the old Responses-API path work unchanged.
// ---------------------------------------------------------------------------

/** Sentinel prefix marking an "id" that actually carries the completed JSON text inline. */
const INLINE_RESULT_PREFIX = "inline-json:";

export type BackgroundJSONOptions = {
  model?: string;
  maxTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  temperature?: number;
};

export type BackgroundPollResult<T> =
  | { status: "running" }
  | { status: "completed"; json: T; usage?: { inputTokens: number; outputTokens: number; totalTokens: number } }
  | { status: "failed"; error: string };

/**
 * Run the JSON generation to completion (blocking, via streaming) and return the completed text as an
 * opaque "id" (prefixed with INLINE_RESULT_PREFIX). Poll it with pollBackgroundJSON, which parses it
 * immediately. Throws if the model returns empty output so the caller records a clean failure.
 */
export async function startBackgroundJSON(system: string, user: string, opts?: BackgroundJSONOptions): Promise<string> {
  const text = await streamChatText(system, user, {
    model: opts?.model ?? MODEL,
    maxTokens: opts?.maxTokens ?? 4096,
    reasoningEffort: opts?.reasoningEffort,
    temperature: opts?.temperature,
    json: true,
    // A single generation can run for minutes — give it the full function budget.
    timeoutMs: 780_000,
    maxRetries: 1,
  });
  if (!text) throw new Error("model returned empty output");
  return INLINE_RESULT_PREFIX + text;
}

/**
 * "Poll" a background result. Because startBackgroundJSON already ran the generation to completion, the
 * id carries the finished JSON text inline — parse and return it immediately (or a readable failure).
 */
export async function pollBackgroundJSON<T = any>(id: string): Promise<BackgroundPollResult<T>> {
  const raw = id.startsWith(INLINE_RESULT_PREFIX) ? id.slice(INLINE_RESULT_PREFIX.length) : id;
  if (!raw) return { status: "failed", error: "empty response" };
  try {
    return { status: "completed", json: safeJsonParse<T>(raw) };
  } catch {
    return { status: "failed", error: `invalid JSON in response (${raw.length} chars)` };
  }
}

/** No-op: the generation already completed in startBackgroundJSON, so there is nothing to cancel. */
export async function cancelBackgroundResponse(_id: string): Promise<void> {
  return;
}
