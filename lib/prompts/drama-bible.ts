/**
 * Stage 1 (task Stage 1: dramaBible) — the structured STORY BIBLE shape + prompts.
 *
 * Before the prose synopsis is written, the story is pinned down as a structured BIBLE: its theme and
 * genre tropes, the protagonist's want/need/flaw arc, the antagonist's goal + pressure mechanism + a rising
 * escalation ladder, the scheduled secrets, the midpoint reversal, the central finale question, the B-line
 * and the key relationships. The prose synopsis is then DERIVED from this bible, and the bible is threaded
 * into every later prompt (season map, episode outlines, scripts) so the whole season stays coherent.
 *
 * This LEAF module owns:
 *   - the bible SHAPE (DramaBible + its sub-interfaces) shared by the prompt, the zod schema and the wiring;
 *   - the count bounds (LITERAL constants) the prompt states and the zod schema enforces — kept in step by
 *     scripts/test-stage169.ts;
 *   - the LLM prompts that emit the bible JSON and that write the prose synopsis FROM the bible;
 *   - the targeted retry note and the compact brief threaded into downstream prompts;
 *   - DRAMA_BIBLE_PROMPT_VERSION, persisted into Project.dramaBibleVersion.
 *
 * It imports NOTHING at runtime from lib/season.ts or lib/ai (keeping it a leaf, like lib/prompts/season-map.ts):
 * lib/drama-bible.ts (validators + generate loop) imports the shape/bounds/prompts from here, and the LLM call
 * is INJECTED so this stays offline-testable.
 */

/** Bumped whenever the drama-bible prompt CONTRACT changes; written to Project.dramaBibleVersion. */
export const DRAMA_BIBLE_PROMPT_VERSION = "6.4.0";

/* ───────────────────────── count bounds (LITERAL — mirrored by the zod schema + tests) ───────────────────────── */

/** genreTropes: 3–6 concrete genre tropes the season plays with. */
export const GENRE_TROPES_MIN = 3;
export const GENRE_TROPES_MAX = 6;
/** antagonist.escalationLadder: 5–7 ordered, rising pressure steps. */
export const ESCALATION_LADDER_MIN = 5;
export const ESCALATION_LADDER_MAX = 7;
/** secrets: 3–4 secrets, each with the episode it is revealed in. */
export const SECRETS_MIN = 3;
export const SECRETS_MAX = 4;

/* ───────────────────────── the bible shape ───────────────────────── */

/** The protagonist's dramatic arc: what they pursue, what they truly need, the flaw in the way, and the change. */
export interface DramaBibleProtagonist {
  want: string;
  need: string;
  flaw: string;
  arcStart: string;
  arcEnd: string;
}

/** The antagonist: their goal, HOW they apply pressure, and the ordered ladder of escalating pressure steps. */
export interface DramaBibleAntagonist {
  goal: string;
  pressureMechanism: string;
  /** Ordered, RISING pressure steps (ESCALATION_LADDER_MIN..MAX). Step i must be worse than step i-1. */
  escalationLadder: string[];
}

/** A secret with who knows it and the episode it must be revealed in. */
export interface DramaBibleSecret {
  secret: string;
  knownBy: string[];
  /** 1-based episode the secret is revealed in. */
  revealEpisode: number;
}

/** The B-line (secondary storyline): its own conflict and the characters it belongs to. */
export interface DramaBibleBLine {
  conflict: string;
  characters: string[];
}

/** A key relationship: the two parties, their dynamic and the tension running through it. */
export interface DramaBibleRelationship {
  a: string;
  b: string;
  dynamic: string;
  tension: string;
}

/** The structured story bible persisted to Project.dramaBible. */
export interface DramaBible {
  theme: string;
  /** GENRE_TROPES_MIN..MAX concrete genre tropes. */
  genreTropes: string[];
  protagonist: DramaBibleProtagonist;
  antagonist: DramaBibleAntagonist;
  /** SECRETS_MIN..MAX scheduled secrets. */
  secrets: DramaBibleSecret[];
  midpointReversal: string;
  finaleQuestion: string;
  bLine: DramaBibleBLine;
  relationships: DramaBibleRelationship[];
}

/* ───────────────────────── rule strings (shared with the prompt) ───────────────────────── */

export const BIBLE_THEME_RULE =
  "THEME: one clear controlling idea the whole season argues (a human truth, not a logline). Every arc and secret should serve it.";

export const BIBLE_TROPES_RULE =
  `GENRE TROPES: list ${GENRE_TROPES_MIN}-${GENRE_TROPES_MAX} concrete genre tropes the season deliberately plays with (recognisable devices, not vague adjectives).`;

export const BIBLE_PROTAGONIST_RULE =
  "PROTAGONIST ARC: give a WANT (the external goal they chase), a NEED (the truth they must learn), a FLAW (what blocks the need), an arcStart (who they are at the open) and an arcEnd (who they become) — the arcEnd must resolve the flaw.";

export const BIBLE_ANTAGONIST_RULE =
  `ANTAGONIST: a goal that directly collides with the protagonist's want, a concrete pressureMechanism (HOW they squeeze the protagonist), and an escalationLadder of ${ESCALATION_LADDER_MIN}-${ESCALATION_LADDER_MAX} ordered steps that RISE — each step is worse and higher-stakes than the one before, building toward the finale.`;

export const BIBLE_SECRETS_RULE =
  `SECRETS: exactly ${SECRETS_MIN}-${SECRETS_MAX} secrets. For each, state the secret, who knows it (knownBy), and the revealEpisode it is revealed in (a 1-based episode within the season). Stagger the reveals across the season — do not dump them all in one episode.`;

export const BIBLE_MIDPOINT_RULE =
  "MIDPOINT REVERSAL: a single decisive turn near the middle that flips the protagonist's situation (e.g. hunter becomes hunted, ally becomes enemy) and changes the terms of the conflict for the back half.";

export const BIBLE_FINALE_RULE =
  "FINALE QUESTION: the ONE dramatic question the whole season poses and the finale must ANSWER (phrase it as a question). One secret's reveal should answer it.";

export const BIBLE_BLINE_RULE =
  "B-LINE: a secondary storyline with its OWN conflict and the characters it belongs to — it should thematically rhyme with the main line, not be disconnected filler.";

export const BIBLE_RELATIONSHIPS_RULE =
  "RELATIONSHIPS: the key relationships as pairs (a, b) with their dynamic and the tension running through each — enough to power the season's interpersonal drama.";

/* ───────────────────────── bible generation prompt ───────────────────────── */

export const DRAMA_BIBLE_SYSTEM =
  "You are the showrunner and story architect of a short-form vertical (9:16) AI drama series. BEFORE any prose " +
  "synopsis is written, you design the STORY BIBLE — the structured backbone the whole season is built on. Apply ALL of these rules:\n" +
  `- ${BIBLE_THEME_RULE}\n` +
  `- ${BIBLE_TROPES_RULE}\n` +
  `- ${BIBLE_PROTAGONIST_RULE}\n` +
  `- ${BIBLE_ANTAGONIST_RULE}\n` +
  `- ${BIBLE_SECRETS_RULE}\n` +
  `- ${BIBLE_MIDPOINT_RULE}\n` +
  `- ${BIBLE_FINALE_RULE}\n` +
  `- ${BIBLE_BLINE_RULE}\n` +
  `- ${BIBLE_RELATIONSHIPS_RULE}\n` +
  "Be concrete and specific — no generic placeholders. Return STRICT JSON of exactly this shape:\n" +
  "{ \"theme\": \"<string>\", " +
  `\"genreTropes\": [\"<trope>\", ... ${GENRE_TROPES_MIN}-${GENRE_TROPES_MAX}], ` +
  "\"protagonist\": { \"want\": \"<string>\", \"need\": \"<string>\", \"flaw\": \"<string>\", \"arcStart\": \"<string>\", \"arcEnd\": \"<string>\" }, " +
  "\"antagonist\": { \"goal\": \"<string>\", \"pressureMechanism\": \"<string>\", " +
  `\"escalationLadder\": [\"<step>\", ... ${ESCALATION_LADDER_MIN}-${ESCALATION_LADDER_MAX}, rising] }, ` +
  `\"secrets\": [ { \"secret\": \"<string>\", \"knownBy\": [\"<character>\", ...], \"revealEpisode\": <int>=1> }, ... ${SECRETS_MIN}-${SECRETS_MAX} ], ` +
  "\"midpointReversal\": \"<string>\", \"finaleQuestion\": \"<string ending in ?>\", " +
  "\"bLine\": { \"conflict\": \"<string>\", \"characters\": [\"<character>\", ...] }, " +
  "\"relationships\": [ { \"a\": \"<character>\", \"b\": \"<character>\", \"dynamic\": \"<string>\", \"tension\": \"<string>\" }, ... ] }. " +
  "Write ALL fields in English. Every revealEpisode must be within the season's episode count.";

/**
 * Build the user message for the bible pass. The source may be a producer idea, an uploaded story, or a
 * genre brief; `episodeCount` bounds the secret schedule (revealEpisode must be within it).
 */
export function dramaBibleUserPrompt(opts: {
  idea?: string | null;
  genres?: string[] | null;
  episodeCount?: number | null;
}): string {
  const idea = (opts.idea ?? "").trim();
  const genres = (opts.genres ?? []).filter(Boolean);
  const n = typeof opts.episodeCount === "number" && opts.episodeCount > 0 ? opts.episodeCount : null;
  return [
    idea ? `STORY / IDEA:\n${idea}` : "STORY / IDEA:\n(none given — invent an original, concrete premise from the genre)",
    genres.length ? `GENRE(S): ${genres.join(", ")}` : "",
    n ? `SEASON LENGTH: ${n} episodes — every secret's revealEpisode MUST be between 1 and ${n}.` : "SEASON LENGTH: unspecified — keep every revealEpisode small (1-8).",
    "Design the story bible. Return only the JSON.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Targeted retry note naming the FIRST failing field (appended to the brief on a validation failure). */
export function dramaBibleRetryNote(failingField: string): string {
  return `Your story bible failed this requirement: ${failingField}. Regenerate the WHOLE bible, fix that requirement and keep every other rule satisfied. Return only the JSON.`;
}

/* ───────────────────────── prose synopsis FROM the bible ───────────────────────── */

export const SYNOPSIS_FROM_BIBLE_SYSTEM =
  "You are a professional screenwriter. You are given a STRUCTURED STORY BIBLE for a short-form vertical (9:16) " +
  "drama series. Write a rich, cinematic PROSE SYNOPSIS (300-600 words) that DERIVES DIRECTLY from the bible: it " +
  "must dramatize the theme, honour the protagonist's want/need/flaw arc, build the antagonist's escalating " +
  "pressure, plant and pay off the scheduled secrets in order, hinge on the midpoint reversal, pose the finale " +
  "question, and weave in the B-line and key relationships. Do NOT contradict the bible or invent conflicting " +
  "facts. Write in vivid, specific prose — no bullet lists. Return the synopsis as plain prose text.";

/** Render the bible into the user message for the prose-synopsis pass. */
export function synopsisFromBibleUserPrompt(bible: DramaBible): string {
  return `STORY BIBLE:\n${dramaBibleBrief(bible)}\n\nWrite the prose synopsis derived from this bible.`;
}

/* ───────────────────────── compact brief (threaded into downstream prompts) ───────────────────────── */

/**
 * A compact, human-readable rendering of the bible, threaded into the season-map / episode-outline / script
 * prompts so every later stage stays consistent with the bible. Pure; returns "" for a null/absent bible so
 * downstream prompts are UNCHANGED for old (bible-less) projects (backward compat).
 */
export function dramaBibleBrief(bible?: DramaBible | null): string {
  if (!bible) return "";
  const p = bible.protagonist;
  const a = bible.antagonist;
  const ladder = (a?.escalationLadder ?? []).filter(Boolean);
  const secrets = (bible.secrets ?? []).filter((s) => s && s.secret);
  const rels = (bible.relationships ?? []).filter((r) => r && r.a && r.b);
  const lines = [
    `THEME: ${bible.theme}`,
    (bible.genreTropes ?? []).filter(Boolean).length ? `GENRE TROPES: ${(bible.genreTropes ?? []).filter(Boolean).join(", ")}` : "",
    p ? `PROTAGONIST: wants ${p.want}; needs ${p.need}; flaw ${p.flaw}; arc ${p.arcStart} → ${p.arcEnd}.` : "",
    a ? `ANTAGONIST: goal ${a.goal}; pressure ${a.pressureMechanism}.` : "",
    ladder.length ? `ESCALATION LADDER (rising): ${ladder.map((s, i) => `${i + 1}=${s}`).join(", ")}` : "",
    secrets.length ? `SECRETS (reveal on schedule): ${secrets.map((s) => `"${s.secret}"@ep${s.revealEpisode}`).join("; ")}` : "",
    bible.midpointReversal ? `MIDPOINT REVERSAL: ${bible.midpointReversal}` : "",
    bible.finaleQuestion ? `FINALE QUESTION (the season must answer): ${bible.finaleQuestion}` : "",
    bible.bLine?.conflict ? `B-LINE: ${bible.bLine.conflict}${(bible.bLine.characters ?? []).filter(Boolean).length ? ` [${(bible.bLine.characters ?? []).filter(Boolean).join(", ")}]` : ""}` : "",
    rels.length ? `RELATIONSHIPS: ${rels.map((r) => `${r.a}–${r.b} (${r.dynamic}; tension: ${r.tension})`).join("; ")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}
