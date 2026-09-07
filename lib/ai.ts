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
 * Generic chat completion helper.
 * Returns the text content of the first choice.
 */
export async function chat(
  system: string,
  user: string,
  opts?: { temperature?: number; maxTokens?: number; json?: boolean }
): Promise<string> {
  const openai = getOpenAI();
  const res = await openai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: opts?.temperature ?? 0.85,
    max_tokens: opts?.maxTokens ?? 4096,
    ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
  });
  return res.choices[0]?.message?.content?.trim() ?? "";
}

/**
 * JSON chat — parses the response automatically.
 */
export async function chatJSON<T = any>(
  system: string,
  user: string,
  opts?: { temperature?: number; maxTokens?: number }
): Promise<T> {
  const raw = await chat(system, user, { ...opts, json: true });
  return JSON.parse(raw) as T;
}
