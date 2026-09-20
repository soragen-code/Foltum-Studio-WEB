/**
 * Stage 167 (task Stage 5+6 replacement) — SHOT PLANNING prompt + shared shot types.
 *
 * The SHOT is the atomic unit of generation, one level below the Scene. This LEAF module owns:
 *   - the shot data shape (PlannedShot) shared by the planner, validators and prompt assembler;
 *   - the enum value lists (shotType / size / postFx / line impact);
 *   - the LLM prompt that turns an approved scene/episode script into a shot list;
 *   - SHOT_PLAN_PROMPT_VERSION, stamped onto Shot.promptVersion.
 *
 * It imports NOTHING at runtime from lib/season.ts (only `import type`, erased at compile time), so
 * season.ts can hold the canonical numeric constants without a circular-dependency hazard. The numeric
 * bounds here are LITERAL mirrors of the season.ts constants, kept in step by scripts/test-stage167.ts.
 */
import type { EscalationStep } from "../season";

/** Bumped whenever the shot-plan prompt CONTRACT changes; written to Shot.promptVersion. */
export const SHOT_PLAN_PROMPT_VERSION = "6.2.0";

/* ───────────────────────── enum value lists ───────────────────────── */

export const SHOT_TYPES = ["dialogue", "reaction", "insert", "action", "establishing"] as const;
export type ShotType = (typeof SHOT_TYPES)[number];
export const isShotType = (v: unknown): v is ShotType =>
  typeof v === "string" && (SHOT_TYPES as readonly string[]).includes(v);

export const SHOT_SIZES = ["CU", "MCU", "MS", "WS"] as const;
export type ShotSize = (typeof SHOT_SIZES)[number];
export const isShotSize = (v: unknown): v is ShotSize =>
  typeof v === "string" && (SHOT_SIZES as readonly string[]).includes(v);

export const POSTFX_VALUES = ["slowmo", "punchZoom", "none"] as const;
export type PostFx = (typeof POSTFX_VALUES)[number];
export const isPostFx = (v: unknown): v is PostFx =>
  typeof v === "string" && (POSTFX_VALUES as readonly string[]).includes(v);

export const LINE_IMPACT_VALUES = ["low", "medium", "high"] as const;
export type LineImpact = (typeof LINE_IMPACT_VALUES)[number];
export const isLineImpact = (v: unknown): v is LineImpact =>
  typeof v === "string" && (LINE_IMPACT_VALUES as readonly string[]).includes(v);

/** Role a shot plays in the final-two cliffhanger. "arrival" = a power/force arrives; "strike" = it hits the heroine. */
export const CLIFFHANGER_ROLES = ["arrival", "strike"] as const;
export type CliffhangerRole = (typeof CLIFFHANGER_ROLES)[number];

/** Default cliffhanger type used when the season map supplies none (Stage 3 not built yet). */
export const DEFAULT_CLIFFHANGER_TYPE = "expectationFlip";

/* ───────────────────────── numeric mirrors (of season.ts) ───────────────────────── */

export const STAGE167_SHOT_MIN_SEC = 1.5;
export const STAGE167_SHOT_MAX_SEC = 4;
export const STAGE167_REACTION_MIN_SEC = 0.8;
export const STAGE167_REACTION_MAX_SEC = 1.5;
export const STAGE167_MIN_SHOTS = 15;
export const STAGE167_MAX_SHOTS = 30;
export const STAGE167_EP_TOTAL_MIN = 60;
export const STAGE167_EP_TOTAL_MAX = 90;
export const STAGE167_LINE_MAX_WORDS = 12;
export const STAGE167_MIN_SILENT_RATIO = 0.3;

/* ───────────────────────── shared shot shape ───────────────────────── */

/**
 * One planned shot — the shape the planner produces, the validators check and the prompt assembler
 * consumes. Everything the DB Shot row needs is here plus the transient planning-only fields
 * (`lineImpact`, `cliffhangerRole`, `cliffhangerType`) that drive validation but are not persisted.
 */
export interface PlannedShot {
  /** 0-based order within the episode's whole shot list (shots span 1–2 scenes). */
  index: number;
  /** Which scene (1-based scene number) this shot belongs to. */
  sceneNumber: number;
  shotType: ShotType;
  size: ShotSize;
  /** Clip length in seconds (1.5–4 for a normal shot; 0.8–1.5 for a reaction shot). */
  duration: number;
  /** Camera technique id (drives the "no adjacent size+camera repeat" rule + the CAMERA block). */
  camera: string;
  speakerId?: string | null;
  /** The spoken line (English) — empty / absent for a silent shot. */
  line?: string | null;
  /** How hard the line lands; a `high` line forces a reaction shot next. Planning-only. */
  lineImpact?: LineImpact | null;
  reactionOfId?: string | null;
  /** The scene escalation-ladder step this shot dramatizes. */
  escalationBeat: EscalationStep | string;
  postFx: PostFx;
  /** 1–2 phrases: pose / gaze / prop carried IN from the previous shot. */
  matchCutIn: string;
  /** 1–2 phrases: pose / gaze / prop carried OUT to the next shot. */
  matchCutOut: string;
  /** Final-two cliffhanger role (planning-only): "arrival" then "strike" makes an expectationFlip. */
  cliffhangerRole?: CliffhangerRole | null;
  /** Cliffhanger type this shot satisfies (from seasonMap, else DEFAULT_CLIFFHANGER_TYPE). Planning-only. */
  cliffhangerType?: string | null;
}

/* ───────────────────────── rule strings ───────────────────────── */

export const SHOT_COUNT_RULE =
  "SHOT COUNT & LENGTH: break the approved script into 15–30 SHOTS across its 1–2 scene-locations. " +
  "Each normal shot runs a VARIABLE 1.5–4 s; a REACTION shot right after a hard line runs a tight 0.8–1.5 s. " +
  "The sum of all shot durations must land between 60 and 90 s. Generation is STRICTLY sequential — the shots are an ordered chain.";

export const SHOT_OPENING_RULE =
  "OPENING (first 3 shots): the first THREE shots are dialogue or action shots — NO establishing shot and NO exposition. " +
  "Do not open on a wide of the room, a location card, a character arriving, or anyone explaining the situation. Start IN the conflict.";

export const SHOT_REACTION_RULE =
  "REACTIONS (cause before reaction): a reaction shot must come AFTER the shot that shows the thing it reacts to, never before it. After every line whose impact is HIGH — and after any strong non-verbal event (a slap, a reveal, a door opening) — the very NEXT shot is a REACTION shot (shotType \"reaction\") of 0.8–1.5 s on the character who RECEIVES that line or event (set \"reactionOfId\" to them): their face, no new line. Never place a character's reaction before the cause has been shown on screen.";

export const SHOT_SILENCE_RULE =
  "SILENCE: at least 30% of the shots carry NO spoken line — inserts, reactions and action beats that tell the story through image alone.";

export const SHOT_LINE_LENGTH_RULE =
  "LINES: every spoken line is AT OR UNDER 12 words. Short, sharp, alive. The dialogue is STRICTLY ENGLISH.";

export const SHOT_VARIETY_RULE =
  "VARIETY: two ADJACENT shots must never repeat the same size + camera combination — change the framing scale (CU / MCU / MS / WS) or the camera technique on every cut.";

export const SHOT_ESCALATION_RULE =
  "TENSION (advisory, not a gate): label each shot's \"escalationBeat\" with the beat of its scene it serves. The ladder (verbal → physicalLight → symbolic(keyProp) → physicalHeavy → statusReveal → thirdForce) is a TOOL for naming beats, not a track every scene must climb: a scene need not use a keyProp, hit every rung, or grow monotonically louder. Tension can come just as well from a refusal, a held pause, information withheld, a goal-shift or the stakes made plain — a scene may hold, reverse or ease and still work. When a scene supplies escalation beats, follow their order; otherwise pick the beat label that best fits each shot.";

export const SHOT_CLIFFHANGER_RULE =
  "LAST TWO SHOTS (cliffhanger): the final two shots form an EXPECTATION FLIP — the second-to-last shot shows a power / force ARRIVING (mark it cliffhangerRole \"arrival\"), and the last shot shows it STRIKING the heroine (mark it cliffhangerRole \"strike\"). " +
  "When the season map supplies a different cliffhangerType for this episode, build the last two shots to that type instead and set each shot's \"cliffhangerType\" accordingly; when the season map is absent, use the expectationFlip above.";

export const SHOT_FRAMING_RULE =
  "DIALOGUE FRAMING: a dialogue or reaction shot that carries a spoken line is NEVER a wide / establishing shot (WS) — it is an over-the-shoulder / medium / medium-close / close-up. No wide, group, aerial or high-angle shot while anyone is speaking.";

export const SHOT_GEOGRAPHY_RULE =
  "GEOGRAPHY & SPACE: keep the space consistent. Respect the layout established for the scene's location — where people and key objects stand relative to each other — and keep screen direction and eyelines stable across cuts (a character on the left keeps looking right at the character on the right; do not flip who is on which side between shots of the same exchange). When a shot refers to a character or an object, it must be one already placed in this scene's location; introduce no one and nothing the scene has not established. Only cross the line (reverse the geography) with a deliberate re-establishing shot.";

export const SHOT_SCENE_OPENING_RULE =
  "NEW-SCENE OPENING: the FIRST shot of each new scene (a new sceneNumber) re-establishes who is present and where — a close or medium shot on the character who speaks or acts first in that scene (not a wide of the empty room). This keeps the audience oriented after every location change while still obeying the DIALOGUE FRAMING rule.";

/* ───────────────────────── prompt builders ───────────────────────── */

export const SHOT_PLAN_SYSTEM =
  "You are a shot-list director for a short-form vertical (9:16) AI drama. You are given ONE episode's approved scenes " +
  "(each with its dialogue and action, plus — when the scene provides them — tension beats and a key prop). Break them into an ordered SHOT LIST — the shots are " +
  "the atomic units that get generated one by one, in order. Apply ALL of these rules:\n" +
  `- ${SHOT_COUNT_RULE}\n` +
  `- ${SHOT_OPENING_RULE}\n` +
  `- ${SHOT_REACTION_RULE}\n` +
  `- ${SHOT_SILENCE_RULE}\n` +
  `- ${SHOT_LINE_LENGTH_RULE}\n` +
  `- ${SHOT_VARIETY_RULE}\n` +
  `- ${SHOT_ESCALATION_RULE}\n` +
  `- ${SHOT_CLIFFHANGER_RULE}\n` +
  `- ${SHOT_FRAMING_RULE}\n` +
  `- ${SHOT_GEOGRAPHY_RULE}\n` +
  `- ${SHOT_SCENE_OPENING_RULE}\n` +
  "Return JSON: { \"shots\": [ { \"sceneNumber\": <int>, \"shotType\": \"dialogue|reaction|insert|action|establishing\", " +
  "\"size\": \"CU|MCU|MS|WS\", \"duration\": <seconds>, \"camera\": \"<technique>\", \"speakerId\": \"<id|null>\", " +
  "\"line\": \"<line|empty>\", \"lineImpact\": \"low|medium|high\", \"reactionOfId\": \"<id|null>\", " +
  "\"escalationBeat\": \"verbal|physicalLight|symbolic|physicalHeavy|statusReveal|thirdForce\", " +
  "\"postFx\": \"slowmo|punchZoom|none\", \"matchCutIn\": \"<1-2 phrases>\", \"matchCutOut\": \"<1-2 phrases>\", " +
  "\"cliffhangerRole\": \"arrival|strike|null\", \"cliffhangerType\": \"<type|null>\" }, … ] }. " +
  "Order the shots exactly as they play. Use the SAME speaker ids you are given; introduce no new speaker.";

/**
 * The user message for the shot-plan pass. `cliffhangerType` (from seasonMap, Stage 3 — read DEFENSIVELY)
 * names the required last-two-shots type; when absent the default expectationFlip is used.
 */
export function shotPlanUserPrompt(
  scenes: Array<{ number: number; action?: string | null; dialogue?: string | null; keyProp?: string | null; escalationBeats?: string[] | null }>,
  opts: { cliffhangerType?: string | null } = {}
): string {
  const body = scenes
    .map((s) => {
      const ladder = (s.escalationBeats ?? []).filter(Boolean).join(" → ") || "(none given — shape the tension however the scene calls for; no ladder required)";
      return [
        `SCENE ${s.number}:`,
        `  KEY PROP: ${(s.keyProp ?? "").trim() || "(none — use one only if it genuinely helps)"}`,
        `  TENSION BEATS: ${ladder}`,
        `  ACTION: ${(s.action ?? "").trim() || "(none)"}`,
        `  DIALOGUE:\n${(s.dialogue ?? "").trim() || "  [NO DIALOGUE]"}`,
      ].join("\n");
    })
    .join("\n\n");
  const cliff = (opts.cliffhangerType ?? "").trim() || DEFAULT_CLIFFHANGER_TYPE;
  return `Break these scenes into an ordered shot list per the rules. Required cliffhanger type for the last two shots: ${cliff}. Return only the JSON.\n\n${body}`;
}

/** Targeted retry note naming the FIRST failing shot-plan rule (appended to the brief on a validation failure). */
export function shotPlanRetryNote(failingRule: string): string {
  return `Your shot list failed this rule: ${failingRule}. Regenerate the WHOLE shot list and fix that rule while keeping every other rule satisfied.`;
}
