'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Loader2, Wand2, ArrowRight, BookOpen, Copy, Check } from 'lucide-react'
import { useJobPolling, StreamingText } from './use-job-polling'
import { RewritePlaceholder } from './rewrite-placeholder'
import { rewriteViewState } from '@/lib/rewrite-view-state'
import { CancelButton } from './cancel-button'
import { StickyReviseBar } from './sticky-revise-bar'
import { type SeasonEpisode, seasonBuildPercent } from './season-stage'
import { EpisodeFootage } from './episode-footage'
import { PLOT_ACCEPT } from '@/lib/plot-import'


// GenerationJob.type values (mirrored from the server workers — this is a client component, so we can't
// import the worker modules, which pull in prisma/openai). The job's `type` field arrives as a string.
const STORY_REVISE_JOB_TYPE = 'story_revise'
const SEASON_JOB_TYPE = 'season_script'
const STORY_REVISE_EXPECTED_SEC = 90 // prose rewrite + structure sync
const SEASON_REWRITE_EXPECTED_SEC = 480 // affected-episode script rewrite phase

// Fixed episode-boundary bars (see lib/season.ts buildFullStoryFromStructure — Stage 106: built from the structure).
const START_MARK = '═══'
const END_MARK = '───'

type SeasonData = { id: string; title?: string | null; logline?: string | null; status: string; fullStory?: string | null; episodeCount?: number | null; episodes: SeasonEpisode[] } | null
type Job = { id: string; status: string; progress: number; message?: string | null; error?: string | null; resultData?: string | null; streamedText?: string | null } | null

/**
 * Render the season plot: the overview (text before the first ═══ marker) as paragraphs, then each episode block
 * with its ═══ header as a divider and — Stage 128 — its body as ONE continuous synopsis paragraph plus a
 * highlighted Cliffhanger line (legacy episodes saved in the old 3-row footage format still render that way,
 * handled inside EpisodeFootage). ─── closings are hidden.
 */
function FullStoryView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/)
  type Block = { key: number; header: string | null; body: string[] }
  const blocks: Block[] = [{ key: 0, header: null, body: [] }]
  lines.forEach((line, i) => {
    const t = line.trimStart()
    if (t.startsWith(START_MARK)) { blocks.push({ key: i + 1, header: t.replace(/═+/g, '').trim(), body: [] }); return }
    if (t.startsWith(END_MARK)) return
    blocks[blocks.length - 1].body.push(line)
  })
  const renderPlain = (body: string[], keyBase: number) => body.map((line, i) => {
    if (!line.trim()) return <div key={`${keyBase}-${i}`} className="h-2" />
    return <p key={`${keyBase}-${i}`} className="text-sm leading-relaxed">{line}</p>
  })
  return (
    <div className="space-y-2" data-testid="full-story">
      {blocks.map((b) => {
        const bodyText = b.body.join('\n').trim()
        return (
          <div key={b.key}>
            {b.header && (
              <div className="mt-6 flex items-center gap-2 first:mt-0" data-testid="full-story-episode-start">
                <span className="h-px flex-1 bg-primary/40" />
                <span className="rounded-full bg-primary/10 px-3 py-1 text-sm font-bold text-primary">{b.header}</span>
                <span className="h-px flex-1 bg-primary/40" />
              </div>
            )}
            {/* Stage 128 — every episode block renders through EpisodeFootage: it shows the new continuous
               synopsis + cliffhanger, or the legacy 3-row footage for old saved episodes. The intro overview
               block (no header) stays plain prose. */}
            {b.header
              ? <EpisodeFootage description={bodyText} className="mt-3 [&>p]:text-sm [&>p]:leading-relaxed" />
              : renderPlain(b.body, b.key)}
          </div>
        )
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
  const [storyCopied, setStoryCopied] = useState(false) // flashed «Скопировано» on the story copy button
  const [openingEpisode, setOpeningEpisode] = useState<string | null>(null) // episodeId being navigated to
  // Stage 155 — "bring your own plot file": before the plot exists the author chooses to auto-generate it
  // or to upload their own plot file (.txt/.md/.docx/.pdf), which becomes the authoritative source for scripts.
  const [plotMode, setPlotMode] = useState<'auto' | 'upload'>('auto')
  const [plotFile, setPlotFile] = useState<File | null>(null)
  const [uploadBusy, setUploadBusy] = useState(false)
  const plotInputRef = useRef<HTMLInputElement | null>(null)
  // ПРАВКА (task 1) — рекомендованное ИИ число серий (посчитано после аппрува синопсиса). Прифилл поля:
  // выбор продюсера (episodeCount) → рекомендация ИИ → 8 по умолчанию. Продюсер может оставить или изменить.
  const [episodesWanted, setEpisodesWanted] = useState<number>(() => {
    const n = Number(project?.episodeCount ?? project?.recommendedEpisodeCount)
    return Number.isFinite(n) && n > 0 ? Math.min(100, Math.max(1, Math.round(n))) : 8
  })

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
  const total = season?.episodes.length ?? 0
  const episodeCount = total
  // ПРАВКА 1 — сюжет генерируется пачками по 3 эпизода. seasonTotal — итоговое число серий сезона;
  // canGenMore — есть ещё серии, которые не сгенерированы (можно продолжить следующей пачкой).
  const seasonTotal = season?.episodeCount ?? total
  const canGenMore = !!season && !jobActive && seasonTotal > total
  // Percentage shown on the season-build bar. Uses the same monotonic helper as season-stage
  // (floors by written-episode count so the optimistic "Starting..." 1% reset never jumps backwards;
  // capped at 99 so a false 100% never appears before the job actually completes).
  const doneEpisodes = season?.episodes.filter((e) => !!e.script).length ?? 0
  const buildPct = seasonBuildPercent({ progress: job?.progress, done: doneEpisodes, total })
  // Stage 107: the season job writes structure + plot only; scripts are written on demand from the episode
  // page. «Go to first episode therefore always points at episode 1 (lowest number), script or not.
  const firstEpisode = season ? ([...season.episodes].sort((a, b) => a.number - b.number)[0] ?? null) : null

  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!jobActive) return
    // Poll faster than the shared 3 s constant so the streamed partial script (streamedText) shows up in
    // near-real-time. Concurrent reads that hit the CAS-locked advance still return the current row with
    // the latest partial, so the extra ticks are cheap and only surface fresher text.
    const id = setInterval(load, 1500)
    return () => clearInterval(id)
  }, [jobActive, load])

  const start = async () => {
    setStarting(true); setError(null)
    try {
      const res = await fetch('/api/ai/season', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id, episodeCount: episodesWanted }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Failed to start generation')
      setJob({ id: data.jobId, status: 'processing', progress: 1, message: 'Starting...' })
    } catch (e: any) { setError(e?.message ?? 'Error') }
    finally { setStarting(false) }
  }

  // ПРАВКА 1 — продолжить сюжет следующей пачкой из 3 эпизодов (с учётом контекста уже написанных серий).
  const nextBatch = async () => {
    setStarting(true); setError(null)
    try {
      const res = await fetch('/api/ai/season', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id, action: 'next-batch' }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Failed to start generation')
      setJob({ id: data.jobId, status: 'processing', progress: 1, message: 'Starting...' })
    } catch (e: any) { setError(e?.message ?? 'Error') }
    finally { setStarting(false) }
  }

  // Stage 155 — upload the author's own plot file: extract text server-side, store it as the season plot
  // (Season.fullStory + userPlotUploaded), and start the season job so the scripts are written from it.
  const uploadPlot = async () => {
    if (!plotFile) { setError('Выберите файл с сюжетом (.txt, .md, .docx или .pdf)'); return }
    setUploadBusy(true); setError(null)
    try {
      const fd = new FormData()
      fd.append('projectId', project.id)
      fd.append('file', plotFile)
      const res = await fetch('/api/ai/season/full-story/upload', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Не удалось загрузить файл')
      setJob({ id: data.jobId, status: 'processing', progress: 1, message: 'Starting...' })
    } catch (e: any) { setError(e?.message ?? 'Ошибка') }
    finally { setUploadBusy(false) }
  }

  const cancelSeason = async () => {
    if (!job?.id) return
    const res = await fetch(`/api/ai/jobs/${job.id}/cancel`, { method: 'POST' })
    if (res.ok) {
      setJob((j) => (j ? { ...j, status: 'canceled', message: 'Stopping generation...' } : j))
      setTimeout(load, 1500)
    }
  }

  const wasActive = useRef(false)
  useEffect(() => {
    if (jobActive) { wasActive.current = true; return }
    if (wasActive.current) { wasActive.current = false; onRefresh?.() }
  }, [jobActive]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Story-screen edit-by-prompt («What to change in the plot"). Stage 69: the whole operation now runs as a
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
            if (confirm(`${r.error}\n\nContinue and rewrite these episodes?`)) {
              reviseStory({ instruction: lastInstructionRef.current, force: true })
            }
            return
          }
          const affected: number[] = Array.isArray(r.affected) ? r.affected : []
          setStoryText('')
          setStoryNotice(affected.length
            ? `Plot updated. Rewriting episodes: ${affected.join(', ')} — the rest are untouched.`
            : 'Plot updated. Episode scripts were not changed.')
          void load() // refresh fullStory + any active season job
          if (r.seasonJobId) {
            revisePoll.start(r.seasonJobId) // keep the bar going through the episode-rewrite phase
          } else {
            setStoryBusy(false)
          }
        } else if (j.status === 'failed') {
          setError(j.error ?? 'Failed to edit plot'); setStoryBusy(false)
        } else if (j.status === 'canceled') {
          setStoryNotice('Change canceled.'); setStoryBusy(false)
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
      if (!res.ok) throw new Error(data?.error ?? 'Failed to edit plot')
      if (data?.jobId) { revisePoll.start(data.jobId) }
      else setStoryBusy(false)
    } catch (e: any) {
      setError(e?.message ?? 'Error'); setStoryBusy(false)
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

  // Copy the ENTIRE season story (Сюжет) to the clipboard and flash «Скопировано».
  const copyStory = async () => {
    const text = (season?.fullStory ?? '').trim()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setStoryCopied(true)
      setTimeout(() => setStoryCopied(false), 1500)
    } catch {}
  }

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>

  return (
    <div className="space-y-6 pb-40" data-testid="story-stage">
      <div className="rounded-xl border border-border bg-card p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-xl font-bold">Шаг 3 — Сюжет по сериям</h2>
          {episodeCount > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-sm" data-testid="episode-count"><BookOpen className="h-4 w-4" /> {seasonTotal > total ? `${total} / ${seasonTotal}` : episodeCount} серий</span>}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Сезон по сериям: каждая серия — подробный связный синопсис, завершающийся клиффхэнгером. Отредактируйте в панели ниже или нажмите «Регенерировать сюжет». Когда всё устраивает — нажмите «Аппрув / Далее», чтобы перейти к работе над сериями. Перегенерация очищает сгенерированные сцены и видео затронутых серий.
        </p>
        {season?.title && (
          <div className="mt-3">
            <div className="font-semibold">{season.title}</div>
            {season.logline && <p className="text-sm text-muted-foreground">{season.logline}</p>}
          </div>
        )}

        {/* Stage 173 (task 2): after the season structure is built, the next step is the episode PLOT page —
           it shows the plot (сюжет) of the FIRST episode, from where the producer goes to its script or
           generates the next episode's plot. */}
        {firstEpisode && (
          <Link
            href={`/project/${project.id}/plot/${firstEpisode.id}`}
            className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110"
            data-testid="go-first-episode-top"
          >
            Аппрув / К сюжету серий <ArrowRight className="h-4 w-4" />
          </Link>
        )}

        {!season && !jobActive && (
          <div className="mt-4 space-y-4" data-testid="plot-source-choice">
            <p className="text-sm font-medium">Как создать сюжет сезона?</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => setPlotMode('auto')}
                className={`flex-1 rounded-lg border px-4 py-3 text-left text-sm transition ${plotMode === 'auto' ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}
                data-testid="plot-mode-auto"
              >
                <span className="font-semibold">Сгенерировать автоматически</span>
                <span className="mt-1 block text-xs text-muted-foreground">Приложение само построит сюжет сезона по синопсису.</span>
              </button>
              <button
                type="button"
                onClick={() => setPlotMode('upload')}
                className={`flex-1 rounded-lg border px-4 py-3 text-left text-sm transition ${plotMode === 'upload' ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/50'}`}
                data-testid="plot-mode-upload"
              >
                <span className="font-semibold">Загрузить свой файл с сюжетом</span>
                <span className="mt-1 block text-xs text-muted-foreground">Ваш готовый сюжет (.txt, .md, .docx, .pdf) станет основой для сценариев.</span>
              </button>
            </div>

            {plotMode === 'auto' ? (
              <div className="space-y-3" data-testid="episode-count-panel">
                {/* ПРАВКА (task 1) — рекомендованное ИИ число серий: показываем подсказку и поле, где можно оставить
                   рекомендацию или задать своё число. */}
                <div className="rounded-lg border border-border bg-muted/40 p-3">
                  <label htmlFor="episodes-wanted" className="text-sm font-medium">Количество серий в сезоне</label>
                  {typeof project?.recommendedEpisodeCount === 'number' && (
                    <p className="mt-1 text-xs text-muted-foreground" data-testid="episode-count-recommendation">
                      Рекомендация ИИ по синопсису: <b>{project.recommendedEpisodeCount}</b> серий. Можно оставить как есть или изменить.
                    </p>
                  )}
                  <input
                    id="episodes-wanted"
                    type="number"
                    min={1}
                    max={100}
                    value={episodesWanted}
                    onChange={(e) => {
                      const n = Math.round(Number(e.target.value))
                      setEpisodesWanted(Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : 1)
                    }}
                    className="mt-2 w-28 rounded-lg border border-border bg-background px-3 py-2 text-sm"
                    data-testid="episode-count-input"
                  />
                </div>
                <button onClick={start} disabled={starting} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="season-generate">
                  {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                  Сгенерировать сезон
                </button>
              </div>
            ) : (
              <div className="space-y-3" data-testid="plot-upload-panel">
                <input
                  ref={plotInputRef}
                  type="file"
                  accept={PLOT_ACCEPT}
                  onChange={(e) => { setPlotFile(e.target.files?.[0] ?? null); setError(null) }}
                  className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-primary/10 file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary hover:file:bg-primary/20"
                  data-testid="plot-file-input"
                />
                {plotFile && <p className="text-xs text-muted-foreground">Выбран файл: {plotFile.name}</p>}
                <p className="text-xs text-muted-foreground">Поддерживаются .txt, .md, .docx и .pdf (до 8 МБ). Деление на серии сохраняется, если в файле есть заголовки «Серия N», «Эпизод N» или «Episode N».</p>
                <button
                  onClick={uploadPlot}
                  disabled={uploadBusy || !plotFile}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                  data-testid="plot-upload-submit"
                >
                  {uploadBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                  Загрузить и создать сезон
                </button>
              </div>
            )}
          </div>
        )}
        {(jobActive || starting) && !storyBusy && (
          <div className="mt-4 space-y-2" data-testid="season-progress">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-primary" />
                <span className="truncate">{job?.message ?? 'Starting...'}</span>
              </span>
              <span className="flex flex-shrink-0 items-center gap-2">
                <span className="tabular-nums font-medium text-muted-foreground" data-testid="season-progress-pct">{buildPct}%</span>
                {job?.id && !starting && <CancelButton onCancel={cancelSeason} testId="season-cancel" className="flex-shrink-0" />}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded bg-muted">
              <div className="h-full rounded bg-primary transition-all duration-700" style={{ width: `${buildPct}%` }} />
            </div>
            {/* Streaming preview: show the text being written live (accumulates on the server, so a
                reload / return shows the partial-so-far even if the tab was closed). RU + EN. */}
            <StreamingText text={job?.streamedText} active={jobActive} />
          </div>
        )}
        {job?.status === 'canceled' && !jobActive && (
          <div className="mt-4 space-y-2" data-testid="season-canceled">
            <p className="text-sm text-amber-500">{job.message ?? 'Generation canceled'}</p>
            <button onClick={start} disabled={starting} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm" data-testid="season-restart">
              <Wand2 className="h-4 w-4" /> Restart generation
            </button>
          </div>
        )}
        {job?.status === 'failed' && (
          <div className="mt-4 space-y-2">
            <p className="text-sm text-destructive">Error: {job.error ?? 'generation interrupted'}</p>
            <button onClick={start} disabled={starting} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm" data-testid="season-restart">
              <Wand2 className="h-4 w-4" /> Restart generation
            </button>
          </div>
        )}

        {/* Stage 77: while the rewrite runs the OLD story is replaced by a placeholder with the smooth bar. */}
        {rewriteViewState(storyBusy, revisePoll.job?.status) === 'placeholder' ? (
          <RewritePlaceholder
            job={revisePoll.job}
            expectedTotalSec={revisePoll.job?.type === SEASON_JOB_TYPE ? SEASON_REWRITE_EXPECTED_SEC : STORY_REVISE_EXPECTED_SEC}
            label="Rewriting plot…"
            testId="story-revise-progress"
            className="mt-5"
          />
        ) : (
          <>
            {season?.fullStory && (
              <div className="mt-5 rounded-lg border border-border/60 bg-muted/10 p-4" data-testid="story-body">
                <div className="mb-3 flex justify-end">
                  <button type="button" onClick={copyStory} className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:text-foreground" data-testid="copy-story">
                    {storyCopied ? <><Check className="h-4 w-4 text-primary" /> Скопировано</> : <><Copy className="h-4 w-4" /> Копировать</>}
                  </button>
                </div>
                <FullStoryView text={season.fullStory} />
              </div>
            )}
            {season?.fullStory && !jobActive && (
              <div className="mt-3 space-y-3" data-testid="plot-ready">
                <p className="text-sm text-muted-foreground">
                  {canGenMore
                    ? `Готово серий: ${total} из ${seasonTotal}. Первые серии уже можно взять в работу, либо сгенерируйте следующие 3 эпизода.`
                    : 'Сюжет сезона готов. Откройте серию, чтобы написать её сценарий.'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {canGenMore && (
                    <button
                      onClick={nextBatch}
                      disabled={starting || storyBusy}
                      className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
                      data-testid="season-next-batch"
                    >
                      {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                      Сгенерировать следующие 3 эпизода
                    </button>
                  )}
                  <button
                    onClick={start}
                    disabled={starting || storyBusy}
                    className="inline-flex items-center gap-2 rounded-lg bg-secondary px-4 py-2 text-sm font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50"
                    data-testid="season-regenerate"
                  >
                    {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                    Регенерировать сюжет
                  </button>
                </div>
              </div>
            )}
            {season && !season.fullStory && !jobActive && (
              <p className="mt-4 text-sm text-muted-foreground">Сюжет ещё не написан. Правка в панели ниже сгенерирует его.</p>
            )}
          </>
        )}
        {storyNotice && <p className="mt-3 text-sm text-primary" data-testid="story-notice">{storyNotice}</p>}
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>

      {/* Compact bottom-docked «What to change in the plot" field (Stage 69) — restored without the episode list. */}
      <StickyReviseBar
        value={storyText}
        onChange={setStoryText}
        onSubmit={() => reviseStory({ instruction: storyText })}
        busy={storyBusy}
        disabled={jobActive || starting}
        label="Исправить промптом"
        placeholder="Например: сделай финал драматичнее"
        submitLabel="Исправить промптом"
        testId="story-revise"
        hint="Перегенерация очищает сгенерированные сцены и видео затронутых серий."
      />
    </div>
  )
}
