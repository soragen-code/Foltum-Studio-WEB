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
/** Stage 111: frames the master job renders and charges per location — wide (imageUrl) + elevated layout view (imageReverse). */
export { LOCATION_MASTER_FRAMES } from './power-tier'
/** Total reference frames per detail level: low = 3+1, medium = 3+3, high = 3+5 (Stage 111: the extra plan has five slots — the elevated layout view became a mandatory base frame). */
export const LOCATION_FRAMES_BY_DETAIL: Record<LocationDetailLevel, number> = { low: 4, medium: 6, high: 8 }
/** Minimum / maximum possible total across detail levels (low=4 ... high=8). */
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

/** Total reference frames a location should have, by its required detail level (4 / 6 / 8). */
export function desiredTotalFrames(loc?: LocationLike | null): number {
  return LOCATION_FRAMES_BY_DETAIL[locationDetailLevel(loc)]
}

/** Extra frames on top of the 3 base angles (1 / 3 / 5) — never more than the five unique extra slots. */
export function desiredExtraFrames(loc: LocationLike): number {
  return Math.min(LOCATION_TOTAL_MAX - LOCATION_BASE_FRAMES, Math.max(0, desiredTotalFrames(loc) - LOCATION_BASE_FRAMES))
}

/** Human label for the detail level (UI). */
export function locationDetailLabel(level: LocationDetailLevel): string {
  return level === 'high' ? 'high' : level === 'low' ? 'low' : 'medium'
}

// An INT/EXT/ИНТ/НАТ opener or a "day/night/…"-style time-of-day tail (English + Russian). Kept a small
// LOCAL copy (not imported from lib/season.ts) so this pure/client-safe module never depends on server code
// and no import cycle forms (season.ts already imports from here). Keep in sync with season.ts sceneLocationName.
const _LOC_INT_EXT_RE = /^(int|ext|int\.?\/ext\.?|i\/e|инт|нат)\.?$/i
const _LOC_TIME_RE = /^(day|night|dawn|dusk|evening|morning|afternoon|noon|midnight|continuous|later|moments? later|sunset|sunrise|день|ночь|утро|вечер|рассвет|закат|сумерки|полдень|полночь|позже|продолжение)\.?$/i

/** Extract a clean PLACE NAME from a scene's "INT/EXT — place — time"-style descriptor (display fallback). */
function sceneLocName(locationDesc?: string | null): string {
  let t = (locationDesc ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  // Drop a leading "СЦЕНА N."/"SCENE N." heading prefix that can leak from the readable heading format.
  t = t.replace(/^(сцена|scene)\s*\d+\s*[.:·•—–-]?\s*/i, '').trim()
  if (!t) return ''
  const stripIntExt = (s: string) => s.replace(/^(int\.?\/ext\.?|int\.?|ext\.?|i\/e|инт\.?|нат\.?)\s+/i, '').trim()
  const parts = t.split(/\s+[—–-]\s+/).map((p) => p.trim()).filter(Boolean)
  if (parts.length <= 1) return stripIntExt(t)
  if (parts.length >= 3) {
    let start = 0, end = parts.length
    if (_LOC_INT_EXT_RE.test(parts[start])) start++
    if (_LOC_TIME_RE.test(parts[end - 1])) end--
    const middle = parts.slice(start, end).filter(Boolean)
    return middle.length ? stripIntExt(middle.join(' — ')) : stripIntExt(parts[0])
  }
  return _LOC_INT_EXT_RE.test(parts[0]) ? stripIntExt(parts[1]) : stripIntExt(parts[0])
}

function _slug(s: string): string {
  return s.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'loc'
}

/**
 * The locations that belong to an episode: its bound location first, then any project
 * location whose name is mentioned in the episode's location text or a scene's locationDesc.
 *
 * Safety net (Stage 169): when NOTHING matches a real project location but the episode's scenes carry
 * location text, synthesize DISPLAY-ONLY entries (`derived: true`, id "derived:<slug>") from the distinct
 * scene location names so the episode never shows "Locations (0)" while it actually has scene locations.
 * This aggregates on the fly — no data migration — and covers older episodes whose Location rows were never
 * derived, or a client reload whose project prop is stale. Derived entries carry no image controls (see the
 * read-only card in episode-view.tsx). Real DB rows always win over synthetic ones.
 */
export function episodeLocations(
  episode: { locationId?: string | null; locationName?: string | null; location?: any; scenes?: { locationDesc?: string | null; locationId?: string | null }[] },
  projectLocations: any[],
): any[] {
  const out: any[] = []
  const seen = new Set<string>()
  const add = (loc: any) => { if (loc && !seen.has(loc.id)) { seen.add(loc.id); out.push(loc) } }
  const byId = new Map((projectLocations ?? []).map((l) => [l.id, l]))
  if (episode.location) add(episode.location)
  else if (episode.locationId) add(byId.get(episode.locationId))
  // Stage 171b — AUTHORITATIVE binding first: every location a scene is actually bound to (scene.locationId).
  // For MANUAL sub-location cards the card name ("Oasis — Maintenance Pit") is NOT a substring of the scene's
  // top-level locationDesc, so the legacy text-match below silently dropped the real cards AND wrongly pulled in
  // an orphaned top-level location whose name equals the locationDesc. Keying on the persisted scene.locationId
  // shows exactly the cards the script produced (one per authored spot), in scene order.
  for (const s of episode.scenes ?? []) {
    if (s?.locationId) add(byId.get(s.locationId))
  }
  const haystack = `${episode.locationName ?? ''} ${(episode.scenes ?? []).map((s) => s.locationDesc ?? '').join(' ')}`.toLowerCase()
  for (const loc of projectLocations ?? []) {
    if (seen.has(loc.id)) continue
    const name = (loc.name ?? '').toLowerCase().trim()
    if (name.length >= 3 && haystack.includes(name)) add(loc)
  }
  if (out.length === 0) {
    const names = new Set<string>()
    for (const s of episode.scenes ?? []) {
      const n = sceneLocName(s.locationDesc)
      const key = n.toLowerCase()
      if (n && !names.has(key)) { names.add(key); out.push({ id: `derived:${_slug(n)}`, name: n, derived: true }) }
    }
  }
  return out
}
