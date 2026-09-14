/**
 * Stage 40 — automatic project names. The producer is never asked for a title: a project is created
 * with a placeholder and renamed as soon as the story exists — from the LLM's short `title` (idea →
 * synopsis step, or the test-scene step), else derived from the first words of the idea / prompt.
 */

export const PLACEHOLDER_PROJECT_NAME = "New project";
export const PROJECT_NAME_MAX = 40;

/** True when the project still carries the placeholder (or an empty) name, i.e. may be auto-renamed. */
export function isPlaceholderProjectName(name: string | null | undefined): boolean {
  const n = (name ?? "").trim();
  return !n || n === PLACEHOLDER_PROJECT_NAME || /^новый проект(\s*\d+)?$/i.test(n) || /^(untitled|new project)(\s*\d+)?$/i.test(n);
}

/** Clean an LLM-produced title: strip quotes / trailing punctuation, collapse spaces, cap the length. */
export function cleanTitle(raw: string | null | undefined): string {
  let t = (raw ?? "").replace(/\s+/g, " ").trim();
  t = t.replace(/^["'«»“”‘’`*_\s]+|["'«»“”‘’`*_.\s]+$/g, "").trim();
  if (!t) return "";
  if (t.length > PROJECT_NAME_MAX) {
    const cut = t.slice(0, PROJECT_NAME_MAX);
    t = (cut.includes(" ") ? cut.slice(0, cut.lastIndexOf(" ")) : cut).replace(/[\s,;:—-]+$/g, "") + "…";
  }
  return t;
}

/**
 * Short fallback title from the plot text itself: the first sentence, cut to ≤ ~5 words / 40 chars.
 * Used when the model returned no title.
 */
export function deriveProjectName(text: string | null | undefined, maxWords = 5): string {
  const plain = (text ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!plain) return "";
  const firstSentence = plain.split(/(?<=[.!?…])\s+/)[0] ?? plain;
  const words = firstSentence.replace(/^[\s"'«»“”\-—–*#]+/, "").split(" ").filter(Boolean).slice(0, maxWords);
  let title = words.join(" ").replace(/[\s,;:.!?…"'«»“”\-—–]+$/g, "");
  if (title.length > PROJECT_NAME_MAX) title = title.slice(0, PROJECT_NAME_MAX).replace(/\s+\S*$/, "") + "…";
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : "";
}

/** The name to store: the model's title when usable, else the derived one, else the placeholder. */
export function resolveProjectName(title: string | null | undefined, plotText: string | null | undefined): string {
  return cleanTitle(title) || deriveProjectName(plotText) || PLACEHOLDER_PROJECT_NAME;
}
