import OpenAI from "openai";

let _client: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
    _client = new OpenAI({ apiKey });
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

/** Default (fast) model for utility calls: voiceover, translation, idea, frame-state, artifact images. */
const MODEL = "gpt-4o";
/**
 * Strong reasoning model used for SCRIPT generation (season structure, episode scripts, full story).
 * Reasoning models reject `max_tokens` (use `max_completion_tokens`) and any non-default `temperature`.
 */
export const SCRIPT_MODEL = "gpt-6-astra";

/** Reasoning-family models (gpt-5*, gpt-6*, o*) use a different parameter set than gpt-4o. */
export function isReasoningModel(model: string): boolean {
  return /^(gpt-6|gpt-5|o\d)/.test(model);
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

// ---------------------------------------------------------------------------
// Background (asynchronous) JSON generation via the Responses API.
//
// gpt-6-astra spends 5–10 minutes on one episode script. A synchronous call dies at ~300 s
// (Node undici headers timeout, regardless of the SDK timeout) and the Vercel function is killed
// at 800 s. In background mode OpenAI runs the generation server-side; we only store the response
// id and poll it from short requests (see lib/workers/season-script-job.ts).
// ---------------------------------------------------------------------------

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

/** Start a background JSON response. Returns the response id (poll it with pollBackgroundJSON). */
export async function startBackgroundJSON(system: string, user: string, opts?: BackgroundJSONOptions): Promise<string> {
  const openai = getOpenAI();
  const model = opts?.model ?? MODEL;
  const budget = opts?.maxTokens ?? 4096;
  // NOTE: `instructions:` does not satisfy json_object mode ("json" must appear in an input message) —
  // the system prompt is sent as an input message instead.
  const res = await openai.responses.create(
    {
      model,
      background: true,
      store: true,
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      text: { format: { type: "json_object" } },
      max_output_tokens: budget,
      ...(isReasoningModel(model)
        ? { reasoning: { effort: opts?.reasoningEffort ?? SCRIPT_REASONING_EFFORT } }
        : { temperature: opts?.temperature ?? 0.85 }),
    } as any,
    { timeout: 60_000, maxRetries: 2 },
  );
  return res.id;
}

/** Poll a background response: running / completed (parsed JSON) / failed (readable reason). */
export async function pollBackgroundJSON<T = any>(id: string): Promise<BackgroundPollResult<T>> {
  const openai = getOpenAI();
  const r: any = await openai.responses.retrieve(id, {}, { timeout: 60_000, maxRetries: 2 });
  const status = String(r.status ?? "");
  if (status === "queued" || status === "in_progress") return { status: "running" };
  if (status === "completed") {
    const raw = String(r.output_text ?? "");
    let json: T;
    try {
      json = safeJsonParse<T>(raw);
    } catch {
      return { status: "failed", error: `invalid JSON in response (${raw.length} chars)` };
    }
    const usage = r.usage
      ? { inputTokens: r.usage.input_tokens ?? 0, outputTokens: r.usage.output_tokens ?? 0, totalTokens: r.usage.total_tokens ?? 0 }
      : undefined;
    return { status: "completed", json, usage };
  }
  if (status === "incomplete") return { status: "failed", error: `response incomplete: ${r.incomplete_details?.reason ?? "unknown reason"}` };
  if (status === "cancelled") return { status: "failed", error: "response cancelled" };
  return { status: "failed", error: `response ${status || "failed"}: ${r.error?.message ?? r.error?.code ?? "unknown error"}` };
}

/** Cancel a background response (best effort — errors are swallowed). */
export async function cancelBackgroundResponse(id: string): Promise<void> {
  try {
    await getOpenAI().responses.cancel(id, { timeout: 30_000, maxRetries: 0 });
  } catch {}
}
