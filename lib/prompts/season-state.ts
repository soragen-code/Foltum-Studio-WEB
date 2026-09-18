/**
 * Stage 4 (task Stage 4) — the SEASON STATE prompt family.
 *
 * A season carries a live world-state (see SeasonStateData below). After each episode is approved a separate
 * LLM call takes the CURRENT state + the freshly approved episode script and returns the UPDATED state; the
 * next episode's prompt is built FROM this state instead of the old ~1200-char continuity text tail.
 *
 * This module is a LEAF: it only declares the state shape, the prompt strings and the version constant. It
 * NEVER imports lib/season.ts at runtime (avoids a circular import / TDZ). The zod schema, seeding, rendering,
 * contradiction validation and the generate→validate→retry loop live in lib/season-state.ts.
 */

/** Prompt family version persisted onto every SeasonState record (schema.prisma SeasonState.version). */
export const SEASON_STATE_PROMPT_VERSION = "6.5.0";

/* ────────────────────────────── the state shape ────────────────────────────── */

export interface SeasonStateCharacter {
  /** Stable id (cast id when known, else a slug of the name). */
  id: string;
  name: string;
  /** Where the character physically is at the end of the last approved episode. */
  location: string;
  /** Visible physical condition: injuries, exhaustion, pregnancy, disguise, etc. */
  physicalState: string;
  /** What the character is wearing right now (drives CHARACTER blocks downstream). */
  wardrobe: string;
  /** Facts / secrets this character currently KNOWS (used to catch "knows un-revealed info"). */
  knows: string[];
  /** The character's active goal going into the next episode. */
  wants: string;
  /** Relationship state toward other characters, keyed by the other character's name. */
  relationships: Record<string, string>;
  /** Where the character is on their arc, e.g. "denial", "commitment", "fallout". */
  arcStage: string;
}

export interface SeasonStateProp {
  /** Stable id / short name of the object (e.g. "burner-phone", "wedding-ring"). */
  id: string;
  /** Character NAME currently holding the prop, or null when it is not carried. */
  holder?: string | null;
  /** Where the prop is when not carried, or null. */
  location?: string | null;
  /** Condition: "intact", "broken", "destroyed", "hidden", "handed to X", etc. */
  state: string;
}

export interface PlantedSetup {
  /** The setup that has been planted and must pay off later. */
  setup: string;
  /** The episode number where the payoff is expected, or null when not yet scheduled. */
  payoffEpisode: number | null;
}

export interface SeasonStateData {
  characters: SeasonStateCharacter[];
  props: SeasonStateProp[];
  /** Story questions currently OPEN (unresolved). Closing one moves it out of this list. */
  openThreads: string[];
  /** Setups planted for a later payoff. */
  plantedSetups: PlantedSetup[];
  /** Facts the AUDIENCE has been shown (distinct from what each character knows). */
  revealedToAudience: string[];
  /** One-line description of the very last beat of the last approved episode (the continuity anchor). */
  lastSceneEndState: string;
}

/* ────────────────────────────── prompts ────────────────────────────── */

export const SEASON_STATE_UPDATE_SYSTEM = [
  "You are the CONTINUITY SHOWRUNNER for a serialized vertical (9:16) AI drama.",
  "You maintain a strict, machine-readable WORLD STATE for one season so that every following episode stays",
  "consistent: where each character is, what they wear, what they physically look like, what they KNOW, what",
  "they WANT, who they trust, which objects (props) exist and who holds them, which story threads are still",
  "open, which setups have been planted for a later payoff, and what the audience has been shown.",
  "",
  "You are given the CURRENT state (JSON) and the SCRIPT of the episode that was just approved. Return the",
  "UPDATED state that reflects everything that changed in that episode — and ONLY real changes; carry every",
  "unchanged fact forward verbatim. Never invent characters or props that do not appear in the inputs.",
  "",
  "Rules:",
  "- A character can be in exactly ONE location. Update location to where they end the approved episode.",
  "- Wardrobe / physicalState must match how the episode LEFT them (a change of clothes, a new injury, etc.).",
  "- Move a fact into a character's `knows` ONLY once they learn it on-screen in the script.",
  "- Move a fact into `revealedToAudience` once the audience is shown it, even if characters do not know it.",
  "- A prop's holder/location/state must reflect the last time it was seen; a destroyed prop stays destroyed.",
  "- Close an openThread (remove it) when the episode resolves it; add newly opened questions.",
  "- Keep plantedSetups; set payoffEpisode when the episode schedules or delivers the payoff.",
  "- lastSceneEndState is ONE line describing the final beat of the approved episode.",
  "",
  "Return ONE JSON object with EXACTLY these keys and no prose:",
  "{",
  '  "characters": [{"id","name","location","physicalState","wardrobe","knows":[],"wants","relationships":{},"arcStage"}],',
  '  "props": [{"id","holder"|null,"location"|null,"state"}],',
  '  "openThreads": [string],',
  '  "plantedSetups": [{"setup","payoffEpisode"|null}],',
  '  "revealedToAudience": [string],',
  '  "lastSceneEndState": string',
  "}",
].join("\n");

export interface SeasonStateUpdateUserInput {
  seasonTitle?: string | null;
  episodeNumber?: number | null;
  episodeTitle?: string | null;
  /** The current world-state, pretty-printed JSON (or a "seed" note for the first episode). */
  currentStateJson: string;
  /** The full approved episode script text. */
  episodeScript: string;
}

export function seasonStateUpdateUserPrompt(input: SeasonStateUpdateUserInput): string {
  const head = [
    input.seasonTitle ? `SEASON: ${input.seasonTitle}` : null,
    input.episodeNumber != null ? `APPROVED EPISODE: ${input.episodeNumber}${input.episodeTitle ? ` — ${input.episodeTitle}` : ""}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    head,
    "",
    "CURRENT WORLD STATE (JSON):",
    input.currentStateJson,
    "",
    "APPROVED EPISODE SCRIPT:",
    input.episodeScript,
    "",
    "Return the UPDATED world state as ONE JSON object with the exact keys listed in the system message.",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/**
 * Targeted retry note naming the first failing field/entity so the next attempt fixes exactly that problem.
 * `field` is the SeasonStateError.field from the contradiction validator (e.g. "characters[Anna].location").
 */
export function seasonStateRetryNote(field?: string | null): string {
  const target = field && field.trim() ? field.trim() : "shape";
  return [
    `Your previous state was rejected because of: ${target}.`,
    "Fix ONLY that problem, keep every other fact unchanged, and return the corrected JSON object with the",
    "exact keys from the system message and nothing else.",
  ].join("\n");
}
