/**
 * Stage 3 (task Stage 3 seasonMap) — SEASON MAP validators + generate→validate→retry loop.
 *
 * A PURE, offline-testable module: the zod cell schema, the individual rule validators (each returning
 * rule-named, actionable errors), a tolerant normalizer that never throws, and a generate loop that
 * feeds validation failures back into a targeted retry. It reads the shared shape/enum/constant exports
 * from lib/prompts/season-map (a leaf module that imports NOTHING back), and it takes the LLM call as an
 * INJECTED function so it never imports lib/ai — the worker wires chatJSON + SCRIPT_MODEL in, the tests
 * wire a pure fake in.
 */

import { z } from "zod";
import {
  BEAT_TYPES,
  CLIFFHANGER_TYPES,
  TIME_SKIP_VALUES,
  MAJOR_BEAT_TYPES,
  MAJOR_CLIFFHANGER_TYPES,
  RESOLVING_BEAT_TYPES,
  CLOSING_CLIFFHANGER_TYPES,
  majorBeatCadence,
  isBeatType,
  isCliffhangerType,
  isTimeSkip,
  seasonMapUserPrompt,
  seasonMapRetryNote,
  SEASON_MAP_SYSTEM,
  MAP_CLIFFHANGER_RULE,
  MAP_CADENCE_RULE,
  MAP_ESCALATION_RULE,
  MAP_SECRET_RULE,
  MAP_FINALE_RULE,
  MAP_SHAPE_RULE,
  type SeasonMapCell,
  type BeatType,
  type CliffhangerType,
  type TimeSkip,
  type DramaBibleForMap,
} from "@/lib/prompts/season-map";

/* ───────────────────────── zod schema (cell shape) ───────────────────────── */

/** Strict-ish cell schema — the shape a well-formed map cell must have. */
export const seasonMapCellSchema = z.object({
  episode: z.number().int().min(1),
  beatType: z.enum(BEAT_TYPES),
  escalationStep: z.number().int().min(1),
  secretRevealed: z.string().nullable().optional(),
  cliffhangerType: z.enum(CLIFFHANGER_TYPES),
  timeSkipBefore: z.enum(TIME_SKIP_VALUES),
  locations: z.array(z.string().min(1)).min(1).max(3),
  activeThreads: z.array(z.string()),
});

/** The whole season map = an ordered array of cells. */
export const seasonMapSchema = z.array(seasonMapCellSchema);

/* ───────────────────────── error shape ───────────────────────── */

/** A validation rule identifier — every error names the rule it comes from so retries can target it. */
export type SeasonMapRule =
  | "cell-count"
  | "cell-shape"
  | "consecutive-cliffhanger"
  | "major-cadence"
  | "escalation-rising"
  | "secret-schedule"
  | "finale-resolve";

export interface SeasonMapError {
  rule: SeasonMapRule;
  message: string;
  /** 1-based episode the error concerns, when applicable. */
  episode?: number;
}

/* ───────────────────────── individual validators (pure) ───────────────────────── */

/** Exactly `episodeCount` cells, numbered 1..N in order. */
export function validateCellCount(cells: SeasonMapCell[], episodeCount: number): SeasonMapError[] {
  const errors: SeasonMapError[] = [];
  if (cells.length !== episodeCount) {
    errors.push({
      rule: "cell-count",
      message: `Season map must have exactly ${episodeCount} cells (one per episode); got ${cells.length}.`,
    });
  }
  cells.forEach((c, i) => {
    if (c.episode !== i + 1) {
      errors.push({
        rule: "cell-count",
        message: `Cell at index ${i} has episode=${c.episode}; expected ${i + 1} (cells must be ordered 1..N).`,
        episode: i + 1,
      });
    }
  });
  return errors;
}

/** Each cell matches the zod shape (valid enums, 1–3 locations, escalationStep >= 1, …). */
export function validateCellShape(cells: SeasonMapCell[]): SeasonMapError[] {
  const errors: SeasonMapError[] = [];
  cells.forEach((c, i) => {
    const res = seasonMapCellSchema.safeParse(c);
    if (!res.success) {
      const detail = res.error.issues.map((issue) => `${issue.path.join(".") || "cell"}: ${issue.message}`).join("; ");
      errors.push({
        rule: "cell-shape",
        message: `Episode ${c?.episode ?? i + 1} cell is malformed (${MAP_SHAPE_RULE.split(":")[0]}): ${detail}.`,
        episode: typeof c?.episode === "number" ? c.episode : i + 1,
      });
    }
  });
  return errors;
}

/** No two CONSECUTIVE episodes share the same cliffhangerType. */
export function validateConsecutiveCliffhangers(cells: SeasonMapCell[]): SeasonMapError[] {
  const errors: SeasonMapError[] = [];
  for (let i = 1; i < cells.length; i++) {
    if (cells[i].cliffhangerType === cells[i - 1].cliffhangerType) {
      errors.push({
        rule: "consecutive-cliffhanger",
        message: `Episodes ${cells[i - 1].episode} and ${cells[i].episode} both end on a "${cells[i].cliffhangerType}" cliffhanger. ${MAP_CLIFFHANGER_RULE}`,
        episode: cells[i].episode,
      });
    }
  }
  return errors;
}

/** A cell is a MAJOR beat when its beatType OR cliffhangerType is a reveal/betrayal. */
export function isMajorCell(cell: SeasonMapCell): boolean {
  return (
    MAJOR_BEAT_TYPES.includes(cell.beatType) || MAJOR_CLIFFHANGER_TYPES.includes(cell.cliffhangerType)
  );
}

/**
 * A major reveal/betrayal must land at least every `majorBeatCadence(N)` episodes: at least one major
 * exists, the first arrives within the cadence, no gap between consecutive majors exceeds it, and the gap
 * from the last major to the finale does not exceed it. Upper spacing bound only (documented).
 */
export function validateMajorCadence(cells: SeasonMapCell[]): SeasonMapError[] {
  const errors: SeasonMapError[] = [];
  const n = cells.length;
  if (n === 0) return errors;
  const maxGap = majorBeatCadence(n);
  const majorIdx = cells.map((c, i) => (isMajorCell(c) ? i : -1)).filter((i) => i >= 0);
  if (majorIdx.length === 0) {
    errors.push({
      rule: "major-cadence",
      message: `No major turn (reveal/betrayal beat or cliffhanger) anywhere in the season. ${MAP_CADENCE_RULE}`,
    });
    return errors;
  }
  // First major within the cadence window (episode index is 0-based; +1 ⇒ position).
  if (majorIdx[0] + 1 > maxGap) {
    errors.push({
      rule: "major-cadence",
      message: `First major turn is at episode ${cells[majorIdx[0]].episode}; a major turn must land within the first ${maxGap} episodes. ${MAP_CADENCE_RULE}`,
      episode: cells[majorIdx[0]].episode,
    });
  }
  // Gaps between consecutive majors.
  for (let k = 1; k < majorIdx.length; k++) {
    const gap = majorIdx[k] - majorIdx[k - 1];
    if (gap > maxGap) {
      errors.push({
        rule: "major-cadence",
        message: `Episodes ${cells[majorIdx[k - 1]].episode}→${cells[majorIdx[k]].episode} span ${gap} episodes with no major turn (max ${maxGap}). ${MAP_CADENCE_RULE}`,
        episode: cells[majorIdx[k]].episode,
      });
    }
  }
  // Gap from last major to the finale.
  const tailGap = n - 1 - majorIdx[majorIdx.length - 1];
  if (tailGap > maxGap) {
    errors.push({
      rule: "major-cadence",
      message: `The season coasts ${tailGap} episodes after episode ${cells[majorIdx[majorIdx.length - 1]].episode} with no major turn before the finale (max ${maxGap}). ${MAP_CADENCE_RULE}`,
    });
  }
  return errors;
}

/** escalationStep never slides back: each step is >= the previous episode's step. */
export function validateEscalationRising(cells: SeasonMapCell[]): SeasonMapError[] {
  const errors: SeasonMapError[] = [];
  for (let i = 1; i < cells.length; i++) {
    if (cells[i].escalationStep < cells[i - 1].escalationStep) {
      errors.push({
        rule: "escalation-rising",
        message: `Episode ${cells[i].episode} escalationStep ${cells[i].escalationStep} is lower than episode ${cells[i - 1].episode}'s ${cells[i - 1].escalationStep}. ${MAP_ESCALATION_RULE}`,
        episode: cells[i].episode,
      });
    }
  }
  return errors;
}

/**
 * When the bible lists secrets with a scheduled revealEpisode, that episode's cell must set
 * secretRevealed to the secret's id. Absent/empty secrets ⇒ [] (graceful skip — the common case now).
 */
export function validateSecretSchedule(cells: SeasonMapCell[], bible?: DramaBibleForMap | null): SeasonMapError[] {
  const errors: SeasonMapError[] = [];
  const secrets = (bible?.secrets ?? []).filter((s) => s && s.id);
  if (secrets.length === 0) return errors;
  for (const secret of secrets) {
    const cell = cells.find((c) => c.episode === secret.revealEpisode);
    if (!cell) {
      errors.push({
        rule: "secret-schedule",
        message: `Secret "${secret.id}" is scheduled for episode ${secret.revealEpisode}, which has no cell. ${MAP_SECRET_RULE}`,
        episode: secret.revealEpisode,
      });
      continue;
    }
    if (cell.secretRevealed !== secret.id) {
      errors.push({
        rule: "secret-schedule",
        message: `Episode ${secret.revealEpisode} must reveal secret "${secret.id}" (secretRevealed="${cell.secretRevealed ?? "none"}"). ${MAP_SECRET_RULE}`,
        episode: secret.revealEpisode,
      });
    }
  }
  return errors;
}

/**
 * The finale (last cell) must RESOLVE: a resolving beatType AND a closing cliffhangerType. When the bible
 * designates a finaleSecretId (with a finaleQuestion), the last cell must also reveal that secret.
 * Structural check applies with or without a bible (documented fallback).
 */
export function validateFinale(cells: SeasonMapCell[], bible?: DramaBibleForMap | null): SeasonMapError[] {
  const errors: SeasonMapError[] = [];
  if (cells.length === 0) return errors;
  const last = cells[cells.length - 1];
  if (!RESOLVING_BEAT_TYPES.includes(last.beatType)) {
    errors.push({
      rule: "finale-resolve",
      message: `Finale episode ${last.episode} has beatType "${last.beatType}"; it must be a resolving beat (${RESOLVING_BEAT_TYPES.join(" / ")}). ${MAP_FINALE_RULE}`,
      episode: last.episode,
    });
  }
  if (!CLOSING_CLIFFHANGER_TYPES.includes(last.cliffhangerType)) {
    errors.push({
      rule: "finale-resolve",
      message: `Finale episode ${last.episode} ends on a "${last.cliffhangerType}" cliffhanger; it must close (${CLOSING_CLIFFHANGER_TYPES.join(" / ")}), not open a new thread. ${MAP_FINALE_RULE}`,
      episode: last.episode,
    });
  }
  if (bible?.finaleQuestion && bible?.finaleSecretId && last.secretRevealed !== bible.finaleSecretId) {
    errors.push({
      rule: "finale-resolve",
      message: `Finale episode ${last.episode} must reveal the secret "${bible.finaleSecretId}" that answers the central question (secretRevealed="${last.secretRevealed ?? "none"}"). ${MAP_FINALE_RULE}`,
      episode: last.episode,
    });
  }
  return errors;
}

/* ───────────────────────── aggregate validator ───────────────────────── */

export interface SeasonMapValidation {
  ok: boolean;
  errors: SeasonMapError[];
}

/**
 * Run every rule. Order matters for the targeted retry: structural rules (count/shape) first, then the
 * dramatic-shape rules; the retry note names the FIRST failing rule.
 */
export function validateSeasonMap(
  cells: SeasonMapCell[],
  opts: { episodeCount: number; bible?: DramaBibleForMap | null }
): SeasonMapValidation {
  const errors: SeasonMapError[] = [
    ...validateCellCount(cells, opts.episodeCount),
    ...validateCellShape(cells),
    ...validateConsecutiveCliffhangers(cells),
    ...validateMajorCadence(cells),
    ...validateEscalationRising(cells),
    ...validateSecretSchedule(cells, opts.bible),
    ...validateFinale(cells, opts.bible),
  ];
  return { ok: errors.length === 0, errors };
}

/* ───────────────────────── defensive normalization ───────────────────────── */

/** Derive an escalationStep defensively: bible ladder length clamps it; else the 1-based episode index. */
export function deriveEscalationStep(episodeIndex: number, bible?: DramaBibleForMap | null): number {
  const ladderLen = (bible?.escalationLadder ?? []).filter(Boolean).length;
  const step = episodeIndex + 1;
  if (ladderLen > 0) return Math.min(step, ladderLen);
  return step;
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x.trim() : String(x ?? "").trim())).filter(Boolean);
}

/**
 * Coerce arbitrary LLM output into a well-shaped SeasonMapCell[] of exactly `episodeCount` cells. Accepts
 * either a bare array or a { seasonMap: [...] } wrapper. Applies safe enum defaults, clamps locations to
 * 1–3, forces episode = i+1 and a rising-friendly escalation fallback. NEVER throws — worst case it
 * returns a fully-defaulted map (which the validators will then flag, driving a retry / advisory persist).
 */
export function normalizeSeasonMap(
  raw: unknown,
  opts: { episodeCount: number; bible?: DramaBibleForMap | null }
): SeasonMapCell[] {
  const { episodeCount, bible } = opts;
  let arr: unknown[] = [];
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (raw && typeof raw === "object" && Array.isArray((raw as { seasonMap?: unknown }).seasonMap)) {
    arr = (raw as { seasonMap: unknown[] }).seasonMap;
  }
  const cells: SeasonMapCell[] = [];
  for (let i = 0; i < episodeCount; i++) {
    const src = (arr[i] ?? {}) as Record<string, unknown>;
    const beatType: BeatType = isBeatType(src.beatType) ? src.beatType : BEAT_TYPES[3]; // "reveal"
    const cliffhangerType: CliffhangerType = isCliffhangerType(src.cliffhangerType)
      ? src.cliffhangerType
      : CLIFFHANGER_TYPES[1]; // "threat"
    const timeSkipBefore: TimeSkip = isTimeSkip(src.timeSkipBefore) ? src.timeSkipBefore : TIME_SKIP_VALUES[0]; // "none"
    const rawStep = typeof src.escalationStep === "number" && Number.isFinite(src.escalationStep) ? Math.floor(src.escalationStep) : NaN;
    const escalationStep = Number.isFinite(rawStep) && rawStep >= 1 ? rawStep : deriveEscalationStep(i, bible);
    let locations = toStringArray(src.locations).slice(0, 3);
    if (locations.length === 0) locations = ["main"];
    const activeThreads = toStringArray(src.activeThreads);
    const secretRaw = src.secretRevealed;
    const secretRevealed = typeof secretRaw === "string" && secretRaw.trim() ? secretRaw.trim() : null;
    cells.push({
      episode: i + 1,
      beatType,
      escalationStep,
      secretRevealed,
      cliffhangerType,
      timeSkipBefore,
      locations,
      activeThreads,
    });
  }
  return cells;
}

/* ───────────────────────── generate → validate → targeted retry ───────────────────────── */

/** The injected LLM call — same shape as lib/ai `chatJSON` but supplied by the caller (worker / test). */
export type SeasonMapChatFn = (
  system: string,
  user: string,
  opts?: { model?: string; maxTokens?: number; temperature?: number }
) => Promise<unknown>;

export interface GenerateSeasonMapInput {
  episodes: Array<{ number: number; title?: string | null; logline?: string | null; locationName?: string | null }>;
  /** Defaults to episodes.length when omitted. */
  episodeCount?: number;
  bible?: DramaBibleForMap | null;
  seasonLogline?: string | null;
  locations?: string[] | null;
  threads?: string[] | null;
}

export interface GenerateSeasonMapResult {
  seasonMap: SeasonMapCell[];
  valid: boolean;
  errors: SeasonMapError[];
  attempts: number;
}

/**
 * Generate a validated season map: build the prompt, call the injected chat fn, normalize + validate; on
 * failure append a targeted retry note naming the first failing rule and try again (up to maxRetries+1
 * total attempts). NEVER throws — after exhausting retries it returns the best-effort normalized map with
 * valid:false so the worker can persist it as advisory and log the outstanding rule violations.
 */
export async function generateSeasonMap(
  input: GenerateSeasonMapInput,
  chatFn: SeasonMapChatFn,
  opts: { model?: string; maxRetries?: number } = {}
): Promise<GenerateSeasonMapResult> {
  const episodeCount = input.episodeCount ?? input.episodes.length;
  const maxRetries = opts.maxRetries ?? 3;
  const baseUser = seasonMapUserPrompt(input.episodes, {
    seasonLogline: input.seasonLogline,
    locations: input.locations,
    threads: input.threads,
    bible: input.bible,
  });

  let lastResult: GenerateSeasonMapResult = { seasonMap: [], valid: false, errors: [], attempts: 0 };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const user = attempt === 0 ? baseUser : `${baseUser}\n\n${seasonMapRetryNote(lastResult.errors[0]?.message ?? MAP_CADENCE_RULE)}`;
    let raw: unknown = null;
    try {
      raw = await chatFn(SEASON_MAP_SYSTEM, user, { model: opts.model });
    } catch {
      // Treat an LLM/transport failure like empty output — normalize to a defaulted map and keep looping.
      raw = null;
    }
    const cells = normalizeSeasonMap(raw, { episodeCount, bible: input.bible });
    const validation = validateSeasonMap(cells, { episodeCount, bible: input.bible });
    lastResult = { seasonMap: cells, valid: validation.ok, errors: validation.errors, attempts: attempt + 1 };
    if (validation.ok) return lastResult;
  }
  return lastResult;
}
