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

/** Cast tiers (stage 3). CROWD = a named group (family at the table, port workers, protesters…). */
export const CHARACTER_TIERS = ["MAIN", "SUPPORTING", "MINOR", "CROWD"] as const;
export type CharacterTier = (typeof CHARACTER_TIERS)[number];
export const TIER_LABELS: Record<CharacterTier, string> = { MAIN: "Главные", SUPPORTING: "Второстепенные", MINOR: "Эпизодические", CROWD: "Массовка / группы" };
export function normalizeTier(v: unknown): CharacterTier {
  const t = typeof v === "string" ? v.trim().toUpperCase() : "";
  return (CHARACTER_TIERS as readonly string[]).includes(t) ? (t as CharacterTier) : "MAIN";
}

export const characterCardSchema = z.object({
  name: str(120),
  age: z.union([z.string(), z.number()]).transform((v) => String(v).trim()).pipe(z.string().min(1).max(40)),
  role: str(200),
  appearance: str(2500),
  personality: str(2000),
  firstAppearance: str(1500),
  tier: z.preprocess(normalizeTier, z.enum(CHARACTER_TIERS)).optional().default("MAIN"),
  groupSize: z.union([z.number(), z.string(), z.null()]).optional().transform((v) => {
    const n = typeof v === "string" ? parseInt(v, 10) : v;
    return typeof n === "number" && Number.isFinite(n) && n >= 2 ? Math.min(500, Math.round(n)) : null;
  }),
});
export type CharacterCard = z.infer<typeof characterCardSchema>;

/** A key location of the season: name/description in the story language, visualPrompt in English (no people). */
export const locationCardSchema = z.object({
  name: str(120),
  description: str(2000),
  visualPrompt: str(2500),
});
export type LocationCard = z.infer<typeof locationCardSchema>;

export const MAX_CAST = 60;

export const ideaResultSchema = z.object({
  language: z.string().optional(),
  /** Stage 40: short series title (≤ 4 words, story language) — becomes the project name automatically. */
  title: z.string().max(120).optional().nullable(),
  synopsis: z.string().trim().min(80).max(12_000),
  characters: z.array(characterCardSchema).min(2).max(MAX_CAST),
  locations: z.array(locationCardSchema).max(16).optional().default([]),
});
export type IdeaResult = z.infer<typeof ideaResultSchema>;

/** Second idea call / «Добавить ещё персонажей»: extra cast members only. */
export const castExpansionSchema = z.object({
  characters: z.array(characterCardSchema).min(1).max(MAX_CAST),
});

export const synopsisReviseResultSchema = z.object({
  synopsis: z.string().trim().min(80).max(12_000),
  charactersChanged: z.boolean().optional().default(false),
  changeSummary: z.string().max(1000).optional().default(""),
  characters: z.array(characterCardSchema).min(2).max(MAX_CAST).optional(),
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

/** Sanitize a location card: the English visual prompt must stay original (no brands / real landmarks by name). */
export function sanitizeLocationCard(card: LocationCard): LocationCard {
  return { ...card, visualPrompt: sanitizeVideoPrompt(card.visualPrompt, { keep: [card.name] }).prompt.trim() || card.visualPrompt };
}

/** Drop cast entries whose name duplicates an existing one (case-insensitive). */
export function dedupeCast<T extends { name: string }>(cards: T[], existing: string[] = []): T[] {
  const seen = new Set(existing.map((n) => n.trim().toLowerCase()));
  const out: T[] = [];
  for (const c of cards) {
    const k = c.name.trim().toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

export function normalizeIdeaResult(raw: unknown, ideaText: string): { language: IdeaLanguage; title: string; synopsis: string; characters: CharacterCard[]; locations: LocationCard[] } {
  const parsed = ideaResultSchema.parse(raw);
  const synopsis = stripMarkup(parsed.synopsis);
  const title = stripMarkup(parsed.title ?? "").replace(/\s+/g, " ").trim();
  const language = normalizeLanguage(parsed.language, ideaText || synopsis);
  const names = parsed.characters.map((c) => c.name);
  const characters = dedupeCast(parsed.characters).map((c) => sanitizeCharacterCard(c, names));
  const locations = dedupeCast(parsed.locations).map(sanitizeLocationCard);
  return { language, title, synopsis, characters, locations };
}

export function normalizeCastExpansion(raw: unknown, existingNames: string[]): CharacterCard[] {
  const parsed = castExpansionSchema.parse(raw);
  const names = [...existingNames, ...parsed.characters.map((c) => c.name)];
  return dedupeCast(parsed.characters, existingNames).map((c) => sanitizeCharacterCard(c, names));
}

/* ------------------------------------------------------------------ */
/*  Prompts                                                            */
/* ------------------------------------------------------------------ */

const ORIGINALITY_RULES = `ORIGINALITY (strict):
- All characters are ORIGINAL. Never use or reference real people, celebrities, public figures, existing franchises, brands, trademarks or well-known fictional characters. Do not write "looks like <celebrity>".
- Names must be invented and plausible for the story's setting.
- NAMES ARE WESTERN: every character gets an English-language / Western first name and surname (e.g. "Emily Carter", "Daniel Hayes", "Margaret Whitmore"), written in Latin letters even when the story language is Russian. NEVER Russian or Slavic names (no Иван, Марина, Петров, -ова/-ов surnames). The setting may be anywhere, but the cast is named Western.`;

const CHARACTER_FIELD_RULES = `Character card fields (all REQUIRED, non-empty):
- "name": full Western name in Latin letters (first name + surname), see ORIGINALITY
- "age": age as text (e.g. "34" or "late 40s"), in the story language
- "role": role in the story (protagonist, antagonist, ally, mentor, etc.), in the story language
- "appearance": ALWAYS in ENGLISH, 2-3 sentences, concrete and photoreal: age, ethnicity/skin tone, build, face, hair, eyes, clothing style, distinguishing features. Used verbatim as a prompt for AI image generation.
- "personality": 2-3 sentences in the story language — traits, motivation, inner conflict
- "firstAppearance": 1-2 sentences in the story language — where and how the character first appears in the season
- "tier": one of "MAIN" | "SUPPORTING" | "MINOR" | "CROWD"
- "groupSize": integer number of people, ONLY for CROWD groups (otherwise null)
Tier meaning: MAIN = leads carrying the season arc; SUPPORTING = recurring characters close to the leads — FAMILY MEMBERS (state the kinship in "role", e.g. "мать героини", "younger brother"), partners, colleagues, rivals; MINOR = episodic characters with a line or two (a nurse, a taxi driver, a neighbour); CROWD = a named GROUP that appears as a crowd (e.g. "Гости на свадьбе", "Рабочие порта", "Толпа у суда"). For CROWD: "name" is the group name, "age" is the age range, "appearance" describes the group as ONE photoreal wide shot in English (how many people, who they are, how they are dressed, typical postures), "personality" describes how the crowd behaves.`;

const LOCATION_FIELD_RULES = `Location card fields (all REQUIRED):
- "name": short name of the place in the story language (e.g. "Маяк на мысе", "Кухня семьи Орловых")
- "description": 2-3 sentences in the story language — what the place is, its several distinct ZONES the characters move between, and what happens there in the season. Make it a real, lived-in place, not a label.
- "visualPrompt": ALWAYS in ENGLISH, 3-4 sentences, concrete and photoreal: type of place, architecture/interior, its distinct zones and how far it extends (depth: foreground, mid-ground, deep background), materials, colours, time of day and lighting, weather, props and signs of everyday life (working machines, screens, papers, vehicles, plants) — but NO PEOPLE and no text/logos. Used verbatim as a prompt for an AI reference image (vertical 9:16 photograph).
- Locations must be ORIGINAL: no real landmarks, brands, or existing franchises by name.
- The SET of locations must be DIVERSE: mix interiors and exteriors, private and public places, intimate and large/spacious spaces, and different times of day — so the season never feels shot in one kind of room.`;

export const CAST_TARGETS = { MAIN: "3-5", SUPPORTING: "5-10", MINOR: "5-10", CROWD: "2-5" } as const;

export function ideaSystemPrompt(): string {
  return `You are a head writer for a short-form vertical drama series.

From the user's idea produce a season synopsis and the main characters. Return ONLY valid JSON:
{
  "language": "<ISO 639-1 code of the language the idea is written in, e.g. \\"ru\\" or \\"en\\">",
  "title": "<short catchy series title, 1-4 words, in the story language, no quotes>",
  "synopsis": "<plain text, 3-6 short paragraphs separated by blank lines>",
  "characters": [ { "name": "...", "age": "...", "role": "...", "appearance": "...", "personality": "...", "firstAppearance": "..." } ],
  "locations": [ { "name": "...", "description": "...", "visualPrompt": "..." } ]
}
Both arrays are REQUIRED ("locations" must contain 8-14 items).

LANGUAGE: detect the language of the idea and write synopsis, name, age, role, personality, firstAppearance in THAT language. Only "appearance" is in English.

SYNOPSIS: readable and compact (250-450 words). No headings, no markdown, no bullet lists, no labels like "Setup:". It must still convey the whole season arc: the setup (world, hero, hook), the development (rising stakes, relationships), the key turning points, and the finale of the season. Write it as prose a producer can read in one minute.

CHARACTERS: ${CAST_TARGETS.MAIN} MAIN characters only (tier "MAIN"), each visually distinct. The supporting cast, minor characters and crowds are produced in a separate step — do NOT include them here.
${CHARACTER_FIELD_RULES}

LOCATIONS: 8-14 distinct locations across the season (the leads' homes, workplaces, the central place of the story, transitional public places like streets, cafes, transport, and the finale's place). Diverse in type, scale and time of day; each visually distinct.
${LOCATION_FIELD_RULES}

${ORIGINALITY_RULES}`;
}

/**
 * Cast expansion: the second idea call (full supporting/minor/crowd cast) and the
 * «Добавить ещё персонажей» button (with the producer's hint).
 */
export function castExpansionSystemPrompt(language: IdeaLanguage, opts?: { hint?: string; countHint?: string }): string {
  const lang = LANGUAGE_NAMES[language] ?? "the story language";
  const what = opts?.hint?.trim()
    ? `Add NEW characters according to the producer's request below (${opts.countHint ?? "as many as the request implies, 1-12"}). Assign each the correct tier.`
    : `Produce the FULL extended cast around the existing main characters: ${CAST_TARGETS.SUPPORTING} SUPPORTING (must include the leads' family members with kinship in "role"), ${CAST_TARGETS.MINOR} MINOR and ${CAST_TARGETS.CROWD} CROWD groups.`;
  return `You are a head writer / casting director for a short-form vertical drama series.

${what}
Return ONLY valid JSON: { "characters": [ { "name": "...", "age": "...", "role": "...", "appearance": "...", "personality": "...", "firstAppearance": "...", "tier": "SUPPORTING" | "MINOR" | "CROWD" | "MAIN", "groupSize": <int or null> } ] }

RULES:
- Do NOT repeat or rename existing characters; every new character must have a unique name and be visually distinct.
- name, age, role, personality, firstAppearance in ${lang}; "appearance" ALWAYS in English.
- Ground every character in the synopsis: they must have a plausible reason to appear in the season.
${CHARACTER_FIELD_RULES}

${ORIGINALITY_RULES}`;
}

export function castExpansionUserPrompt(synopsis: string, existing: CharacterCard[], hint?: string): string {
  const list = existing.map((c) => `- ${c.name} (${c.tier}${c.groupSize ? `, ${c.groupSize} people` : ""}): ${c.role}, ${c.age}`).join("\n");
  return `SYNOPSIS:\n${synopsis}\n\nEXISTING CHARACTERS:\n${list || "(none)"}${hint?.trim() ? `\n\nPRODUCER'S REQUEST:\n${hint.trim()}` : ""}`;
}

export function reviseLocationSystemPrompt(language: IdeaLanguage): string {
  const lang = LANGUAGE_NAMES[language] ?? "the same language as the current card";
  return `You are a production designer for a short-form vertical drama series. Rewrite ONE location card according to the producer's instruction.

Return ONLY valid JSON with ALL fields: { "name": "...", "description": "...", "visualPrompt": "..." }

RULES:
- name and description in ${lang}; "visualPrompt" ALWAYS in English, no people, no text/logos.
- Apply the instruction; keep everything it does not touch as close to the original as possible (including the name unless asked).
${LOCATION_FIELD_RULES}`;
}

export function reviseLocationUserPrompt(synopsis: string, card: LocationCard, instruction: string): string {
  return `SYNOPSIS (context):\n${synopsis}\n\nCURRENT LOCATION (JSON):\n${JSON.stringify(card)}\n\nINSTRUCTION FROM PRODUCER:\n${instruction.trim()}`;
}

/** Location card generated from a bare name typed by the producer (manual add). */
/** Fallback when the idea call returned no locations: extract 8-14 key locations from the synopsis. */
export function locationsFromSynopsisSystemPrompt(language: IdeaLanguage): string {
  return `You are a production designer for a short-form vertical drama series. From the season synopsis and cast list 8-14 distinct locations across the season (the leads' homes, workplaces, the central place of the story, transitional public places, and the finale's place). Diverse in type, scale and time of day; each visually distinct.
Return ONLY valid JSON: { "locations": [ { "name": "...", "description": "...", "visualPrompt": "..." } ] }
LANGUAGE of "name" and "description": ${LANGUAGE_NAMES[language]}.
${LOCATION_FIELD_RULES}
${ORIGINALITY_RULES}`;
}
export const locationsResultSchema = z.object({ locations: z.array(locationCardSchema).min(1).max(16) });

export function locationFromNameSystemPrompt(language: IdeaLanguage): string {
  const lang = LANGUAGE_NAMES[language] ?? "the story language";
  return `You are a production designer. Given a season synopsis and the name (and optional note) of a location, write its card.
Return ONLY valid JSON: { "name": "...", "description": "...", "visualPrompt": "..." } — name and description in ${lang}, visualPrompt in English.
${LOCATION_FIELD_RULES}`;
}

export function ideaUserPrompt(idea: string): string {
  return `IDEA:\n${idea.trim()}`;
}

/* ------------------------------------------------------------------ */
/*  Auto-idea mode — the AI invents an original story from a genre     */
/* ------------------------------------------------------------------ */

/** Genres/directions the producer can pick in AUTO mode (id + Russian label + English descriptor for the model). */
export const GENRES = [
  { id: "detective", label: "Детектив", en: "detective / crime mystery" },
  { id: "horror", label: "Ужасы", en: "horror" },
  { id: "fantasy", label: "Магия / Фэнтези", en: "magic / fantasy" },
  { id: "scifi", label: "Сай-фай", en: "science fiction" },
  { id: "drama", label: "Драма", en: "drama" },
  { id: "thriller", label: "Триллер", en: "thriller / suspense" },
  { id: "romance", label: "Романтика", en: "romance" },
  { id: "comedy", label: "Комедия", en: "comedy" },
  { id: "adventure", label: "Приключения", en: "adventure" },
  { id: "postapoc", label: "Постапокалипсис", en: "post-apocalyptic" },
  { id: "mystery", label: "Мистика", en: "supernatural mystery" },
  { id: "action", label: "Боевик", en: "action" },
  { id: "historical", label: "Историческая драма", en: "historical drama" },
  { id: "melodrama", label: "Мелодрама", en: "melodrama / family saga" },
] as const;
export type GenreId = (typeof GENRES)[number]["id"];
export const GENRE_BY_ID: Record<string, (typeof GENRES)[number]> = Object.fromEntries(GENRES.map((g) => [g.id, g]));

/** Map incoming genre ids (or free labels) to English descriptors for the model, keeping unknown values as-is. */
export function genresToEnglish(genres: string[]): string[] {
  const out: string[] = [];
  for (const g of genres) {
    const key = (g ?? "").trim();
    if (!key) continue;
    const found = GENRE_BY_ID[key.toLowerCase()];
    out.push(found ? found.en : key);
  }
  return out;
}

export function ideaAutoSystemPrompt(language: IdeaLanguage): string {
  const lang = LANGUAGE_NAMES[language] ?? "Russian";
  return `You are an award-winning head writer for a short-form vertical drama series. The producer has NOT written a story — your job is to INVENT one from scratch in the chosen genre(s), then produce the season synopsis, the main characters and the locations. Return ONLY valid JSON:
{
  "language": "${language}",
  "title": "<short catchy series title, 1-4 words, in the story language, no quotes>",
  "synopsis": "<plain text, 3-6 short paragraphs separated by blank lines>",
  "characters": [ { "name": "...", "age": "...", "role": "...", "appearance": "...", "personality": "...", "firstAppearance": "..." } ],
  "locations": [ { "name": "...", "description": "...", "visualPrompt": "..." } ]
}
Both arrays are REQUIRED ("locations" must contain 8-14 items).

INVENT A GRIPPING, ORIGINAL STORY: a fresh premise with a strong hook, a clear protagonist with a want and a fear, an escalating conflict, real turning points and a season finale with a twist. It must honour the chosen genre(s). AVOID clichés and predictable, generic plots — no "chosen one wakes with amnesia", no tired tropes; surprise the viewer while staying coherent. Combine the genres if more than one is given.

LANGUAGE: write synopsis, name, age, role, personality, firstAppearance in ${lang}. Only "appearance" is in English. (The video model always voices the dialogue in English later — this is only the planning text.)

SYNOPSIS: readable and compact (250-450 words). No headings, no markdown, no bullet lists, no labels. It must convey the whole season arc: the setup (world, hero, hook), the development (rising stakes, relationships), the key turning points, and the finale of the season. Write it as prose a producer can read in one minute.

CHARACTERS: ${CAST_TARGETS.MAIN} MAIN characters only (tier "MAIN"), each visually distinct. The supporting cast, minor characters and crowds are produced in a separate step — do NOT include them here.
${CHARACTER_FIELD_RULES}

LOCATIONS: 8-14 distinct locations across the season (the leads' homes, workplaces, the central place of the story, transitional public places like streets, cafes, transport, and the finale's place). Diverse in type, scale and time of day; each visually distinct.
${LOCATION_FIELD_RULES}

${ORIGINALITY_RULES}`;
}

export function ideaAutoUserPrompt(genres: string[], extras?: string): string {
  const gl = genresToEnglish(genres);
  const genreLine = gl.length ? gl.join(", ") : "director's choice — pick a compelling popular genre";
  const extra = extras?.trim();
  return `GENRE(S) / DIRECTION: ${genreLine}\n\nADDITIONAL WISHES FROM THE PRODUCER: ${extra ? extra : "(none — you have full creative freedom within the genre)"}\n\nInvent the original season now.`;
}

/**
 * Stage 12 — the producer uploaded a FINISHED story (parsed from .txt/.md/.docx/.pdf).
 * Treat that text as CANON: structure it into a season synopsis, main cast and locations,
 * rewriting its essence as LITTLE as possible and only filling genuine gaps.
 * Language is auto-detected from the uploaded story (passed in as `language`).
 */
export function ideaFromStorySystemPrompt(language: IdeaLanguage): string {
  const lang = LANGUAGE_NAMES[language] ?? "Russian";
  return `You are an award-winning head writer for a short-form vertical drama series. The producer has UPLOADED a finished story. Your job is NOT to invent a new plot — treat the uploaded story as CANON. Preserve its premise, characters, events, tone and ending. Structure it into a season synopsis, the main characters and the locations, rewriting the essence as LITTLE as possible and only filling genuine gaps (unnamed places, thin descriptions) so it can be produced. Return ONLY valid JSON:
{
  "language": "${language}",
  "title": "<short catchy series title, 1-4 words, in the story language, no quotes>",
  "synopsis": "<plain text, 3-6 short paragraphs separated by blank lines>",
  "characters": [ { "name": "...", "age": "...", "role": "...", "appearance": "...", "personality": "...", "firstAppearance": "..." } ],
  "locations": [ { "name": "...", "description": "...", "visualPrompt": "..." } ]
}
Both arrays are REQUIRED ("locations" must contain 8-14 items).

CANON FIDELITY: do NOT change the story's plot, characters or ending. Keep the same names, relationships and events. If the uploaded story lacks a detail needed for production (a location's look, a character's age), invent it in the SAME spirit — never contradict the source. Do not add new major plot lines.

LANGUAGE: write synopsis, name, age, role, personality, firstAppearance in ${lang} (the same language as the uploaded story). Only "appearance" is in English. (The video model always voices the dialogue in English later — this is only the planning text.)

SYNOPSIS: readable and compact (250-450 words), faithful to the uploaded story. No headings, no markdown, no bullet lists, no labels. Convey the whole season arc: setup, development, key turning points and the finale, exactly as in the source.

CHARACTERS: ${CAST_TARGETS.MAIN} MAIN characters (tier "MAIN") drawn from the uploaded story, each visually distinct. Supporting/minor cast and crowds are produced separately — do NOT include them here.
${CHARACTER_FIELD_RULES}

LOCATIONS: 8-14 distinct locations that appear in (or are strongly implied by) the uploaded story. Diverse in type, scale and time of day; each visually distinct.
${LOCATION_FIELD_RULES}

${ORIGINALITY_RULES}`;
}

export function ideaFromStoryUserPrompt(story: string): string {
  return `UPLOADED STORY (CANON — structure this, do not replace it):\n\n${story}\n\nStructure this uploaded story into the season synopsis, main cast and locations now, staying faithful to it.`;
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
{ "name": "...", "age": "...", "role": "...", "appearance": "...", "personality": "...", "firstAppearance": "...", "tier": "...", "groupSize": <int or null> }

RULES:
- name, age, role, personality, firstAppearance in ${lang}; "appearance" ALWAYS in English. Keep "tier" unless the instruction changes the character's importance.
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
  tier?: string | null;
  groupSize?: number | null;
}): CharacterCard {
  return {
    name: c.name,
    age: c.age?.trim() || "—",
    role: c.role?.trim() || "—",
    appearance: c.appearance?.trim() || "—",
    personality: c.personality?.trim() || c.description?.trim() || "—",
    firstAppearance: c.firstAppearance?.trim() || "—",
    tier: normalizeTier(c.tier),
    groupSize: c.groupSize ?? null,
  };
}

/** Prisma `data` fragment for a character card (shared by idea / revise / add routes). */
export function characterCardToData(c: CharacterCard) {
  return {
    name: c.name,
    age: c.age,
    role: c.role,
    appearance: c.appearance,
    personality: c.personality,
    firstAppearance: c.firstAppearance,
    description: c.firstAppearance,
    tier: c.tier ?? "MAIN",
    groupSize: c.tier === "CROWD" ? c.groupSize ?? 12 : null,
  };
}
