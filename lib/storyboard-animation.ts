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
  const lines = plan?.speech ?? extractSpokenLines(board.actionOrDialogue, cast);
  const action = plan?.actionEnglish ?? legacyAction(board.actionOrDialogue, cast);
  return { plan, lines, action, tracking: plan ? plan.cameraMode === "TRACKING" : hasActorTravel(action) };
}

export function storyboardCameraMode(board: AnimationBoard): "TRACKING" | "LOCKED_OFF" {
  return animationParts(board).tracking ? "TRACKING" : "LOCKED_OFF";
}

export function buildStoryboardAnimationPrompt(board: AnimationBoard): string {
  const { plan, lines, action, tracking } = animationParts(board);
  const duration = board.durationSec ?? 6;
  if (!Number.isInteger(duration) || duration < 4 || duration > 6) throw new Error("Storyboard duration must stay 4–6s; rebuild conflicting boards.");
  if (lines.reduce((sum, line) => sum + estimatedSpeechSeconds(line), 0) > duration)
    throw new Error("Dialogue duration conflict: rebuild boards to distribute the original lines across consecutive 4–6s clips. No acceleration, truncation or omitted speech is allowed.");
  const instructions = styledVisualPrompt([
    `Animate the original board opening frame into ONE continuous 3-6 second live-action shot (this clip: ${duration}s).`,
    tracking ? TRACKING_BOARD_CAMERA : LOCKED_BOARD_CAMERA,
    "No internal cuts, transitions, montage or shot/reverse-shot within this clip. Hard cuts and freely selected new angles occur BETWEEN boards only.",
    `ACTOR ACTION ONLY: ${action || "Natural breathing and motivated reactions from the opening pose."}`,
    plan ? boardShotContext(plan) : `SCENE CAST CONTEXT: ${(board.characters ?? []).join(", ")}. Every named character remains present even outside the crop; stable screen sides and a coherent 180-degree layout for the whole group, each speaker's eyeline on the person they address (not always the same partner), never at camera.`,
    "Keep every character's identity, wardrobe and the location exactly as in the start frame. Preserve the same walls, geometry, materials, lighting and furniture; bench back stays flush against its wall. No teleporting, morphing or frozen padding.",
    lines.length ? "AUDIO: audible original-language on-scene dialogue below, in this exact order and with the indicated delivery. Lip sync ONLY the named speaker to their own line when visible, with their eyeline on that line's addressee; every other present character listens/reacts and NEVER mouths or speaks that line. An off-screen speaker still speaks from their established position (not a narrator). No translated speech, paraphrase, additional lines, voice-over narrator or sped-up speech. Finish each phrase naturally within the clip. No background music; preserve natural ambience." : "AUDIO: natural scene ambience, no invented speech or narrator, no background music.",
  ].join("\n"), plan?.cast ?? board.characters ?? []);
  // Append verbatim speech AFTER the visual sanitizer; names/text/delivery must never be rewritten.
  return instructions + (lines.length ? "\nORIGINAL SPOKEN LINES (verbatim, not on-screen text):\n" + lines.map((line, i) => `${i + 1}. SPEAKER: ${line.speaker}; TO: ${line.addressee || "the group"}; DELIVERY: ${line.delivery || "natural, consistent with the script"}; SAY EXACTLY: ${JSON.stringify(line.text)}`).join("\n") : "");
}

/** Used by the real worker and mock transport tests, not merely by a preview. */
export function buildStoryboardVideoRequest(board: AnimationBoard & { imageUrl: string }): SeedanceImageToVideoInput {
  if (!/^https?:\/\//.test(board.imageUrl)) throw new Error("Generate the board opening frame before animating it.");
  return {
    prompt: buildStoryboardAnimationPrompt(board),
    image: board.imageUrl, // untouched original opening-frame URL, no resizing or collage
    resolution: "720p",
    duration: board.durationSec ?? 6,
    generate_audio: true,
  };
}
