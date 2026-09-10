/**
 * Stage 20 (D1/D2) — episode cast = characters actually used in scenes.
 *
 * The episode-level References tab and the readiness gate are driven by EpisodeCharacter. Historically
 * that was written from the DECLARED cast (outline.characters the LLM assigned by logline), so an
 * episode with 1 character actually appearing still requested references for 3 declared characters.
 *
 * This pure helper computes the UNION of the per-scene character id sets (deduped, order preserved),
 * so only characters that really appear are required. If no scene names any character (edge case),
 * it falls back to the declared cast so the episode is never left with zero characters.
 */
export function episodeCastFromScenes(
  sceneCharacterIds: (string[] | null | undefined)[],
  declaredCharacterIds: string[] = []
): string[] {
  const seen = new Set<string>();
  const union: string[] = [];
  for (const ids of sceneCharacterIds) {
    for (const id of ids ?? []) {
      if (id && !seen.has(id)) {
        seen.add(id);
        union.push(id);
      }
    }
  }
  if (union.length) return union;
  // Fallback: no scene referenced any character — keep the declared cast (deduped).
  const fallback: string[] = [];
  const fseen = new Set<string>();
  for (const id of declaredCharacterIds) {
    if (id && !fseen.has(id)) {
      fseen.add(id);
      fallback.push(id);
    }
  }
  return fallback;
}
