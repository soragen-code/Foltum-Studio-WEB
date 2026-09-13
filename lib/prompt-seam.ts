/**
 * Stage 78 — seam directives applied to the assembled scene prompt AFTER `buildScenePrompt`
 * (lib/scene-prompt.ts is frozen, so this is a pure post-processing layer used by BOTH the
 * video worker and the GET prompt preview, keeping the shown text byte-identical to the submitted one).
 *
 *  - the "speech finished before the final second" line is removed: it made every clip end on a
 *    silent, frozen beat (the model "lands" the line and holds a pose);
 *  - the END STATE prefix is softened: the last frame passes THROUGH the described instant while
 *    motion and sound continue;
 *  - a MOTION-TO-LAST-FRAME directive is appended;
 *  - in chain mode the previous scene's last frame ([ImageN]) must be RE-FRAMED, never copied.
 * A manual promptOverride is the producer's text — it is returned unchanged.
 */
import { END_STATE_PREFIX, SPEECH_BEFORE_CUT_LINE } from "@/lib/scene-prompt";

export const MOTION_TO_LAST_FRAME_LINE =
  "Life never stops: characters keep moving, breathing, reacting and speaking naturally right up to the very last frame; ambient sound and room tone continue to the end; no freeze, no held pose, no silent still at the end — the cut happens mid-life.";

export const SOFT_END_STATE_PREFIX = "END STATE (the last frame passes THROUGH this moment while motion and sound continue): ";

/** Replace the frozen-frame END STATE prefix with the "pass through this moment" wording. */
export function softenEndState(prompt: string): string {
  return prompt.split(END_STATE_PREFIX).join(SOFT_END_STATE_PREFIX);
}

/** Remove the exact SPEECH_BEFORE_CUT_LINE line (and the empty line it leaves behind). */
export function removeSpeechBeforeCutLine(prompt: string): string {
  if (!prompt.includes(SPEECH_BEFORE_CUT_LINE)) return prompt;
  const lines = prompt.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === SPEECH_BEFORE_CUT_LINE) {
      // Drop a blank line that would now sit between two blocks (double blank).
      if (out.length && out[out.length - 1].trim() === "" && lines[i + 1] !== undefined && lines[i + 1].trim() === "") i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

/**
 * Apply all seam directives. Idempotent: applying twice yields the same text.
 * With a manual override the prompt is returned unchanged.
 */
export function applySeamDirectives(prompt: string, opts: { hasOverride: boolean }): string {
  if (opts.hasOverride) return prompt;
  let out = softenEndState(removeSpeechBeforeCutLine(prompt));
  if (!out.includes(MOTION_TO_LAST_FRAME_LINE)) out = `${out.trimEnd()}\n\n${MOTION_TO_LAST_FRAME_LINE}`;
  return out;
}

/**
 * Part D — the new scene CONTINUES the previous scene's last frame ([ImageN]) as its STARTING POINT
 * only, never as a frozen composition to hold.
 *
 * Stage 82 rework: the previous wording ("the SAME instant — identical people at identical spots in
 * the same phase of movement") froze the characters into the hand-off pose for the whole clip. Now
 * [ImageN] is used purely as the ENTRY FRAME for continuity — same world, same people, same wardrobe,
 * light and time of day — after which the characters move and act freely per this scene, and the
 * camera (at its new angle) does NOT reposition anyone to keep them in frame: people stay where the
 * story puts them and may pass out of shot. Continuity = same world + continuing action, not a held pose.
 */
export function reframePreviousFrameLine(imageIndex: number): string {
  const tag = `[Image${imageIndex}]`;
  return `CONTINUE FROM ${tag}: use ${tag} only as the STARTING frame of this shot — the world carries straight on from it (the same characters with the same faces, wardrobe, hair and build; the same location, props, set dressing, light and time of day; nothing and nobody new is added, nothing removed). It is NOT a still to hold and that exact composition is not frozen: from the first frame the characters keep moving and acting for THIS scene, free to walk, turn, shift and leave the frame. The camera opens from a clearly different angle (about 30–60° around the subjects) with a different shot scale and height, and it is NOT re-blocked to keep everyone in view — people stay wherever the action puts them and may pass out of shot; the shot keeps living and moving from that new angle.`;
}

/** Alias kept for the spec's naming (RE_FRAME_PREVIOUS_FRAME_LINE). */
export const RE_FRAME_PREVIOUS_FRAME_LINE = reframePreviousFrameLine;

/**
 * Append the RE-FRAME directive for the `previous_frame` reference (1-based [ImageN] index = position
 * in the ordered reference list + 1). No previous_frame ref / manual override → unchanged. Idempotent.
 */
export function applyReframeDirective(
  prompt: string,
  refs: Array<{ kind: string }>,
  opts: { hasOverride: boolean }
): string {
  if (opts.hasOverride) return prompt;
  const i = refs.findIndex((r) => r.kind === "previous_frame");
  if (i < 0) return prompt;
  const line = reframePreviousFrameLine(i + 1);
  if (prompt.includes(line)) return prompt;
  return `${prompt.trimEnd()}\n${line}`;
}

/* ------------------------------------------------------------------------------------------ */
/*  Stage 81 — NEW-SHOT CAMERA MOVE                                                             */
/*                                                                                             */
/*  RE-FRAME (Part D) only moves the camera to a different ANGLE for frame 1, but the clip then */
/*  inherited the static, locked-off framing of the previous scene's final frame — the new     */
/*  scene "froze" on the seam (user report: «камера сцены стоит так же, как в конце предыдущей»).*/
/*  This directive gives EVERY continuing scene its OWN camera motion that is already underway  */
/*  on the first frame and runs through the whole clip, so the shot never opens on a held,      */
/*  static composition. The starting frame is still shared for continuity — only the camera     */
/*  work is fresh. The concrete move rotates deterministically by scene number for variety.     */
/* ------------------------------------------------------------------------------------------ */

/** Distinct camera moves, rotated by scene number so consecutive scenes don't repeat the same motion. */
export const NEW_SHOT_CAMERA_MOVES = [
  "a slow push-in, the camera gliding toward the subjects",
  "a steady dolly-out, the camera easing back to open up the space",
  "a lateral tracking move, the camera gliding sideways across the scene",
  "a smooth pan sweeping across the setting",
  "a gentle arc, the camera orbiting around the subjects",
  "a slow crane with a subtle tilt that reveals the surroundings",
] as const;

/** Pick the camera move for a scene (1-based); deterministic, cycles through NEW_SHOT_CAMERA_MOVES. */
export function cameraMoveForScene(sceneNumber: number): string {
  const n = Number.isFinite(sceneNumber) && sceneNumber > 0 ? Math.floor(sceneNumber) : 1;
  return NEW_SHOT_CAMERA_MOVES[(n - 1) % NEW_SHOT_CAMERA_MOVES.length];
}

/** The NEW-SHOT CAMERA MOVE directive line for a given scene number. */
export function newShotCameraMoveLine(sceneNumber: number): string {
  return (
    `NEW-SHOT CAMERA MOVE: this shot has its OWN camera work — ${cameraMoveForScene(sceneNumber)} — ` +
    `that is ALREADY IN MOTION on the very first frame and continues throughout the clip. ` +
    `The camera does NOT hold, copy or settle back into the static, locked-off framing of the previous shot's final frame; ` +
    `it establishes this scene's own angle and momentum from frame 1 and keeps moving — the shot never freezes on a still composition at the start. ` +
    `The blocking is NOT adjusted to the camera: characters are never nudged, re-centred or pulled back into frame to fit the new angle — they stay where the action puts them and may sit at the edge of frame or pass out of shot entirely while the camera looks elsewhere.`
  );
}

/**
 * Append the NEW-SHOT CAMERA MOVE directive for a CONTINUING scene (continuity "last_frame" or
 * "text_only" — i.e. any scene that carries over from a previous one). Scene 1 / parallel ("none")
 * already frames freely, so it is left untouched. A manual override is returned unchanged. Idempotent.
 */
export function applyNewShotCameraMove(
  prompt: string,
  sceneNumber: number,
  opts: { hasOverride: boolean; continuity: Continuity }
): string {
  if (opts.hasOverride) return prompt;
  if (opts.continuity === "none") return prompt;
  const line = newShotCameraMoveLine(sceneNumber);
  if (prompt.includes(line)) return prompt;
  return `${prompt.trimEnd()}\n${line}`;
}

/* ------------------------------------------------------------------------------------------ */
/*  Stage 82 — CONTINUOUS ACTION (persistent world, one unbroken event)                         */
/*                                                                                             */
/*  Requirement 3: the WHOLE episode should read as a single, continuous piece of action — the  */
/*  same world, the same characters, the same light and the same event carrying on in time —    */
/*  while the camera simply cuts to different vantage points inside it. Continuity lives at the  */
/*  level of the world and the action, NOT at the level of a fixed frame composition or pose.   */
/* ------------------------------------------------------------------------------------------ */

export const CONTINUOUS_ACTION_LINE =
  "CONTINUOUS ACTION: this shot is one more vantage point on a single, unbroken event that runs across the whole episode — the same world, the same characters (same faces, wardrobe, hair, build), the same location, light and time of day, the same action simply carrying on in real time from the previous shot. The cut is only the camera jumping to another angle or spot inside that ongoing moment; time never resets, nobody is re-posed to match a frame, and the life on screen (movement, gestures, speech, ambient sound) continues without a break.";

/**
 * Append the CONTINUOUS ACTION directive for a CONTINUING scene (continuity "last_frame" / "text_only").
 * Scene 1 / parallel ("none") starts a fresh vantage with no prior shot to carry on from, so it is left
 * untouched. A manual override is returned unchanged. Idempotent.
 */
export function applyContinuousAction(
  prompt: string,
  opts: { hasOverride: boolean; continuity: Continuity }
): string {
  if (opts.hasOverride) return prompt;
  if (opts.continuity === "none") return prompt;
  if (prompt.includes(CONTINUOUS_ACTION_LINE)) return prompt;
  return `${prompt.trimEnd()}\n${CONTINUOUS_ACTION_LINE}`;
}

/* ------------------------------------------------------------------------------------------ */
/*  Part C — continuity channel of a scene submission                                          */
/* ------------------------------------------------------------------------------------------ */

/** How the scene is tied to the previous one: its last frame as an image, text only, or nothing (scene 1 / parallel). */
export type Continuity = "last_frame" | "text_only" | "none";

/** Russian job message shown when chain mode has no previous last frame yet. */
export const TEXT_ONLY_CONTINUITY_MESSAGE = "Кадр предыдущей сцены не готов — генерация по описанию";

export function resolveContinuity(input: {
  chainMode: "chain" | "parallel";
  sceneNumber: number;
  previousFrameSceneId?: string | null;
  refs?: Array<{ kind: string }>;
}): Continuity {
  const hasFrame = !!input.previousFrameSceneId || !!input.refs?.some((r) => r.kind === "previous_frame");
  if (hasFrame) return "last_frame";
  if (input.chainMode === "chain" && input.sceneNumber > 1) return "text_only";
  return "none";
}
