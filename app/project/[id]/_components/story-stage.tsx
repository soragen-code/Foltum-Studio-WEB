'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Loader2, Wand2, ArrowRight, Check, BookOpen } from 'lucide-react'
import { JOB_POLL_INTERVAL_MS } from './use-job-polling'
import { CancelButton } from './cancel-button'
import { StickyReviseBar } from './sticky-revise-bar'
import { episodeStatusLabel, CharacterAvatars, type SeasonEpisode } from './season-stage'

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
  const abortRef = useRef<AbortController | null>(null)

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
  const ep1 = season?.episodes.find((e) => e.number === 1) ?? null

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

  /** Story-screen edit-by-prompt (also used to sync the story after idea edits). Regenerates the prose
   *  + keeps the structure in sync; only changed episodes are rewritten (existing assets are otherwise kept). */
  const reviseStory = async (opts: { instruction: string; force?: boolean }) => {
    const instruction = opts.instruction.trim()
    if (instruction.length < 3) return
    setStoryBusy(true); setError(null); setStoryNotice('')
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      const res = await fetch('/api/ai/season/full-story/revise', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, instruction, force: !!opts.force }),
        signal: ctrl.signal,
      })
      const data = await res.json()
      if (res.status === 409 && data?.needsForce) {
        if (confirm(`${data.error}\n\nПродолжить и переписать эти эпизоды?`)) return reviseStory({ ...opts, force: true })
        return
      }
      if (!res.ok) throw new Error(data?.error ?? 'Не удалось изменить сюжет')
      setStoryText('')
      const affected: number[] = Array.isArray(data?.affected) ? data.affected : []
      setStoryNotice(affected.length
        ? `Сюжет обновлён. Переписываю эпизоды: ${affected.join(', ')} — остальные не тронуты.`
        : 'Сюжет обновлён. Сценарии эпизодов не изменились.')
      if (typeof data?.fullStory === 'string') setSeason((s) => (s ? { ...s, fullStory: data.fullStory } : s))
      if (data?.jobId) setJob({ id: data.jobId, status: 'processing', progress: 1, message: 'Запуск...' })
      await load()
    } catch (e: any) {
      if (e?.name === 'AbortError') { setStoryNotice('Изменение отменено.') }
      else setError(e?.message ?? 'Ошибка')
    }
    finally { setStoryBusy(false); abortRef.current = null }
  }
  const cancelRevise = () => { abortRef.current?.abort() }

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

        {!season && !jobActive && (
          <button onClick={start} disabled={starting} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="season-generate">
            {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            Сгенерировать сезон
          </button>
        )}
        {(jobActive || starting) && (
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

        {storyNotice && <p className="mt-3 text-sm text-primary" data-testid="story-notice">{storyNotice}</p>}
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>

      {season && total > 0 && (
        <div className="rounded-xl border border-border bg-card p-4 sm:p-6" data-testid="episode-nav">
          <h3 className="font-display text-lg font-bold">Эпизоды</h3>
          <p className="mt-1 text-sm text-muted-foreground">Открывайте любой эпизод — референсы, сцены и сборка делаются на его экране. Эпизоды можно готовить в любом порядке.</p>
          <div className="mt-3 space-y-2">
            {season.episodes.map((ep) => {
              const ready = !!ep.script
              return (
                <div key={ep.id} className="flex items-center gap-3 rounded-lg border border-border/60 p-3" data-testid="episode-nav-item">
                  <span className="shrink-0 text-xs font-semibold uppercase text-muted-foreground">Эп. {ep.number}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{ep.title}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="rounded bg-muted px-1.5 py-0.5" data-testid="episode-nav-status">{!ready && jobActive ? 'пишется...' : episodeStatusLabel(ep)}</span>
                      <CharacterAvatars chars={ep.characters} size="h-5 w-5" />
                    </div>
                  </div>
                  {ready ? (
                    <Link href={`/project/${project.id}/episode/${ep.id}`} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted" data-testid="open-episode">
                      Открыть <ArrowRight className="h-4 w-4" />
                    </Link>
                  ) : (
                    <span className="shrink-0 text-xs text-muted-foreground">{jobActive ? 'сценарий пишется' : 'ожидает'}</span>
                  )}
                </div>
              )
            })}
          </div>
          {ep1?.script && (
            <Link href={`/project/${project.id}/episode/${ep1.id}`} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground sm:w-auto" data-testid="go-to-episode-1">
              Перейти к эпизоду 1 <ArrowRight className="h-4 w-4" />
            </Link>
          )}
          {scriptsDone === total && total > 0 && <p className="mt-3 inline-flex items-center gap-1 text-sm text-primary"><Check className="h-4 w-4" /> Все {total} сценариев готовы</p>}
        </div>
      )}

      {season && (
        <StickyReviseBar
          value={storyText}
          onChange={setStoryText}
          onSubmit={() => reviseStory({ instruction: storyText })}
          busy={storyBusy}
          onCancel={cancelRevise}
          label="Что изменить в сюжете"
          placeholder="Например: сделай 6 эпизодов вместо 8; измени эпизод 2 — добавь сцену погони; добавь линию с сестрой героя"
          submitLabel="Изменить сюжет"
          hint="ИИ перепишет историю и синхронизирует структуру (в т.ч. число эпизодов). Переписываются только затронутые эпизоды — остальные и их ассеты не тронуты."
          testId="story-revise"
        />
      )}
    </div>
  )
}
