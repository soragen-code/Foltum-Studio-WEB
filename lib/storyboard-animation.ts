/** Stage 132 — actual Storyboard i2v request, with no unsupported provider fields.
 * Contract checked against the PRIMARY endpoint documentation (2026-09-16):
 * https://wavespeed.ai/models/bytedance/seedance-2.5/image-to-video
 * Required: prompt, image. Optional: last_image, duration (4–30, default 5),
 * resolution (480p/720p/1080p/4k, default 720p), generate_audio (default true).
 * Aspect follows image. Additional character reference images are NOT in this contract.
 * last_image is an END FRAME, not an identity reference — deliberately never repurposed.
 * Keep current Storyboard quality (720p) and 4–6s budget; no resize or model switch.
 */
import type { SeedanceImageToVideoInput } from "@/lib/wavespeed";
import { styledVisualPrompt } from "@/lib/visual-style";
import { boardShotContext, readBoardDirection, type BoardDirection } from "@/lib/storyboard-direction";
import { resolveVisibleCast, buildShotSizeLine, type BoardCoverage, type ShotSize } from "@/lib/board-coverage";
import { estimatedSpeechSeconds, extractSpokenLines, hasActorTravel, type SpokenLine } from "@/lib/storyboard-dialogue";

export const STORYBOARD_I2V_EXTRA_REFS_SUPPORTED = false;
export const LOCKED_BOARD_CAMERA = "CAMERA MODE: LOCKED-OFF. Keep the opening board image's exact camera pose, angle, focal length, subject distance and shot size throughout the entire clip. No push-in, pull-out, zoom, pan, tilt, orbit, drift or reframing. Character gestures and head turns never move the camera.";
export const TRACKING_BOARD_CAMERA = "CAMERA MODE: TRACKING. Only while the scripted characters physically travel through the location, a smooth motivated tracking camera follows them, maintaining stable subject distance, angle relative to the characters, focal length and shot size from the opening board image. Hold when they stop. No autonomous fly-away, push/pull, zoom, orbit or unrelated pan/tilt; never track a gesture or head turn.";

export interface AnimationBoard {
  actionOrDialogue: string;
  motion?: string | null;
  directionJson?: string | null;
  characters?: string[];
  durationSec?: number | null;
  /** Stage 143 — 0-based board position (= position in the scene); drives the visible-cast / shot-size block. */
  boardIndex?: number;
  /**
   * Stage 144 — the immediately previous board's English action/motion (same scene). When set, this clip's
   * OPENING pose is the previous board's END state, so the motion must CONTINUE from that inherited state rather
   * than start from a neutral pose. Omitted (first board of a scene / scene boundary) → no continuation note.
   */
  previousActionText?: string | null;
  /**
   * Stage 220 — per-scene i2v: the END FRAME of the scene, passed as Seedance `last_image`. The clip animates the
   * board's START frame INTO this end frame over the whole scene's duration. Omitted → single-frame animation.
   */
  lastImageUrl?: string | null;
  /**
   * Stage 220 — the scene's verbatim attributed spoken lines (from castInFrame.dialogue), used directly instead of
   * re-parsing actionOrDialogue. When provided, these are the AUDIO the clip must voice, in order.
   */
  spokenLines?: SpokenLine[] | null;
  /**
   * Stage 220 — the English MOTION description of the start→end transition (castInFrame.motion). When provided it
   * is the actor-action authority for the clip instead of the parsed action text.
   */
  actionText?: string | null;
  /**
   * Stage 235 — the board's chosen shot SCALE (ShotSize string) and the exact cast that scale frames
   * (castInFrame.inFrame). When BOTH are set, the clip's cast-context block states the HARD shot size + head-count
   * so the animation keeps the board's framing. Omitted on legacy boards → the presence-derived context is used.
   */
  shotType?: string | null;
  inFrameCast?: string[] | null;
}

function legacyAction(text: string, cast: string[]): string {
  // Old motionEn may explicitly request dolly/push-in; it is NOT camera authority anymore.
  let action = text.replace(/"[^"\n]*"|«[^»]*»|“[^”]*”/gu, "");
  for (const name of cast) action = action.split("\n").filter(row => !row.trim().startsWith(`${name}:`)).join("\n");
  return action.split(/[.;\n]/u).filter(s => !/\b(?:camera|zoom|dolly|pan|tilt|orbit|push.in|pull.out|refram)\b/iu.test(s)).join(". ").trim();
}

function animationParts(board: AnimationBoard): { plan: BoardDirection | null; lines: SpokenLine[]; action: string; tracking: boolean } {
  const plan = readBoardDirection(board.directionJson);
  const cast = plan?.cast ?? board.characters ?? [];
  // Stage 220 — a per-scene board supplies its verbatim spoken lines (castInFrame.dialogue) and its start→end
  // MOTION text directly, so we never re-parse actionOrDialogue (which is a still-frame description, not speech).
  const lines = plan?.speech ?? board.spokenLines ?? extractSpokenLines(board.actionOrDialogue, cast);
  const action = plan?.actionEnglish ?? board.actionText ?? legacyAction(board.actionOrDialogue, cast);
  const tracking = plan ? plan.cameraMode === "TRACKING" : hasActorTravel(board.actionText ?? action);
  return { plan, lines, action, tracking };
}

export function storyboardCameraMode(board: AnimationBoard): "TRACKING" | "LOCKED_OFF" {
  return animationParts(board).tracking ? "TRACKING" : "LOCKED_OFF";
}

/**
 * Stage 235 — the cast-context block for a per-scene (planless) board. When the board carries an explicit shot
 * SCALE + in-frame cast (chosen at plan time for varied board-to-board coverage), state the HARD shot size and
 * exact head-count so the clip holds that framing (1 board = 1 shot = 1 camera setup). Legacy boards without a
 * chosen shot fall back to the presence-derived IN FRAME sentence.
 */
function buildBoardCastContext(board: AnimationBoard): string {
  const context =
    "nobody else appears in the frame. Every other named character remains present in the location, outside the crop; " +
    "stable screen sides and a coherent 180-degree layout for the whole group, each speaker's eyeline on the person " +
    "they address (not always the same partner), never at camera.";
  if (board.shotType && Array.isArray(board.inFrameCast) && board.inFrameCast.length) {
    const visible = board.inFrameCast;
    const cov: BoardCoverage = {
      shotSize: board.shotType as ShotSize,
      visible,
      offScreen: (board.characters ?? []).filter((c) => !visible.includes(c)),
      focus: visible[0] ?? "",
    };
    return `${buildShotSizeLine(cov)} ${context}`;
  }
  const visible = resolveVisibleCast(null, board.boardIndex ?? 1, board.characters ?? [], board.actionOrDialogue).visible;
  return `SCENE CAST CONTEXT — IN FRAME: ${visible.join(", ")}; ${context}`;
}

export function buildStoryboardAnimationPrompt(board: AnimationBoard): string {
  const { plan, lines, action, tracking } = animationParts(board);
  const duration = board.durationSec ?? 6;
  if (!Number.isInteger(duration) || duration < 4 || duration > 30) throw new Error("Storyboard duration must stay 4–30s; rebuild conflicting boards.");
  if (lines.reduce((sum, line) => sum + estimatedSpeechSeconds(line), 0) > duration)
    throw new Error("Dialogue duration conflict: rebuild boards to distribute the original lines across consecutive 4–6s clips. No acceleration, truncation or omitted speech is allowed.");
  // Stage 144 — this board's opening frame already IS the previous board's ongoing moment (continuity), so the
  // motion continues from that inherited pose/contact rather than starting from a neutral stance.
  const prevAction = (board.previousActionText ?? "").trim();
  const continues = prevAction.length > 0;
  const actionLine = continues
    ? `ACTOR ACTION ONLY: The opening frame already shows the ongoing action continued from the previous shot (${prevAction}) — keep every pose, body contact and prop from the opening frame and CONTINUE the motion smoothly from it; do NOT reset to a neutral pose or restart the action. ${action || "Natural continuation with motivated reactions from the opening pose."}`
    : `ACTOR ACTION ONLY: ${action || "Natural breathing and motivated reactions from the opening pose."}`;
  const toEnd = !!board.lastImageUrl;
  const instructions = styledVisualPrompt([
    toEnd
      ? `Animate the scene as ONE continuous live-action shot (this clip: ${duration}s) that begins EXACTLY on the provided START frame (image) and ends EXACTLY on the provided END frame (last_image), moving smoothly and naturally between them across the whole duration. No internal reset — the same characters, wardrobe, props and location throughout.`
      : `Animate the original board opening frame into ONE continuous live-action shot (this clip: ${duration}s).`,
    tracking ? TRACKING_BOARD_CAMERA : LOCKED_BOARD_CAMERA,
    "No internal cuts, transitions, montage or shot/reverse-shot within this clip. Hard cuts and freely selected new angles occur BETWEEN boards only.",
    actionLine,
    plan ? boardShotContext(plan, board.boardIndex ?? 1, undefined, continues) : buildBoardCastContext(board),
    "Keep every character's identity, wardrobe and the location exactly as in the start frame. Preserve the same walls, geometry, materials, lighting and furniture; bench back stays flush against its wall. No teleporting, morphing or frozen padding.",
    lines.length ? "AUDIO: audible ENGLISH on-scene dialogue below, in this exact order and with the indicated delivery. Lip sync ONLY the named speaker to their own line when visible, with their eyeline on that line's addressee; every other present character listens/reacts and NEVER mouths or speaks that line. An off-screen speaker still speaks from their established position (not a narrator). Speak the lines EXACTLY as written in English — no re-translation, paraphrase, additional lines, voice-over narrator or sped-up speech. Finish each phrase naturally within the clip. No background music; preserve natural ambience." : "AUDIO: natural scene ambience, no invented speech or narrator, no background music.",
  ].join("\n"), plan?.cast ?? board.characters ?? []);
  // Append verbatim speech AFTER the visual sanitizer; names/text/delivery must never be rewritten.
  return instructions + (lines.length ? "\nENGLISH SPOKEN LINES (verbatim, not on-screen text):\n" + lines.map((line, i) => `${i + 1}. SPEAKER: ${line.speaker}; TO: ${line.addressee || "the group"}; DELIVERY: ${line.delivery || "natural, consistent with the script"}; SAY EXACTLY: ${JSON.stringify(line.text)}`).join("\n") : "");
}

/** Used by the real worker and mock transport tests, not merely by a preview. */
export function buildStoryboardVideoRequest(board: AnimationBoard & { imageUrl: string }): SeedanceImageToVideoInput {
  if (!/^https?:\/\//.test(board.imageUrl)) throw new Error("Generate the board opening frame before animating it.");
  return {
    prompt: buildStoryboardAnimationPrompt(board),
    image: board.imageUrl, // untouched original opening-frame URL, no resizing or collage
    ...(board.lastImageUrl && /^https?:\/\//.test(board.lastImageUrl) ? { last_image: board.lastImageUrl } : {}),
    resolution: "720p",
    duration: board.durationSec ?? 6,
    generate_audio: true,
  };
}
