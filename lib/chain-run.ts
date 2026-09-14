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
