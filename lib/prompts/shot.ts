/**
 * Stage 167 (task Stage 5+6 replacement) — PER-SHOT video-model prompt assembly.
 *
 * Reuses the 9-block philosophy of lib/prompts/scene.ts, dropped one level to the SHOT. A shot prompt
 * is assembled from these ordered blocks (concrete scene/action/dialogue content FIRST, general rules
 * in a short TAIL):
 *
 *   1) STYLE        — global project style, one line (same for every shot of the season).
 *   2) LOCATION     — the shot's location name + light (lean for interior shots).
 *   3) CHARACTER    — ONLY the characters actually in frame; wardrobe from SeasonState with fallback.
 *   4) MATCH-CUT IN — 1–2 phrases: pose / gaze / prop carried from the previous shot.
 *   5) ACTION       — one micro-action.
 *   6) LINE         — only when the shot has a spoken line.
 *   7) CAMERA       — from the shotType→camera-technique table, honoring the dialogue-framing rule.
 *   8) MATCH-CUT OUT— 1–2 phrases carried to the next shot.
 *   9) NEGATIVE     — prohibitions + the no-WS-while-speaking ban.
 *
 * The long START-STATE / END-STATE descriptions are added ONLY for the FIRST and LAST shot of a scene
 * (interior shots stay lean). This module is PURE and imports NOTHING at runtime from lib/season.ts
 * (only `import type`), so it stays a leaf module. It reuses the Stage 164 framing rule + negatives
 * from lib/scene-prompt.ts for consistency with the scene-level prompt.
 */
import { DIALOGUE_FRAMING_RULE, buildNegatives } from "@/lib/scene-prompt";
import { normalizeDialogueLanguage, isEnglish, dialogueLanguageLabel } from "@/lib/dialogue-language";
import type { PlannedShot, ShotType, ShotSize } from "./shot-plan";
// Stage 4 (task Stage 4) — type-only import (erased at build; keeps this a leaf module) of the live
// world-state slice. When supplied, the CHARACTER block reads wardrobe / physicalState from it by name.
import type { SeasonStateLike } from "./scene";

/** Bumped whenever the shot-prompt block ordering / wording changes; written to Shot.promptVersion. */
export const SHOT_PROMPT_VERSION = "6.2.0";

/* ───────────────────────── shotType → camera table ───────────────────────── */

export interface ShotCamera {
  /** Camera technique id (stable; also used by the no-adjacent-repeat rule). */
  technique: string;
  /** Human-readable camera movement / framing description. */
  description: string;
  /** The default framing scale for this shot type. */
  defaultSize: ShotSize;
  /** Sizes this shot type is allowed to use (the FIRST is the default). */
  allowedSizes: ShotSize[];
}

/**
 * shotType → camera technique. It HONORS the dialogue-framing rule: dialogue / reaction shots only ever
 * use OTS / half-body / medium / medium-close / close-up (MS / MCU / CU) — never WS. Only establishing
 * shots are allowed a WS (and an establishing shot never carries a spoken line).
 */
export const SHOT_CAMERA_BY_TYPE: Record<ShotType, ShotCamera> = {
  dialogue: { technique: "ots-medium", description: "over-the-shoulder / medium-close, eye-level, holding on the speaker", defaultSize: "MCU", allowedSizes: ["MCU", "MS", "CU"] },
  reaction: { technique: "push-close", description: "a slow push to a close-up on the listener's face, eye-level", defaultSize: "CU", allowedSizes: ["CU", "MCU"] },
  insert: { technique: "static-detail", description: "a static detail insert on a prop / hand / object", defaultSize: "CU", allowedSizes: ["CU", "MCU"] },
  action: { technique: "handheld-track", description: "a handheld tracking move following the action", defaultSize: "MS", allowedSizes: ["MS", "MCU", "WS"] },
  establishing: { technique: "wide-lock", description: "a locked wide establishing frame of the whole space", defaultSize: "WS", allowedSizes: ["WS", "MS"] },
};

/** True when a shot type is a dialogue framing that must never be a WS while a line is spoken. */
export function isDialogueFramedShot(shotType: ShotType): boolean {
  return shotType === "dialogue" || shotType === "reaction";
}

/**
 * Resolve the final framing SIZE for a shot: a dialogue / reaction shot that carries a spoken line is
 * forced OFF WS onto its shot type's default framing (Stage 164 rule). Pure.
 */
export function resolveShotSize(shot: Pick<PlannedShot, "shotType" | "size" | "line">): ShotSize {
  const hasLine = !!(shot.line && shot.line.trim());
  if (isDialogueFramedShot(shot.shotType) && hasLine && shot.size === "WS") {
    return SHOT_CAMERA_BY_TYPE[shot.shotType].defaultSize;
  }
  return shot.size;
}

/* ───────────────────────── input types ───────────────────────── */

export interface ShotCharacterLike {
  characterId: string;
  name: string;
  tier?: string | null;
  appearance?: string | null;
  /** Live wardrobe from SeasonState (Stage 4) — falls back to appearance when absent. */
  wardrobe?: string | null;
}

export interface ShotPromptInput {
  style?: string | null;
  locationName?: string | null;
  locationLight?: string | null;
  /** Only the characters ACTUALLY in this shot's frame. */
  characters: ShotCharacterLike[];
  shot: PlannedShot;
  /** Long start-state text — supplied ONLY for the FIRST shot of a scene. */
  startState?: string | null;
  /** Long end-state text — supplied ONLY for the LAST shot of a scene. */
  endState?: string | null;
  /** True when this shot is the first shot of its scene (adds STATE-IN). */
  isSceneFirst?: boolean;
  /** True when this shot is the last shot of its scene (adds STATE-OUT). */
  isSceneLast?: boolean;
  dialogueLanguage?: string | null;
  /**
   * Stage 8: English translation of the SPOKEN line (drives native audio only — NOT subtitles, which
   * were removed). Video models understand English best, so when dialogueLanguage != "en" the LINE
   * block references THIS (English) for the model to voice, while the stored line stays in
   * dialogueLanguage. When "en" it is unused (line IS English).
   */
  lineTranslation?: string | null;
  /**
   * Stage 4 (task Stage 4) — the live SeasonState slice. When present the CHARACTER block prefers each
   * character's wardrobe / physicalState / location from here (matched by name) over the per-shot
   * ShotCharacterLike fallback. Absent/null → the block behaves exactly as before (appearance fallback).
   */
  seasonState?: SeasonStateLike | null;
}

const oneLine = (t?: string | null) => (t ?? "").replace(/\s+/g, " ").trim();

/* ───────────────────────── block builders ───────────────────────── */

export function shotStyleBlock(i: ShotPromptInput): string {
  const s = oneLine(i.style);
  return s ? `STYLE: ${s}` : "";
}

export function shotLocationBlock(i: ShotPromptInput): string {
  const name = oneLine(i.locationName);
  const light = oneLine(i.locationLight);
  if (!name && !light) return "";
  return `LOCATION: ${[name, light].filter(Boolean).join(" — ")}.`;
}

export function shotCharacterBlock(i: ShotPromptInput): string {
  const named = i.characters.filter((c) => c.tier !== "CROWD" && oneLine(c.name));
  if (!named.length) return "";
  const stateChars = i.seasonState?.characters ?? [];
  const findState = (name: string) => stateChars.find((s) => oneLine(s?.name).toLowerCase() === name.toLowerCase()) ?? null;
  const lines = named.map((c) => {
    const st = findState(oneLine(c.name));
    // SeasonState wardrobe wins, then the per-shot wardrobe, then the static appearance.
    const wardrobe = oneLine(st?.wardrobe) || oneLine(c.wardrobe) || oneLine(c.appearance);
    const physical = oneLine(st?.physicalState); // live physical condition from SeasonState, when present
    const look = oneLine(c.appearance);
    const bits = [
      look ? `look: ${look}` : "",
      wardrobe ? `wardrobe: ${wardrobe}` : "",
      physical ? `physical: ${physical}` : "",
    ].filter(Boolean);
    return `- ${c.name.trim()}${bits.length ? ` — ${bits.join("; ")}` : ""}.`;
  });
  return `CHARACTERS (only these people are in frame):\n${lines.join("\n")}`;
}

/** STATE-IN — the long start-state, ONLY on the first shot of a scene. */
export function shotStartStateBlock(i: ShotPromptInput): string {
  if (!i.isSceneFirst) return "";
  const st = oneLine(i.startState);
  return st ? `START STATE (first shot of the scene — establish it fully): ${st}` : "";
}

export function shotMatchCutInBlock(i: ShotPromptInput): string {
  const m = oneLine(i.shot.matchCutIn);
  return m ? `MATCH-CUT IN (continue the SAME instant from the previous shot): ${m}` : "";
}

export function shotActionBlock(i: ShotPromptInput): string {
  // The micro-action is carried on the escalation beat + shot type; the planner puts the concrete
  // action into matchCut / line, so ACTION states the single beat this shot dramatizes.
  const beat = oneLine(i.shot.escalationBeat);
  return beat ? `ACTION (one micro-action, escalation step "${beat}"): a single continuous beat, no internal montage cuts.` : "";
}

export function shotLineBlock(i: ShotPromptInput): string {
  const line = oneLine(i.shot.line);
  if (!line) return "";
  const code = normalizeDialogueLanguage(i.dialogueLanguage);
  if (isEnglish(code)) {
    // English (default): the line IS English — no translation branch, byte-identical to prior behavior.
    return `LINE (spoken in English, voiced verbatim): ${line}`;
  }
  // Non-English: the video model understands English best, so it VOICES the ENGLISH translation while the
  // stored line stays in the dialogue language (no subtitles). Fall back to the line if no translation.
  const label = dialogueLanguageLabel(code);
  const englishForModel = oneLine(i.lineTranslation) || line;
  return `LINE (spoken in ${label}; the model reads this English translation verbatim): ${englishForModel}`;
}

export function shotCameraBlock(i: ShotPromptInput): string {
  const cam = SHOT_CAMERA_BY_TYPE[i.shot.shotType] ?? SHOT_CAMERA_BY_TYPE.dialogue;
  const size = resolveShotSize(i.shot);
  const hasLine = !!oneLine(i.shot.line);
  const parts = [`CAMERA: ${cam.description}; framing scale ${size} (technique: ${oneLine(i.shot.camera) || cam.technique}).`];
  if (isDialogueFramedShot(i.shot.shotType) && hasLine) {
    // Stage 164 rule at the shot level: never a WS while a line is spoken.
    parts.push(DIALOGUE_FRAMING_RULE);
  }
  return parts.join("\n");
}

export function shotMatchCutOutBlock(i: ShotPromptInput): string {
  const m = oneLine(i.shot.matchCutOut);
  return m ? `MATCH-CUT OUT (carry to the next shot): ${m}` : "";
}

/** STATE-OUT — the long end-state, ONLY on the last shot of a scene. */
export function shotEndStateBlock(i: ShotPromptInput): string {
  if (!i.isSceneLast) return "";
  const st = oneLine(i.endState);
  return st ? `END STATE (last shot of the scene — end exactly here): ${st}` : "";
}

export function shotNegativeBlock(i: ShotPromptInput): string {
  const base = buildNegatives(false);
  const additions = "no wardrobe change, no new characters, no on-screen text or captions, no change of time of day or light";
  const framing = isDialogueFramedShot(i.shot.shotType) && oneLine(i.shot.line)
    ? "; no wide, establishing, aerial, high-angle or group shot while the character speaks"
    : "";
  return `${base}\nNEGATIVE (also forbidden): ${additions}${framing}.`;
}

/* ───────────────────────── assemble ───────────────────────── */

export type ShotBlockName =
  | "style"
  | "location"
  | "character"
  | "startState"
  | "matchCutIn"
  | "action"
  | "line"
  | "camera"
  | "matchCutOut"
  | "endState"
  | "negative";

export const SHOT_BLOCK_BUILDERS: Array<{ name: ShotBlockName; build: (i: ShotPromptInput) => string }> = [
  { name: "style", build: shotStyleBlock },
  { name: "location", build: shotLocationBlock },
  { name: "character", build: shotCharacterBlock },
  { name: "startState", build: shotStartStateBlock },
  { name: "matchCutIn", build: shotMatchCutInBlock },
  { name: "action", build: shotActionBlock },
  { name: "line", build: shotLineBlock },
  { name: "camera", build: shotCameraBlock },
  { name: "matchCutOut", build: shotMatchCutOutBlock },
  { name: "endState", build: shotEndStateBlock },
  { name: "negative", build: shotNegativeBlock },
];

export const SHOT_BLOCK_NAMES: ShotBlockName[] = SHOT_BLOCK_BUILDERS.map((b) => b.name);

export interface AssembledShotPrompt {
  prompt: string;
  blocks: Record<ShotBlockName, string>;
  size: ShotSize;
  version: string;
}

/**
 * Assemble the full per-shot prompt deterministically from the ordered blocks. Empty blocks are dropped;
 * the rest are joined with a blank line. Pure: identical inputs → identical output.
 */
export function assembleShotPrompt(input: ShotPromptInput): AssembledShotPrompt {
  const blocks = {} as Record<ShotBlockName, string>;
  for (const { name, build } of SHOT_BLOCK_BUILDERS) blocks[name] = build(input);
  const prompt = SHOT_BLOCK_NAMES.map((n) => blocks[n]).filter((s) => s && s.length > 0).join("\n\n");
  return { prompt, blocks, size: resolveShotSize(input.shot), version: SHOT_PROMPT_VERSION };
}
