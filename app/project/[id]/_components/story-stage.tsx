'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Loader2, Wand2, ArrowRight, BookOpen } from 'lucide-react'
import { JOB_POLL_INTERVAL_MS, useJobPolling, SmoothProgress } from './use-job-polling'
import { CancelButton } from './cancel-button'
import { StickyReviseBar } from './sticky-revise-bar'
import { type SeasonEpisode } from './season-stage'

// GenerationJob.type values (mirrored from the server workers — this is a client component, so we can't
// import the worker modules, which pull in prisma/openai). The job's `type` field arrives as a string.
const STORY_REVISE_JOB_TYPE = 'story_revise'
const SEASON_JOB_TYPE = 'season_script'
const STORY_REVISE_EXPECTED_SEC = 90 // prose rewrite + structure sync
const SEASON_REWRITE_EXPECTED_SEC = 480 // affected-episode script rewrite phase

// Fixed episode-boundary bars written by the LLM (see lib/season.ts fullStoryFormatRules).
const START_MARK = '═══'
const END_MARK = '───'

type SeasonData = { id: string; title?: string | null; logline?: string | null; status: string; fullStory?: string | null; episodes: SeasonEpisode[] } | null
type Job = { id: string; status: string; progress: number; message?: string | null; error?: string | null; resultData?: string | null } | null

/** Render the whole-season prose story, styling the ═══/─── episode markers as dividers. */
function FullStoryView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/)
  return (
    <div className="space-y-2" data-testid="full-story">
      {lines.map((line, i) => {
        const t = line.trimStart()
        if (t.startsWith(START_MARK)) {
          const label = t.replace(/═+/g, '').trim()
          return (
            <div key={i} className="mt-6 flex items-center gap-2 first:mt-0" data-testid="full-story-episode-start">
              <span className="h-px flex-1 bg-primary/40" />
              <span className="rounded-full bg-primary/10 px-3 py-1 text-sm font-bold text-primary">{label}</span>
              <span className="h-px flex-1 bg-primary/40" />
            </div>
          )
        }
        // Stage 14 (A3): the "end of episode N" markers are no longer shown — a new episode header
        // already implies the previous one ended. Old stories still contain the ─── bars, so we skip
        // them silently here (both legacy and new content render cleanly).
        if (t.startsWith(END_MARK)) return null
        if (!t) return <div key={i} className="h-2" />
        return <p key={i} className="text-sm leading-relaxed">{line}</p>
      })}
    </div>
  )
}

export function StoryStage({ project, onRefresh }: { project: any; onRefresh?: () => void }) {
  const [season, setSeason] = useState<SeasonData>(null)
  const [job, setJob] = useState<Job>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [storyText, setStoryText] = useState('')
  const [storyBusy, setStoryBusy] = useState(false)
  const [storyNotice, setStoryNotice] = useState('')
  const [openingEpisode, setOpeningEpisode] = useState<string | null>(null) // episodeId being navigated to

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/ai/season?projectId=${project.id}`, { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setSeason(data.season ?? null)
      setJob(data.job ?? null)
    } catch {}
    finally { setLoading(false) }
  }, [project.id])

  const jobActive = !!job && (job.status === 'pending' || job.status === 'processing')
  const result = (() => { try { return job?.resultData ? JSON.parse(job.resultData) : null } catch { return null } })()
  const paused = !!job && job.status === 'completed' && result && result.done === false
  const total = season?.episodes.length ?? 0
  const scriptsDone = season?.episodes.filter((e) => e.script).length ?? 0
  const episodeCount = total
  // Stage 59 (step 3 «Сюжет сезона»): the first episode that already has a script — the entry point into
  // step 4 (episode creation). Used by the identical «Перейти к первому эпизоду» buttons at top and bottom.
  const firstEpisode = season?.episodes.find((e) => !!e.script) ?? null

  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!jobActive) return
    const id = setInterval(load, JOB_POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [jobActive, load])

  const start = async () => {
    setStarting(true); setError(null)
    try {
      const res = await fetch('/api/ai/season', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id, ...(typeof project.episodeCount === 'number' ? { episodeCount: project.episodeCount } : {}) }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Не удалось запустить генерацию')
      setJob({ id: data.jobId, status: 'processing', progress: 1, message: 'Запуск...' })
    } catch (e: any) { setError(e?.message ?? 'Ошибка') }
    finally { setStarting(false) }
  }

  const cancelSeason = async () => {
    if (!job?.id) return
    const res = await fetch(`/api/ai/jobs/${job.id}/cancel`, { method: 'POST' })
    if (res.ok) {
      continuedFor.current = job.id
      setJob((j) => (j ? { ...j, status: 'canceled', message: 'Останавливаю генерацию...' } : j))
      setTimeout(load, 1500)
    }
  }

  // Auto-continue when the worker paused on the time budget.
  const continuedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!paused || jobActive || starting || !job) return
    if (continuedFor.current === job.id) return
    continuedFor.current = job.id
    void start()
  }, [paused, jobActive, starting, job]) // eslint-disable-line react-hooks/exhaustive-deps
  const wasActive = useRef(false)
  useEffect(() => {
    if (jobActive) { wasActive.current = true; return }
    if (wasActive.current) { wasActive.current = false; onRefresh?.() }
  }, [jobActive]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Story-screen edit-by-prompt («Что изменить в сюжете»). Stage 69: the whole operation now runs as a
   * background GenerationJob (type "story_revise") with a smooth 0→100 % bar — prose rewrite + structure
   * sync — that then follows the handed-off season job for the affected-episode script rewrite. Only
   * changed episodes are rewritten; existing episodes/assets are otherwise kept.
   */
  const lastInstructionRef = useRef('')
  const revisePoll = useJobPolling({
    onFinish: (res) => {
      const j = res.job
      if (j.type === STORY_REVISE_JOB_TYPE) {
        if (j.status === 'completed') {
          const r = j.result || {}
          if (r.needsForce) {
            setStoryBusy(false)
            if (confirm(`${r.error}\n\nПродолжить и переписать эти эпизоды?`)) {
              reviseStory({ instruction: lastInstructionRef.current, force: true })
            }
            return
          }
          const affected: number[] = Array.isArray(r.affected) ? r.affected : []
          setStoryText('')
          setStoryNotice(affected.length
            ? `Сюжет обновлён. Переписываю эпизоды: ${affected.join(', ')} — остальные не тронуты.`
            : 'Сюжет обновлён. Сценарии эпизодов не изменились.')
          void load() // refresh fullStory + any active season job
          if (r.seasonJobId) {
            revisePoll.start(r.seasonJobId) // keep the bar going through the episode-rewrite phase
          } else {
            setStoryBusy(false)
          }
        } else if (j.status === 'failed') {
          setError(j.error ?? 'Не удалось изменить сюжет'); setStoryBusy(false)
        } else if (j.status === 'canceled') {
          setStoryNotice('Изменение отменено.'); setStoryBusy(false)
        }
      } else if (j.type === SEASON_JOB_TYPE) {
        // Phase 2 (affected-episode scripts) finished.
        setStoryBusy(false)
        void load()
        onRefresh?.()
      }
    },
  })

  const reviseStory = async (opts: { instruction: string; force?: boolean }) => {
    const instruction = opts.instruction.trim()
    if (instruction.length < 3) return
    lastInstructionRef.current = instruction
    setStoryBusy(true); setError(null); setStoryNotice('')
    try {
      const res = await fetch('/api/ai/season/full-story/revise', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, instruction, force: !!opts.force }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Не удалось изменить сюжет')
      if (data?.jobId) { revisePoll.start(data.jobId) }
      else setStoryBusy(false)
    } catch (e: any) {
      setError(e?.message ?? 'Ошибка'); setStoryBusy(false)
    }
  }

  // Resume the progress bar if the page was reloaded while a story-revise job was running.
  const reviseResumedRef = useRef(false)
  useEffect(() => {
    if (reviseResumedRef.current) return
    reviseResumedRef.current = true
    ;(async () => {
      try {
        const res = await fetch(`/api/ai/season/full-story/revise?projectId=${project.id}`, { cache: 'no-store' })
        const data = await res.json()
        const j = data?.job
        if (j && (j.status === 'pending' || j.status === 'processing')) {
          setStoryBusy(true)
          revisePoll.start(j.id)
        }
      } catch { /* ignore */ }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>

  return (
    <div className="space-y-6 pb-40" data-testid="story-stage">
      <div className="rounded-xl border border-border bg-card p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-xl font-bold">Сюжет сезона</h2>
          {episodeCount > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-sm" data-testid="episode-count"><BookOpen className="h-4 w-4" /> {episodeCount} эпизодов</span>}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Полная история сезона одним текстом. Каждый эпизод начинается со своей метки-заголовка; локации и персонажи описаны прямо в тексте, а их референсы генерируются на экране эпизода. Правку сюжета вносите в панели внизу — она не ломает уже сгенерированные эпизоды и ассеты.
        </p>
        {season?.title && (
          <div className="mt-3">
            <div className="font-semibold">{season.title}</div>
            {season.logline && <p className="text-sm text-muted-foreground">{season.logline}</p>}
          </div>
        )}

        {/* Stage 59 (step 3 → step 4): jump straight to the first ready episode. Identical to the bottom button. */}
        {firstEpisode && (
          <Link
            href={`/project/${project.id}/episode/${firstEpisode.id}`}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110"
            data-testid="go-first-episode-top"
          >
            Перейти к первому эпизоду <ArrowRight className="h-4 w-4" />
          </Link>
        )}

        {!season && !jobActive && (
          <button onClick={start} disabled={starting} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="season-generate">
            {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            Сгенерировать сезон
          </button>
        )}
        {(jobActive || starting) && !storyBusy && (
          <div className="mt-4 space-y-2" data-testid="season-progress">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-primary" />
                <span className="truncate">{job?.message ?? 'Запуск...'}</span>
                {total > 0 && <span className="flex-shrink-0 text-muted-foreground">· сценарии {scriptsDone}/{total}</span>}
              </span>
              {job?.id && !starting && <CancelButton onCancel={cancelSeason} testId="season-cancel" className="flex-shrink-0" />}
            </div>
            <div className="h-2 w-full overflow-hidden rounded bg-muted">
              <div className="h-full rounded bg-primary transition-all duration-700" style={{ width: `${Math.max(2, job?.progress ?? 0)}%` }} />
            </div>
          </div>
        )}
        {job?.status === 'canceled' && !jobActive && (
          <div className="mt-4 space-y-2" data-testid="season-canceled">
            <p className="text-sm text-amber-500">{job.message ?? 'Генерация отменена'}</p>
            <button onClick={start} disabled={starting} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm" data-testid="season-continue">
              <Wand2 className="h-4 w-4" /> Продолжить генерацию
            </button>
          </div>
        )}
        {job?.status === 'failed' && (
          <div className="mt-4 space-y-2">
            <p className="text-sm text-destructive">Ошибка: {job.error ?? 'генерация прервана'}</p>
            <button onClick={start} disabled={starting} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm" data-testid="season-continue">
              <Wand2 className="h-4 w-4" /> Продолжить генерацию
            </button>
          </div>
        )}
        {paused && !jobActive && (
          <button onClick={start} disabled={starting} className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm" data-testid="season-continue">
            <Wand2 className="h-4 w-4" /> Продолжить генерацию ({result?.remaining} эпизодов осталось)
          </button>
        )}

        {season?.fullStory && (
          <div className="mt-5 rounded-lg border border-border/60 bg-muted/10 p-4" data-testid="story-body">
            <FullStoryView text={season.fullStory} />
          </div>
        )}
        {season && !season.fullStory && !jobActive && (
          <p className="mt-4 text-sm text-muted-foreground">Сюжет ещё не написан. Изменение ниже сгенерирует его.</p>
        )}

        {storyBusy && revisePoll.job && (
          <SmoothProgress
            job={revisePoll.job}
            expectedTotalSec={revisePoll.job.type === SEASON_JOB_TYPE ? SEASON_REWRITE_EXPECTED_SEC : STORY_REVISE_EXPECTED_SEC}
            className="mt-4"
          />
        )}
        {storyNotice && <p className="mt-3 text-sm text-primary" data-testid="story-notice">{storyNotice}</p>}
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>

      {/* Compact bottom-docked «Что изменить в сюжете» field (Stage 69) — restored without the episode list. */}
      <StickyReviseBar
        value={storyText}
        onChange={setStoryText}
        onSubmit={() => reviseStory({ instruction: storyText })}
        busy={storyBusy}
        disabled={jobActive || starting}
        label="Что изменить в сюжете"
        placeholder="Например: сделать финал драматичнее"
        submitLabel="Изменить сюжет"
        testId="story-revise"
      />
    </div>
  )
}
