/**
 * Stage 77 — resume-after-reload matching for the episode-script rewrite.
 *
 * `/api/ai/episodes/[id]/revise` creates a `season_script` GenerationJob whose resultData state
 * carries `revise.episodeIds: [episodeId]`. GET /api/ai/season?projectId=… returns the latest
 * season job as a raw Prisma row (`resultData` is a JSON string); GET /api/jobs/[id] returns the
 * same row with `result` already parsed. This helper accepts either shape.
 *
 * Returns true when the job is active (pending/processing) AND its revise queue names this episode.
 * A season job without a revise queue (initial season generation) is NOT a rewrite of this episode.
 */
export type SeasonJobLike = {
  id?: string
  status?: string | null
  resultData?: string | null
  result?: unknown
} | null | undefined

function parseState(job: NonNullable<SeasonJobLike>): any {
  if (job.result && typeof job.result === 'object') return job.result
  if (typeof job.resultData === 'string' && job.resultData) {
    try { return JSON.parse(job.resultData) } catch { return null }
  }
  return null
}

export function isEpisodeRevisePending(job: SeasonJobLike, episodeId: string): boolean {
  if (!job || !episodeId) return false
  if (job.status !== 'pending' && job.status !== 'processing') return false
  const state = parseState(job)
  const ids = state?.revise?.episodeIds
  if (!Array.isArray(ids)) return false
  return ids.includes(episodeId)
}
