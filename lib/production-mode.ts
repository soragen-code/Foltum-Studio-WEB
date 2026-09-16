/**
 * Stage 129 — WHEN the episode production mode (SCENES / STORYBOARD) may be chosen.
 *
 * The mode fork (introduced in Stage 127) is no longer offered right after the story is built. It is now
 * offered ONLY after the episode's references (characters + locations) are ready, and production (the 9-scene
 * pipeline OR the 12–15 board storyboard) stays locked until a mode has been explicitly chosen. This module
 * holds the small PURE gating predicates so the UI condition is testable in isolation and identical everywhere.
 *
 * Nothing here changes the pipelines themselves or the /api/ai/storyboard/mode endpoint — it only decides when
 * the selector is visible and when the author may move on to production.
 */

export type ProductionMode = "SCENES" | "STORYBOARD";

/** True when a value is a real, explicitly-chosen production mode (never null / legacy-unset). */
export function isProductionMode(value: unknown): value is ProductionMode {
  return value === "SCENES" || value === "STORYBOARD";
}

/**
 * The mode selector is shown only once EVERY episode reference is ready (characters + locations). Before that
 * the author cannot see or use the fork — `refsReady` is the same readiness signal the References step gates on.
 */
export function canChooseMode(refsReady: boolean): boolean {
  return refsReady === true;
}

/**
 * Production (Scenes → 9 scenes, Storyboard → 12–15 boards) is unlocked only after references are ready AND a
 * mode has been explicitly chosen. A null / legacy-unset mode does NOT unlock the forward step — the author is
 * asked to pick first. (Legacy episodes that already have generated scenes remain reachable via their own path.)
 */
export function canEnterProduction(refsReady: boolean, mode: ProductionMode | null | undefined): boolean {
  return canChooseMode(refsReady) && isProductionMode(mode);
}

/**
 * Which production surface to render for a given mode. STORYBOARD → the board panel; everything else (SCENES or
 * a legacy null mode on an episode whose scenes already exist) → the classic scenes pipeline, unchanged.
 */
export function productionSurface(mode: ProductionMode | null | undefined): "scenes" | "storyboard" {
  return mode === "STORYBOARD" ? "storyboard" : "scenes";
}
