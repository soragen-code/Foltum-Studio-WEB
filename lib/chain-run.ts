/**
 * Stage 40 — chain generation mode ("Chain mode"), pure helpers (DB-free, unit-tested).
 *
 * `Episode.chainMode` is always "chain" (Stage 100 removed parallel mode entirely):
 *   scenes are generated strictly one after another. After each finished scene its last
 *   frame is described by a vision model (`Scene.endStateActual`) and that description opens the
 *   prompt of the next scene. Credits are charged per scene when the scene actually starts. On the
 *   first failure the chain stops and the episode keeps a note (`Episode.chainRunNote`).
 *
 * The `ChainMode` type / `isChainMode` guard still accept the legacy "parallel" literal so old
 * stored rows and API payloads deserialize without error, but `normalizeChainMode` collapses every
 * input to "chain" and nothing writes "parallel" anymore.
 */

export type ChainMode = "parallel" | "chain";
export const CHAIN_MODES: readonly ChainMode[] = ["parallel", "chain"];

export function isChainMode(value: unknown): value is ChainMode {
  return value === "parallel" || value === "chain";
}

export function normalizeChainMode(_value?: unknown): ChainMode {
  // Stage 100: parallel mode was removed entirely. Generation is ALWAYS sequential (chain):
  // scenes run strictly one after another and each scene opens on the real last frame of the
  // previous scene. The stored value (including legacy "parallel" rows) is ignored.
  return "chain";
}

export interface ChainSceneLike {
  id: string;
  number: number;
  videoUrl?: string | null;
  videoPrompt?: string | null;
  status?: string | null;
}

/**
 * The next scene to start in a chain run: the lowest-numbered scene that has a prompt, has no video
 * yet and is not already generating. `afterNumber` restricts the search to scenes after the one that
 * just finished (so a re-generated middle scene never re-runs earlier scenes).
 */
export function nextChainScene<S extends ChainSceneLike>(scenes: readonly S[], afterNumber = 0): S | null {
  const sorted = [...scenes].sort((a, b) => a.number - b.number);
  for (const s of sorted) {
    if (s.number <= afterNumber) continue;
    if (!(s.videoPrompt ?? "").trim()) continue;
    if (s.videoUrl) continue;
    if (s.status === "generating") continue;
    return s;
  }
  return null;
}

/**
 * Default scene-chain selector (restored): the earliest scene that still needs a video AND has a
 * prompt, without ever skipping past it. If that earliest gap is already generating we return null so
 * the chain waits for it, rather than starting a LATER scene in parallel. Strict prefix growth
 * 1→2→3…, gaps always filled in order, nothing skipped.
 */
export function nextSequentialChainScene<S extends ChainSceneLike>(scenes: readonly S[]): S | null {
  const sorted = [...scenes].sort((a, b) => a.number - b.number);
  const target = sorted.find((s) => !s.videoUrl && (s.videoPrompt ?? "").trim().length > 0);
  if (!target) return null; // every prompted scene has a video → chain is complete
  if (target.status === "generating") return null; // earliest gap is in progress → do not skip ahead
  return target;
}

/**
 * Stage 153 — a scene enriched with whether a video GenerationJob is currently in flight for it.
 * Used by the server-side sweeper to decide, from a fresh DB snapshot, what a stalled chain should do.
 */
export interface ChainResumeSceneLike extends ChainSceneLike {
  /** A video GenerationJob (pending/processing) already exists for this scene. */
  hasActiveJob?: boolean | null;
}

/**
 * Stage 153 — server-side sweeper decision (DB-free, unit-tested).
 *
 * Returns the SINGLE scene a stalled chain run should start now, or null when nothing should start.
 * Preserves the strict sequential invariant ("never start N+1 until N is generated"):
 *   • the only candidate is the LOWEST-numbered scene that still needs a video and has a prompt;
 *   • it starts only when that scene is idle — not already `generating` and with no in-flight job;
 *   • if that earliest ungenerated scene is still generating / has an active job, null is returned
 *     (it is in progress or being recovered elsewhere) — so the sweeper never skips ahead and never
 *     double-starts the same scene.
 *
 * When `chainRunActive` is false the chain is off and the sweeper never forces ordering (returns null).
 */
export function chainSceneToResume<S extends ChainResumeSceneLike>(
  episode: { chainRunActive?: boolean | null; scenes: readonly S[] },
): S | null {
  if (!episode.chainRunActive) return null; // sequential mode OFF → never force ordering
  const sorted = [...episode.scenes].sort((a, b) => a.number - b.number);
  // Earliest scene that still needs a video AND has a prompt (unprompted scenes are not in the chain).
  const target = sorted.find((s) => !s.videoUrl && (s.videoPrompt ?? "").trim().length > 0);
  if (!target) return null; // every prompted scene is generated → chain is done
  if (target.status === "generating") return null; // N is in progress → do not start anything
  if (target.hasActiveJob) return null; // a job already exists for it → idempotent, no double-start
  return target;
}

/* ───────────────────────── Stage 167 — SHOT chain ───────────────────────── */

/**
 * Stage 167 — a SHOT in a chain run. The atomic unit of generation is now the shot (one level below
 * the scene). Shots are ordered GLOBALLY across the episode by (sceneNumber, index) — `Shot.index` is
 * 0-based WITHIN its scene, so the scene number is the primary sort key and the per-scene index breaks
 * ties. `videoUrl` set = generated; `status === "generating"` = a clip is already in flight.
 */
export interface ChainShotLike {
  id: string;
  /** 1-based scene number the shot belongs to (primary global-order key). */
  sceneNumber: number;
  /** 0-based order of the shot WITHIN its scene (secondary global-order key). */
  index: number;
  videoUrl?: string | null;
  status?: string | null;
}

/**
 * Stage 167 — the SHOT a running chain must generate next: ALWAYS the earliest ungenerated shot in the
 * strict global order (sceneNumber, then index): it takes NO "after" cursor so it can never skip an earlier ungenerated shot
 * when shots finish out of order, and it returns null when that earliest gap is already `generating`
 * (the chain waits for it rather than starting a later shot in parallel). Every persisted shot is in
 * the chain — unlike scenes there is no per-shot prompt gate (the prompt is assembled at generation time).
 */
export function nextSequentialShot<S extends ChainShotLike>(shots: readonly S[]): S | null {
  const sorted = [...shots].sort((a, b) => a.sceneNumber - b.sceneNumber || a.index - b.index);
  const target = sorted.find((s) => !s.videoUrl); // earliest shot that still needs a clip
  if (!target) return null; // every shot has a clip → the episode is fully generated (ready to assemble)
  if (target.status === "generating") return null; // earliest gap is in progress → do not skip ahead
  return target;
}

/** Ordered list of the scenes a chain run will go through (for the confirmation modal / tests). */
export function chainOrder<S extends ChainSceneLike>(scenes: readonly S[]): S[] {
  const out: S[] = [];
  let after = 0;
  for (;;) {
    const next = nextChainScene(scenes, after);
    if (!next) return out;
    out.push(next);
    after = next.number;
  }
}

/** Russian note stored on the episode when the chain stops because a scene failed. */
export function chainStopMessage(sceneNumber: number, error: string): string {
  const reason = (error ?? "").trim() || "unknown error";
  return `Chain stopped at scene ${sceneNumber}: ${reason}`;
}

export const CHAIN_INSUFFICIENT_CREDITS = "insufficient credits";
