'use client'

/**
 * Stage 127 — Storyboard production mode UI.
 *
 * Rendered inside the episode "scenes" phase ONLY when Episode.mode === 'STORYBOARD'. It is fully
 * self-contained: it splits the (already built) story into 12–15 boards, renders one 9:16 keyframe per
 * board, animates each keyframe into a 4–6s clip via image-to-video, and stitches the ~90s cut.
 *
 * This is the only place where the keyframe/image-to-video ban is lifted — the Scenes flow (in
 * episode-view.tsx) is untouched and keeps its text-to-video / no-start-frame rules.
 */

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Film, Wand2, ImageIcon, Play, Download } from 'lucide-react'
import { JobProgressBar, SmoothProgress, useJobPolling } from '../../_components/use-job-polling'
import { boardFramePrecondition } from '@/lib/board-anchor'

type Board = {
  id: string
  index: number
  actionOrDialogue: string
  motionEn?: string | null
  imageUrl?: string | null
  videoUrl?: string | null
  durationSec?: number | null
  status: string
  error?: string | null
}

function validUrl(u?: string | null): u is string {
  return typeof u === 'string' && /^https?:\/\//.test(u)
}

/** One board card: keyframe still + action/dialogue text + per-board frame/animate controls. */
function BoardCard({ board, onChanged, frameLocked }: { board: Board; onChanged: () => void; frameLocked: boolean }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const framePoll = useJobPolling({
    onFinish: (res) => { setBusy(false); if (res.job.status === 'failed') setErr(res.job.error ?? 'Frame generation failed'); onChanged() },
  })
  const animatePoll = useJobPolling({
    onFinish: (res) => { setBusy(false); if (res.job.status === 'failed') setErr(res.job.error ?? 'Animation failed'); onChanged() },
  })

  const run = useCallback(async (kind: 'frame' | 'animate') => {
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`/api/ai/storyboard/${board.id}/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const data = await res.json()
      if (!res.ok) { setBusy(false); setErr(data?.error ?? 'Request failed'); return }
      if (data.jobId) { (kind === 'frame' ? framePoll : animatePoll).start(data.jobId) }
      else { setBusy(false); onChanged() }
    } catch (e: any) {
      setBusy(false); setErr(e?.message ?? 'Request failed')
    }
  }, [board.id, framePoll, animatePoll, onChanged])

  return (
    <div className="rounded-xl border border-border bg-card p-3" data-testid={`board-card-${board.index}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground">Кадр {board.index + 1}{board.durationSec ? ` · ${board.durationSec}s` : ''}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{board.status}</span>
      </div>
      {/* 9:16 portrait viewer: object-contain + letterbox so the still/clip is never cropped or stretched. */}
      <div className="flex aspect-[9/16] w-full items-center justify-center overflow-hidden rounded-lg bg-black">
        {validUrl(board.videoUrl) ? (
          <video src={board.videoUrl} controls playsInline className="h-full w-full object-contain" />
        ) : validUrl(board.imageUrl) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={board.imageUrl} alt={`Board ${board.index + 1}`} className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground"><ImageIcon className="h-8 w-8 opacity-40" /></div>
        )}
      </div>
      <p className="mt-2 line-clamp-4 text-sm">{board.actionOrDialogue}</p>
      {/* Frame generation keeps the raw job progress bar. */}
      {framePoll.isActive && framePoll.job && <div className="mt-2"><JobProgressBar job={framePoll.job} expectedTotalSec={90} /></div>}
      {/* Feature: image-to-video (i2v) animation shows a monotonic 0–100% bar with an elapsed counter.
          Seedance emits no per-frame percent, so SmoothProgress eases the coarse time-based server
          checkpoints upward and always displays a rising numeric percentage while the clip renders. */}
      {animatePoll.isActive && animatePoll.job && <div className="mt-2"><SmoothProgress job={animatePoll.job} expectedTotalSec={60} /></div>}
      {err && <p className="mt-1 text-xs text-destructive">{err}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {/* Stage 145 — strictly sequential: the frame button is disabled until the previous board's
            frame is ready (regenerating an already-framed board stays enabled). English tooltip. */}
        <button onClick={() => run('frame')} disabled={busy || frameLocked} title={frameLocked ? 'Generate the previous shot first' : undefined} className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50" data-testid={`board-frame-${board.index}`}>
          {busy && framePoll.isActive ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImageIcon className="h-3.5 w-3.5" />} {validUrl(board.imageUrl) ? 'Перерисовать кадр' : 'Сгенерировать кадр'}
        </button>
        <button onClick={() => run('animate')} disabled={busy || !validUrl(board.imageUrl)} title={!validUrl(board.imageUrl) ? 'Сначала сгенерируйте кадр' : 'Оживить кадр в клип'} className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50" data-testid={`board-animate-${board.index}`}>
          {busy && animatePoll.isActive ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} {validUrl(board.videoUrl) ? 'Переанимировать' : 'Оживить'}
        </button>
      </div>
    </div>
  )
}

export function StoryboardPanel({ projectId, episodeId, initialVideoUrl }: { projectId: string; episodeId: string; initialVideoUrl?: string | null }) {
  const [boards, setBoards] = useState<Board[]>([])
  const [videoUrl, setVideoUrl] = useState<string | null>(initialVideoUrl ?? null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [splitting, setSplitting] = useState(false)
  const [stitching, setStitching] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/ai/storyboard/boards?episodeId=${encodeURIComponent(episodeId)}`, { cache: 'no-store' })
      const data = await res.json()
      if (res.ok) {
        setBoards(data.boards ?? [])
        if (validUrl(data.videoUrl)) setVideoUrl(data.videoUrl)
        // resume an in-flight split job
        if (data.job && (data.job.status === 'pending' || data.job.status === 'processing')) {
          setSplitting(true); splitPoll.start(data.job.id)
        }
      }
    } catch { /* ignore transient */ }
    finally { setLoading(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episodeId])

  const splitPoll = useJobPolling({
    onFinish: (res) => { setSplitting(false); if (res.job.status === 'failed') setError(res.job.error ?? 'Не удалось разбить историю на кадры'); refresh() },
  })
  const stitchPoll = useJobPolling({
    onFinish: (res) => {
      setStitching(false)
      if (res.job.status === 'failed') setError(res.job.error ?? 'Не удалось собрать ролик')
      else if (validUrl(res.job.result?.videoUrl)) setVideoUrl(res.job.result.videoUrl)
      refresh()
    },
  })

  useEffect(() => { refresh() }, [refresh])

  const startSplit = useCallback(async () => {
    setSplitting(true); setError(null)
    try {
      const res = await fetch('/api/ai/storyboard/boards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, episodeId }) })
      const data = await res.json()
      if (!res.ok) { setSplitting(false); setError(data?.error ?? 'Не удалось запустить разбиение'); return }
      if (data.jobId) splitPoll.start(data.jobId)
      else { setSplitting(false); refresh() }
    } catch (e: any) { setSplitting(false); setError(e?.message ?? 'Ошибка запроса') }
  }, [projectId, episodeId, splitPoll, refresh])

  const startAssemble = useCallback(async () => {
    setStitching(true); setError(null)
    try {
      const res = await fetch('/api/ai/storyboard/assemble', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ episodeId }) })
      const data = await res.json()
      if (!res.ok) { setStitching(false); setError(data?.error ?? 'Не удалось запустить сборку'); return }
      if (data.jobId) stitchPoll.start(data.jobId)
      else setStitching(false)
    } catch (e: any) { setStitching(false); setError(e?.message ?? 'Ошибка запроса') }
  }, [episodeId, stitchPoll])

  const allAnimated = boards.length > 0 && boards.every((b) => validUrl(b.videoUrl))
  const framedCount = boards.filter((b) => validUrl(b.imageUrl)).length
  const animatedCount = boards.filter((b) => validUrl(b.videoUrl)).length

  return (
    <div className="mt-4" data-testid="storyboard-panel">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
        <button onClick={startSplit} disabled={splitting} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="storyboard-generate-boards">
          {splitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} {boards.length ? 'Перестроить кадры' : 'Разбить историю на кадры'}
        </button>
        <button onClick={startAssemble} disabled={!allAnimated || stitching} title={allAnimated ? 'Склеить клипы кадров в один ролик' : 'Доступно, когда все кадры оживлены'} className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50" data-testid="storyboard-assemble">
          {stitching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />} Собрать ролик (~90с)
        </button>
        <span className="text-xs text-muted-foreground" data-testid="storyboard-status">
          {boards.length} кадров · {framedCount} с кадром · {animatedCount} оживлено{videoUrl ? ' · ролик собран' : ''}
        </span>
        {splitting && splitPoll.job && <div className="w-full"><JobProgressBar job={splitPoll.job} expectedTotalSec={40} /></div>}
        {stitching && stitchPoll.job && <div className="w-full"><JobProgressBar job={stitchPoll.job} expectedTotalSec={180} /></div>}
        <p className="w-full text-xs text-muted-foreground">
          Режим «Сториборд»: история делится на 12–15 кадров (один кадр = одно действие или пара реплик). Каждый кадр — референс-изображение 9:16, которое оживляется в клип 4–6с через image-to-video (кадр = стартовый фрейм). Клипы склеиваются в единый ролик ~90с с одной музыкальной дорожкой.
        </p>
        {error && <p className="w-full text-sm text-destructive" data-testid="storyboard-error">{error}</p>}
      </div>

      {validUrl(videoUrl) && (
        <div className="mt-4 rounded-xl border border-border bg-card p-4" data-testid="storyboard-video">
          <h2 className="mb-2 inline-flex items-center gap-1 font-semibold"><Film className="h-4 w-4" /> Собранный ролик</h2>
          {/* Vertical 9:16 player: fixed portrait aspect, object-contain (never stretched/cropped or
              auto-fullscreen), height bounded by the viewport, centered with black letterbox on the sides. */}
          <div className="mx-auto flex aspect-[9/16] max-h-[80vh] w-full max-w-sm items-center justify-center overflow-hidden rounded-lg bg-black">
            <video src={videoUrl} controls playsInline className="h-full w-full object-contain" />
          </div>
          <div className="mt-2"><a href={videoUrl} download className="inline-flex items-center gap-1 text-sm text-primary"><Download className="h-4 w-4" /> Скачать mp4</a></div>
        </div>
      )}

      {loading ? (
        <p className="mt-6 text-sm text-muted-foreground"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> Загрузка кадров…</p>
      ) : boards.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">Кадров пока нет. Нажмите «Разбить историю на кадры», чтобы сгенерировать раскадровку из готовой истории.</p>
      ) : (
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4" data-testid="storyboard-boards">
          {boards.map((b) => (
            <BoardCard
              key={b.id}
              board={b}
              onChanged={refresh}
              frameLocked={!boardFramePrecondition({ index: b.index, imageUrl: b.imageUrl }, boards.map((s) => ({ index: s.index, imageUrl: s.imageUrl }))).allowed}
            />
          ))}
        </div>
      )}
    </div>
  )
}
