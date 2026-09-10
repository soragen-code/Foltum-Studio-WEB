/**
 * Stage 36 — hygiene for the manual per-scene prompt override.
 *
 * Producers paste LLM answers into the override verbatim, so the saved text used to carry a chatty
 * preamble ("Сделал проще: …") and a ```text … ``` Markdown fence — all of which was then submitted
 * to the video model as part of the prompt. `normalizePromptOverride` is a PURE function that keeps
 * only the prompt itself:
 *   1. if the text contains a fenced code block (``` or ```lang), ONLY the content of the first fence
 *      is kept (the fence markers are stripped);
 *   2. otherwise, if a line starts with a `[SECTION]` header such as `[SCENE]`, `[SHOT TYPE]` or
 *      `[ACTION]:`, everything before the first such header is dropped;
 *   3. the result is trimmed and runs of 3+ blank lines are collapsed to 2.
 * An empty / whitespace-only result means "no override" (the caller resets it to null).
 */

const FENCE_RE = /```[^\n`]*\n([\s\S]*?)```/;
/** A line that starts with an UPPERCASE bracket header like `[SCENE]`, `[SHOT TYPE]`, `[ACTION]:`. */
const SECTION_HEADER_RE = /^\s*\[[A-Z][A-Z0-9 _\-/&]*\]\s*:?/m;

export function normalizePromptOverride(text: string): string {
  let out = (text ?? "").replace(/\r\n?/g, "\n");

  const fence = FENCE_RE.exec(out);
  if (fence) {
    out = fence[1];
  } else {
    // Unterminated fence (``` opened but never closed): drop everything up to and including the opener.
    const openOnly = /```[^\n`]*\n/.exec(out);
    if (openOnly) out = out.slice(openOnly.index + openOnly[0].length);
    const header = SECTION_HEADER_RE.exec(out);
    if (header && header.index > 0) out = out.slice(header.index);
  }

  return out.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n").trim();
}
