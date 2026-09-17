'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Loader2, Wand2, ArrowRight, BookOpen } from 'lucide-react'
import { JOB_POLL_INTERVAL_MS, useJobPolling } from './use-job-polling'
import { RewritePlaceholder } from './rewrite-placeholder'
import { rewriteViewState } from '@/lib/rewrite-view-state'
import { CancelButton } from './cancel-button'
import { StickyReviseBar } from './sticky-revise-bar'
import { type SeasonEpisode } from './season-stage'
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

type SeasonData = { id: string; title?: string | null; logline?: string | null; status: string; fullStory?: string | null; episodes: SeasonEpisode[] } | null
type Job = { id: string; status: string; progress: number; message?: string | null; error?: string | null; resultData?: string | null } | null

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
  const [openingEpisode, setOpeningEpisode] = useState<string | null>(null) // episodeId being navigated to
  // Stage 155 — "bring your own plot file": before the plot exists the author chooses to auto-generate it
  // or to upload their own plot file (.txt/.md/.docx/.pdf), which becomes the authoritative source for scripts.
  const [plotMode, setPlotMode] = useState<'auto' | 'upload'>('auto')
  const [plotFile, setPlotFile] = useState<File | null>(null)
  const [uploadBusy, setUploadBusy] = useState(false)
  const plotInputRef = useRef<HTMLInputElement | null>(null)

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
  // Stage 107: the season job writes structure + plot only; scripts are written on demand from the episode
  // page. «Go to first episode therefore always points at episode 1 (lowest number), script or not.
  const firstEpisode = season ? ([...season.episodes].sort((a, b) => a.number - b.number)[0] ?? null) : null

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

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>

  return (
    <div className="space-y-6 pb-40" data-testid="story-stage">
      <div className="rounded-xl border border-border bg-card p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-xl font-bold">Season plot</h2>
          {episodeCount > 0 && <span className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-sm" data-testid="episode-count"><BookOpen className="h-4 w-4" /> {episodeCount} episodes</span>}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          The season, episode by episode: each episode is a detailed continuous synopsis ending on its cliffhanger. Edit in the panel below; rewriting clears the generated scenes and videos of the affected episodes.
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
            Go to first episode <ArrowRight className="h-4 w-4" />
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
              <button onClick={start} disabled={starting} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="season-generate">
                {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                Сгенерировать сезон
              </button>
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
              {job?.id && !starting && <CancelButton onCancel={cancelSeason} testId="season-cancel" className="flex-shrink-0" />}
            </div>
            <div className="h-2 w-full overflow-hidden rounded bg-muted">
              <div className="h-full rounded bg-primary transition-all duration-700" style={{ width: `${Math.max(2, job?.progress ?? 0)}%` }} />
            </div>
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
                <FullStoryView text={season.fullStory} />
              </div>
            )}
            {season?.fullStory && !jobActive && (
              <p className="mt-3 text-sm text-muted-foreground" data-testid="plot-ready">Season plot is ready. Open an episode to write its script.</p>
            )}
            {season && !season.fullStory && !jobActive && (
              <p className="mt-4 text-sm text-muted-foreground">The plot hasn't been written yet. Editing below will generate it.</p>
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
        label="What to change in the plot"
        placeholder="For example: make the ending more dramatic"
        submitLabel="Edit story"
        testId="story-revise"
        hint="Rewriting clears the generated scenes and videos of the affected episodes."
      />
    </div>
  )
}
