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
 *
 * Stage 101 rework: the model kept copying the CAMERA of [ImageN] (angle, scale, height) into the next
 * scene. The directive now (a) sits at the TOP of the prompt, (b) explicitly FORBIDS the reference's
 * composition / angle / scale / height as this shot's frame 1, (c) names a CONCRETE opening camera —
 * the script's own CAMERA block from startState when present, otherwise a deterministic angle rotated
 * by scene number (NEW_SHOT_OPENING_ANGLES) so consecutive scenes never open the same way.
 */
export function reframePreviousFrameLine(imageIndex: number): string {
  const tag = `[Image${imageIndex}]`;
  return `CONTINUE FROM ${tag}: use ${tag} only as the STARTING frame of this shot — the world carries straight on from it (the same characters with the same faces, wardrobe, hair and build; the same location, props, set dressing, light and time of day; nothing and nobody new is added, nothing removed). It is NOT a still to hold and that exact composition is not frozen: from the first frame the characters keep moving and acting for THIS scene, free to walk, turn, shift and leave the frame. The camera opens from a clearly different angle with a different shot scale and height, and it is NOT re-blocked to keep everyone in view — people stay wherever the action puts them and may pass out of shot; the shot keeps living and moving from that new angle.`;
}

/** Alias kept for the spec's naming (RE_FRAME_PREVIOUS_FRAME_LINE). */
export const RE_FRAME_PREVIOUS_FRAME_LINE = reframePreviousFrameLine;

/**
 * Stage 101 — concrete OPENING CAMERA for a continuing scene (angle + shot scale + camera height),
 * rotated by scene number so consecutive scenes open differently. Each entry is a full, unambiguous
 * camera setup — never a vague "about 30–60°".
 */
export const NEW_SHOT_OPENING_ANGLES = [
  "a REVERSE angle (~180°) from the opposite side of the space, medium shot at eye level",
  "a 90° SIDE angle from frame-left of the reference, full shot at chest height",
  "a HIGH WIDE shot from the opposite side, the camera well above head height looking down",
  "a 90° SIDE angle from frame-right of the reference, medium close-up at eye level",
  "a LOW MEDIUM shot from the far side of the space, the camera near knee height looking up",
  "a THREE-QUARTER over-the-shoulder angle from behind the subject who was nearest the camera in the reference, medium shot slightly above eye level",
] as const;

/** Pick the opening camera for a scene (1-based); deterministic, cycles through NEW_SHOT_OPENING_ANGLES. */
export function openingAngleForScene(sceneNumber: number): string {
  const n = Number.isFinite(sceneNumber) && sceneNumber > 0 ? Math.floor(sceneNumber) : 1;
  return NEW_SHOT_OPENING_ANGLES[(n - 1) % NEW_SHOT_OPENING_ANGLES.length];
}

/**
 * Extract the scripted "CAMERA:" block from a scene startState ("WORLD: …\nCAMERA: …").
 * Runs from "CAMERA:" to the end of the text or to the next labelled block (e.g. "\nWORLD:").
 * Returns null when there is no CAMERA block.
 */
export function extractScriptedCamera(startState: string | null | undefined): string | null {
  if (!startState) return null;
  const m = /CAMERA:\s*([\s\S]*?)(?=\n\s*[A-Z][A-Z \/&-]{2,}:|$)/.exec(startState);
  if (!m) return null;
  const cam = m[1].replace(/\s+/g, " ").trim();
  return cam.length ? cam : null;
}

/**
 * Stage 102 — the vision description of the previous scene's REAL last frame opens with a mandatory
 * "CAMERA OF THIS FRAME: …" line (lib/frame-state.ts). It is read here as an anti-example for frame 1
 * and stripped wherever the description is inserted as world-state text.
 */
export const PREVIOUS_CAMERA_LINE_RE = /^\s*CAMERA OF THIS FRAME:\s*(.+?)\s*$/im;

/** The camera of the previous scene's actual last frame, or null when the line is absent. */
export function extractPreviousCamera(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = PREVIOUS_CAMERA_LINE_RE.exec(text);
  const cam = m ? m[1].replace(/\s+/g, " ").trim() : "";
  return cam.length ? cam : null;
}

/** Remove the "CAMERA OF THIS FRAME: …" line (and the blank line after it), keeping the state text. */
export function stripPreviousCameraLine(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(/^\s*CAMERA OF THIS FRAME:[^\n]*\n?/im, "").replace(/^\s*\n/, "").trim();
}

export type ReframeOpts = { hasOverride: boolean; sceneNumber?: number; startState?: string | null; previousEndState?: string | null };

/** The full Stage 101 CONTINUE-FROM directive (base line + camera prohibition + concrete frame-1 camera). */
export function reframeDirective(imageIndex: number, opts: { sceneNumber?: number; startState?: string | null; previousEndState?: string | null } = {}): string {
  const tag = `[Image${imageIndex}]`;
  const scripted = extractScriptedCamera(opts.startState);
  const fallback = openingAngleForScene(opts.sceneNumber ?? 1);
  const previousCamera = extractPreviousCamera(opts.previousEndState);
  // Stage 102: the previous shot's REAL final camera as an explicit anti-example.
  const antiExample = previousCamera
    ? `The previous shot ended on: ${previousCamera} — this exact camera (angle, scale, height) is FORBIDDEN for frame 1; open instead from ${scripted ? scripted.replace(/\.$/, "") : fallback}.`
    : "";
  const prohibition =
    `The composition, camera angle, shot scale and camera height of ${tag} are FORBIDDEN as this shot's first frame. ` +
    `Frame 1 must NOT match ${tag} in angle, scale or height. ${tag} defines ONLY: who stands where, in what pose / phase of movement, wardrobe, props, set dressing, light and time of day.`;
  const camera = scripted
    ? `FRAME-1 CAMERA (from the script — mandatory): ${scripted} If any of it is ambiguous, open on ${fallback}.`
    : `FRAME-1 CAMERA (mandatory): open on ${fallback}.`;
  const blocking =
    `The camera is NOT re-blocked to keep everyone in view — people stay where the action puts them and may pass out of shot; ` +
    `from frame 1 the characters keep moving and acting freely for this scene.`;
  return `${reframePreviousFrameLine(imageIndex)}\n${prohibition}${antiExample ? `\n${antiExample}` : ""}\n${camera} ${blocking}`;
}

/**
 * PREPEND the RE-FRAME directive for the `previous_frame` reference (1-based [ImageN] index = position
 * in the ordered reference list + 1) to the TOP of the prompt, so the model reads the camera rule before
 * anything else. No previous_frame ref / manual override → unchanged. Idempotent (one directive per prompt).
 * `sceneNumber` / `startState` are optional (backward compatible with the Stage 78 call shape).
 */
export function applyReframeDirective(
  prompt: string,
  refs: Array<{ kind: string }>,
  opts: ReframeOpts
): string {
  if (opts.hasOverride) return prompt;
  const i = refs.findIndex((r) => r.kind === "previous_frame");
  if (i < 0) return prompt;
  const marker = `CONTINUE FROM [Image${i + 1}]:`;
  if (prompt.includes(marker)) return prompt;
  const directive = reframeDirective(i + 1, { sceneNumber: opts.sceneNumber, startState: opts.startState, previousEndState: opts.previousEndState });
  return `${directive}\n\n${prompt.trimStart()}`;
}

/* ------------------------------------------------------------------------------------------ */
/*  Stage 81 — NEW-SHOT CAMERA MOVE                                                             */
/*                                                                                             */
/*  RE-FRAME (Part D) only moves the camera to a different ANGLE for frame 1, but the clip then */
/*  inherited the static, locked-off framing of the previous scene's final frame — the new     */
/*  scene "froze" on the seam (user report: "the scene camera stays the same as at the end of the previous one").*/
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
/*  Stage 84 — LOCATION AS THE BASE LAYER                                                       */
/*  The location reference is the foundation of the frame: the environment / set / background   */
/*  is established FIRST from the location reference images, and only THEN are the characters    */
/*  placed INTO that already-built location (composited on top of / inside it). The location is  */
/*  never rebuilt, restyled or re-composed to fit the characters — it comes first, the people    */
/*  occupy it. This does NOT reorder the [ImageN] reference set (that mapping is owned by the     */
/*  protected lib/scene-prompt.ts); it makes the layering order explicit for the video model.    */
/* ------------------------------------------------------------------------------------------ */

export const LOCATION_BASE_LAYER_LINE =
  "LOCATION IS THE BASE LAYER: build the frame from the location reference images first — the environment, set, walls, floor, objects, depth, lighting and palette of that place are laid down as the foundation of the shot. The characters are then placed INTO this already-established location, standing on its floor with its walls and objects beside and behind them, composited on top of / inside it. Never rebuild, restyle, relight or re-compose the location around the characters, and never render them as figures pasted in front of a picture of the place: the location comes first as the base plate, the people occupy it second.";

/**
 * Append the LOCATION-AS-BASE-LAYER directive when a location reference is actually attached to the
 * scene (Stage 84). No location reference → nothing to layer under, so it is left untouched. A manual
 * override owns its full text and is returned unchanged. Idempotent.
 */
export function applyLocationBaseLayer(
  prompt: string,
  opts: { hasOverride: boolean; hasLocationRef: boolean }
): string {
  if (opts.hasOverride) return prompt;
  if (!opts.hasLocationRef) return prompt;
  if (prompt.includes(LOCATION_BASE_LAYER_LINE)) return prompt;
  return `${prompt.trimEnd()}\n${LOCATION_BASE_LAYER_LINE}`;
}

/* ------------------------------------------------------------------------------------------ */
/*  Stage 88 — HARD LOCATION CONSISTENCY (a fixed geography every shot obeys)                   */
/*                                                                                             */
/*  Requirement 2: within one location every shot must describe the SAME place — the same       */
/*  landmarks at the same distances, the same materials, the same weather and the same          */
/*  direction of light relative to the terrain — so cutting between shots never rebuilds or      */
/*  rearranges the world. The location anchor block below is a CONSTANT string (byte-identical   */
/*  in every prompt of that location) so the "same anchor in every shot" requirement is met by   */
/*  construction. The master establishing shot / the elevated LAYOUT frame is a REFERENCE ONLY for  */
/*  that fixed geography — explicitly NOT a camera angle to shoot from. The camera is defined     */
/*  RELATIVE to the fixed landmarks (only the camera moves; the world geography stays put), no    */
/*  object appears or disappears between shots, and persistent state (footprints, marks, moved    */
/*  props, where each character was left) carries over from the previous shot. Pure post-         */
/*  processing directive keyed on "the scene has a location reference"; the protected             */
/*  lib/scene-prompt.ts is never touched, and it fires retroactively for old projects too.        */
/* ------------------------------------------------------------------------------------------ */

export const LOCATION_ANCHOR_LINE =
  "LOCATION ANCHOR (one fixed geography for every shot here): treat this location as a single, unchanging place with a fixed map. Across every shot of it, keep the SAME landmarks at the SAME relative distances and directions, the SAME materials and surfaces, the SAME weather, and the SAME direction and quality of light relative to the terrain (the sun / key light always comes from the same side, casting shadows the same way). The location reference images — the wide establishing view and especially the elevated LAYOUT view (camera raised, looking slightly down over the whole space) — are a REFERENCE for this fixed geography ONLY: they show where every object, zone and doorway sits relative to the others, and are explicitly NOT a camera angle to copy or shoot from. Position the camera RELATIVE to those fixed landmarks (e.g. looking across the space from beside a named landmark toward another): only the camera moves between shots, the world's geography never rotates, rescales or rearranges. Nothing appears that was not there and nothing vanishes that was: every object, structure and set-dressing element stays present and in its place from shot to shot. Persistent state carries over — footprints, tracks, marks, spilled or moved objects, opened doors and the exact spot where each character was last left all remain as they were, so consecutive shots read as the same continuous place in the same moment. SAME STRUCTURE, SAME OBJECTS (do NOT toggle geometry between shots): keep the SAME building integrity and the SAME roof / ceiling state — an intact roof or concrete ceiling stays intact in every shot, a collapsed roof open to the sky stays collapsed in every shot; it NEVER flips from intact to open-sky (or back) between two shots of this one place. Keep the SAME shape, width and placement of every opening (doorway, gateway, window, breach) — a narrow doorway does not become a wide tiled span from one shot to the next. Keep the SAME background landmarks seen past those openings — a distant collapsed overpass, ruin, skyline, puddle or group of figures either exists in EVERY shot of this location or in NONE; such a landmark is never swapped for a different one between shots. Keep the SAME set of floor and set-dressing objects (including any bag — its logo, colour, shape and exact placement stay fixed). Do NOT add or remove structural elements, openings, background landmarks or objects between shots; the camera only re-frames this one fixed geography, it never rebuilds it.";

/**
 * Append the Stage 88 LOCATION ANCHOR directive when the scene actually has a location reference
 * (same detection as the Stage 84 base-layer directive). No location reference → there is no fixed
 * geography to anchor, so it is left untouched. A manual override owns its full text and is returned
 * unchanged. Idempotent (applying twice yields the same text).
 */
export function applyLocationConsistency(
  prompt: string,
  opts: { hasOverride: boolean; hasLocationRef: boolean }
): string {
  if (opts.hasOverride) return prompt;
  if (!opts.hasLocationRef) return prompt;
  if (prompt.includes(LOCATION_ANCHOR_LINE)) return prompt;
  return `${prompt.trimEnd()}\n${LOCATION_ANCHOR_LINE}`;
}

/* ------------------------------------------------------------------------------------------ */
/*  Stage 86 — "has a location reference" detection that also covers OLD projects              */
/*                                                                                             */
/*  Stage 84 fired the LOCATION-AS-BASE-LAYER directive only when a location image made it into */
/*  the [ImageN] reference set (built.retryRefs with kind === "location"). That set is built in  */
/*  the protected lib/scene-prompt.ts via isStyledAsset()/VISUAL_STYLE_ID, so a location image  */
/*  generated by an OLD project — before the current visual-style id — is silently excluded and  */
/*  the directive never fires, even though the scene genuinely HAS a location. We must not touch  */
/*  the protected selection, so instead we detect the location by TYPE at the pipeline level:    */
/*  a location reference exists when EITHER a location-typed ref is attached (new/styled          */
/*  projects), OR the scene's location row carries a real image URL in the DB (old projects).     */
/*  This is keyed on the reference TYPE / the location's own data, never on record creation order. */
/* ------------------------------------------------------------------------------------------ */

/** A minimal shape of a Location row — only the reference-image fields matter here. */
export type LocationImageRow = {
  imageUrl?: string | null;
  imageReverse?: string | null;
  imageDetail?: string | null;
  imageExtra?: string | null;
} | null | undefined;

/** True when the location row carries at least one real reference image (any angle or extra). */
export function locationRowHasImage(location: LocationImageRow): boolean {
  if (!location) return false;
  const isUrl = (u: unknown): u is string =>
    typeof u === "string" && /^https?:\/\//.test(u.trim()) && u.trim().length > 10;
  if (isUrl(location.imageUrl) || isUrl(location.imageReverse) || isUrl(location.imageDetail)) return true;
  // imageExtra is a JSON array of URLs (parsed defensively — a malformed value never throws).
  if (typeof location.imageExtra === "string" && location.imageExtra.trim()) {
    try {
      const arr = JSON.parse(location.imageExtra);
      if (Array.isArray(arr) && arr.some(isUrl)) return true;
    } catch { /* ignore malformed imageExtra */ }
  }
  return false;
}

/**
 * Decide whether the scene has a location reference for the Stage 84 base-layer directive, in a way
 * that works retroactively for OLD projects. Determined by TYPE, not by creation order:
 *   1. a location-typed ref is attached to the scene (built.retryRefs has kind === "location"); OR
 *   2. the built reference object names a locationId (equivalent signal from scene-prompt); OR
 *   3. the scene's location row carries a real image URL (covers old projects whose location image
 *      predates the current visual-style id and is therefore not attached as a styled [ImageN] ref).
 */
export function sceneHasLocationRef(input: {
  retryRefs?: Array<{ kind: string }> | null;
  reference?: { locationId?: string | null } | null;
  location?: LocationImageRow;
}): boolean {
  if (Array.isArray(input.retryRefs) && input.retryRefs.some((r) => r.kind === "location")) return true;
  const locId = input.reference?.locationId;
  if (typeof locId === "string" && locId.length > 0) return true;
  return locationRowHasImage(input.location);
}

/* ------------------------------------------------------------------------------------------ */
/*  Stage 87 — SERIES INTRO (the FIRST scene of every episode is the show's opening)            */
/*                                                                                             */
/*  Requirement 1: the first scene of an episode is built like the intro of a series — ONLY     */
/*  wide / establishing shots of the location and of what is happening, plus an OFF-SCREEN       */
/*  VOICEOVER that carries the backstory / exposition (it may recount the catastrophe or event  */
/*  that led to the current situation). No dialogue close-ups, no lip-synced face-to-face talk. */
/*  Implemented as a pure post-processing directive keyed on the scene NUMBER (=== 1), so it     */
/*  fires for EVERY episode's first scene, retroactively for old projects too — the protected    */
/*  lib/scene-prompt.ts is never touched. The narration is explicitly off-screen (not tied to    */
/*  any on-camera character's articulation), covering the voiceover side at the prompt              */
/*  level; the model renders the voiceover as an unseen narrator over the establishing imagery.  */
/* ------------------------------------------------------------------------------------------ */

export const SERIES_INTRO_LINE =
  "SERIES INTRO (opening scene): this is the FIRST scene of the episode and it opens the story like the intro to a TV series. Use ONLY wide, establishing shots of the location and the world — sweeping, atmospheric views that take in the setting, its scale and mood, and whatever is happening in it, including any aftermath, disaster or event that led to the current situation. Do NOT use dialogue close-ups: no tight talking-head shots, no lip-synced face-to-face conversation, no character delivering lines to camera. Any people appear only as small figures inside the wide frames, never in conversational close-up. The narration is delivered as an OFF-SCREEN VOICEOVER — an unseen narrator speaking over the images to set up the backstory and context, never tied to the mouth, lips or articulation of anyone visible in the shot.";

/**
 * Append the SERIES-INTRO directive for the FIRST scene of an episode (sceneNumber === 1). Every
 * other scene is returned unchanged, and a manual override owns its full text and is untouched.
 * Idempotent (applying twice yields the same text). Keyed on the scene number only, so it works
 * retroactively for scenes created by old projects.
 */
export function applySeriesIntro(
  prompt: string,
  sceneNumber: number,
  opts: { hasOverride: boolean }
): string {
  if (opts.hasOverride) return prompt;
  if (!(Number.isFinite(sceneNumber) && Math.floor(sceneNumber) === 1)) return prompt;
  if (prompt.includes(SERIES_INTRO_LINE)) return prompt;
  return `${prompt.trimEnd()}\n${SERIES_INTRO_LINE}`;
}

/* ------------------------------------------------------------------------------------------ */
/*  Part C — continuity channel of a scene submission                                          */
/* ------------------------------------------------------------------------------------------ */

/** How the scene is tied to the previous one: its last frame as an image, text only, or nothing (scene 1 / parallel). */
export type Continuity = "last_frame" | "reangled_frame" | "text_only" | "none";

/** Russian job message shown when chain mode has no previous last frame yet. */
export const TEXT_ONLY_CONTINUITY_MESSAGE = "The previous scene frame is not ready - generating from the description";

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
