/**
 * Stage 143 — per-board VISIBLE CAST + hard SHOT SIZE + deterministic scene coverage (Storyboard only, pure).
 *
 * Why: every board used to receive the identity references of the WHOLE episode cast in image_input and listed
 * the whole cast in the prompt ("not everyone must be visible", "Choose ONE framing", "CAMERA: free"), and since
 * Stage 142 the scene anchor frame (a wide with everybody) was attached too. The diffusion model therefore drew
 * every board as the same wide group shot — no singles on the speaker, no reverse on the listener.
 *
 * Fix (three layers, all deterministic, no LLM):
 *   1. resolveVisibleCast(): from the board's BoardDirection (speaker / addressee / shot) and its position in the
 *      scene → EXACTLY which characters are in frame and the shot size. Only THEIR reference images go into
 *      image_input; everyone else is named once as OFF-SCREEN.
 *   2. planSceneCoverage(): applied at planning time to the whole scene — CHARACTER-FORWARD (Stage 146): board 1 is
 *      a WIDE ESTABLISHING with the whole cast (a justified scene-opening establishing), and every LATER dialogue
 *      board stays built around the characters — a mid-scene "group" wide ALWAYS degrades to OTS / medium on the
 *      speaker (a wide is no longer the periodic base of a talking scene). Group ACTION (3+ participants,
 *      entrances/exits) is still a justified wide, resolved by count.
 *   3. Prompt blocks: SHOT SIZE (EXACTLY N in frame, nobody else anywhere) + OFF-SCREEN line.
 * The 180° axis / established screen sides (S134) and the speech ledger (S139) are untouched.
 */
import type { BoardDirection } from "@/lib/storyboard-direction";

export type ShotSize =
  | "CLOSE-UP"
  | "MEDIUM CLOSE-UP"
  | "MEDIUM"
  | "OVER-THE-SHOULDER"
  | "TWO-SHOT"
  | "THREE-SHOT"
  | "WIDE ESTABLISHING";

export interface BoardCoverage {
  shotSize: ShotSize;
  /** Characters actually in frame (cast order). */
  visible: string[];
  /** Cast members present in the location but NOT visible in this frame. */
  offScreen: string[];
  /** The active speaker (dialogue boards) — the in-focus subject of a single / OTS; "" for action boards. */
  focus: string;
}

/** A wide (whole-cast) dialogue board may repeat at most once every WIDE_MIN_GAP boards. */
export const WIDE_MIN_GAP = 4;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Cast members literally named in a text (cast order). Unicode-safe word boundaries; case-insensitive. */
export function castNamesInText(text: string, cast: string[]): string[] {
  const t = text ?? "";
  if (!t.trim()) return [];
  return cast.filter((name) => {
    const n = name.trim();
    if (!n) return false;
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, "iu").test(t);
  });
}

const inCastOrder = (names: string[], cast: string[]) => cast.filter((c) => names.includes(c));

function sizeByCount(n: number): ShotSize {
  return n <= 1 ? "MEDIUM" : n === 2 ? "TWO-SHOT" : "WIDE ESTABLISHING";
}

/**
 * EXACTLY who is in frame and at what shot size for one board.
 *   - board 1 of the scene → WIDE ESTABLISHING, whole cast (sets the geometry the anchor frame will carry)
 *   - dialogue: close_up / medium → speaker only; over_shoulder / listener_reverse → speaker + addressee;
 *     two_shot → the pair; three_shot → speaker, addressee + one more; group → whole cast
 *   - action (no speech) / legacy board without direction → the cast members named in the action text;
 *     nobody named → whole cast. 3+ participants → wide.
 */
export function resolveVisibleCast(
  direction: BoardDirection | null,
  boardPosInScene: number,
  cast: string[],
  actionText: string,
): BoardCoverage {
  const fullCast = Array.from(new Set(cast.map((c) => c.trim()).filter(Boolean)));
  const finish = (shotSize: ShotSize, names: string[], focus = ""): BoardCoverage => {
    const visible = inCastOrder(Array.from(new Set(names.filter((n) => fullCast.includes(n)))), fullCast);
    const vis = visible.length ? visible : fullCast;
    return { shotSize: visible.length ? shotSize : sizeByCount(vis.length), visible: vis, offScreen: fullCast.filter((c) => !vis.includes(c)), focus: vis.includes(focus) ? focus : "" };
  };
  // Stage 152 — the FIRST board of a scene (boardPosInScene 0) that OPENS on dialogue is a CLOSE-UP of the first
  // speaker (the character delivering the scene's first source line), not a whole-cast wide. An action-only /
  // empty first board keeps the WIDE ESTABLISHING opener (nothing is being said, so there is no speaker to favour).
  if (boardPosInScene <= 0 || fullCast.length === 0) {
    const opening = direction?.speech ?? [];
    const firstSpeaker = opening[0]?.speaker || direction?.focus || "";
    if (opening.length && firstSpeaker && fullCast.includes(firstSpeaker))
      return finish("CLOSE-UP", [firstSpeaker], firstSpeaker);
    return finish("WIDE ESTABLISHING", fullCast);
  }

  const speech = direction?.speech ?? [];
  if (!direction || speech.length === 0) {
    const named = castNamesInText(`${direction?.actionEnglish ?? ""}\n${actionText ?? ""}`, fullCast);
    const participants = named.length ? named : fullCast;
    return finish(sizeByCount(participants.length), participants);
  }

  const speaker = speech[speech.length - 1]?.speaker || direction.focus;
  const addressee = direction.addressee || direction.listener || (fullCast.length === 2 ? fullCast.find((c) => c !== speaker) ?? "" : "");
  const pair = addressee ? [speaker, addressee] : [speaker];
  switch (direction.shot) {
    // Stage 152 — a per-scene opener at board index > 0 is tagged shot=close_up with focus = the scene's FIRST
    // speaker (planSceneCoverage). Honour that focus when it is a real speaker in this board; otherwise a normal
    // mid-scene close_up favours the active (last) speaker exactly as before (finalize sets focus = last there).
    case "close_up": { const f = direction.focus && speech.some((s) => s.speaker === direction.focus) ? direction.focus : speaker; return finish("CLOSE-UP", [f], f); }
    case "medium": return finish("MEDIUM", [speaker], speaker);
    case "over_shoulder": return finish(addressee ? "OVER-THE-SHOULDER" : "MEDIUM", pair, speaker);
    // Reverse: the frame favours the addressed listener (reaction), the speaker stays in the pair.
    case "listener_reverse": return finish(addressee ? "MEDIUM CLOSE-UP" : "MEDIUM", pair, addressee || speaker);
    case "two_shot": {
      const other = addressee || fullCast.find((c) => c !== speaker) || "";
      return finish(other ? "TWO-SHOT" : "MEDIUM", other ? [speaker, other] : [speaker], speaker);
    }
    case "three_shot": {
      const third = fullCast.find((c) => !pair.includes(c)) ?? "";
      const trio = third ? [...pair, third] : pair;
      return finish(trio.length >= 3 ? "THREE-SHOT" : trio.length === 2 ? "TWO-SHOT" : "MEDIUM", trio, speaker);
    }
    case "group": return finish("WIDE ESTABLISHING", fullCast, speaker);
    default: return finish(addressee ? "OVER-THE-SHOULDER" : "MEDIUM", pair, speaker);
  }
}

/**
 * Stage 152 — CHARACTER-FORWARD scene coverage applied to the WHOLE scene at planning time (shots known before render):
 *   - the FIRST dialogue board of EVERY scene → CLOSE-UP of that scene's FIRST speaker (the character who delivers
 *     the scene's first source dialogue line = speech[0].speaker). Scene boundaries are detected from each line's
 *     `scene` tag (threaded from the source builders): a board opens a scene when it is the very first board, or its
 *     first line's scene number differs from the previous dialogue board's. This supersedes the Stage 146 rule that
 *     made board 1 a WIDE ESTABLISHING group shot.
 *   - every LATER dialogue board stays built around the characters: a mid-scene "group" wide ALWAYS degrades to
 *     over_shoulder (when the line has an addressee / listener) or medium on the ACTIVE (last) speaker — a wide is no
 *     longer the periodic base of a talking scene, it only returns when a shot genuinely needs it.
 *   - group ACTION (3+ named participants / whole cast moving) is still a justified wide (resolveVisibleCast by count).
 *   - an action-only (speechless) board is never touched, so a scene that opens on action keeps its wide establishing.
 * Speech, cast, addressee, listener, camera data and the S139 ledger are never touched — only `shot` / `focus`.
 * The 180° axis / established screen sides (S134) remain owned by boardShotContext, unchanged here.
 */
export function planSceneCoverage(directions: BoardDirection[], _actionTexts: string[] = []): BoardDirection[] {
  let prevScene: number | undefined;
  return directions.map((d, i) => {
    if (!d.speech.length) return d;
    const scene = d.speech[0]?.scene;
    const isOpener = i === 0 || (scene != null && scene !== prevScene);
    if (scene != null) prevScene = scene;
    const firstSpeaker = d.speech[0]?.speaker || d.focus;
    const activeSpeaker = d.speech[d.speech.length - 1]?.speaker || d.focus;
    if (isOpener) return { ...d, shot: "close_up", focus: firstSpeaker };
    if (d.shot === "group") return { ...d, shot: d.addressee || d.listener ? "over_shoulder" : "medium", focus: activeSpeaker };
    return d;
  });
}

/** Prompt block: hard shot size + exact head-count (English, for Seedream). */
export function buildShotSizeLine(c: BoardCoverage): string {
  const n = c.visible.length;
  const partner = c.visible.find((v) => v !== c.focus) ?? "";
  const ots = c.shotSize === "OVER-THE-SHOULDER" && c.focus && partner
    ? ` Foreground: the back of ${partner}'s shoulder/head, large and soft; ${c.focus} in focus beyond it.`
    : c.shotSize === "MEDIUM CLOSE-UP" && c.focus && partner
      ? ` Reverse angle: ${c.focus} in focus, listening/reacting; ${partner} only partially at the frame edge.`
      : "";
  return `SHOT SIZE: ${c.shotSize} — EXACTLY ${n} character${n === 1 ? "" : "s"} in frame: ${c.visible.join(", ")}. No other people, faces, silhouettes or crowd visible anywhere in the frame, including the background.${ots}`;
}

/** Prompt line naming the cast members who stay in the location but are NOT in this frame. */
export function buildOffScreenLine(c: BoardCoverage): string {
  return c.offScreen.length ? `OFF-SCREEN (not visible in this frame, remain in the location): ${c.offScreen.join(", ")}.` : "";
}
