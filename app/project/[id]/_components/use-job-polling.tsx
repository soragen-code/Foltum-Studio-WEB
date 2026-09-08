'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Check, AlertCircle } from 'lucide-react'

export interface JobInfo {
  id: string
  type: string
  status: 'pending' | 'processing' | 'completed' | 'failed' | string
  progress: number
  message: string | null
  projectId: string
  characterId?: string | null
  sceneId?: string | null
  error?: string | null
  result?: any
  createdAt: string
  updatedAt: string
}

export interface JobPollResponse {
  job: JobInfo
  characters?: any[]
  scene?: any
}

export const JOB_POLL_INTERVAL_MS = 3000

/**
 * Poll GET /api/jobs/[id] every 3 s until the job is completed or failed.
 * `onUpdate` is called on every tick, `onFinish` once with the terminal payload.
 * Returns the current job (or null) plus start/stop controls.
 */
export function useJobPolling({
  onUpdate,
  onFinish,
}: {
  onUpdate?: (res: JobPollResponse) => void
  onFinish?: (res: JobPollResponse) => void
}) {
  const [job, setJob] = useState<JobInfo | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const cbRef = useRef({ onUpdate, onFinish })
  cbRef.current = { onUpdate, onFinish }

  const stop = useCallback(() => {
    activeIdRef.current = null
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const start = useCallback(
    (jobId: string) => {
      stop()
      activeIdRef.current = jobId

      const tick = async () => {
        if (activeIdRef.current !== jobId) return
        try {
          const res = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' })
          if (res.status === 404) { stop(); setJob(null); return }
          const data: JobPollResponse = await res.json()
          if (activeIdRef.current !== jobId) return
          if (data?.job) {
            setJob(data.job)
            cbRef.current.onUpdate?.(data)
            if (data.job.status === 'completed' || data.job.status === 'failed') {
              stop()
              cbRef.current.onFinish?.(data)
              return
            }
          }
        } catch {
          // transient network error — keep polling
        }
        if (activeIdRef.current === jobId) timerRef.current = setTimeout(tick, JOB_POLL_INTERVAL_MS)
      }
      tick()
    },
    [stop]
  )

  useEffect(() => stop, [stop])

  const isActive = !!job && (job.status === 'pending' || job.status === 'processing')
  return { job, isActive, start, stop, clear: () => setJob(null) }
}

/**
 * Estimate remaining time. Progress is time-based on the server (it resets when the video
 * model retries after a copyright-filter rejection), so linear extrapolation from
 * elapsed/progress explodes on retries ("~85 min remaining"). Use the expected duration
 * for the CURRENT attempt instead, and never show more than 2× the expected total.
 */
export function estimateRemaining(job: JobInfo, expectedTotalSec: number): string {
  const elapsed = (Date.now() - new Date(job.createdAt).getTime()) / 1000
  const p = Math.max(0, Math.min(100, job.progress))
  const retrying = /retry|attempt/i.test(job.message ?? '')
  let remaining: number
  if (retrying) {
    // A fresh attempt just started: progress tells how far this attempt is, not the total.
    remaining = expectedTotalSec * (1 - p / 100)
  } else if (p >= 10 && elapsed > 5) {
    remaining = Math.min((elapsed / p) * (100 - p), expectedTotalSec * 2)
  } else {
    remaining = Math.max(0, expectedTotalSec - elapsed)
  }
  if (remaining <= 5) return 'almost done'
  if (remaining < 60) return `~${Math.max(10, Math.ceil(remaining / 10) * 10)} sec remaining`
  return `~${Math.ceil(remaining / 60)} min remaining`
}

/** Progress bar driven by a GenerationJob (bg-muted track, bg-primary fill). */
export function JobProgressBar({
  job,
  expectedTotalSec,
  className = '',
}: {
  job: JobInfo
  expectedTotalSec: number
  className?: string
}) {
  // Re-render every second so the ETA text stays fresh between polls
  const [, setTick] = useState(0)
  useEffect(() => {
    if (job.status !== 'processing' && job.status !== 'pending') return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [job.status])

  const done = job.status === 'completed'
  const failed = job.status === 'failed'
  const pct = done ? 100 : Math.max(0, Math.min(100, job.progress))
  const eta = done || failed ? '' : estimateRemaining(job, expectedTotalSec)

  return (
    <div className={`space-y-2 ${className}`}>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2">
          {done ? (
            <Check className="h-3 w-3 flex-shrink-0 text-green-400" />
          ) : failed ? (
            <AlertCircle className="h-3 w-3 flex-shrink-0 text-destructive" />
          ) : (
            <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-primary" />
          )}
          <span className="truncate">
            {failed ? job.error ?? 'Generation failed' : job.message ?? 'Working...'}
            {eta && <span className="text-muted-foreground/70"> · {eta}</span>}
          </span>
        </span>
        <span className="ml-3 flex-shrink-0 tabular-nums">{Math.round(pct)}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all duration-500 ease-out ${failed ? 'bg-destructive' : 'bg-primary'}`}
          style={{ width: `${failed ? 100 : pct}%` }}
        />
      </div>
    </div>
  )
}
