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

const MODEL = "gpt-4o";

/**
 * Hard per-request time cap. Without this the OpenAI SDK falls back to its 10-minute default
 * timeout, so a single stalled generation can sit "processing" for ~600 s (the mini-trailer bug:
 * one hung call reaching the default timeout, the progress bar frozen). A generous 4-minute cap
 * still comfortably fits every real gpt-4o generation while turning a hang into a fast, clear failure.
 */
const DEFAULT_TIMEOUT_MS = 240_000;
/** One retry on transient errors (down from the SDK default of 2) — fail fast instead of stacking long waits. */
const DEFAULT_MAX_RETRIES = 1;

export type ChatOptions = {
  temperature?: number;
  maxTokens?: number;
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
  const res = await openai.chat.completions.create(
    {
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: opts?.temperature ?? 0.85,
      max_tokens: opts?.maxTokens ?? 4096,
      ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
    },
    { timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxRetries: opts?.maxRetries ?? DEFAULT_MAX_RETRIES },
  );
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
  return JSON.parse(raw) as T;
}
