'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, FileText, Grid3x3, Loader2, Scissors, Sparkles, Video } from 'lucide-react'
import { PromptModal } from '@/app/project/[id]/_components/prompt-modal'

/**
 * Stage 240 — GRID STORYBOARD panel.
 *
 * One editable prompt → one 5×5 sheet (25 panels) rendered with GPT Image 2.0 → approve → slice into 25
 * per-scene start frames → generate all scene videos (each scene = its panel start frame + refs + grid plate).
 * Bilingual RU + EN labels; the prompt itself stays English (edited in the shared PromptModal).
 */

type Panel = { id: string; number: number; title?: string | null; startFrameUrl?: string | null; gridPanelIndex?: number | null }
type Job = { id: string; status: string; progress?: number | null; message?: string | null; error?: string | null } | null
type GridState = { gridUrl: string | null; gridPrompt: string | null; gridApproved: boolean; panels: Panel[]; job: Job }

const isHttp = (u?: string | null): u is string => !!u && /^https?:\/\//.test(u)
const active = (j: Job) => !!j && (j.status === 'pending' || j.status === 'processing')

export function StoryboardGridPanel({ projectId, episodeId }: { projectId: string; episodeId: string }) {
  const [state, setState] = useState<GridState | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'grid' | 'approve' | 'videos'>(null)
  const [showPrompt, setShowPrompt] = useState(false)
  const [videosStarted, setVideosStarted] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/ai/storyboard/grid?episodeId=${episodeId}`, { cache: 'no-store' })
      const d = await r.json()
      if (!r.ok) throw new Error(d?.error || 'Не удалось загрузить сториборд')
      setState(d)
      return d as GridState
    } catch (e: any) {
      setErr(e?.message ?? 'Ошибка загрузки')
      return null
    } finally {
      setLoading(false)
    }
  }, [episodeId])

  useEffect(() => { load() }, [load])

  // Poll while a grid / slice job is running so the sheet + panels refresh on completion.
  useEffect(() => {
    const job = state?.job
    if (!active(job)) { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } return }
    if (pollRef.current) return
    pollRef.current = setInterval(async () => {
      const jobId = state?.job?.id
      if (!jobId) return
      const r = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' }).catch(() => null)
      if (!r || !r.ok) return
      const d = await r.json()
      const st = d?.job?.status
      if (st && st !== 'pending' && st !== 'processing') {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
        setBusy(null)
        await load()
      } else {
        setState((s) => (s ? { ...s, job: d.job } : s))
      }
    }, 3000)
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
  }, [state?.job, load])

  const post = async (url: string, body: object) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(d?.error || 'Запрос не выполнен')
    return d
  }

  const generateGrid = async () => {
    setErr(null); setBusy('grid')
    try { const d = await post('/api/ai/storyboard/grid', { episodeId }); setState((s) => (s ? { ...s, job: { id: d.jobId, status: 'processing', progress: 0 } } : s)) }
    catch (e: any) { setErr(e?.message ?? 'Ошибка'); setBusy(null) }
  }

  const approveGrid = async () => {
    setErr(null); setBusy('approve')
    try { const d = await post('/api/ai/storyboard/grid/approve', { episodeId }); setState((s) => (s ? { ...s, job: { id: d.jobId, status: 'processing', progress: 0 } } : s)) }
    catch (e: any) { setErr(e?.message ?? 'Ошибка'); setBusy(null) }
  }

  const generateAllVideos = async () => {
    setErr(null); setBusy('videos')
    try { await post('/api/ai/generate-episode-videos', { projectId, episodeId }); setVideosStarted(true) }
    catch (e: any) { setErr(e?.message ?? 'Ошибка') }
    finally { setBusy(null) }
  }

  if (loading) return <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Загрузка... / Loading...</div>

  const job = state?.job ?? null
  const jobRunning = active(job)
  const hasGrid = isHttp(state?.gridUrl)
  const approved = !!state?.gridApproved
  const slicedCount = (state?.panels ?? []).filter((p) => isHttp(p.startFrameUrl)).length

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6">
      <Link href={`/project/${projectId}/episode/${episodeId}`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> К эпизоду / Back to episode
      </Link>

      <div className="mb-5 flex items-center gap-2">
        <Grid3x3 className="h-6 w-6 text-primary" />
        <h1 className="font-display text-2xl font-bold">Сториборд-грид 5×5 / Storyboard grid 5×5</h1>
      </div>
      <p className="mb-6 text-sm text-muted-foreground">
        Единый лист из 25 панелей (5 рядов × 5 сцен) рисуется в GPT Image 2.0 по редактируемому промпту. После одобрения
        лист нарезается на 25 кадров — каждый становится стартовым кадром своей сцены.<br />
        One 25-panel sheet is rendered from an editable prompt; after approval it is sliced into 25 per-scene start frames.
      </p>

      {err && <p className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

      <div className="mb-6 flex flex-wrap gap-3">
        <button onClick={generateGrid} disabled={jobRunning || busy !== null}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">
          {busy === 'grid' || (jobRunning && !approved) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {hasGrid ? 'Перегенерировать грид / Regenerate grid' : 'Сгенерировать грид 5×5 / Generate 5×5 grid'}
        </button>

        <button onClick={() => setShowPrompt(true)} disabled={busy !== null}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-muted disabled:opacity-50">
          <FileText className="h-4 w-4" /> Промпт / View Prompt
        </button>

        <button onClick={approveGrid} disabled={!hasGrid || jobRunning || busy !== null}
          className="inline-flex items-center gap-2 rounded-lg border border-primary/50 bg-primary/10 px-4 py-2 text-sm font-semibold text-primary hover:bg-primary/20 disabled:opacity-50">
          {busy === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
          Одобрить и нарезать 25 кадров / Approve & slice 25 frames
        </button>

        {approved && (
          <button onClick={generateAllVideos} disabled={busy !== null || videosStarted}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-muted disabled:opacity-50">
            {busy === 'videos' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Video className="h-4 w-4" />}
            {videosStarted ? 'Генерация запущена / Generation started' : 'Сгенерировать все видео / Generate all videos'}
          </button>
        )}
      </div>

      {jobRunning && (
        <div className="mb-6 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
          <div className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> {job?.message || 'Обработка... / Processing...'}</div>
          {typeof job?.progress === 'number' && (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-border">
              <div className="h-full bg-primary transition-all" style={{ width: `${Math.max(5, job.progress)}%` }} />
            </div>
          )}
        </div>
      )}

      {hasGrid && (
        <div className="mb-8">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted-foreground">Лист сториборда / Storyboard sheet</h2>
            {approved && <span className="rounded bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">Одобрено · {slicedCount}/25 кадров</span>}
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={state!.gridUrl!} alt="Storyboard 5x5 grid" className="w-full rounded-lg border border-border" />
        </div>
      )}

      {slicedCount > 0 && (
        <div>
          <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Стартовые кадры сцен / Scene start frames</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 md:grid-cols-5">
            {(state?.panels ?? []).map((p) => (
              <div key={p.id} className="overflow-hidden rounded-lg border border-border">
                {isHttp(p.startFrameUrl) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.startFrameUrl!} alt={`Scene ${p.number}`} className="aspect-video w-full object-cover" />
                ) : (
                  <div className="flex aspect-video w-full items-center justify-center bg-muted text-xs text-muted-foreground">—</div>
                )}
                <div className="px-2 py-1 text-xs text-muted-foreground">Сцена {p.number}{p.gridPanelIndex ? ` · #${p.gridPanelIndex}` : ''}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showPrompt && (
        <PromptModal
          title="Промпт сториборда / Storyboard prompt"
          description="Редактируемый английский промпт для листа 5×5. Плейсхолдеры подставляются из данных проекта."
          endpoint={`/api/ai/storyboard/grid/prompt?episodeId=${episodeId}`}
          resetBody={{ prompt: '' }}
          alwaysShowReset
          testId="grid-prompt-modal"
          onClose={() => setShowPrompt(false)}
        />
      )}
    </div>
  )
}
