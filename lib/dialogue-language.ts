/**
 * Stage 8 (final) — project-level DIALOGUE LANGUAGE plumbing (default English).
 *
 * The whole scenario core produces ENGLISH dialogue by default. This leaf module carries the plumbing
 * that lets a project OPT IN to another dialogue language later WITHOUT changing any current behavior:
 *
 *   - normalizeDialogueLanguage(v) — coerce a raw value to a supported ISO-639-1 code, else "en".
 *   - getDialogueLanguage(project) — the pure resolver used EVERYWHERE (old rows with null → "en").
 *   - isEnglish(code)             — the "no-op" guard: when true, every branch below is current behavior.
 *   - dialogueLanguageLabel(code) — human-readable name for the LLM directive.
 *   - dialogueLanguageDirective(code) — the v6.8.0 instruction injected into generation prompts;
 *     for "en" it returns "" (a genuine no-op), so English projects get byte-identical prompts.
 *
 * PURE: no network / LLM / DB. Importable from prompt modules and workers alike (it imports nothing
 * from lib/season.ts, so it never creates a cycle).
 */

/** Bumped when the dialogue-language directive wording/contract changes; stamped where a version is needed. */
export const DIALOGUE_LANGUAGE_PROMPT_VERSION = "6.8.0";

/** The project default — English. Existing and new projects resolve here unless explicitly changed. */
export const DEFAULT_DIALOGUE_LANGUAGE = "en";

/** Supported dialogue languages (ISO-639-1 → English label). Additive: extend freely; unknown → "en". */
export const DIALOGUE_LANGUAGES: Record<string, string> = {
  en: "English",
  uk: "Ukrainian",
  ru: "Russian",
  es: "Spanish",
  pt: "Portuguese",
  fr: "French",
  de: "German",
  it: "Italian",
  tr: "Turkish",
  pl: "Polish",
  hi: "Hindi",
  ar: "Arabic",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
};

/**
 * Coerce any raw value to a supported dialogue-language code, defaulting to English. Accepts a bare code
 * ("uk"), a code with region ("uk-UA" → "uk"), or a full English label ("Ukrainian" → "uk"), all
 * case-insensitively. Anything unrecognized (null, "", garbage) → "en". Never throws. Pure.
 */
export function normalizeDialogueLanguage(v: unknown): string {
  if (typeof v !== "string") return DEFAULT_DIALOGUE_LANGUAGE;
  const raw = v.trim().toLowerCase();
  if (!raw) return DEFAULT_DIALOGUE_LANGUAGE;
  // bare code or region-tagged code ("uk", "uk-ua", "en_us")
  const code = raw.split(/[-_]/)[0];
  if (code in DIALOGUE_LANGUAGES) return code;
  // full English label ("ukrainian")
  const byLabel = Object.entries(DIALOGUE_LANGUAGES).find(([, label]) => label.toLowerCase() === raw);
  if (byLabel) return byLabel[0];
  return DEFAULT_DIALOGUE_LANGUAGE;
}

/** The pure resolver: read a project's dialogueLanguage, normalize it, default "en". Old rows → "en". */
export function getDialogueLanguage(project?: { dialogueLanguage?: string | null } | null): string {
  return normalizeDialogueLanguage(project?.dialogueLanguage ?? null);
}

/** True when the resolved code is English — the guard that keeps every language branch a no-op today. */
export function isEnglish(code: unknown): boolean {
  return normalizeDialogueLanguage(code) === DEFAULT_DIALOGUE_LANGUAGE;
}

/** Human-readable language name for a code (for LLM directives / prompt copy). Defaults to "English". */
export function dialogueLanguageLabel(code?: string | null): string {
  return DIALOGUE_LANGUAGES[normalizeDialogueLanguage(code)] ?? "English";
}

/**
 * The v6.8.0 generation directive injected into synopsis / season / episode-script prompts. It tells the
 * model to write ALL dialogue, character names and titles in the given language. For English it returns
 * "" — a genuine no-op, so English projects (the default) get exactly today's prompts and today's output.
 * Pure.
 */
export function dialogueLanguageDirective(code?: string | null): string {
  const norm = normalizeDialogueLanguage(code);
  if (norm === DEFAULT_DIALOGUE_LANGUAGE) return "";
  const label = dialogueLanguageLabel(norm);
  return (
    `DIALOGUE LANGUAGE: write ALL spoken dialogue, character names, and episode/season titles in ${label}. ` +
    `Keep stage directions, scene descriptions and any structured field keys in English. Dialogue must read ` +
    `naturally to a native ${label} speaker — do not transliterate English.`
  );
}
