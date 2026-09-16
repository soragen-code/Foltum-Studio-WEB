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
import { withForcedGender } from "@/lib/full-body-prompt";

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
  board: { index: number; actionOrDialogue: string; motion?: string | null };
  characters: BoardCharacterLink[];
  locationName?: string | null;
  locationDesc?: string | null;
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
export function buildBoardMotionPrompt(board: { actionOrDialogue: string; motion?: string | null }): string {
  const motion = (board.motion ?? "").trim();
  const body = motion || board.actionOrDialogue.trim();
  return styledVisualPrompt(
    `Animate this still into a continuous 3-6 second live-action shot. ${body} ` +
      "Natural, physically believable motion of the subject and a subtle, motivated camera move (no teleporting, no morphing, no frozen padding). Keep every character's identity, wardrobe and the location exactly as in the start frame.",
  );
}

/**
 * Assemble the Seedream FRAME prompt for one board's 9:16 keyframe still (the clip's start frame).
 */
export function buildBoardFramePrompt(input: BuildBoardFramePromptInput): BuildBoardFramePromptResult {
  const { board, characters } = input;
  const dialogue = isDialogueBoard(board.actionOrDialogue);
  const locationLine = [input.locationName, input.locationDesc].map((s) => (s ?? "").trim()).filter(Boolean).join(" — ");
  const castLines = characters.map(characterFrameLine).filter(Boolean);

  const body = [
    `KEYFRAME STILL — a single cinematic vertical ${REFERENCE_ASPECT_RATIO} frame: the OPENING frame of a 3-6 second shot (it will be animated into a moving clip).`,
    `BOARD ${board.index + 1} — ${dialogue ? "DIALOGUE beat" : "ACTION beat"}: ${board.actionOrDialogue.trim()}`,
    castLines.length ? `CHARACTERS IN FRAME:\n${castLines.join("\n")}` : "",
    locationLine ? `LOCATION: ${locationLine}` : "",
    REFERENCE_APPEARANCE_ONLY_LINE,
    dialogue ? GAZE_AT_LISTENER_LINE : "",
    "CAMERA: free — pick the angle, height, distance and lens that best frame THIS beat; the camera is NOT locked to any previous shot and there is no fixed camera. Compose a real, deep environment (foreground / mid-ground / background), never a flat frontal line-up.",
    `Vertical ${REFERENCE_ASPECT_RATIO} composition, photoreal, no on-screen text, no captions, no watermark.`,
  ].filter(Boolean).join("\n");

  return {
    prompt: styledVisualPrompt(`${VISUAL_STYLE}\n${body}`, characters.map((c) => c.name)),
    aspectRatio: REFERENCE_ASPECT_RATIO,
  };
}
