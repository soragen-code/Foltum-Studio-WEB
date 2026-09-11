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
        ? { max_completion_tokens: budget, reasoning_effort: opts?.reasoningEffort ?? "medium" }
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
  return JSON.parse(stripJsonFences(raw)) as T;
}

/** Some models wrap JSON in ```json fences even in json mode — strip them before parsing. */
function stripJsonFences(raw: string): string {
  const m = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1] : raw;
}
