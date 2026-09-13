/**
 * Stage 76 — dashboard project cover.
 *
 * Pure helper: picks the location image of the first episode of the first season
 * (first season = lowest `number`, fallback earliest `createdAt`; first episode = lowest `number`).
 * If that episode has no location image, falls back to the next episode in the SAME season
 * that has one. Returns null when nothing usable is found. No DB access.
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

function createdMs(s: CoverSeason): number {
  if (!s.createdAt) return Number.POSITIVE_INFINITY
  const ms = new Date(s.createdAt).getTime()
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
}

export function pickProjectCover(seasons: CoverSeason[] | null | undefined): string | null {
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
