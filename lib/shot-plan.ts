/**
 * Stage 167 (task Stage 5+6 replacement) — SHOT-PLAN VALIDATORS + normalizer.
 *
 * Pure, unit-testable functions that turn a raw LLM shot list into a validated PlannedShot[] and check
 * the six shot-plan rules. Each validator returns ACTIONABLE errors so a targeted retry can name the
 * failing rule (reusing the generate → critique → targeted-fix pattern from season-script-job.ts).
 *
 * NO network, NO LLM, NO DB here — this module is 100% pure logic.
 */
import {
  SHOT_MIN_SECONDS,
  SHOT_MAX_SECONDS,
  REACTION_SHOT_MIN_SECONDS,
  REACTION_SHOT_MAX_SECONDS,
  EPISODE_MIN_SHOTS,
  EPISODE_MAX_SHOTS,
  EPISODE_SHOT_TOTAL_MIN,
  EPISODE_SHOT_TOTAL_MAX,
  SHOT_LINE_MAX_WORDS,
  SHOT_MIN_SILENT_RATIO,
} from "@/lib/season";
import {
  type PlannedShot,
  type ShotType,
  type ShotSize,
  type PostFx,
  isShotType,
  isShotSize,
  isPostFx,
  isLineImpact,
  DEFAULT_CLIFFHANGER_TYPE,
} from "@/lib/prompts/shot-plan";

/** A single actionable validation failure. `rule` is a stable id; `message` is human-readable. */
export interface ShotPlanError {
  rule:
    | "shot-count"
    | "total-duration"
    | "shot-duration"
    | "first-three-no-establishing"
    | "high-impact-reaction"
    | "silent-ratio"
    | "line-word-count"
    | "no-adjacent-size-camera"
    | "last-two-cliffhanger"
    | "dialogue-framing";
  message: string;
  /** The shot index the failure is anchored to, when applicable. */
  shotIndex?: number;
}

export interface ShotPlanValidation {
  ok: boolean;
  errors: ShotPlanError[];
}

/* ───────────────────────── helpers ───────────────────────── */

const clean = (t?: string | null) => (t ?? "").replace(/\s+/g, " ").trim();
/** A shot "has a line" when its line is a non-empty string. */
export const shotHasLine = (s: Pick<PlannedShot, "line">): boolean => clean(s.line).length > 0;
/** Word count of a spoken line. */
export const lineWordCount = (line?: string | null): number => {
  const t = clean(line);
  return t ? t.split(" ").length : 0;
};

/* ───────────────────────── individual validators (each pure) ───────────────────────── */

/** First 3 shots must be dialogue OR action, never establishing, and never carry exposition. */
export function validateFirstThreeShots(shots: PlannedShot[]): ShotPlanError[] {
  const errors: ShotPlanError[] = [];
  shots.slice(0, 3).forEach((s) => {
    if (s.shotType === "establishing") {
      errors.push({ rule: "first-three-no-establishing", shotIndex: s.index, message: `Shot ${s.index} is an establishing shot; the first 3 shots must be dialogue or action (no establishing, no exposition).` });
    } else if (s.shotType !== "dialogue" && s.shotType !== "action" && s.shotType !== "reaction") {
      errors.push({ rule: "first-three-no-establishing", shotIndex: s.index, message: `Shot ${s.index} is a "${s.shotType}" shot; the first 3 shots must be dialogue or action.` });
    }
  });
  return errors;
}

/** After each HIGH-impact line, the next shot must be a reaction shot of 0.8–1.5 s. */
export function validateHighImpactReactions(shots: PlannedShot[]): ShotPlanError[] {
  const errors: ShotPlanError[] = [];
  shots.forEach((s, i) => {
    if (shotHasLine(s) && s.lineImpact === "high") {
      const next = shots[i + 1];
      if (!next || next.shotType !== "reaction") {
        errors.push({ rule: "high-impact-reaction", shotIndex: s.index, message: `Shot ${s.index} lands a HIGH-impact line but the next shot is not a reaction shot.` });
      } else if (next.duration < REACTION_SHOT_MIN_SECONDS || next.duration > REACTION_SHOT_MAX_SECONDS) {
        errors.push({ rule: "high-impact-reaction", shotIndex: next.index, message: `Reaction shot ${next.index} must run ${REACTION_SHOT_MIN_SECONDS}–${REACTION_SHOT_MAX_SECONDS} s (got ${next.duration}s).` });
      }
    }
  });
  return errors;
}

/** At least 30% of shots must carry NO spoken line. */
export function validateSilentRatio(shots: PlannedShot[]): ShotPlanError[] {
  if (!shots.length) return [];
  const silent = shots.filter((s) => !shotHasLine(s)).length;
  const ratio = silent / shots.length;
  if (ratio < SHOT_MIN_SILENT_RATIO) {
    return [{ rule: "silent-ratio", message: `Only ${(ratio * 100).toFixed(0)}% of shots are silent; at least ${(SHOT_MIN_SILENT_RATIO * 100).toFixed(0)}% must carry no line.` }];
  }
  return [];
}

/** Every spoken line must be ≤ 12 words. */
export function validateLineWordCounts(shots: PlannedShot[]): ShotPlanError[] {
  const errors: ShotPlanError[] = [];
  shots.forEach((s) => {
    const wc = lineWordCount(s.line);
    if (wc > SHOT_LINE_MAX_WORDS) {
      errors.push({ rule: "line-word-count", shotIndex: s.index, message: `Shot ${s.index} line is ${wc} words; every line must be ≤ ${SHOT_LINE_MAX_WORDS} words.` });
    }
  });
  return errors;
}

/** Two adjacent shots must never repeat the same size + camera combination. */
export function validateNoAdjacentSizeCamera(shots: PlannedShot[]): ShotPlanError[] {
  const errors: ShotPlanError[] = [];
  for (let i = 1; i < shots.length; i++) {
    const prev = shots[i - 1];
    const cur = shots[i];
    if (prev.size === cur.size && clean(prev.camera).toLowerCase() === clean(cur.camera).toLowerCase()) {
      errors.push({ rule: "no-adjacent-size-camera", shotIndex: cur.index, message: `Shots ${prev.index} and ${cur.index} repeat the same size (${cur.size}) + camera (${cur.camera}); vary one of them.` });
    }
  }
  return errors;
}

/**
 * A dialogue / reaction shot that carries a spoken line must never be a WS (Stage 164 framing rule at
 * the shot level).
 */
export function validateDialogueFraming(shots: PlannedShot[]): ShotPlanError[] {
  const errors: ShotPlanError[] = [];
  shots.forEach((s) => {
    if ((s.shotType === "dialogue" || s.shotType === "reaction") && shotHasLine(s) && s.size === "WS") {
      errors.push({ rule: "dialogue-framing", shotIndex: s.index, message: `Shot ${s.index} speaks a line in a WS; a dialogue/reaction shot with a line must be OTS / MS / MCU / CU, never WS.` });
    }
  });
  return errors;
}

/**
 * The last two shots must form an expectationFlip (arrival → strike) OR satisfy a supplied cliffhanger
 * type. When `cliffhangerType` is absent, the DEFAULT (expectationFlip) is required.
 */
export function validateLastTwoCliffhanger(shots: PlannedShot[], opts: { cliffhangerType?: string | null } = {}): ShotPlanError[] {
  if (shots.length < 2) {
    return [{ rule: "last-two-cliffhanger", message: "An episode needs at least two shots to build the closing cliffhanger." }];
  }
  const type = clean(opts.cliffhangerType) || DEFAULT_CLIFFHANGER_TYPE;
  const penult = shots[shots.length - 2];
  const last = shots[shots.length - 1];
  // Path A — expectationFlip: penultimate marked "arrival", last marked "strike".
  const isFlip = penult.cliffhangerRole === "arrival" && last.cliffhangerRole === "strike";
  // Path B — a named seasonMap cliffhanger type reflected on the last shot.
  const namedType = clean(last.cliffhangerType).toLowerCase();
  const isNamed = namedType.length > 0 && namedType === type.toLowerCase();
  if (type.toLowerCase() === DEFAULT_CLIFFHANGER_TYPE.toLowerCase()) {
    if (!isFlip && !isNamed) {
      return [{ rule: "last-two-cliffhanger", message: `The last two shots must form an expectationFlip: shot ${penult.index} = a force arriving (cliffhangerRole "arrival"), shot ${last.index} = it striking the heroine (cliffhangerRole "strike").` }];
    }
  } else if (!isNamed && !isFlip) {
    return [{ rule: "last-two-cliffhanger", message: `The last two shots must satisfy the season cliffhanger type "${type}" (set the last shot's cliffhangerType) or the expectationFlip fallback.` }];
  }
  return [];
}

/** Shot count, per-shot duration and whole-episode total-duration bounds. */
export function validateShotCounts(shots: PlannedShot[]): ShotPlanError[] {
  const errors: ShotPlanError[] = [];
  if (shots.length < EPISODE_MIN_SHOTS || shots.length > EPISODE_MAX_SHOTS) {
    errors.push({ rule: "shot-count", message: `An episode must have ${EPISODE_MIN_SHOTS}–${EPISODE_MAX_SHOTS} shots (got ${shots.length}).` });
  }
  shots.forEach((s) => {
    const isReaction = s.shotType === "reaction";
    const min = isReaction ? REACTION_SHOT_MIN_SECONDS : SHOT_MIN_SECONDS;
    const max = isReaction ? REACTION_SHOT_MAX_SECONDS : SHOT_MAX_SECONDS;
    if (s.duration < min || s.duration > max) {
      errors.push({ rule: "shot-duration", shotIndex: s.index, message: `Shot ${s.index} (${s.shotType}) runs ${s.duration}s; must be ${min}–${max}s.` });
    }
  });
  const total = shots.reduce((a, s) => a + (s.duration || 0), 0);
  if (total < EPISODE_SHOT_TOTAL_MIN || total > EPISODE_SHOT_TOTAL_MAX) {
    errors.push({ rule: "total-duration", message: `The episode total is ${total.toFixed(1)}s; must be ${EPISODE_SHOT_TOTAL_MIN}–${EPISODE_SHOT_TOTAL_MAX}s.` });
  }
  return errors;
}

/* ───────────────────────── aggregate ───────────────────────── */

/** Run EVERY shot-plan validator; returns { ok, errors } with all actionable failures (ordered). */
export function validateShotPlan(shots: PlannedShot[], opts: { cliffhangerType?: string | null } = {}): ShotPlanValidation {
  const errors: ShotPlanError[] = [
    ...validateShotCounts(shots),
    ...validateFirstThreeShots(shots),
    ...validateHighImpactReactions(shots),
    ...validateSilentRatio(shots),
    ...validateLineWordCounts(shots),
    ...validateNoAdjacentSizeCamera(shots),
    ...validateDialogueFraming(shots),
    ...validateLastTwoCliffhanger(shots, opts),
  ];
  return { ok: errors.length === 0, errors };
}

/* ───────────────────────── normalizer ───────────────────────── */

type RawShot = Partial<Record<keyof PlannedShot, unknown>>;

/**
 * Coerce a raw LLM shot array into a well-typed PlannedShot[]: fill safe defaults for missing/invalid
 * enums, force a 0-based sequential `index`, coerce numeric duration, and default `sceneNumber` to 1.
 * Never throws — a totally malformed entry becomes a safe placeholder shot. Pure.
 */
export function normalizeShotPlan(raw: unknown): PlannedShot[] {
  const arr: RawShot[] = Array.isArray(raw)
    ? (raw as RawShot[])
    : Array.isArray((raw as { shots?: unknown })?.shots)
    ? ((raw as { shots: RawShot[] }).shots)
    : [];
  return arr.map((r, i) => {
    const shotType: ShotType = isShotType(r.shotType) ? r.shotType : "dialogue";
    const size: ShotSize = isShotSize(r.size) ? r.size : "MS";
    const postFx: PostFx = isPostFx(r.postFx) ? r.postFx : "none";
    const durNum = typeof r.duration === "number" && Number.isFinite(r.duration) ? r.duration : SHOT_MIN_SECONDS;
    const line = typeof r.line === "string" ? r.line : null;
    return {
      index: i,
      sceneNumber: typeof r.sceneNumber === "number" && r.sceneNumber > 0 ? Math.round(r.sceneNumber) : 1,
      shotType,
      size,
      duration: durNum,
      camera: typeof r.camera === "string" && r.camera.trim() ? r.camera.trim() : shotType,
      speakerId: typeof r.speakerId === "string" ? r.speakerId : null,
      line,
      lineImpact: isLineImpact(r.lineImpact) ? r.lineImpact : (line ? "medium" : null),
      reactionOfId: typeof r.reactionOfId === "string" ? r.reactionOfId : null,
      escalationBeat: typeof r.escalationBeat === "string" && r.escalationBeat.trim() ? r.escalationBeat.trim() : "verbal",
      postFx,
      matchCutIn: typeof r.matchCutIn === "string" ? r.matchCutIn.trim() : "",
      matchCutOut: typeof r.matchCutOut === "string" ? r.matchCutOut.trim() : "",
      cliffhangerRole: r.cliffhangerRole === "arrival" || r.cliffhangerRole === "strike" ? r.cliffhangerRole : null,
      cliffhangerType: typeof r.cliffhangerType === "string" ? r.cliffhangerType : null,
    } satisfies PlannedShot;
  });
}
