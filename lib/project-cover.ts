/**
 * Dashboard project cover (аватарка проекта).
 *
 * Pure helper, no DB access. Picks the FIRST generated LOCATION reference of the project (v2 flow):
 * episodes of Project.episodeRefsV2 are scanned in ascending number; within an episode the refs are taken
 * in their stored order; the first `kind: "location"` ref with a ready http(s) imageUrl wins.
 * Legacy fallback: location image of the first episode of the first season (old v1 projects).
 * Returns null when nothing usable is found.
 */

export interface CoverEpisode {
  number: number
  location?: { imageUrl?: string | null } | null
}

export interface CoverSeason {
  number?: number | null
  createdAt?: Date | string
  episodes: CoverEpisode[]
}

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const s = v.trim()
  return /^https?:\/\/\S+$/i.test(s)
}

/** First generated location image from Project.episodeRefsV2 ({ "<n>": { items: EpisodeRefV2[] } }). */
export function pickProjectCoverV2(episodeRefsV2: unknown): string | null {
  if (!episodeRefsV2 || typeof episodeRefsV2 !== 'object' || Array.isArray(episodeRefsV2)) return null
  const entries = Object.entries(episodeRefsV2 as Record<string, any>)
    .map(([k, v]) => [Number(k), v] as const)
    .filter(([n]) => Number.isFinite(n))
    .sort((a, b) => a[0] - b[0])
  for (const [, entry] of entries) {
    const items: any[] = Array.isArray(entry?.items) ? entry.items : []
    for (const ref of items) {
      if (ref?.kind !== 'location') continue
      if (ref?.imageStatus && ref.imageStatus !== 'done') continue
      if (isHttpUrl(ref?.imageUrl)) return ref.imageUrl.trim()
    }
  }
  return null
}

function createdMs(s: CoverSeason): number {
  if (!s.createdAt) return Number.POSITIVE_INFINITY
  const ms = new Date(s.createdAt).getTime()
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
}

/** Legacy (v1 data): location image of the first episode of the first season. */
export function pickProjectCoverLegacy(seasons: CoverSeason[] | null | undefined): string | null {
  if (!Array.isArray(seasons) || seasons.length === 0) return null

  const first = [...seasons].sort((a, b) => {
    const an = typeof a.number === 'number' ? a.number : null
    const bn = typeof b.number === 'number' ? b.number : null
    if (an !== null && bn !== null && an !== bn) return an - bn
    if (an !== null && bn === null) return -1
    if (an === null && bn !== null) return 1
    return createdMs(a) - createdMs(b)
  })[0]
  if (!first) return null

  const episodes = [...(first.episodes ?? [])].sort((a, b) => a.number - b.number)
  for (const ep of episodes) {
    const url = ep.location?.imageUrl
    if (isHttpUrl(url)) return url.trim()
  }
  return null
}

/** v2 first generated location → legacy v1 location → null. */
export function pickProjectCover(episodeRefsV2: unknown, seasons?: CoverSeason[] | null): string | null {
  return pickProjectCoverV2(episodeRefsV2) ?? pickProjectCoverLegacy(seasons)
}
