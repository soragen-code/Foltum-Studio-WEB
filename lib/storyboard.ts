/**
 * Stage 127 — STORYBOARD production mode (pure logic).
 *
 * An alternative to the classic SCENES pipeline, chosen AFTER the episode story is built. Instead of
 * dividing the episode into 9 scenes with reangle/region-plate continuity (text-to-video), STORYBOARD
 * breaks the story into 12–15 KEYFRAME BOARDS. Each board is ONE shot change — one action beat OR one
 * pair of dialogue lines — rendered as a 9:16 reference still (Seedream) that is then ANIMATED into a
 * 3–6s clip via IMAGE-TO-VIDEO (the board frame is the clip's START frame). The 12–15 clips are stitched
 * into one ~90s cut.
 *
 * This module is PURE (no network, no LLM, no DB): board-count / duration maths, the single flowing
 * through-line derived from the shared footage description (WITHOUT the SHOT 1 / SHOT 2 "first-30 /
 * last-30" split), the LLM prompt builders and the normalizer/validator for the model's board list.
 *
 * IMPORTANT scoping: the classic SCENES footage 2-beat plan (SHOT 1 / SHOT 2 / CLIFFHANGER) is left
 * intact — SCENES depends on it. STORYBOARD only READS that description and merges it into one
 * continuous story seed here; it never rewrites the stored episode description.
 */
import { parseEpisodeFootage } from "@/lib/season";

/* ───────────── board-count & duration budget ───────────── */

/** 12–15 boards per episode (one shot change each). */
export const STORYBOARD_MIN_BOARDS = 12;
export const STORYBOARD_MAX_BOARDS = 15;

/**
 * Per-board clip length. The task asks for a shot change every 3–6s; the image-to-video provider
 * (Seedance 2.5 i2v) floors a clip at 4s (SEEDANCE_I2V_MIN_DURATION) and caps it at 6s for a board,
 * so the RENDERED window is [4,6]. 4–6s ⊂ 3–6s, so the "every 3–6s" rule still holds.
 */
export const STORYBOARD_MIN_BOARD_SEC = 4;
export const STORYBOARD_MAX_BOARD_SEC = 6;

/** Target total length of the stitched cut (~90s ≈ 1.5 min). Bounded below by count·4 and above by count·6. */
export const STORYBOARD_TARGET_TOTAL_SEC = 90;

/** A board as produced by the LLM split (before we assign an index / clamp durations). */
export interface RawBoard {
  /** One action beat OR one dialogue pair (story language). */
  actionOrDialogue: string;
  /** English image-to-video MOTION note: what visibly moves during the 3–6s animation. */
  motion?: string | null;
  /** Suggested clip length in seconds (clamped to [4,6]); optional — filled by distribution when absent. */
  durationSec?: number | null;
}

/** A normalized board ready to persist (index assigned, duration clamped). */
export interface NormalizedBoard {
  index: number;
  actionOrDialogue: string;
  motion: string | null;
  durationSec: number;
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/**
 * Distribute a total running time across `count` boards so every board lands in [4,6]s and the sum is
 * as close to ~90s as the window allows (count·4 … count·6). With 15 boards this reaches 90s exactly;
 * with 12 boards the reachable max is 72s (still "~1–1.5 min"). Deterministic and pure.
 */
export function distributeBoardDurations(count: number, total = STORYBOARD_TARGET_TOTAL_SEC): number[] {
  const n = Math.max(1, Math.floor(count));
  const lo = STORYBOARD_MIN_BOARD_SEC, hi = STORYBOARD_MAX_BOARD_SEC;
  const clampedTotal = Math.max(n * lo, Math.min(n * hi, Math.round(total)));
  const base = Math.floor(clampedTotal / n);
  let rem = clampedTotal - base * n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(clampInt(base + (i < rem ? 1 : 0), lo, hi));
  }
  return out;
}

/**
 * Normalize the LLM's board list into persistable boards: trim to 12–15, assign 0-based indices in
 * order, and clamp/fill each board's duration to the [4,6]s window (using the ~90s distribution for
 * any board the model left without a duration). Boards with empty text are dropped before counting.
 */
export function normalizeBoards(raw: RawBoard[]): NormalizedBoard[] {
  const cleaned = (raw ?? [])
    .map((b) => ({
      actionOrDialogue: (b?.actionOrDialogue ?? "").trim(),
      motion: (b?.motion ?? "").trim() || null,
      durationSec: b?.durationSec ?? null,
    }))
    .filter((b) => b.actionOrDialogue.length > 0);
  // Enforce the 12–15 window: never keep more than the max (extra boards are dropped from the end).
  const kept = cleaned.slice(0, STORYBOARD_MAX_BOARDS);
  const fallback = distributeBoardDurations(kept.length);
  return kept.map((b, i) => ({
    index: i,
    actionOrDialogue: b.actionOrDialogue,
    motion: b.motion,
    durationSec:
      b.durationSec != null && Number.isFinite(b.durationSec)
        ? clampInt(b.durationSec, STORYBOARD_MIN_BOARD_SEC, STORYBOARD_MAX_BOARD_SEC)
        : fallback[i],
  }));
}

/** Human-readable problems with a normalized board list (empty = valid). Used by the route and tests. */
export function validateBoards(boards: NormalizedBoard[]): string[] {
  const problems: string[] = [];
  if (boards.length < STORYBOARD_MIN_BOARDS)
    problems.push(`only ${boards.length} boards (need at least ${STORYBOARD_MIN_BOARDS})`);
  if (boards.length > STORYBOARD_MAX_BOARDS)
    problems.push(`${boards.length} boards (max ${STORYBOARD_MAX_BOARDS})`);
  boards.forEach((b, i) => {
    if (b.index !== i) problems.push(`board ${i}: index out of order (${b.index})`);
    if (!b.actionOrDialogue.trim()) problems.push(`board ${i}: empty action/dialogue`);
    if (b.durationSec < STORYBOARD_MIN_BOARD_SEC || b.durationSec > STORYBOARD_MAX_BOARD_SEC)
      problems.push(`board ${i}: duration ${b.durationSec}s out of [${STORYBOARD_MIN_BOARD_SEC},${STORYBOARD_MAX_BOARD_SEC}]`);
  });
  return problems;
}

/** Sum of the clip durations = the length of the final stitched cut. */
export function totalBoardSeconds(boards: { durationSec: number }[]): number {
  return boards.reduce((s, b) => s + b.durationSec, 0);
}

/* ───────────── single flowing through-line (no 30/30 split) ───────────── */

/** Strip labels/markers that impose a two-beat "first-30 / last-30" division. */
const SPLIT_MARKER_RE = /\b(?:shot\s*1|shot\s*2|beat\s*1|beat\s*2|opens\s+on|cliffhanger|first\s+30|last\s+30)\s*(?:\([^)]*\))?\s*:?/gi;

/**
 * Build the STORYBOARD story seed: a SINGLE flowing through-line, a bit more detailed than a logline and
 * WITHOUT the "first 30s / last 30s" (SHOT 1 / SHOT 2) division. When the shared episode description is
 * the 2-beat footage plan, its beats are merged into one continuous sequence of events (labels removed);
 * otherwise the raw description is returned with any stray split markers stripped. The stored episode
 * description is never modified — this is a read-only derivation for the STORYBOARD board split.
 */
export function detailedEpisodeStory(description: string | null | undefined): string {
  const raw = (description ?? "").replace(/\*\*/g, "").trim();
  if (!raw) return "";
  const f = parseEpisodeFootage(raw);
  if (f) {
    // Merge the beats into one through-line: opening image → action → escalation → final image, no labels.
    const opening = f.opensOn ? f.opensOn.trim() : "";
    const shot1 = f.shot1.replace(/^\s*opens\s+on\s*:\s*/i, "").trim();
    const shot1Body = opening && shot1.startsWith(opening) ? shot1.slice(opening.length).trim() : shot1;
    const parts = [opening, shot1Body, f.shot2.trim(), f.cliffhanger.trim()].filter(Boolean);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }
  return raw.replace(SPLIT_MARKER_RE, "").replace(/\s+/g, " ").trim();
}

/** True when the text still carries a two-beat / 30-30 split marker (used by tests & the revise guard). */
export function hasSplitMarkers(text: string | null | undefined): boolean {
  return SPLIT_MARKER_RE.test(text ?? "");
}

/* ───────────── LLM prompt builders for the board split ───────────── */

/** JSON shape the split model must return. */
export const STORYBOARD_BOARDS_JSON_HINT =
  `Return JSON: { "boards": [ { "actionOrDialogue": "<one action beat OR one pair of dialogue lines, story language>", "motion": "<English: what visibly MOVES during the 3-6s animation — subject action + camera move>", "durationSec": <integer 4..6> }, ... ] }`;

export function storyboardBoardsSystemPrompt(): string {
  return [
    "You are a storyboard director for a vertical 9:16 short AI drama (~90 seconds).",
    "You receive the episode STORY as a single flowing through-line (no scene division).",
    `Break it into ${STORYBOARD_MIN_BOARDS}-${STORYBOARD_MAX_BOARDS} KEYFRAME BOARDS.`,
    "RULES:",
    "- 1 board = 1 SHOT CHANGE. A shot change happens every 3-6 seconds of screen time.",
    "- Each board depicts EITHER one physical action beat OR one pair of dialogue lines (at most two spoken lines) — never both, never more.",
    "- The boards run in strict chronological order and together cover the WHOLE story from its opening image to its final image, with no gaps and no time skips.",
    "- Each board's frame is a single still that becomes the START frame of a 3-6s image-to-video clip, so also describe the MOTION: what the subject does and how the camera moves during those seconds.",
    `- The clips are stitched into one continuous cut of about ${STORYBOARD_TARGET_TOTAL_SEC} seconds; give each board a durationSec between ${STORYBOARD_MIN_BOARD_SEC} and ${STORYBOARD_MAX_BOARD_SEC}.`,
    "- Keep the same characters and locations throughout; do not invent new events beyond the story.",
    STORYBOARD_BOARDS_JSON_HINT,
  ].join("\n");
}

export function storyboardBoardsUserPrompt(story: string, opts?: { characters?: string[]; location?: string | null }): string {
  const chars = opts?.characters?.filter(Boolean) ?? [];
  const loc = (opts?.location ?? "").trim();
  return [
    loc ? `LOCATION: ${loc}` : "",
    chars.length ? `CHARACTERS: ${chars.join(", ")}` : "",
    "STORY (single through-line — split it into boards in order):",
    story.trim(),
  ].filter(Boolean).join("\n\n");
}
