// The number of location reference frames depends on the REQUIRED VISUAL DETAIL LEVEL of the
// place (how many distinct camera setups the shooting needs), NOT on its physical size.
// The level is chosen by the script LLM when locations are created (Location.detailLevel);
// legacy rows without a level fall back to a heuristic on the prompt richness.
// Pure/client-safe — no server imports.

export const LOCATION_DETAIL_LEVELS = ['low', 'medium', 'high'] as const
export type LocationDetailLevel = (typeof LOCATION_DETAIL_LEVELS)[number]

export type LocationLike = { name?: string | null; description?: string | null; visualPrompt?: string | null; detailLevel?: string | null }

/** Base angles always generated on the Location row (imageUrl + imageReverse + imageDetail). */
export const LOCATION_BASE_FRAMES = 3
/** Total reference frames per detail level: low = 3+1, medium = 3+3, high = 3+6 (the full six-slot extra plan). */
export const LOCATION_FRAMES_BY_DETAIL: Record<LocationDetailLevel, number> = { low: 4, medium: 6, high: 9 }
/** Minimum / maximum possible total across detail levels (low=4 ... high=9). */
export const LOCATION_TOTAL_MIN = LOCATION_FRAMES_BY_DETAIL.low
export const LOCATION_TOTAL_MAX = LOCATION_FRAMES_BY_DETAIL.high

export function isLocationDetailLevel(v: unknown): v is LocationDetailLevel {
  return typeof v === 'string' && (LOCATION_DETAIL_LEVELS as readonly string[]).includes(v)
}

const DETAIL_RANK: Record<LocationDetailLevel, number> = { low: 0, medium: 1, high: 2 }

/** Never downgrade a stored level: keep the higher of the current and the incoming one. */
export function maxDetailLevel(current: string | null | undefined, incoming: string | null | undefined): LocationDetailLevel | null {
  const a = isLocationDetailLevel(current) ? current : null
  const b = isLocationDetailLevel(incoming) ? incoming : null
  if (!a) return b
  if (!b) return a
  return DETAIL_RANK[b] > DETAIL_RANK[a] ? b : a
}

/** Words that signal many distinct zones / dense props / complex staging in a location prompt. */
const RICHNESS_HINTS = [
  // en
  'zone', 'zones', 'area', 'areas', 'corner', 'corners', 'shelves', 'shelf', 'crowded', 'cluttered', 'packed', 'stacks', 'stacked',
  'tables', 'benches', 'workbench', 'machines', 'machinery', 'crates', 'barrels', 'stalls', 'booths', 'counters', 'racks', 'tools',
  'fight', 'chase', 'battle', 'brawl', 'crowd', 'staircase', 'stairs', 'balcony', 'mezzanine', 'corridors', 'rooms', 'doorways',
  // ru
  'зон', 'участк', 'угол', 'углы', 'полк', 'стеллаж', 'загромож', 'заставлен', 'тесн', 'столы', 'скамь', 'верстак', 'станк', 'ящик',
  'бочк', 'прилавк', 'лавк', 'инструмент', 'драк', 'бой', 'погон', 'толп', 'лестниц', 'балкон', 'коридор', 'комнат', 'двер',
]

function textOf(loc: LocationLike): string {
  return `${loc.name ?? ''} ${loc.description ?? ''} ${loc.visualPrompt ?? ''}`.toLowerCase()
}

/**
 * Heuristic fallback for legacy locations without an LLM-set detail level: judge the richness
 * of the visual prompt (how many distinct objects/zones it enumerates), never its physical size.
 *   very short / empty prompt → low; long, list-like prompt with many zones/props → high; else medium.
 */
export function inferDetailLevel(loc: LocationLike): LocationDetailLevel {
  const prompt = `${loc.description ?? ''} ${loc.visualPrompt ?? ''}`.trim()
  // A bare name or a one-liner: nothing to cover from many setups.
  if (prompt.length < 100) return 'low'
  const t = textOf(loc)
  const items = prompt.split(/[,;]/).filter((x) => x.trim().length > 2).length
  const hints = RICHNESS_HINTS.reduce((n, k) => (t.includes(k) ? n + 1 : n), 0)
  const score = items + hints * 2 + (prompt.length > 500 ? 3 : prompt.length > 300 ? 1 : 0)
  if (score >= 14) return 'high'
  return 'medium'
}

/** Effective detail level of a location: the stored LLM level, or the heuristic fallback. */
export function locationDetailLevel(loc?: LocationLike | null): LocationDetailLevel {
  if (!loc) return 'medium'
  return isLocationDetailLevel(loc.detailLevel) ? loc.detailLevel : inferDetailLevel(loc)
}

/** Total reference frames a location should have, by its required detail level (4 / 6 / 9). */
export function desiredTotalFrames(loc?: LocationLike | null): number {
  return LOCATION_FRAMES_BY_DETAIL[locationDetailLevel(loc)]
}

/** Extra frames on top of the 3 base angles (1 / 3 / 6) — never more than the six unique extra slots. */
export function desiredExtraFrames(loc: LocationLike): number {
  return Math.min(LOCATION_TOTAL_MAX - LOCATION_BASE_FRAMES, Math.max(0, desiredTotalFrames(loc) - LOCATION_BASE_FRAMES))
}

/** Human label for the detail level (RU UI). */
export function locationDetailLabel(level: LocationDetailLevel): string {
  return level === 'high' ? 'высокая' : level === 'low' ? 'низкая' : 'средняя'
}

/**
 * The locations that belong to an episode: its bound location first, then any project
 * location whose name is mentioned in the episode's location text or a scene's locationDesc.
 */
export function episodeLocations(
  episode: { locationId?: string | null; locationName?: string | null; location?: any; scenes?: { locationDesc?: string | null }[] },
  projectLocations: any[],
): any[] {
  const out: any[] = []
  const seen = new Set<string>()
  const add = (loc: any) => { if (loc && !seen.has(loc.id)) { seen.add(loc.id); out.push(loc) } }
  if (episode.location) add(episode.location)
  else if (episode.locationId) add(projectLocations.find((l) => l.id === episode.locationId))
  const haystack = `${episode.locationName ?? ''} ${(episode.scenes ?? []).map((s) => s.locationDesc ?? '').join(' ')}`.toLowerCase()
  for (const loc of projectLocations) {
    if (seen.has(loc.id)) continue
    const name = (loc.name ?? '').toLowerCase().trim()
    if (name.length >= 3 && haystack.includes(name)) add(loc)
  }
  return out
}
