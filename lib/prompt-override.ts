/**
 * Stage 36 — hygiene for the manual per-scene prompt override.
 *
 * The manual override is the producer's own text and is submitted to the video model verbatim, so
 * `normalizePromptOverride` must NOT alter, filter or drop any of its content. It is a PURE function
 * that only performs whitespace hygiene:
 *   1. CRLF / CR line endings are normalized to LF;
 *   2. runs of 3+ blank lines are collapsed to a single blank line (2 newlines);
 *   3. the result is trimmed of leading / trailing whitespace.
 * No fenced-code unwrapping and no `[SECTION]`-preamble stripping are performed — whatever the producer
 * types is kept exactly. An empty / whitespace-only result means "no override" (the caller resets it
 * to null).
 */

export function normalizePromptOverride(text: string): string {
  const out = (text ?? "").replace(/\r\n?/g, "\n");
  return out.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n").trim();
}
