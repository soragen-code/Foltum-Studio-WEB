/**
 * Stage 127 — STORYBOARD board FRAME prompt (pure).
 *
 * `buildBoardFramePrompt` is a PURE function that assembles the Seedream prompt for a single board's
 * 9:16 keyframe still. That still becomes the START FRAME of a 3–6s image-to-video clip, so — unlike the
 * SCENES pipeline — the keyframe here is INTENTIONAL (the Stage 104 keyframe/i2v ban is LIFTED for
 * STORYBOARD only; SCENES still never uses a start-frame pose).
 *
 * It reuses the project's shared visual grammar so a board frame is consistent with the rest of the app:
 *   - 9:16 vertical (REFERENCE_ASPECT_RATIO) + VISUAL_STYLE (lib/visual-style)
 *   - gender-lock (withForcedGender / genderLockClause — lib/full-body-prompt, Stage 125)
 *   - references define appearance only / no frontal line-up (REFERENCE_APPEARANCE_ONLY_LINE, Stage 116)
 *   - eyelines connect in dialogue (GAZE_AT_LISTENER_LINE, Stage 120)
 *   - camera free (never locked to a previous shot — the general no-camera-lock rule)
 *
 * No network, no LLM, no DB — safe to unit-test and to reuse in a "show full prompt" preview.
 */
import { VISUAL_STYLE, REFERENCE_ASPECT_RATIO, styledVisualPrompt } from "@/lib/visual-style";
import { REFERENCE_APPEARANCE_ONLY_LINE, GAZE_AT_LISTENER_LINE } from "@/lib/scene-prompt";
import { buildStoryboardAnimationPrompt, type AnimationBoard } from "@/lib/storyboard-animation";
import { boardShotContext, readBoardDirection } from "@/lib/storyboard-direction";
import { withForcedGender } from "@/lib/full-body-prompt";
import { buildSetAnchorsLine } from "@/lib/set-anchors";
import { buildSceneAnchorLine, BOARD_BODY_FURNITURE_LINE } from "@/lib/board-anchor";
import { resolveVisibleCast, buildShotSizeLine, buildOffScreenLine, type BoardCoverage } from "@/lib/board-coverage";

/**
 * Stage 131 — the GEOMETRY AUTHORITY block for a board frame when the episode Location's master plate(s) are
 * attached as reference. It ports the SCENES location-stability grammar (Stage 119/122) to STORYBOARD: the
 * attached plate(s) are the ABSOLUTE authority for the location's fixed furniture, architecture, materials and
 * lighting, which stay IDENTICAL across every board of this location — only the characters' action/pose and the
 * camera angle change. Wall-adjacency is enforced (a wall is never replaced by columns; wall-set seating keeps its
 * back flush against its wall at every angle) and the camera stays FREE (any angle/height/scale, never locked).
 */
export const BOARD_GEOMETRY_AUTHORITY_LINE =
  "GEOMETRY AUTHORITY (location is constant across boards): the attached location master plate(s) are the ABSOLUTE, authoritative truth of this place. Across EVERY board of this location the fixed elements are IDENTICAL — the SAME walls, floor and its pattern, the SAME columns, doorways and openings, the SAME large/fixed furniture and fixtures, with the SAME architecture, materials, colours, placement and lighting as in the plate(s) and the previous board of this location. Only the characters' action/pose and the camera angle change between boards; the room itself never changes. Do NOT swap furniture for a different model, do NOT restyle, resize, add, remove or rearrange fixed set objects, and do NOT change or invent architecture: where a plate shows a solid wall it stays a solid wall, NEVER replaced by columns, pillars, a passage, an archway, an opening, a doorway, a window or open space, and NEVER add any structure not present in the plate(s). Any furniture set against a wall (a bench, a couch, a cabinet) keeps its back/rear side FLUSH against that same wall in every board and at every camera angle — it never drifts off the wall to leave a gap, columns or open space behind it.";

/**
 * Stage 131 — when a per-zone REGION PLATE (a controlled re-frame of the masters onto this board's part of the
 * location) is the attached authority, it is the PRIMARY environment truth for this board, above the masters.
 */
export const BOARD_REGION_PLATE_AUTHORITY_LINE =
  "REGION PLATE IS THE PRIMARY ENVIRONMENT AUTHORITY (this zone of the location): the attached region plate is a controlled re-frame of the master plates onto the exact part of the location where this board plays — treat it as the primary truth of the background and geometry, above every other reference. Reproduce its walls, floor, columns, fixtures and fixed furniture EXACTLY, at the same places, with wall-adjacent furniture flush against the same wall, and the same architecture, materials, colours and lighting. It fixes the ENVIRONMENT ONLY — it imposes no character pose and it is NOT the camera angle of this board.";

/** A character appearing in a board frame (identity + sex source of truth). */
export interface BoardCharacterLink {
  name: string;
  appearance?: string | null;
  age?: string | null;
  /** Character.gender ("male" | "female" | null) — Stage 125 source of truth for the sex lock. */
  gender?: string | null;
  role?: string | null;
  tier?: string | null;
}

export interface BuildBoardFramePromptInput {
  board: { index: number; actionOrDialogue: string; motion?: string | null; directionJson?: string | null };
  characters: BoardCharacterLink[];
  locationName?: string | null;
  locationDesc?: string | null;
  /**
   * Stage 131 — geometry-authority flags for the location plate(s) attached as image_input by the worker.
   * `hasPlate` gates the whole GEOMETRY AUTHORITY block (when false the frame keeps the Stage 127 text-only
   * behaviour, unchanged); `hasRegionPlate` promotes the region-plate wording when a per-zone plate leads.
   */
  hasPlate?: boolean;
  hasRegionPlate?: boolean;
  /**
   * Stage 140 — the location's persistent large set pieces (derived by `deriveSetAnchors` from the episode
   * locationDesc + all boards' action text). When non-empty, an emphatic PERSISTENT SET PIECES line is added
   * so the same furniture/props stay present across every board and every camera angle (no more vanishing
   * desk on a reverse shot). Empty/omitted → the prompt is byte-identical to the Stage 131 behaviour.
   */
  setAnchors?: string[];
  /**
   * Stage 142 — 1-based position of the SCENE ANCHOR FRAME (the scene's first rendered board still) inside the
   * image_input the worker attaches. When set, a "SCENE ANCHOR FRAME (reference image N)" block is added that
   * demands the identical set from that frame. Null/omitted (first board of a scene) → no anchor block.
   */
  anchorRefIndex?: number | null;
  /**
   * Stage 143 — the board's resolved VISIBLE CAST + SHOT SIZE (the worker computes it once and filters the
   * identity references by it). Omitted → resolved here from the direction / board position / action text.
   */
  coverage?: BoardCoverage;
}

export interface BuildBoardFramePromptResult {
  prompt: string;
  /** Always 9:16 (Stage 124) — the whole app renders vertical. */
  aspectRatio: string;
}

/** Heuristic: a board is a dialogue board when its text carries quoted speech. */
export function isDialogueBoard(text: string | null | undefined): boolean {
  return /[«""].*?\S.*?[»""]/u.test(text ?? "") || /["'].+?["']/.test(text ?? "");
}

/** One CHARACTERS-IN-FRAME line per person, with the sex forced to the front (gender-lock, Stage 125). */
function characterFrameLine(c: BoardCharacterLink): string {
  const base = (c.appearance ?? "").trim() || c.name;
  // withForcedGender leads with "A fully grown adult woman/man ..." and appends the explicit sex-lock clause.
  const who = withForcedGender(base, c.age ?? null, c.appearance ?? "", c.gender, c.role, c.name);
  return `${c.name}: ${who}`;
}

/**
 * The English image-to-video MOTION prompt for a board: what the subject does and how the camera moves
 * during the 3–6s animation whose START frame is this board's still. Falls back to the board's action
 * text when the split model gave no explicit motion.
 */
export function buildBoardMotionPrompt(board: AnimationBoard): string {
  return buildStoryboardAnimationPrompt(board);
}

/**
 * Assemble the Seedream FRAME prompt for one board's 9:16 keyframe still (the clip's start frame).
 */
export function buildBoardFramePrompt(input: BuildBoardFramePromptInput): BuildBoardFramePromptResult {
  const { board, characters } = input;
  const direction = readBoardDirection(board.directionJson);
  const dialogue = direction ? direction.speech.length > 0 : isDialogueBoard(board.actionOrDialogue);
  const locationLine = [input.locationName, input.locationDesc].map((s) => (s ?? "").trim()).filter(Boolean).join(" — ");
  // Stage 143 — EXACTLY who is in frame. Only the visible characters get an identity line; everyone else is
  // named once as OFF-SCREEN (they stay in the location, they are NOT drawn).
  const coverage = input.coverage ?? resolveVisibleCast(direction, board.index, characters.map((c) => c.name), board.actionOrDialogue);
  const visibleCharacters = characters.filter((c) => coverage.visible.includes(c.name));
  const castLines = (visibleCharacters.length ? visibleCharacters : characters).map(characterFrameLine).filter(Boolean);

  // Stage 131 — when the episode Location's plate(s) are attached (hasPlate), add the GEOMETRY AUTHORITY block so
  // the location stays IDENTICAL across boards (a region plate, if present, leads over the masters). When no plate
  // is bound the board keeps the Stage 127 text-only behaviour (unchanged).
  const geometryAuthorityLine = input.hasPlate
    ? (input.hasRegionPlate ? `${BOARD_REGION_PLATE_AUTHORITY_LINE}\n${BOARD_GEOMETRY_AUTHORITY_LINE}` : BOARD_GEOMETRY_AUTHORITY_LINE)
    : "";

  const body = [
    `KEYFRAME STILL — a single cinematic vertical ${REFERENCE_ASPECT_RATIO} frame: the OPENING frame of a 3-6 second shot (it will be animated into a moving clip).`,
    `BOARD ${board.index + 1} — ${dialogue ? "DIALOGUE beat" : "ACTION beat"}: ${board.actionOrDialogue.trim()}`,
    castLines.length ? `CHARACTERS IN FRAME (EXACTLY these ${castLines.length} — nobody else):\n${castLines.join("\n")}` : "",
    locationLine ? `LOCATION: ${locationLine}` : "",
    geometryAuthorityLine,
    // Stage 142 — the scene's first rendered board still is attached as an IMAGE reference; name its index.
    input.anchorRefIndex ? buildSceneAnchorLine(input.anchorRefIndex) : "",
    buildSetAnchorsLine(input.setAnchors ?? []),
    // Stage 142 — bodies never fuse into desks/tables (every board, anchor or not).
    BOARD_BODY_FURNITURE_LINE,
    REFERENCE_APPEARANCE_ONLY_LINE,
    dialogue ? GAZE_AT_LISTENER_LINE : "",
    direction
      ? boardShotContext(direction, board.index, coverage)
      : [buildShotSizeLine(coverage), buildOffScreenLine(coverage), dialogue ? "DIALOGUE COVERAGE: the shot size and the exact cast in frame are fixed by the SHOT SIZE line above. Maintain connected eyelines, screen sides and the 180-degree axis. Off-screen partners remain in the location. Shot changes only BETWEEN boards by hard cut." : ""].filter(Boolean).join("\n"),
    "CAMERA: angle, height and lens are free (the camera is NOT locked to any previous shot; there is no fixed camera), but the SHOT SIZE and the exact cast in frame are FIXED by the SHOT SIZE line — never widen the frame to include anyone else. Compose a real, deep environment (foreground / mid-ground / background), never a flat frontal line-up.",
    `Vertical ${REFERENCE_ASPECT_RATIO} composition, photoreal, no on-screen text, no captions, no watermark.`,
  ].filter(Boolean).join("\n");

  return {
    prompt: styledVisualPrompt(`${VISUAL_STYLE}\n${body}`, characters.map((c) => c.name)),
    aspectRatio: REFERENCE_ASPECT_RATIO,
  };
}
