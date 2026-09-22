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

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Loader2, Film, Wand2, ImageIcon, Play, ChevronDown, ChevronRight, ChevronLeft, Copy, Check, X, Maximize2 } from 'lucide-react'
import { JobProgressBar, SmoothProgress, useJobPolling } from '../../_components/use-job-polling'
import { boardFramePrecondition } from '@/lib/board-anchor'
import { DownloadVideoButton } from '@/app/project/[id]/_components/download-video-button'

/** A reference image passed to a model, as persisted by the worker (label is already Russian). */
type BoardRef = { index: number; url: string; kind: string; label: string }

/** Stage 220 — the per-scene shot plan persisted on BOTH boards of a scene (Board.castInFrame). */
type CastInFrame = {
  onScreen?: string[]
  entering?: string[]
  exiting?: string[]
  startFrame?: string
  endFrame?: string
  motion?: string
  durationSec?: number
}

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
  // Stage 220 — per-scene model: scene grouping + role (start/end) + the scene's shot plan.
  // Nullable/absent on legacy boards, which keep rendering as a flat list.
  sceneId?: string | null
  boardRole?: string | null
  castInFrame?: CastInFrame | null
  // Group B — transparency fields (nullable; absent on legacy boards)
  imagePrompt?: string | null
  motionPromptEn?: string | null
  frameRefs?: BoardRef[] | null
  animateRefs?: BoardRef[] | null
  frameSeed?: number | null
}

/** Stage 174 — mirrors AssetReconciliation from lib/asset-gathering (per-kind ready/missing counts). */
type KindStatus = { ready: number; missing: number; total: number; missingIds: string[] }
type AssetReconciliation = {
  characters: KindStatus
  locations: KindStatus
  props: KindStatus
  blockingMissing: number
  totalMissing: number
}

function validUrl(u?: string | null): u is string {
  return typeof u === 'string' && /^https?:\/\//.test(u)
}

/**
 * Lightweight full-screen image lightbox, wired through context so any thumbnail (a rendered frame or a
 * reference image) can open itself without prop-drilling. `openImage(url)` is provided by StoryboardPanel.
 */
const LightboxContext = createContext<((url: string) => void) | null>(null)
function useLightbox() { return useContext(LightboxContext) }

/** The full-screen overlay: dark backdrop, centered object-contain image, close via backdrop / ✕ / Esc. */
function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр изображения"
      data-testid="storyboard-lightbox"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Закрыть"
        title="Закрыть (Esc)"
        className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20"
        data-testid="storyboard-lightbox-close"
      >
        <X className="h-5 w-5" />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt="Просмотр изображения"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] max-w-[95vw] object-contain"
      />
    </div>
  )
}

/** One asset-kind tile in the "Ассеты" panel: how many refs are ready from the library vs. still generating. */
function AssetKindStat({ title, k }: { title: string; k: KindStatus }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
        <div>Готово: <span className="font-semibold text-foreground">{k.ready}</span> из {k.total}</div>
        {k.missing > 0 && <div className="text-amber-600 dark:text-amber-400">Генерируется: {k.missing}</div>}
      </div>
    </div>
  )
}

/** Small copy-to-clipboard button with a transient "copied" tick. English prompt content is copied verbatim. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* clipboard unavailable */ }
      }}
      className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} {copied ? 'Скопировано' : 'Копировать'}
    </button>
  )
}

/** One labelled prompt block: Russian heading + copy button + the verbatim (English) prompt text. */
function PromptBlock({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-foreground">{title}</span>
        <CopyButton text={text} />
      </div>
      <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-[11px] leading-snug text-muted-foreground">{text}</p>
    </div>
  )
}

/** A labelled list of the reference images that were actually passed to a model. */
function RefList({ title, refs }: { title: string; refs: BoardRef[] }) {
  const openImage = useLightbox()
  return (
    <div>
      <span className="text-[11px] font-semibold text-foreground">{title}</span>
      <div className="mt-1 flex flex-wrap gap-2">
        {refs.map((r) => (
          <div key={`${r.index}-${r.url}`} className="w-16">
            <div className="flex aspect-[9/16] w-full items-center justify-center overflow-hidden rounded border border-border bg-black">
              {validUrl(r.url)
                ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={r.url}
                    alt={r.label}
                    onClick={openImage ? () => openImage(r.url) : undefined}
                    title={openImage ? 'Открыть во весь экран' : undefined}
                    className={`h-full w-full object-contain${openImage ? ' cursor-zoom-in' : ''}`}
                  />
                )
                : <ImageIcon className="h-4 w-4 opacity-40" />}
            </div>
            <p className="mt-0.5 text-center text-[9px] leading-tight text-muted-foreground">#{r.index} {r.label}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

/** One "who is in frame" line («В кадре» / «Входят» / «Выходят»); hidden when the name list is empty. */
function CastLine({ label, names }: { label: string; names?: string[] }) {
  if (!names || names.length === 0) return null
  return (
    <div className="text-[11px] leading-snug">
      <span className="font-semibold text-foreground">{label}:</span> <span className="text-muted-foreground">{names.join(', ')}</span>
    </div>
  )
}

/** One board card: keyframe still + action/dialogue text + per-board frame/animate controls. */
function BoardCard({ board, onChanged, frameLocked, registerFrameRun }: { board: Board; onChanged: () => void; frameLocked: boolean; registerFrameRun?: (fn: () => void) => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [showDetails, setShowDetails] = useState(false)
  const openImage = useLightbox()

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

  // Stage 220 — a scene's «Сгенерировать оба кадра» button fires the frame POST for BOTH boards concurrently
  // (start + end render in parallel). Each card registers its own frame runner with the parent scene group.
  useEffect(() => { registerFrameRun?.(() => { void run('frame') }) }, [registerFrameRun, run])

  // Per-scene role label; legacy boards keep the flat «Кадр N» heading. Duration (clip length) is a start-frame
  // concept — the end frame is a still keyframe and shows no duration.
  const isEnd = board.boardRole === 'end'
  const canAnimate = !isEnd
  const roleLabel = board.boardRole === 'start' ? 'Начальный кадр' : isEnd ? 'Последний кадр' : `Кадр ${board.index + 1}`
  const showDur = !isEnd && board.durationSec

  return (
    <div className="rounded-xl border border-border bg-card p-3" data-testid={`board-card-${board.index}`}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-muted-foreground">{roleLabel}{showDur ? ` · ${board.durationSec}s` : ''}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{board.status}</span>
      </div>
      {/* 9:16 portrait viewer: compact (bounded max width, centered) + object-contain letterbox so the
          still/clip is never cropped or stretched. A rendered frame opens full-screen in the lightbox. */}
      <div className="relative mx-auto flex aspect-[9/16] w-full max-w-[200px] items-center justify-center overflow-hidden rounded-lg bg-black">
        {validUrl(board.videoUrl) ? (
          <video src={board.videoUrl} controls playsInline className="h-full w-full object-contain" />
        ) : validUrl(board.imageUrl) ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={board.imageUrl}
              alt={`Board ${board.index + 1}`}
              onClick={openImage ? () => openImage(board.imageUrl!) : undefined}
              title={openImage ? 'Открыть во весь экран' : undefined}
              className={`h-full w-full object-contain${openImage ? ' cursor-zoom-in' : ''}`}
            />
            {openImage && (
              <button
                type="button"
                onClick={() => openImage(board.imageUrl!)}
                aria-label="Открыть во весь экран"
                title="Открыть во весь экран"
                className="absolute right-1.5 top-1.5 inline-flex h-7 w-7 items-center justify-center rounded-md bg-black/50 text-white transition hover:bg-black/70"
                data-testid={`board-expand-${board.index}`}
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
            )}
          </>
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
        {/* Stage 220 — only the START frame is animated (start→end i2v clip). The END frame is a still keyframe
            passed as the clip's last_image, so it exposes no animate control. */}
        {canAnimate && (
          <button onClick={() => run('animate')} disabled={busy || !validUrl(board.imageUrl)} title={!validUrl(board.imageUrl) ? 'Сначала сгенерируйте кадр' : 'Оживить сцену в клип (начальный → последний кадр)'} className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50" data-testid={`board-animate-${board.index}`}>
            {busy && animatePoll.isActive ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} {validUrl(board.videoUrl) ? 'Переанимировать' : 'Оживить сцену'}
          </button>
        )}
      </div>

      {/* B2/B3 — collapsible "frame details": the actual prompts and the actual reference images the models received.
          Prompt text is English (as sent to the providers); all headings/labels are Russian. */}
      {(() => {
        const framePrompt = (board.imagePrompt ?? '').trim()
        const animatePrompt = (board.motionPromptEn ?? board.motionEn ?? '').trim()
        const frameRefs = Array.isArray(board.frameRefs) ? board.frameRefs : []
        const animateRefs = Array.isArray(board.animateRefs) ? board.animateRefs : []
        const hasAny = framePrompt || animatePrompt || frameRefs.length || animateRefs.length || typeof board.frameSeed === 'number'
        if (!hasAny) return null
        return (
          <div className="mt-2 border-t border-border pt-2">
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              data-testid={`board-details-toggle-${board.index}`}
            >
              {showDetails ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} Детали кадра
            </button>
            {showDetails && (
              <div className="mt-2 space-y-3" data-testid={`board-details-${board.index}`}>
                {framePrompt && <PromptBlock title={validUrl(board.imageUrl) ? "Промпт кадра (image, англ.)" : "Промпт кадра — план (image, англ.)"} text={framePrompt} />}
                {animatePrompt && <PromptBlock title="Промпт оживления (i2v, англ.)" text={animatePrompt} />}
                {frameRefs.length > 0 && <RefList title="Референсы кадра (переданы в image-модель)" refs={frameRefs} />}
                {animateRefs.length > 0 && <RefList title="Референсы оживления (переданы в i2v)" refs={animateRefs} />}
                {typeof board.frameSeed === 'number' && (
                  <p className="text-[11px] text-muted-foreground">Seed кадра: <span className="font-mono text-foreground">{board.frameSeed}</span> <span className="opacity-70">(фиксирован для повторяемости; провайдер учитывает его приблизительно)</span></p>
                )}
              </div>
            )}
          </div>
        )
      })()}
    </div>
  )
}

/**
 * Stage 220 — one scene = exactly two boards (start frame + end frame) rendered in PARALLEL, plus one i2v clip
 * (start→end). The header shows «Сцена N», the scene duration and who is on-screen / entering / exiting, and a
 * single «Сгенерировать оба кадра» button that fires both frame POSTs concurrently. The end frame is a still
 * keyframe (the clip's last_image) and is never animated on its own.
 */
function SceneGroup({ sceneNumber, boards, onChanged, boardFrameLocked }: {
  sceneNumber: number
  boards: Board[]
  onChanged: () => void
  boardFrameLocked: (b: Board) => boolean
}) {
  const runners = useRef<Map<string, () => void>>(new Map())
  const register = useCallback((id: string) => (fn: () => void) => { runners.current.set(id, fn) }, [])
  const runBoth = useCallback(() => { runners.current.forEach((fn) => fn()) }, [])

  // Both boards of a scene carry the same shot plan (onScreen/entering/exiting/motion/duration).
  const plan = boards.find((b) => b.castInFrame)?.castInFrame ?? null
  const start = boards.find((b) => b.boardRole === 'start') ?? boards[0]
  const end = boards.find((b) => b.boardRole === 'end')
  const ordered = [start, ...(end ? [end] : boards.filter((b) => b !== start))].filter(Boolean) as Board[]
  const dur = plan?.durationSec ?? start?.durationSec ?? null
  // The whole scene is locked while the previous scene is still rendering (a not-yet-framed board is gated).
  const sceneLocked = ordered.some((b) => !validUrl(b.imageUrl) && boardFrameLocked(b))

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-3" data-testid={`scene-group-${sceneNumber}`}>
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">Сцена {sceneNumber}{dur ? ` · ${dur}s` : ''}</div>
          {plan && (
            <div className="mt-1 space-y-0.5">
              <CastLine label="В кадре" names={plan.onScreen} />
              <CastLine label="Входят" names={plan.entering} />
              <CastLine label="Выходят" names={plan.exiting} />
            </div>
          )}
        </div>
        <button
          onClick={runBoth}
          disabled={sceneLocked}
          title={sceneLocked ? 'Доступно, когда предыдущая сцена будет готова' : undefined}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-50"
          data-testid={`scene-frames-${sceneNumber}`}
        >
          <ImageIcon className="h-3.5 w-3.5" /> Сгенерировать оба кадра
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {ordered.map((b) => (
          <BoardCard
            key={b.id}
            board={b}
            onChanged={onChanged}
            frameLocked={boardFrameLocked(b)}
            registerFrameRun={register(b.id)}
          />
        ))}
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
  const [assets, setAssets] = useState<AssetReconciliation | null>(null)
  const [boardGate, setBoardGate] = useState<string | null>(null)
  // Stage 230 — per-scene UI: one scene per page with a pager («‹ Сцена N из M ›»).
  const [scenePage, setScenePage] = useState(0)
  // Full-screen preview target (a rendered frame or a reference image); null = lightbox closed.
  const [lightbox, setLightbox] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/ai/storyboard/boards?episodeId=${encodeURIComponent(episodeId)}`, { cache: 'no-store' })
      const data = await res.json()
      if (res.ok) {
        setBoards(data.boards ?? [])
        if (validUrl(data.videoUrl)) setVideoUrl(data.videoUrl)
        setAssets(data.assets ?? null)
        setBoardGate(data.boardGate ?? null)
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

  // Stage 174 — while the episode is parked at the asset gate, re-poll every 5s so the panel tracks
  // generation and picks up the auto-started split (kicked off by the advance-chains cron) as soon as the
  // refs are ready. The interval clears itself once the gate lifts (boardGate → null / a split job appears).
  const gathering = boardGate === 'assets'
  useEffect(() => {
    if (!gathering) return
    const t = setInterval(() => { refresh() }, 5000)
    return () => clearInterval(t)
  }, [gathering, refresh])

  const startSplit = useCallback(async () => {
    setSplitting(true); setError(null)
    try {
      const res = await fetch('/api/ai/storyboard/boards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, episodeId }) })
      const data = await res.json()
      if (!res.ok) {
        setSplitting(false)
        if (data?.assets) setAssets(data.assets) // e.g. 402: show what still needs generating
        setError(data?.error ?? 'Не удалось запустить разбиение')
        return
      }
      // Stage 174 — asset gate engaged: refs are being generated, the split is deferred. The advance-chains
      // cron will start the split automatically once everything is ready. Enter the "gathering" state and let
      // the poll effect below track progress; no split job to poll yet.
      if (data.gated) {
        setSplitting(false)
        setBoardGate('assets')
        if (data.assets) setAssets(data.assets)
        return
      }
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

  // Stage 220 — per-scene model: a scene = 2 boards (start + end); only the START frame becomes a clip (start→end
  // i2v), the END frame is a still keyframe. So "animated" is counted over clip boards only (boardRole !== 'end').
  const perScene = boards.some((b) => !!b.boardRole)
  const clipBoards = boards.filter((b) => b.boardRole !== 'end')
  const allAnimated = clipBoards.length > 0 && clipBoards.every((b) => validUrl(b.videoUrl))
  const framedCount = boards.filter((b) => validUrl(b.imageUrl)).length
  const animatedCount = clipBoards.filter((b) => validUrl(b.videoUrl)).length

  // Group boards into scenes, preserving index order (start idx=2i precedes end idx=2i+1). Legacy boards with a
  // null sceneId each become their own singleton group so they still render.
  const sceneGroups = (() => {
    const groups: { key: string; boards: Board[] }[] = []
    const byKey = new Map<string, number>()
    for (const b of [...boards].sort((a, z) => a.index - z.index)) {
      const key = b.sceneId ?? `__legacy__${b.id}`
      if (!byKey.has(key)) { byKey.set(key, groups.length); groups.push({ key, boards: [] }) }
      groups[byKey.get(key)!].boards.push(b)
    }
    return groups
  })()

  // Keep the active scene page within bounds when the number of scenes changes (rebuild / first load).
  useEffect(() => {
    setScenePage((p) => Math.min(Math.max(0, p), Math.max(0, sceneGroups.length - 1)))
  }, [sceneGroups.length])

  const frameLockedFor = (b: Board) =>
    !boardFramePrecondition(
      { index: b.index, imageUrl: b.imageUrl, boardRole: b.boardRole, sceneId: b.sceneId },
      boards.map((s) => ({ index: s.index, imageUrl: s.imageUrl, sceneId: s.sceneId })),
    ).allowed

  return (
    <LightboxContext.Provider value={setLightbox}>
    <div className="mt-4" data-testid="storyboard-panel">
      {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(null)} />}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
        <button onClick={startSplit} disabled={splitting || gathering} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="storyboard-generate-boards">
          {splitting || gathering ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} {gathering ? 'Сбор ассетов…' : boards.length ? 'Перестроить кадры' : 'Разбить историю на кадры'}
        </button>
        <button onClick={startAssemble} disabled={!allAnimated || stitching} title={allAnimated ? 'Склеить клипы кадров в один ролик' : 'Доступно, когда все кадры оживлены'} className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50" data-testid="storyboard-assemble">
          {stitching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />} Собрать ролик (~90с)
        </button>
        <span className="text-xs text-muted-foreground" data-testid="storyboard-status">
          {perScene
            ? `${sceneGroups.length} сцен · ${framedCount} из ${boards.length} кадров · ${animatedCount} из ${clipBoards.length} сцен оживлено`
            : `${boards.length} кадров · ${framedCount} с кадром · ${animatedCount} оживлено`}{videoUrl ? ' · ролик собран' : ''}
        </span>
        {splitting && splitPoll.job && <div className="w-full"><JobProgressBar job={splitPoll.job} expectedTotalSec={40} /></div>}
        {stitching && stitchPoll.job && <div className="w-full"><JobProgressBar job={stitchPoll.job} expectedTotalSec={180} /></div>}
        {error && <p className="w-full text-sm text-destructive" data-testid="storyboard-error">{error}</p>}
      </div>

      {/* Stage 174 — «Ассеты»: the references the boards need (characters + locations + props), reconciled
          against the library. Anything missing is generated automatically before the split; the split starts
          on its own once everything is ready (the tab may be closed). */}
      {assets && (assets.characters.total + assets.locations.total + assets.props.total > 0) && (
        <div className="mt-4 rounded-xl border border-border bg-card p-4" data-testid="storyboard-assets">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <h2 className="inline-flex items-center gap-1 font-semibold"><ImageIcon className="h-4 w-4" /> Ассеты</h2>
            {gathering && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" data-testid="storyboard-assets-gathering">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Ассеты генерируются…
              </span>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <AssetKindStat title="Персонажи" k={assets.characters} />
            <AssetKindStat title="Локации" k={assets.locations} />
            <AssetKindStat title="Предметы" k={assets.props} />
          </div>
          {gathering && (
            <p className="mt-3 text-xs text-muted-foreground">
              Недостающие референсы генерируются автоматически. Разбивка истории на кадры начнётся сама, как только все персонажи и локации будут готовы — это окно можно закрыть.
            </p>
          )}
        </div>
      )}

      {validUrl(videoUrl) && (
        <div className="mt-4 rounded-xl border border-border bg-card p-4" data-testid="storyboard-video">
          <h2 className="mb-2 inline-flex items-center gap-1 font-semibold"><Film className="h-4 w-4" /> Собранный ролик</h2>
          {/* Vertical 9:16 player: fixed portrait aspect, object-contain (never stretched/cropped or
              auto-fullscreen), height bounded by the viewport, centered with black letterbox on the sides. */}
          <div className="mx-auto flex aspect-[9/16] max-h-[80vh] w-full max-w-sm items-center justify-center overflow-hidden rounded-lg bg-black">
            <video src={videoUrl} controls playsInline className="h-full w-full object-contain" />
          </div>
          <div className="mt-2"><DownloadVideoButton videoUrl={videoUrl} fileStem="storyboard" label="Скачать mp4" /></div>
        </div>
      )}

      {loading ? (
        <p className="mt-6 text-sm text-muted-foreground"><Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> Загрузка кадров…</p>
      ) : boards.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">Кадров пока нет. Нажмите «Разбить историю на кадры», чтобы сгенерировать раскадровку из готовой истории.</p>
      ) : perScene ? (
        // Per-scene layout: ONE scene per page with a pager. Each scene has a start frame + end frame that
        // render in parallel; scenes themselves are generated strictly in order (previous scene must finish).
        <div className="mt-6 space-y-4" data-testid="storyboard-boards">
          {(() => {
            const page = Math.min(Math.max(0, scenePage), Math.max(0, sceneGroups.length - 1))
            const g = sceneGroups[page]
            if (!g) return null
            return (
              <>
                <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2" data-testid="storyboard-scene-pager">
                  <button
                    onClick={() => setScenePage((p) => Math.max(0, p - 1))}
                    disabled={page <= 0}
                    className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm font-medium disabled:opacity-40"
                    data-testid="storyboard-scene-prev"
                    aria-label="Предыдущая сцена"
                  >
                    <ChevronLeft className="h-4 w-4" /> Назад
                  </button>
                  <div className="text-sm font-semibold text-foreground" data-testid="storyboard-scene-indicator">
                    Сцена {page + 1} из {sceneGroups.length}
                  </div>
                  <button
                    onClick={() => setScenePage((p) => Math.min(sceneGroups.length - 1, p + 1))}
                    disabled={page >= sceneGroups.length - 1}
                    className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm font-medium disabled:opacity-40"
                    data-testid="storyboard-scene-next"
                    aria-label="Следующая сцена"
                  >
                    Далее <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
                <SceneGroup
                  key={g.key}
                  sceneNumber={page + 1}
                  boards={g.boards}
                  onChanged={refresh}
                  boardFrameLocked={frameLockedFor}
                />
              </>
            )
          })()}
        </div>
      ) : (
        // Legacy flat layout for episodes built before the per-scene model.
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4" data-testid="storyboard-boards">
          {boards.map((b) => (
            <BoardCard
              key={b.id}
              board={b}
              onChanged={refresh}
              frameLocked={frameLockedFor(b)}
            />
          ))}
        </div>
      )}
    </div>
    </LightboxContext.Provider>
  )
}
