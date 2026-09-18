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
 * Stage 163 — the scene a RUNNING chain must generate next: ALWAYS the lowest-numbered scene that
 * still needs a video, has a prompt and is idle (not already generating). Unlike
 * `nextChainScene(scenes, afterNumber)`, this takes NO "after" cursor, so it can never skip an
 * earlier ungenerated scene when scenes happen to complete out of order (a manual middle re-gen, a
 * double trigger, a transient) — which previously produced a permanent non-prefix set like
 * {1,3,4,6} with scenes 2 and 5 skipped forever. It is the exact strict selection the cron sweeper
 * already applies via `chainSceneToResume`, so the server chain and the sweeper now agree: strict
 * prefix growth 1→2→3→…, gaps always filled in order, nothing skipped.
 */
export function nextSequentialChainScene<S extends ChainSceneLike>(scenes: readonly S[]): S | null {
  const sorted = [...scenes].sort((a, b) => a.number - b.number);
  // The earliest scene that still needs a video AND has a prompt (unprompted scenes are not in the
  // chain). Crucially we do NOT skip past it: if this scene is already generating we return null so
  // the chain waits for it, rather than starting a LATER scene in parallel / leaving it behind.
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
