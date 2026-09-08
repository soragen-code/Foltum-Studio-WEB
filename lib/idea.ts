/**
 * Stage 1 of the new flow: idea → synopsis + characters.
 *
 * Pure helpers (schemas, language detection, prompt builders, normalisation)
 * live here so they can be unit-tested without OpenAI. The routes in
 * app/api/ai/idea/* and app/api/ai/characters/* call `chatJSON` and then
 * validate through these schemas.
 */
import { z } from "zod";
import { sanitizeVideoPrompt } from "@/lib/sanitize-prompt";

/* ------------------------------------------------------------------ */
/*  Language                                                           */
/* ------------------------------------------------------------------ */

/** ISO 639-1 codes we recognise; anything else falls back to "en". */
export const SUPPORTED_LANGUAGES = ["ru", "en", "uk", "de", "fr", "es", "it", "pl", "pt", "tr"] as const;
export type IdeaLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * Cheap script-based detection used as a fallback / sanity check for the LLM's
 * own `language` answer. Cyrillic → "ru" (or "uk" when Ukrainian-only letters dominate).
 */
export function detectLanguage(text: string): IdeaLanguage {
  const t = (text ?? "").trim();
  if (!t) return "en";
  const letters = t.replace(/[^\p{L}]/gu, "");
  if (!letters) return "en";
  const cyr = (letters.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  if (cyr / letters.length > 0.4) {
    const ukOnly = (t.match(/[іїєґІЇЄҐ]/g) ?? []).length;
    const ruOnly = (t.match(/[ыэъЫЭЪ]/g) ?? []).length;
    return ukOnly > ruOnly && ukOnly >= 2 ? "uk" : "ru";
  }
  return "en";
}

export function normalizeLanguage(value: unknown, fallbackText: string): IdeaLanguage {
  const v = typeof value === "string" ? value.trim().toLowerCase().slice(0, 2) : "";
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(v)) return v as IdeaLanguage;
  return detectLanguage(fallbackText);
}

export const LANGUAGE_NAMES: Record<IdeaLanguage, string> = {
  ru: "Russian",
  en: "English",
  uk: "Ukrainian",
  de: "German",
  fr: "French",
  es: "Spanish",
  it: "Italian",
  pl: "Polish",
  pt: "Portuguese",
  tr: "Turkish",
};

/* ------------------------------------------------------------------ */
/*  Schemas                                                            */
/* ------------------------------------------------------------------ */

const str = (max: number) => z.string().trim().min(1).max(max);

export const characterCardSchema = z.object({
  name: str(120),
  age: z.union([z.string(), z.number()]).transform((v) => String(v).trim()).pipe(z.string().min(1).max(40)),
  role: str(120),
  appearance: str(2000),
  personality: str(2000),
  firstAppearance: str(1500),
});
export type CharacterCard = z.infer<typeof characterCardSchema>;

export const ideaResultSchema = z.object({
  language: z.string().optional(),
  synopsis: z.string().trim().min(80).max(12_000),
  characters: z.array(characterCardSchema).min(2).max(8),
});
export type IdeaResult = z.infer<typeof ideaResultSchema>;

export const synopsisReviseResultSchema = z.object({
  synopsis: z.string().trim().min(80).max(12_000),
  charactersChanged: z.boolean().optional().default(false),
  changeSummary: z.string().max(1000).optional().default(""),
  characters: z.array(characterCardSchema).min(2).max(8).optional(),
});
export type SynopsisReviseResult = z.infer<typeof synopsisReviseResultSchema>;

/* ------------------------------------------------------------------ */
/*  Normalisation                                                      */
/* ------------------------------------------------------------------ */

/** Strip markdown/markup the model may leak into a "plain paragraphs" synopsis. */
export function stripMarkup(text: string): string {
  return (text ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$|[.,;:!?])/g, "$1$2")
    .replace(/^[ \t]*[-*•][ \t]+/gm, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Sanitize a character card for originality: no real people / brands /
 * franchises in appearance; keep the character's own name.
 */
export function sanitizeCharacterCard(card: CharacterCard, keepNames: string[] = []): CharacterCard {
  const keep = [card.name, ...keepNames];
  return {
    ...card,
    appearance: sanitizeVideoPrompt(card.appearance, { keep }).prompt.trim() || card.appearance,
  };
}

export function normalizeIdeaResult(raw: unknown, ideaText: string): { language: IdeaLanguage; synopsis: string; characters: CharacterCard[] } {
  const parsed = ideaResultSchema.parse(raw);
  const synopsis = stripMarkup(parsed.synopsis);
  const language = normalizeLanguage(parsed.language, ideaText || synopsis);
  const names = parsed.characters.map((c) => c.name);
  const characters = parsed.characters.map((c) => sanitizeCharacterCard(c, names));
  return { language, synopsis, characters };
}

/* ------------------------------------------------------------------ */
/*  Prompts                                                            */
/* ------------------------------------------------------------------ */

const ORIGINALITY_RULES = `ORIGINALITY (strict):
- All characters are ORIGINAL. Never use or reference real people, celebrities, public figures, existing franchises, brands, trademarks or well-known fictional characters. Do not write "looks like <celebrity>".
- Names must be invented and plausible for the story's setting.`;

const CHARACTER_FIELD_RULES = `Character card fields (all REQUIRED, non-empty):
- "name": full name
- "age": age as text (e.g. "34" or "late 40s"), in the story language
- "role": role in the story (protagonist, antagonist, ally, mentor, etc.), in the story language
- "appearance": ALWAYS in ENGLISH, 2-3 sentences, concrete and photoreal: age, ethnicity/skin tone, build, face, hair, eyes, clothing style, distinguishing features. Used verbatim as a prompt for AI image generation.
- "personality": 2-3 sentences in the story language — traits, motivation, inner conflict
- "firstAppearance": 1-2 sentences in the story language — where and how the character first appears in the season`;

export function ideaSystemPrompt(): string {
  return `You are a head writer for a short-form vertical drama series.

From the user's idea produce a season synopsis and the main characters. Return ONLY valid JSON:
{
  "language": "<ISO 639-1 code of the language the idea is written in, e.g. \\"ru\\" or \\"en\\">",
  "synopsis": "<plain text, 3-6 short paragraphs separated by blank lines>",
  "characters": [ { "name": "...", "age": "...", "role": "...", "appearance": "...", "personality": "...", "firstAppearance": "..." } ]
}

LANGUAGE: detect the language of the idea and write synopsis, name, age, role, personality, firstAppearance in THAT language. Only "appearance" is in English.

SYNOPSIS: readable and compact (250-450 words). No headings, no markdown, no bullet lists, no labels like "Setup:". It must still convey the whole season arc: the setup (world, hero, hook), the development (rising stakes, relationships), the key turning points, and the finale of the season. Write it as prose a producer can read in one minute.

CHARACTERS: 3-6 characters, each visually distinct.
${CHARACTER_FIELD_RULES}

${ORIGINALITY_RULES}`;
}

export function ideaUserPrompt(idea: string): string {
  return `IDEA:\n${idea.trim()}`;
}

export function reviseSynopsisSystemPrompt(language: IdeaLanguage): string {
  const lang = LANGUAGE_NAMES[language] ?? "the same language as the current synopsis";
  return `You are a head writer revising a season synopsis of a short-form vertical drama series according to the producer's instruction.

Return ONLY valid JSON:
{
  "synopsis": "<the full revised synopsis>",
  "charactersChanged": <true if the instruction changes any character's name, age, role, appearance, personality or first appearance, or adds/removes a character; otherwise false>,
  "changeSummary": "<one short sentence in ${lang} describing what changed in the character list, or empty string>",
  "characters": [ <the FULL updated character list, only when charactersChanged is true; omit otherwise> ]
}

RULES:
- Keep the synopsis in ${lang} and keep the same format: plain prose, 3-6 short paragraphs separated by blank lines, no headings/markdown/bullets, 250-450 words. It must still cover setup, development, key turning points and the season finale.
- Apply ONLY what the instruction asks; keep everything else as close to the original as possible.
- When charactersChanged is true, return every character (existing ones minimally edited, plus additions/removals).
${CHARACTER_FIELD_RULES}

${ORIGINALITY_RULES}`;
}

export function reviseSynopsisUserPrompt(synopsis: string, characters: CharacterCard[], instruction: string): string {
  return `CURRENT SYNOPSIS:\n${synopsis}\n\nCURRENT CHARACTERS (JSON):\n${JSON.stringify(characters)}\n\nINSTRUCTION FROM PRODUCER:\n${instruction.trim()}`;
}

export function reviseCharacterSystemPrompt(language: IdeaLanguage): string {
  const lang = LANGUAGE_NAMES[language] ?? "the same language as the current card";
  return `You are a character designer for a short-form vertical drama series. Rewrite ONE character card according to the producer's instruction.

Return ONLY valid JSON with ALL fields:
{ "name": "...", "age": "...", "role": "...", "appearance": "...", "personality": "...", "firstAppearance": "..." }

RULES:
- name, age, role, personality, firstAppearance in ${lang}; "appearance" ALWAYS in English.
- Apply the instruction; keep everything the instruction does not touch as close to the original as possible (including the name unless asked to change it).
- Keep the card consistent with the synopsis.
${CHARACTER_FIELD_RULES}

${ORIGINALITY_RULES}`;
}

export function reviseCharacterUserPrompt(synopsis: string, card: CharacterCard, instruction: string): string {
  return `SYNOPSIS (context):\n${synopsis}\n\nCURRENT CARD (JSON):\n${JSON.stringify(card)}\n\nINSTRUCTION FROM PRODUCER:\n${instruction.trim()}`;
}

export function reviseAppearanceSystemPrompt(): string {
  return `You rewrite the "appearance" description of an ORIGINAL character used as a photoreal image-generation prompt.

Return ONLY valid JSON: { "appearance": "<2-3 English sentences>" }

RULES:
- Apply the producer's instruction (which may be in any language) to the current appearance; keep every detail the instruction does not touch.
- Always answer in ENGLISH, concrete and photoreal: age, ethnicity/skin tone, build, face, hair, eyes, clothing, distinguishing features.
${ORIGINALITY_RULES}`;
}

export function reviseAppearanceUserPrompt(card: { name: string; appearance: string }, instruction: string): string {
  return `CHARACTER: ${card.name}\nCURRENT APPEARANCE:\n${card.appearance}\n\nINSTRUCTION:\n${instruction.trim()}`;
}

/** Convert a DB character row into the card shape used by prompts (fills blanks). */
export function toCharacterCard(c: {
  name: string;
  age?: string | null;
  role?: string | null;
  appearance?: string | null;
  personality?: string | null;
  firstAppearance?: string | null;
  description?: string | null;
}): CharacterCard {
  return {
    name: c.name,
    age: c.age?.trim() || "—",
    role: c.role?.trim() || "—",
    appearance: c.appearance?.trim() || "—",
    personality: c.personality?.trim() || c.description?.trim() || "—",
    firstAppearance: c.firstAppearance?.trim() || "—",
  };
}
