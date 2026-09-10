// Stage 12: estimate how "big" a location is so the episode reference generator
// produces MORE reference frames for large spaces (a city street or a forest needs
// far more coverage than a small room). Pure/client-safe — no server imports.

/** Keywords that imply a large, spatially complex place (need many reference frames). */
const BIG_KEYWORDS = [
  // en
  'city', 'street', 'avenue', 'square', 'plaza', 'boulevard', 'downtown', 'skyline',
  'forest', 'woods', 'field', 'meadow', 'valley', 'mountain', 'desert', 'beach', 'coast',
  'harbor', 'harbour', 'port', 'dock', 'pier', 'river', 'lake', 'sea', 'ocean',
  'station', 'terminal', 'airport', 'stadium', 'arena', 'hall', 'factory', 'warehouse',
  'mall', 'market', 'bazaar', 'campus', 'hospital', 'castle', 'palace', 'mansion',
  'complex', 'landscape', 'park', 'garden', 'yard', 'courtyard', 'rooftop', 'bridge',
  'highway', 'road', 'village', 'town', 'district', 'quarter', 'cathedral', 'church',
  'hangar', 'dam', 'quarry', 'mine', 'canyon', 'cliff', 'hill', 'ruins', 'temple',
  // ru
  'город', 'улиц', 'площад', 'проспект', 'лес', 'поле', 'долин', 'гор', 'пустын',
  'пляж', 'побережь', 'порт', 'причал', 'река', 'озер', 'море', 'океан', 'вокзал',
  'станци', 'аэропорт', 'стадион', 'арен', 'завод', 'фабрик', 'склад', 'рынок',
  'базар', 'кампус', 'больниц', 'замок', 'дворец', 'особняк', 'комплекс', 'парк',
  'сад', 'двор', 'крыш', 'мост', 'шоссе', 'дорог', 'деревн', 'посёлок', 'посел',
  'район', 'собор', 'церков', 'храм', 'каньон', 'утёс', 'холм', 'руин', 'ландшафт',
]

/** Keywords that imply an especially vast/open place (need the most frames). */
const HUGE_KEYWORDS = [
  'city', 'skyline', 'downtown', 'forest', 'desert', 'valley', 'mountain', 'ocean',
  'sea', 'landscape', 'stadium', 'airport', 'canyon', 'harbor', 'harbour',
  'город', 'лес', 'пустын', 'долин', 'гор', 'океан', 'море', 'ландшафт', 'стадион', 'аэропорт', 'каньон',
]

function textOf(loc: { name?: string | null; description?: string | null; visualPrompt?: string | null }): string {
  return `${loc.name ?? ''} ${loc.description ?? ''} ${loc.visualPrompt ?? ''}`.toLowerCase()
}

export type LocationScale = 'small' | 'big' | 'huge'

/** Estimate location scale from its name/description/prompt. */
export function locationScale(loc: { name?: string | null; description?: string | null; visualPrompt?: string | null }): LocationScale {
  const t = textOf(loc)
  if (HUGE_KEYWORDS.some((k) => t.includes(k))) return 'huge'
  if (BIG_KEYWORDS.some((k) => t.includes(k))) return 'big'
  return 'small'
}

/**
 * Stage 14 (E): every episode location must have MANY angles — ~15 frames, within a 10–20
 * range scaled by size. The base 3 angles (imageUrl/imageReverse/imageDetail) are always
 * generated, so the EXTRA count below tops the total up to: compact → 15, крупная → 18,
 * очень крупная → 20. This gives Seedance dense spatial coverage of each place.
 */
export const LOCATION_TOTAL_MIN = 10
export const LOCATION_TOTAL_TARGET = 15
export const LOCATION_TOTAL_MAX = 20
/** Base angles always generated on the Location row (imageUrl + imageReverse + imageDetail). */
export const LOCATION_BASE_FRAMES = 3

export function desiredTotalFrames(loc: { name?: string | null; description?: string | null; visualPrompt?: string | null }): number {
  switch (locationScale(loc)) {
    case 'huge': return LOCATION_TOTAL_MAX // 20
    case 'big': return 18
    default: return LOCATION_TOTAL_TARGET // 15
  }
}

export function desiredExtraFrames(loc: { name?: string | null; description?: string | null; visualPrompt?: string | null }): number {
  return Math.max(0, desiredTotalFrames(loc) - LOCATION_BASE_FRAMES)
}

/** Human label for the scale (RU UI). */
export function locationScaleLabel(scale: LocationScale): string {
  return scale === 'huge' ? 'очень крупная' : scale === 'big' ? 'крупная' : 'компактная'
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
