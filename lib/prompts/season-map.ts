/**
 * Stage 3 (task Stage 3 seasonMap) — SEASON MAP prompt + shared shot-map types.
 *
 * Before any episode is outlined, the whole season is given a deliberate SHAPE: one MAP CELL per episode
 * that fixes its dramatic beat, escalation step, cliffhanger, time-skip, locations and carried threads,
 * so the season has beat variety, secrets landing on schedule, cliffhangers that never repeat back-to-back
 * and a finale that resolves rather than opens. This LEAF module owns:
 *   - the map-cell shape (SeasonMapCell) shared by the prompt, the validators and the outline wiring;
 *   - the enum value lists (beatType / cliffhangerType / timeSkipBefore);
 *   - the LLM prompt that emits the seasonMap JSON honoring every rule;
 *   - SEASON_MAP_PROMPT_VERSION, persisted into Season.seasonMapVersion.
 *
 * It imports NOTHING at runtime from lib/season.ts (keeping it a leaf, like lib/prompts/shot-plan.ts):
 * numeric bounds are LITERAL mirrors kept in step by scripts/test-stage168.ts.
 */

/** Bumped whenever the season-map prompt CONTRACT changes; written to Season.seasonMapVersion. */
export const SEASON_MAP_PROMPT_VERSION = "6.3.0";

/* ───────────────────────── enum value lists ───────────────────────── */

/** The dramatic beat an episode delivers. */
export const BEAT_TYPES = ["humiliation", "falseVictory", "betrayal", "reveal", "nearMiss", "rescue", "choice"] as const;
export type BeatType = (typeof BEAT_TYPES)[number];
export const isBeatType = (v: unknown): v is BeatType =>
  typeof v === "string" && (BEAT_TYPES as readonly string[]).includes(v);

/** How the episode ends — the type of cliffhanger. */
export const CLIFFHANGER_TYPES = ["reveal", "threat", "choice", "betrayal", "arrival"] as const;
export type CliffhangerType = (typeof CLIFFHANGER_TYPES)[number];
export const isCliffhangerType = (v: unknown): v is CliffhangerType =>
  typeof v === "string" && (CLIFFHANGER_TYPES as readonly string[]).includes(v);

/** The elapsed time BEFORE this episode begins (relative to the previous one). */
export const TIME_SKIP_VALUES = ["none", "minutes", "hours", "days", "weeks"] as const;
export type TimeSkip = (typeof TIME_SKIP_VALUES)[number];
export const isTimeSkip = (v: unknown): v is TimeSkip =>
  typeof v === "string" && (TIME_SKIP_VALUES as readonly string[]).includes(v);

/* ───────────────────────── major-beat / finale classification (documented) ───────────────────────── */

/**
 * A MAJOR beat (drives the reveal/betrayal cadence rule) = the episode's beatType is a reveal/betrayal
 * OR its cliffhangerType is a reveal/betrayal. Documented interpretation: either signal counts, because
 * a betrayal delivered only in the cliffhanger still lands as a major turn for the audience.
 */
export const MAJOR_BEAT_TYPES: readonly BeatType[] = ["reveal", "betrayal"];
export const MAJOR_CLIFFHANGER_TYPES: readonly CliffhangerType[] = ["reveal", "betrayal"];

/**
 * RESOLVING beat types + CLOSING cliffhanger types — used by the finale rule. The last episode must land a
 * resolving beat (reveal / choice / rescue) AND a closing cliffhanger (reveal / choice) so the season's
 * central question is ANSWERED rather than a fresh thread opened (threat / betrayal / arrival all OPEN).
 */
export const RESOLVING_BEAT_TYPES: readonly BeatType[] = ["reveal", "choice", "rescue"];
export const CLOSING_CLIFFHANGER_TYPES: readonly CliffhangerType[] = ["reveal", "choice"];

/* ───────────────────────── long / short season threshold (documented) ───────────────────────── */

/** A season with MORE than this many episodes is LONG; at or below it is SHORT (mirrors the design brief). */
export const LONG_SEASON_MIN_EPISODES = 13; // > 12 episodes ⇒ long
/** SHORT season: a major reveal/betrayal at least every 3–4 episodes (upper spacing bound enforced = 4). */
export const SHORT_SEASON_MAJOR_CADENCE = 4;
/** LONG season: a major reveal/betrayal at least every 8–10 episodes (upper spacing bound enforced = 10). */
export const LONG_SEASON_MAJOR_CADENCE = 10;

/** True when the episode count makes this a LONG season (documented threshold). */
export function isLongSeason(episodeCount: number): boolean {
  return episodeCount >= LONG_SEASON_MIN_EPISODES;
}
/** The maximum allowed spacing (in episodes) between consecutive major beats for this season length. */
export function majorBeatCadence(episodeCount: number): number {
  return isLongSeason(episodeCount) ? LONG_SEASON_MAJOR_CADENCE : SHORT_SEASON_MAJOR_CADENCE;
}

/* ───────────────────────── shared map-cell shape ───────────────────────── */

/**
 * One season-map cell — the shape the LLM produces, the validators check and the episode-outline wiring
 * consumes. `escalationStep` references a step in the antagonist escalation ladder (from dramaBible in
 * Stage 1 — NOT built yet; a numeric 1..N derived from episode position is used as a defensive fallback).
 * `secretRevealed` references a dramaBible secret id/label; optional and tolerant of absence.
 */
export interface SeasonMapCell {
  /** 1-based episode number this cell governs. */
  episode: number;
  beatType: BeatType;
  /** Reference to a step in the escalation ladder (>=1). Fallback: the episode's 1-based position. */
  escalationStep: number;
  /** Optional reference to a secret id/label revealed this episode (dramaBible — tolerate absence). */
  secretRevealed?: string | null;
  cliffhangerType: CliffhangerType;
  timeSkipBefore: TimeSkip;
  /** 1–3 location names/ids in play this episode. */
  locations: string[];
  /** Thread labels/ids carried through this episode. */
  activeThreads: string[];
}

/**
 * The dramaBible slice the season map reads (Stage 1 — NOT built yet). Everything is optional so the map
 * generator and validators DEGRADE GRACEFULLY when the bible is absent (the common case right now).
 */
export interface DramaBibleForMap {
  /** The antagonist escalation ladder (ordered step labels). Absent → numeric fallback from episode index. */
  escalationLadder?: string[] | null;
  /** Secrets with the episode each must be revealed in. Absent/empty → the secret-reveal rule is skipped. */
  secrets?: Array<{ id: string; revealEpisode: number }> | null;
  /** The season's central dramatic question. Absent → the documented structural finale fallback applies. */
  finaleQuestion?: string | null;
  /** The secret whose reveal answers the finaleQuestion, if the bible designates one. */
  finaleSecretId?: string | null;
}

/* ───────────────────────── rule strings (shared with the prompt) ───────────────────────── */

export const MAP_BEAT_VARIETY_RULE =
  "BEAT VARIETY: give the season a deliberate mix of beat types (humiliation, falseVictory, betrayal, reveal, nearMiss, rescue, choice). Do not repeat the same beatType on many episodes in a row — vary the emotional shape episode to episode.";

export const MAP_CLIFFHANGER_RULE =
  "CLIFFHANGERS: no two CONSECUTIVE episodes may share the same cliffhangerType (reveal / threat / choice / betrayal / arrival). Each episode ends on a DIFFERENT kind of hook than the one before it.";

export const MAP_CADENCE_RULE =
  "MAJOR-TURN CADENCE: a MAJOR beat — beatType reveal or betrayal, OR cliffhangerType reveal or betrayal — must land at least every 3–4 episodes in a SHORT season (6–12 eps) and at least every 8–10 episodes in a LONG season (13+ eps). Never let the season coast for longer than that without a major turn.";

export const MAP_ESCALATION_RULE =
  "ESCALATION: escalationStep references the antagonist escalation ladder and RISES across the season — it never slides back down. Each episode is at least as high on the ladder as the one before it.";

export const MAP_SECRET_RULE =
  "SECRETS: when the story bible lists secrets with a designated revealEpisode, the cell for that episode MUST set secretRevealed to that secret's id — reveal each secret exactly in its scheduled episode, never earlier.";

export const MAP_FINALE_RULE =
  "FINALE: the LAST episode's cell must RESOLVE the season — a resolving beatType (reveal / choice / rescue) and a closing cliffhangerType (reveal / choice) that ANSWERS the central question rather than opening a new thread (threat / betrayal / arrival open, they do not close).";

export const MAP_SHAPE_RULE =
  "SHAPE: every cell has 1–3 locations and lists the activeThreads carried through that episode. timeSkipBefore is one of none / minutes / hours / days / weeks and marks the elapsed time before the episode begins.";

/* ───────────────────────── prompt builders ───────────────────────── */

export const SEASON_MAP_SYSTEM =
  "You are the showrunner of a short-form vertical (9:16) AI drama series. BEFORE the episodes are outlined, " +
  "you design the SEASON MAP: one cell per episode that fixes the season's deliberate structure. Apply ALL of these rules:\n" +
  `- ${MAP_BEAT_VARIETY_RULE}\n` +
  `- ${MAP_CLIFFHANGER_RULE}\n` +
  `- ${MAP_CADENCE_RULE}\n` +
  `- ${MAP_ESCALATION_RULE}\n` +
  `- ${MAP_SECRET_RULE}\n` +
  `- ${MAP_FINALE_RULE}\n` +
  `- ${MAP_SHAPE_RULE}\n` +
  "Return STRICT JSON: { \"seasonMap\": [ { \"episode\": <int>, " +
  "\"beatType\": \"humiliation|falseVictory|betrayal|reveal|nearMiss|rescue|choice\", " +
  "\"escalationStep\": <int>=1>, \"secretRevealed\": \"<secretId|null>\", " +
  "\"cliffhangerType\": \"reveal|threat|choice|betrayal|arrival\", " +
  "\"timeSkipBefore\": \"none|minutes|hours|days|weeks\", " +
  "\"locations\": [\"<name>\", ...1-3], \"activeThreads\": [\"<thread>\", ...] }, ... ] }. " +
  "Emit EXACTLY one cell per episode, in order 1..N. Use the location and thread names you are given; introduce no new characters.";

/** Render the dramaBible slice into the user prompt (or a defensive note when it is absent). */
function dramaBibleBlock(bible?: DramaBibleForMap | null): string {
  if (!bible) return "STORY BIBLE: (none yet — derive escalationStep from episode position 1..N; there are no scheduled secrets; resolve the finale structurally).";
  const ladder = (bible.escalationLadder ?? []).filter(Boolean);
  const secrets = (bible.secrets ?? []).filter((s) => s && s.id);
  const lines = [
    ladder.length ? `ESCALATION LADDER (rise through these): ${ladder.map((s, i) => `${i + 1}=${s}`).join(", ")}` : "ESCALATION LADDER: (none — use numeric 1..N by episode position)",
    secrets.length ? `SECRETS (reveal each in its episode): ${secrets.map((s) => `${s.id}@ep${s.revealEpisode}`).join(", ")}` : "SECRETS: (none scheduled)",
    bible.finaleQuestion ? `CENTRAL QUESTION (the finale must answer): ${bible.finaleQuestion}` : "CENTRAL QUESTION: (none given — resolve the finale structurally)",
  ];
  return `STORY BIBLE:\n${lines.map((l) => `  ${l}`).join("\n")}`;
}

/**
 * Build the user message for the season-map pass. `episodes` is the approved structure outline (or a light
 * list of episode numbers/titles); `bible` (Stage 1) is read DEFENSIVELY.
 */
export function seasonMapUserPrompt(
  episodes: Array<{ number: number; title?: string | null; logline?: string | null; locationName?: string | null }>,
  opts: { seasonLogline?: string | null; locations?: string[] | null; threads?: string[] | null; bible?: DramaBibleForMap | null } = {}
): string {
  const count = episodes.length;
  const seasonKind = isLongSeason(count) ? `LONG (${count} episodes — major turn at least every ${LONG_SEASON_MAJOR_CADENCE})` : `SHORT (${count} episodes — major turn at least every ${SHORT_SEASON_MAJOR_CADENCE})`;
  const epLines = episodes
    .map((e) => `  Ep.${e.number}${e.title ? ` «${e.title}»` : ""}${e.logline ? `: ${e.logline}` : ""}${e.locationName ? ` [loc: ${e.locationName}]` : ""}`)
    .join("\n");
  const locs = (opts.locations ?? []).filter(Boolean);
  const threads = (opts.threads ?? []).filter(Boolean);
  return [
    opts.seasonLogline ? `SEASON: ${opts.seasonLogline}` : "",
    `SEASON LENGTH: ${seasonKind}.`,
    dramaBibleBlock(opts.bible),
    locs.length ? `AVAILABLE LOCATIONS: ${locs.join(", ")}` : "",
    threads.length ? `THREADS TO CARRY: ${threads.join(", ")}` : "",
    `EPISODES:\n${epLines}`,
    `Design the season map: EXACTLY ${count} cells (one per episode, in order). Return only the JSON.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Targeted retry note naming the FIRST failing rule (appended to the brief on a validation failure). */
export function seasonMapRetryNote(failingRule: string): string {
  return `Your season map failed this rule: ${failingRule}. Regenerate the WHOLE season map, fix that rule and keep every other rule satisfied. Return exactly one cell per episode.`;
}

/**
 * The per-episode brief block appended to that episode's outline prompt so the outline FULFILLS its map
 * cell (beatType / cliffhangerType / timeSkipBefore / locations / activeThreads / secretRevealed). Pure;
 * returns "" for a missing cell so the outline prompt is unchanged for old (map-less) seasons.
 */
export function seasonMapCellBrief(cell?: SeasonMapCell | null): string {
  if (!cell) return "";
  const parts = [
    `SEASON-MAP CELL FOR THIS EPISODE (the outline MUST fulfil it):`,
    `- BEAT: deliver a "${cell.beatType}" beat as this episode's dramatic core.`,
    `- CLIFFHANGER: end on a "${cell.cliffhangerType}" cliffhanger.`,
    `- ESCALATION STEP: ${cell.escalationStep} (do not drop below the previous episode's step).`,
    `- TIME SKIP BEFORE: ${cell.timeSkipBefore}.`,
    cell.locations.length ? `- LOCATIONS: keep to ${cell.locations.join(", ")}.` : "",
    cell.activeThreads.length ? `- ACTIVE THREADS: carry ${cell.activeThreads.join(", ")}.` : "",
    cell.secretRevealed ? `- SECRET: reveal "${cell.secretRevealed}" in this episode.` : "",
  ];
  return parts.filter(Boolean).join("\n");
}
