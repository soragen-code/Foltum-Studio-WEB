/**
 * Stage 165 (task Stage 6) — DETERMINISTIC, BLOCK-ASSEMBLED SCENE PROMPT.
 *
 * The video-model prompt for a scene is assembled from NINE ordered, individually pure block
 * functions. Each function takes the same `SceneBlockInput` and returns a string (or "" when it
 * does not apply). `assembleScenePrompt` concatenates the non-empty blocks in this FIXED order:
 *
 *   1) STYLE         — global project style, ONE line, identical for every scene of the season.
 *   2) LOCATION      — region-plate + setInventory + time-of-day / light of the current scene.
 *   3) CHARACTER(S)  — only characters PRESENT in the scene: canonical look-lock + gender-lock +
 *                      wardrobe / physicalState (from SeasonState when available) + emotion.
 *   4) CONTINUITY IN — the current scene's startState (consistent with the previous endState /
 *                      SeasonState.lastSceneEndState for the first scene of an episode).
 *   5) ACTION        — one action / one beat, no internal montage cuts within the clip.
 *   6) DIALOGUE      — lines in the project dialogueLanguage + an English translation for the model;
 *                      speakers ONLY from the CHARACTER blocks; a new scene opens on a CLOSE-UP of
 *                      the character who starts speaking.
 *   7) CAMERA        — movement + shot size chosen from a beatType-keyed table (no repeat vs the
 *                      previous scene's move); folds in the Stage 164 DIALOGUE_FRAMING_RULE.
 *   8) CONTINUITY OUT— endState (final second: poses, props, gaze, light).
 *   9) NEGATIVE      — prohibitions (wardrobe change, new characters, on-screen text, time-of-day
 *                      change) plus the existing negatives, and the DIALOGUE_FRAMING ban.
 *
 * ORDERING DECISION (reconciles the standing "scene/action/dialogue modules at the START, general
 * rules in a short TAIL" convention): the CONCRETE per-scene content (STYLE is a single short line,
 * then LOCATION / CHARACTER / CONTINUITY IN / ACTION / DIALOGUE) comes first; the RULE-LIKE tail
 * (CAMERA directives, CONTINUITY OUT, NEGATIVE prohibitions) comes last. The order 1..9 above is
 * fixed and never varies per scene, which is what makes the assembly deterministic.
 *
 * This module is PURE: identical inputs always produce the identical prompt, with no side effects
 * and no real reference URLs in the text. It reuses the existing rule constants and helpers from
 * lib/scene-prompt.ts so ALL current consistency guarantees are preserved (region-plate,
 * gender-lock, startState/endState inheritance, SINGLE_SPEAKER_DIRECTION, the Stage 164
 * no-wide-shot-during-dialogue rule, the close-up opening of each scene, 9:16, action inheritance).
 *
 * BACKWARD COMPATIBILITY: every new field (beatType, SeasonState, per-character gender/voiceProfile)
 * is read DEFENSIVELY — when absent the block falls back to the cast / current scene exactly as the
 * pipeline behaves today. No block ever throws on a missing new field.
 */
import {
  DIALOGUE_FRAMING_RULE,
  SINGLE_SPEAKER_DIRECTION,
  LOCATION_INSIDE_NOTE,
  REGION_PLATE_NOTE,
  buildNegatives,
  isInteriorLocation,
  matchSetInventoryInText,
  distinctSpeakerCount,
} from "@/lib/scene-prompt";
import { parseDialogue } from "@/lib/voiceover";
import { resolveGenderNoun, withExplicitAge } from "@/lib/full-body-prompt";

/* ────────────────────────────── input types ────────────────────────────── */

export interface SceneBlockScene {
  id?: string | null;
  sceneKind?: string | null;
  locationDesc?: string | null;
  videoPrompt?: string | null;
  action?: string | null;
  dialogue?: string | null;
  dialogueEn?: string | null;
  voiceover?: string | null;
  startState?: string | null;
  endState?: string | null;
  continuesFrom?: string | null;
  /** Stage 3/5 — the dramatic beat of the scene. Absent on legacy scenes → CAMERA falls back. */
  beatType?: string | null;
}

export interface SceneBlockCharacter {
  characterId: string;
  name: string;
  tier?: string | null;
  appearance?: string | null;
  age?: string | null;
  /** Stage 2/125 — explicit sex lock; when null the gender is inferred from the appearance text. */
  gender?: string | null;
}

export interface SceneBlockLocation {
  id?: string | null;
  name?: string | null;
  setInventory?: string | null;
  imageUrl?: string | null;
  imageReverse?: string | null;
}

/**
 * Stage 4 — the live world state (does NOT exist until Stage 4). Read defensively: when absent the
 * CHARACTER / CONTINUITY blocks fall back to the cast appearance and the current scene's startState.
 */
export interface SeasonStateCharacterLike {
  id?: string | null;
  name?: string | null;
  physicalState?: string | null;
  wardrobe?: string | null;
  location?: string | null;
  arcStage?: string | null;
}

export interface SeasonStateLike {
  characters?: SeasonStateCharacterLike[] | null;
  lastSceneEndState?: string | null;
}

export interface SceneBlockPrevious {
  endState?: string | null;
  /** The camera move id the PREVIOUS scene resolved to — used to avoid repeating it here. */
  cameraMove?: string | null;
}

export interface SceneBlockInput {
  /** Global project style — one short line, identical for every scene of the season. */
  style?: string | null;
  scene: SceneBlockScene;
  /** Characters PRESENT in the scene (SceneCharacter → Character). */
  characters: SceneBlockCharacter[];
  location?: SceneBlockLocation | null;
  regionPlateUrl?: string | null;
  seasonState?: SeasonStateLike | null;
  previous?: SceneBlockPrevious | null;
  /** Project dialogue language for the spoken lines; the model always also gets English. Default English. */
  dialogueLanguage?: string | null;
}

/* ────────────────────────────── shared predicates ────────────────────────────── */

const oneLine = (t?: string | null) => (t ?? "").replace(/\s+/g, " ").trim();

/** A narration scene carries an off-screen voice-over, never on-camera dialogue. */
export function isNarrationScene(scene: SceneBlockScene): boolean {
  return scene.sceneKind === "narration" && !!oneLine(scene.voiceover);
}
/** An action scene is a fight / duel / chase — combat staging, not a dialogue framing. */
export function isActionScene(scene: SceneBlockScene): boolean {
  return !isNarrationScene(scene) && scene.sceneKind === "action";
}
/** A TALKING scene is any on-screen dialogue clip (not narration, not action). The Stage 164 rule applies. */
export function isTalkingScene(scene: SceneBlockScene): boolean {
  return !isNarrationScene(scene) && !isActionScene(scene);
}

/**
 * The resolved English dialogue for the scene (dialogueEn wins, else dialogue). Empty for narration.
 * NOTE: newlines are PRESERVED (not collapsed) — parseDialogue / distinctSpeakerCount separate speakers
 * by line, so collapsing to one line would mis-count a multi-speaker scene as a single speaker.
 */
function resolvedDialogue(scene: SceneBlockScene): string {
  if (isNarrationScene(scene)) return "";
  return (scene.dialogueEn ?? "").trim() || (scene.dialogue ?? "").trim();
}

/** The character who speaks the FIRST line (drives the scene-opening close-up). Null when none. */
export function firstSpeaker(dialogue: string | null | undefined): string | null {
  const lines = parseDialogue(dialogue);
  for (const l of lines) {
    const s = (l.speaker ?? "").trim();
    if (s) return s;
  }
  return null;
}

/* ────────────────────────────── (1) STYLE ────────────────────────────── */

/** Global project style — a single line, identical for every scene of the season. */
export function styleBlock(input: SceneBlockInput): string {
  const style = oneLine(input.style);
  return style ? `STYLE: ${style}` : "";
}

/* ────────────────────────────── (2) LOCATION ────────────────────────────── */

/**
 * The location block: region-plate authority note (when a plate exists), the location NAME, the set
 * inventory objects that THIS scene uses, and the time-of-day / light from the scene descriptor.
 * Interiors additionally carry the "characters are INSIDE this space" note (LOCATION_INSIDE_NOTE).
 */
export function locationBlock(input: SceneBlockInput): string {
  const { location, scene } = input;
  const hasPlates = !!(location?.imageUrl && location?.imageReverse);
  const name = oneLine(location?.name);
  const desc = oneLine(scene.locationDesc);
  const parts: string[] = [];
  if (name) parts.push(`LOCATION: ${name}${desc ? ` — ${desc}` : ""}.`);
  else if (desc) parts.push(`LOCATION: ${desc}.`);
  if (oneLine(input.regionPlateUrl)) parts.push(REGION_PLATE_NOTE);
  const setObjects = matchSetInventoryInText(
    location?.setInventory,
    `${scene.videoPrompt ?? ""}\n${scene.action ?? ""}\n${scene.dialogue ?? ""}`.toLowerCase(),
  );
  if (setObjects.length) parts.push(`SET OBJECTS: ${setObjects.join("; ")}.`);
  if (isInteriorLocation(scene.locationDesc, hasPlates)) parts.push(LOCATION_INSIDE_NOTE);
  return parts.join("\n");
}

/* ────────────────────────────── (3) CHARACTER(S) ────────────────────────────── */

/**
 * One line per PRESENT character (crowds excluded from the named look-lock): canonical appearance
 * look-lock + explicit gender/age lock, wardrobe / physical state pulled from the live SeasonState
 * when available (else the cast appearance), and the emotion read from the scene's startState.
 */
export function characterBlocks(input: SceneBlockInput): string {
  const named = input.characters.filter(c => c.tier !== "CROWD" && oneLine(c.name));
  if (!named.length) return "";
  const stateByName = new Map<string, SeasonStateCharacterLike>();
  for (const s of input.seasonState?.characters ?? []) {
    const key = oneLine(s?.name).toLowerCase();
    if (key) stateByName.set(key, s);
  }
  const startState = oneLine(input.scene.startState);
  const lines = named.map(c => {
    const name = c.name.trim();
    const gender = resolveGenderNoun(c.gender, c.appearance);
    // Look-lock with an explicit gender + age clause (preserves gender-lock).
    const who = withExplicitAge(name, c.age, c.appearance ?? "", gender);
    const appearance = oneLine(c.appearance);
    const live = stateByName.get(name.toLowerCase());
    // Wardrobe / physical state: SeasonState wins (Stage 4); else fall back to the cast appearance.
    const wardrobe = oneLine(live?.wardrobe);
    const physical = oneLine(live?.physicalState);
    // Emotion is read from the scene's startState when it names this character.
    const emotion = emotionFor(name, startState);
    const bits = [appearance ? `look: ${appearance}` : "", wardrobe ? `wardrobe: ${wardrobe}` : "", physical ? `state: ${physical}` : "", emotion ? `emotion: ${emotion}` : ""].filter(Boolean);
    return `- ${who}${bits.length ? ` — ${bits.join("; ")}` : ""}.`;
  });
  return `CHARACTERS (only these people are in frame):\n${lines.join("\n")}`;
}

/** Best-effort emotion extraction: the clause around the character's name in the startState text. */
function emotionFor(name: string, startState: string): string {
  if (!startState || !name) return "";
  const re = new RegExp(`${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}[^.]*\\b(angry|furious|afraid|scared|terrified|calm|cold|tense|nervous|smiling|grinning|crying|tearful|shaken|guarded|wary|defiant|resigned|hopeful|desperate|exhausted|relieved|suspicious)\\b`, "i");
  const m = startState.match(re);
  return m ? m[1].toLowerCase() : "";
}

/* ────────────────────────────── (4) CONTINUITY IN ────────────────────────────── */

/**
 * The scene's start state (OPENING). For the first scene of an episode (no previous scene) the
 * SeasonState.lastSceneEndState is used as the continuity anchor when available, else the scene's own
 * startState. When there IS a previous scene its endState is the authoritative anchor the opening must
 * continue (same instant / place / light) — its consistency is asserted here by carrying that text.
 */
export function continuityInBlock(input: SceneBlockInput): string {
  const start = oneLine(input.scene.startState);
  const prevEnd = oneLine(input.previous?.endState);
  const seasonAnchor = oneLine(input.seasonState?.lastSceneEndState);
  const anchor = prevEnd || seasonAnchor;
  const parts: string[] = [];
  if (start) parts.push(`CONTINUITY IN (frame 1 — continue the SAME instant from the previous shot, new camera): ${start}`);
  else if (anchor) parts.push(`CONTINUITY IN (frame 1 — continue the SAME instant from the previous shot, new camera): ${anchor}`);
  if (anchor && start && anchor !== start) parts.push(`It must remain consistent with the previous end state: ${anchor}`);
  return parts.join("\n");
}

/* ────────────────────────────── (5) ACTION ────────────────────────────── */

/** One action / one beat — a single continuous clip-length beat, never an internal montage of cuts. */
export function actionBlock(input: SceneBlockInput): string {
  const action = oneLine(input.scene.action);
  if (!action) return "";
  return `ACTION (one continuous beat, no internal montage cuts within the clip): ${action}`;
}

/* ────────────────────────────── (6) DIALOGUE ────────────────────────────── */

/**
 * The spoken lines. The story-language lines are voiced and the model also gets the English text
 * (currently the project default is English, so both are the same). Speakers are constrained to the
 * CHARACTER blocks. The standing rule is preserved: a new scene opens on a CLOSE-UP of the character
 * who starts speaking. Empty for narration / no-dialogue scenes.
 */
export function dialogueBlock(input: SceneBlockInput): string {
  const scene = input.scene;
  if (isNarrationScene(scene)) {
    const vo = oneLine(scene.voiceover);
    return vo ? `NARRATION (off-screen English voice-over, no on-camera lip-sync): ${vo}` : "";
  }
  const dialogue = resolvedDialogue(scene);
  if (!dialogue) return "";
  const lang = oneLine(input.dialogueLanguage) || "English";
  const present = new Set(input.characters.filter(c => c.tier !== "CROWD").map(c => c.name.trim().toLowerCase()));
  const speaker = firstSpeaker(dialogue);
  const openLine = speaker
    ? `Open on a CLOSE-UP of ${speaker}, the character who speaks first.`
    : `Open on a CLOSE-UP of the character who speaks first.`;
  const speakerNote = present.size
    ? ` Only the characters listed above speak; introduce no new speaker.`
    : "";
  const langNote = lang.toLowerCase() === "english"
    ? ` Lines are spoken in English and voiced verbatim.`
    : ` Lines are spoken in ${lang}; the English translation for the model is given verbatim.`;
  return `DIALOGUE: ${openLine}${speakerNote}${langNote}\n${dialogue}`;
}

/* ────────────────────────────── (7) CAMERA ────────────────────────────── */

export interface CameraChoice {
  /** The stable move id (persisted so the NEXT scene can avoid repeating it). */
  move: string;
  /** Human-readable movement description. */
  movement: string;
  /** Shot size / framing description. */
  size: string;
}

/**
 * Camera table keyed by beatType. beatType arrives with Stage 3/5; legacy scenes have none and fall
 * back to "default". While anyone speaks the Stage 164 rule overrides the size to a dialogue framing.
 */
export const CAMERA_BY_BEAT: Record<string, CameraChoice> = {
  humiliation: { move: "slow-push-in", movement: "a slow push-in", size: "close-up on the face" },
  reveal: { move: "rack-focus", movement: "a rack focus / quick whip", size: "medium reframing onto the revealed subject" },
  threat: { move: "low-angle", movement: "a low-angle tilt up", size: "medium-close on the aggressor" },
  betrayal: { move: "slow-arc", movement: "a slow arc around the pair", size: "medium two-shot tightening to a close-up" },
  falseVictory: { move: "gentle-rise", movement: "a gentle rise", size: "medium celebratory framing" },
  nearMiss: { move: "handheld-snap", movement: "a handheld snap-reframe", size: "medium-close tracking" },
  rescue: { move: "steady-push", movement: "a steady push-in", size: "medium widening to include the rescuer" },
  choice: { move: "hold-close", movement: "a slow push settling to a hold", size: "close-up on the deciding face" },
  default: { move: "steady-medium", movement: "a steady framing with at most 1–2 hard cuts", size: "medium / over-the-shoulder" },
};

/** Deterministic alternate move used when the beat's default move repeats the previous scene's move. */
const ALT_MOVE: Record<string, CameraChoice> = {
  "slow-push-in": { move: "slow-arc", movement: "a slow arc (varied from the previous shot)", size: "close-up on the face" },
  "rack-focus": { move: "steady-medium", movement: "a steady reframe (varied from the previous shot)", size: "medium reframing onto the revealed subject" },
  "low-angle": { move: "steady-push", movement: "a steady push-in (varied from the previous shot)", size: "medium-close on the aggressor" },
  "slow-arc": { move: "slow-push-in", movement: "a slow push-in (varied from the previous shot)", size: "medium two-shot tightening to a close-up" },
  "gentle-rise": { move: "steady-medium", movement: "a steady framing (varied from the previous shot)", size: "medium framing" },
  "handheld-snap": { move: "steady-push", movement: "a steady push-in (varied from the previous shot)", size: "medium-close tracking" },
  "steady-push": { move: "slow-arc", movement: "a slow arc (varied from the previous shot)", size: "medium framing" },
  "hold-close": { move: "slow-push-in", movement: "a slow push-in (varied from the previous shot)", size: "close-up on the deciding face" },
  "steady-medium": { move: "slow-push-in", movement: "a slow push-in (varied from the previous shot)", size: "medium / over-the-shoulder" },
};

/**
 * Choose the camera for a scene from its beatType, avoiding a repeat of the previous scene's move.
 * Pure: (beatType, previousMove) → CameraChoice. Unknown / missing beatType falls back to "default".
 */
export function chooseCameraMove(beatType: string | null | undefined, previousMove?: string | null): CameraChoice {
  const key = beatType && CAMERA_BY_BEAT[beatType] ? beatType : "default";
  const base = CAMERA_BY_BEAT[key];
  if (previousMove && base.move === previousMove) {
    return ALT_MOVE[base.move] ?? { ...base, move: `${base.move}-alt`, movement: `${base.movement} (varied from the previous shot)` };
  }
  return base;
}

/**
 * The CAMERA block: the beat-driven movement + shot size (no repeat of the previous move). For a
 * talking scene the size is CONSTRAINED to a dialogue framing and the Stage 164 rule is folded in
 * verbatim; for a single speaker the compact SINGLE_SPEAKER_DIRECTION is added.
 */
export function cameraBlock(input: SceneBlockInput): string {
  const scene = input.scene;
  const cam = chooseCameraMove(scene.beatType, input.previous?.cameraMove);
  const talking = isTalkingScene(scene);
  const dialogue = resolvedDialogue(scene);
  const parts: string[] = [];
  if (talking) {
    // Stage 164 — while anyone speaks the shot is a dialogue framing, never a wide/establishing shot.
    parts.push(`CAMERA: ${cam.movement}; a DIALOGUE framing (over-the-shoulder / waist-up half-body / medium / medium-close / close-up), never a wide / establishing / aerial / high-angle / group / whole-space shot while anyone speaks.`);
    parts.push(DIALOGUE_FRAMING_RULE);
    if (distinctSpeakerCount(dialogue) < 2) parts.push(SINGLE_SPEAKER_DIRECTION);
  } else {
    parts.push(`CAMERA: ${cam.movement}; ${cam.size}.`);
  }
  return parts.join("\n");
}

/* ────────────────────────────── (8) CONTINUITY OUT ────────────────────────────── */

/** The scene's end state — the final second: poses, prop states, gaze direction and light. */
export function continuityOutBlock(input: SceneBlockInput): string {
  const end = oneLine(input.scene.endState);
  if (!end) return "";
  return `CONTINUITY OUT (last frame — end exactly here: poses, props, gaze, light): ${end}`;
}

/* ────────────────────────────── (9) NEGATIVE ────────────────────────────── */

/**
 * Prohibitions: the existing negatives (no on-screen text, no watermark, no extra people, ...) plus
 * the Stage 6 additions (no wardrobe change, no new characters, no time-of-day change) and — for a
 * talking scene — the explicit no-wide-shot-while-speaking ban.
 */
export function negativeBlock(input: SceneBlockInput): string {
  const scene = input.scene;
  const base = buildNegatives(isNarrationScene(scene));
  const additions = "no wardrobe change, no new characters, no on-screen text or captions, no change of time of day or light from the location references";
  const framing = isTalkingScene(scene)
    ? "; no wide, establishing, aerial, high-angle, group or whole-space shot while any character is speaking"
    : "";
  return `${base}\nNEGATIVE (also forbidden): ${additions}${framing}.`;
}

/* ────────────────────────────── assemble ────────────────────────────── */

export interface AssembledScenePrompt {
  /** The final deterministic prompt: the non-empty blocks concatenated in the fixed 1..9 order. */
  prompt: string;
  /** The individual block strings (persisted for debugging / per-block regeneration). */
  blocks: Record<SceneBlockName, string>;
  /** The camera move id this scene resolved to — persist it so the next scene can avoid repeating it. */
  cameraMove: string;
}

export type SceneBlockName =
  | "style"
  | "location"
  | "character"
  | "continuityIn"
  | "action"
  | "dialogue"
  | "camera"
  | "continuityOut"
  | "negative";

/** The nine block builders, in the fixed assembly order. */
export const SCENE_BLOCK_BUILDERS: Array<{ name: SceneBlockName; build: (i: SceneBlockInput) => string }> = [
  { name: "style", build: styleBlock },
  { name: "location", build: locationBlock },
  { name: "character", build: characterBlocks },
  { name: "continuityIn", build: continuityInBlock },
  { name: "action", build: actionBlock },
  { name: "dialogue", build: dialogueBlock },
  { name: "camera", build: cameraBlock },
  { name: "continuityOut", build: continuityOutBlock },
  { name: "negative", build: negativeBlock },
];

/** The ordered list of block names (single source of truth for the per-block regen endpoint). */
export const SCENE_BLOCK_NAMES: SceneBlockName[] = SCENE_BLOCK_BUILDERS.map(b => b.name);

/**
 * Assemble the full scene prompt deterministically from the nine ordered blocks. Pure: identical
 * inputs → identical output. Empty blocks are dropped; the rest are joined with a blank line.
 */
export function assembleScenePrompt(input: SceneBlockInput): AssembledScenePrompt {
  const blocks = {} as Record<SceneBlockName, string>;
  for (const { name, build } of SCENE_BLOCK_BUILDERS) blocks[name] = build(input);
  const prompt = SCENE_BLOCK_NAMES.map(n => blocks[n]).filter(s => s && s.length > 0).join("\n\n");
  const cameraMove = chooseCameraMove(input.scene.beatType, input.previous?.cameraMove).move;
  return { prompt, blocks, cameraMove };
}

/**
 * Recompute a SINGLE block and splice it into the previously-stored assembled prompt (per-block
 * regeneration). Only `block` is rebuilt from the fresh input; every other block is carried over
 * verbatim from `storedBlocks` (falling back to a fresh compute when a block was never stored). The
 * result is re-joined in the fixed 1..9 order, so it stays internally consistent. Pure.
 */
export function regenerateBlock(
  input: SceneBlockInput,
  block: SceneBlockName,
  storedBlocks?: Partial<Record<SceneBlockName, string>> | null,
): AssembledScenePrompt {
  const blocks = {} as Record<SceneBlockName, string>;
  for (const { name, build } of SCENE_BLOCK_BUILDERS) {
    if (name === block) {
      blocks[name] = build(input); // recompute only the requested block
    } else if (storedBlocks && typeof storedBlocks[name] === "string") {
      blocks[name] = storedBlocks[name] as string; // carry the stored block over unchanged
    } else {
      blocks[name] = build(input); // never stored → best-effort fresh compute
    }
  }
  const prompt = SCENE_BLOCK_NAMES.map(n => blocks[n]).filter(s => s && s.length > 0).join("\n\n");
  const cameraMove = chooseCameraMove(input.scene.beatType, input.previous?.cameraMove).move;
  return { prompt, blocks, cameraMove };
}
