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
 * Part D — the new scene must not open on a copy of the previous scene's last frame ([ImageN]):
 * same instant, same people/props/light, only the camera has moved.
 */
export function reframePreviousFrameLine(imageIndex: number): string {
  const tag = `[Image${imageIndex}]`;
  return `RE-FRAME ${tag}: frame 1 of this shot is NOT a copy of ${tag} and that exact composition never appears in this clip. It is the SAME instant — identical people at identical spots in the same phase of movement, identical wardrobe, props, set dressing, light and time of day; nothing and nobody new is added, nothing removed. Only the camera differs: it has moved to a clearly different angle (about 30–60° around the subjects) with a different shot scale and height, and the shot keeps living and moving from that new angle.`;
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
    `it establishes this scene's own angle and momentum from frame 1 and keeps moving — the shot never freezes on a still composition at the start.`
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
