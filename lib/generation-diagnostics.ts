export type FailureKind = "copyright_audio" | "copyright_video" | "copyright" | "moderation" | "overload" | "timeout" | "provider";

/** Retain the provider's wording and request IDs, but never credentials or signed URLs. */
export function safeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown provider error");
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:r8_[\w-]+|sk-[\w-]+)\b/g, "[redacted]")
    .replace(/((?:api[_-]?key|token|secret|authorization)["']?\s*[:=]\s*)["']?[^\s,}"']+/gi, "$1[redacted]");
}

export function classifyProviderError(error: unknown): FailureKind {
  const text = safeProviderError(error).toLowerCase();
  if (/\be003\b|high demand|overload|capacity|\b429\b/.test(text)) return "overload";
  if (/timed?\s*out|timeout/.test(text)) return "timeout";
  if (/copyright/.test(text)) {
    if (/output\s+audio|audio.*copyright/.test(text)) return "copyright_audio";
    if (/output\s+video|video.*copyright/.test(text)) return "copyright_video";
    return "copyright";
  }
  if (/moderation|content policy|sensitive|flagged|safety|risk|violat|nsfw|prohibited|blocked|not allowed/.test(text)) return "moderation";
  return "provider";
}

export interface GenerationAttempt {
  jobId?: string;
  sceneId?: string;
  characterId?: string;
  predictionId?: string;
  attempt: number;
  model: string;
  phase: "reference" | "video";
  status: string;
  style: string;
  language?: string;
  input: Record<string, unknown>; // Only scalar input + reference IDs; never media URLs.
  error?: string;
  errorKind?: FailureKind;
}

export function logAttempt(attempt: GenerationAttempt): void {
  console.info("[generation-attempt]", JSON.stringify(attempt));
}

export function safeDiagnosticInput(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input, (_key, value) => typeof value === "string" ? safeProviderError(value) : value));
}
