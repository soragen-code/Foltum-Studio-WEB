/**
 * Stage 20 — canonical location anchoring.
 *
 * An episode has exactly ONE key location (Episode.locationDesc, the canonical place text that also
 * drives the location reference images). The scene planner writes each Scene.locationDesc as free text
 * regenerated per scene, so the LLM drifts ("temple" in scene 1, "field" in scene 2). To keep the place
 * locked, every scene that is NOT a deliberately shown location-change stores the episode's canonical
 * locationDesc verbatim — so all such scenes share the IDENTICAL place text. This also makes
 * canChainFrame (which compares normalized locationDesc) reliable across the episode.
 *
 * Pure + idempotent: applying it twice yields the same result. No I/O, unit-testable.
 */
export const LOCATION_CHANGE = "location-change";

/**
 * Returns the locationDesc that should be STORED for a scene.
 * - A genuine shown location-change scene (continuesFrom === "location-change") keeps its own text.
 * - Every other scene is anchored to the episode's canonical locationDesc (when we have one).
 * - If no canonical episode text is available, the scene's own text is preserved (safe fallback).
 */
export function anchorSceneLocation(
  sceneLocationDesc: string | null | undefined,
  episodeLocationDesc: string | null | undefined,
  continuesFrom: string | null | undefined
): string {
  const scene = (sceneLocationDesc ?? "").trim();
  const canonical = (episodeLocationDesc ?? "").trim();
  const kind = (continuesFrom ?? "").trim().toLowerCase();
  // A deliberately shown move to a new place keeps its own text.
  if (kind === LOCATION_CHANGE) return scene || canonical;
  // Non-location-change scenes are anchored to the single canonical place (idempotent: canonical→canonical).
  return canonical || scene;
}
