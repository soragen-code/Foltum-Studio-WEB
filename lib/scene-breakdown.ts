/**
 * P7–P10 (pipeline fix) — PURE, offline-testable decision helpers for the episode scene-breakdown
 * worker (lib/workers/scenes-job.ts). This is a LEAF module: it imports NOTHING at runtime (no prisma,
 * no LLM client), so every function here can be exercised on synthetic fixtures without a DB / network.
 *
 * It owns four independent concerns:
 *   P7  — scriptApprovalState / scriptFingerprint: the "approved script is the single source of truth"
 *         gate and a stable hash of a script used to detect when derived scenes have gone STALE.
 *   P8  — validateSceneCoverage: coverage validation that REPLACES the old blind slice(0, MAX_SCENES).
 *         The scene count is a PRODUCTION LIMIT, not a quality target, so "too few" is never a failure;
 *         only real coverage gaps (missing action, broken order, no final scene) are problems, and going
 *         OVER the production ceiling is reported explicitly (never a silent drop of core scenes).
 *   P10 — pickPredecessorState / dependentStateIds: pick the season-memory predecessor by
 *         reflectsEpisodeNumber (NOT by updatedAt), and find the later states that a reworked early
 *         episode invalidates (so they can be marked stale).
 */

/* ───────────────────────── P7 — approved-script single source of truth ───────────────────────── */

export interface EpisodeApprovalLike {
  /** The approved shooting script (Episode.script). Empty/whitespace/absent = not approved. */
  script?: string | null;
  /** Episode.status — context only; the REAL approval signal is a non-empty script. */
  status?: string | null;
}

export interface ScriptApprovalState {
  approved: boolean;
  /** Human-readable reason, used verbatim in the HALT message when not approved. */
  reason: string;
}

/**
 * The scene breakdown MUST be built from the episode's APPROVED script (its events + dialogue are the
 * single source of truth), never re-derived from the project synopsis + episode description. There is no
 * separate `scriptApprovedAt` field in the schema: the real signal that a script exists and was approved
 * is a NON-EMPTY `Episode.script` (the season/episode script job sets status → "script_ready" and writes
 * the script text together). Moving an episode into the scene breakdown IS the approval step.
 *
 * PURE. Returns { approved:false } with a clear reason when there is no usable script, so the worker can
 * HALT with a status/error instead of silently generating scenes from the description.
 */
export function scriptApprovalState(episode: EpisodeApprovalLike | null | undefined): ScriptApprovalState {
  const script = (episode?.script ?? "").trim();
  if (!script) {
    return {
      approved: false,
      reason:
        "This episode has no approved script yet. Generate and approve the episode script first — the " +
        "scene breakdown is built from the approved script, not from the synopsis/description.",
    };
  }
  return { approved: true, reason: "Approved script present." };
}

/**
 * A stable, order-sensitive fingerprint of a script's meaningful text. Used to detect that the script an
 * episode's scenes/shots were derived from has CHANGED (→ the derived rows are stale). Whitespace-insensitive
 * (collapses runs of whitespace) so cosmetic reformatting does not spuriously invalidate derived rows, but
 * any real change to events/dialogue changes the hash. PURE and dependency-free (small FNV-1a hash).
 */
export function scriptFingerprint(script: string | null | undefined): string {
  const normalized = (script ?? "").replace(/\s+/g, " ").trim();
  // FNV-1a 32-bit — deterministic, no crypto import needed for a change-detection hash.
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Unsigned hex + length, so different-length collisions are astronomically unlikely.
  return `${(h >>> 0).toString(16)}-${normalized.length}`;
}

/* ───────────────────────── P8 — scene coverage validation (no blind slice) ───────────────────────── */

export interface CoverageSceneLike {
  number?: number | null;
  action?: string | null;
  dialogue?: string | null;
}

export interface SceneCoverageResult {
  /** Real coverage gaps that make the breakdown unusable (order/action/final-scene). NEVER "too few". */
  problems: string[];
  /** True when more scenes were produced than the production ceiling can hold (explicit, never silent). */
  overLimit: boolean;
  /** How many scenes the model produced. */
  count: number;
  /** The production ceiling (a hard clip limit, NOT a quality target). */
  maxScenes: number;
  /** How many scenes exceed the ceiling and would be trimmed (0 when within the limit). */
  overflow: number;
  /** 1-based indices of scenes with no action text. */
  missingAction: number[];
  /** 1-based indices of scenes whose dialogue block has no SPEAKER-labelled line. */
  missingSpeakers: number[];
}

/** A dialogue block preserves speakers when at least one line looks like `SPEAKER (cue): "line"` / `SPEAKER: line`. */
export function dialogueHasSpeaker(dialogue: string | null | undefined): boolean {
  const text = (dialogue ?? "").trim();
  if (!text) return false;
  // A speaker label = a leading token in CAPS / TitleCase followed by an optional "(cue)" then a colon.
  return text
    .split(/\r?\n/)
    .some((line) => /^\s*[\p{Lu}][\p{L}0-9 .'’\-]*(?:\s*\([^)]*\))?\s*:/u.test(line.trim()));
}

/**
 * Validate that the scene breakdown COVERS the approved script instead of blindly trimming it.
 *
 * The old worker used `scenes.slice(0, MAX_SCENES)` as the ONLY mechanism — silently dropping any scene
 * past the ceiling, and never checking that the kept scenes actually covered the script. This validator
 * replaces that: it checks the properties that make a breakdown faithful to the script —
 *   • ORDER preserved: scene numbers are consecutive 1..n in story order;
 *   • every scene carries real ACTION (the event of the scene);
 *   • speakers preserved: a scene with dialogue keeps SPEAKER-labelled lines;
 *   • a FINAL scene is present (the cliffhanger scene);
 * and reports going OVER the production ceiling EXPLICITLY (overLimit / overflow) so the caller can trim
 * with a logged note rather than a silent drop. The scene COUNT is a production limit, not a quality
 * signal, so a breakdown with FEWER than any minimum is NOT a problem when its coverage is complete.
 *
 * PURE. `problems` empty ⇒ coverage is complete (regardless of count).
 */
export function validateSceneCoverage(
  scenes: CoverageSceneLike[] | null | undefined,
  opts: { maxScenes: number },
): SceneCoverageResult {
  const list = Array.isArray(scenes) ? scenes : [];
  const maxScenes = Math.max(1, Math.floor(opts.maxScenes));
  const problems: string[] = [];
  const missingAction: number[] = [];
  const missingSpeakers: number[] = [];

  if (list.length === 0) {
    problems.push("no scenes produced — the breakdown is empty");
    return { problems, overLimit: false, count: 0, maxScenes, overflow: 0, missingAction, missingSpeakers };
  }

  list.forEach((s, i) => {
    const pos = i + 1;
    // ORDER preserved: numbers must be consecutive 1..n in story order.
    const num = Number(s?.number);
    if (Number.isFinite(num) && num !== pos) {
      problems.push(`scene at position ${pos} is numbered ${num} — numbering must be consecutive 1..n in story order`);
    }
    // Every scene needs real ACTION (the event of the scene).
    if (!(s?.action ?? "").trim()) {
      missingAction.push(pos);
      problems.push(`scene ${pos} has no action — the scene's event is missing`);
    }
    // Speakers preserved: a scene that has a dialogue block must keep SPEAKER-labelled lines.
    const dlg = (s?.dialogue ?? "").trim();
    if (dlg && !dialogueHasSpeaker(dlg)) {
      missingSpeakers.push(pos);
      problems.push(`scene ${pos} dialogue has no SPEAKER-labelled line — speakers must be preserved from the script`);
    }
  });

  // A FINAL scene must be present and carry action (the cliffhanger scene closes the episode).
  const last = list[list.length - 1];
  if (!(last?.action ?? "").trim()) {
    problems.push("the final scene has no action — the episode's closing/cliffhanger scene is missing");
  }

  const overflow = Math.max(0, list.length - maxScenes);
  return {
    problems,
    overLimit: overflow > 0,
    count: list.length,
    maxScenes,
    overflow,
    missingAction,
    missingSpeakers,
  };
}

/* ───────────────────────── P10 — season-memory predecessor + dependents ───────────────────────── */

export interface SeasonStateRowLike {
  id: string;
  /** The episode number whose approval produced this state (null = seeded initial state). */
  reflectsEpisodeNumber?: number | null;
  /** Tie-breaker when two rows reflect the same episode number (the most recent wins). */
  updatedAt?: Date | string | number | null;
  /** Some callers carry the state payload; kept generic so this stays a pure helper. */
  state?: unknown;
}

function toTime(v: Date | string | number | null | undefined): number {
  if (v == null) return 0;
  if (v instanceof Date) return v.getTime();
  const t = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(t) ? t : 0;
}

/**
 * Pick the PREDECESSOR season-state for the episode about to be written: the row whose
 * reflectsEpisodeNumber is the LARGEST value strictly LESS than `episodeNumber`. This is the fix for the
 * bug where the worker read the newest row by `updatedAt` — which, after an early episode is reworked,
 * returns a state that reflects a LATER episode and corrupts continuity. When two rows reflect the same
 * predecessor number, the most recently updated one wins. A seeded row (reflectsEpisodeNumber == null) is
 * only used as a fallback when NO numbered predecessor exists.
 *
 * PURE. Returns null when there is no usable predecessor (caller then seeds an initial state).
 */
export function pickPredecessorState<T extends SeasonStateRowLike>(
  states: readonly T[] | null | undefined,
  episodeNumber: number,
): T | null {
  const rows = Array.isArray(states) ? states : [];
  const numbered = rows.filter(
    (r) => typeof r.reflectsEpisodeNumber === "number" && Number.isFinite(r.reflectsEpisodeNumber) && (r.reflectsEpisodeNumber as number) < episodeNumber,
  );
  if (numbered.length) {
    return numbered.reduce((best, r) => {
      const a = r.reflectsEpisodeNumber as number;
      const b = best.reflectsEpisodeNumber as number;
      if (a !== b) return a > b ? r : best;
      return toTime(r.updatedAt) >= toTime(best.updatedAt) ? r : best;
    });
  }
  // No numbered predecessor: fall back to the most recent SEEDED row (reflectsEpisodeNumber == null).
  const seeded = rows.filter((r) => r.reflectsEpisodeNumber == null);
  if (seeded.length) {
    return seeded.reduce((best, r) => (toTime(r.updatedAt) >= toTime(best.updatedAt) ? r : best));
  }
  return null;
}

/**
 * When an EARLY episode is reworked (its scenes/state regenerated), every season-state row that reflects a
 * LATER episode was derived from the now-outdated chain and is STALE. Return their ids so the caller can
 * mark them stale. `episodeNumber` is the episode being reworked; rows with reflectsEpisodeNumber strictly
 * GREATER than it are the dependents. The row for `episodeNumber` itself is replaced (append-only) rather
 * than marked stale, so it is excluded here.
 *
 * PURE.
 */
export function dependentStateIds<T extends SeasonStateRowLike>(
  states: readonly T[] | null | undefined,
  episodeNumber: number,
): string[] {
  const rows = Array.isArray(states) ? states : [];
  return rows
    .filter((r) => typeof r.reflectsEpisodeNumber === "number" && (r.reflectsEpisodeNumber as number) > episodeNumber)
    .map((r) => r.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}
