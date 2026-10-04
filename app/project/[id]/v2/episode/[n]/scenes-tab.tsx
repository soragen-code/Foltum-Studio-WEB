'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Eye, Play, AlertTriangle, Film, Download, RotateCcw, RefreshCw, X, ChevronLeft, ChevronRight } from 'lucide-react'
import type { EpisodeFinalV2, EpisodeSceneV2 } from '@/lib/idea-v2'
import { useTranslation } from '@/lib/i18n/context'
import { ScenePromptModal, type ScenePromptRef, type ScenePromptScene } from './scene-prompt-modal'

/**
 * Поток v2 · вкладка «Сцены» серии n.
 * После «Утвердить сториборд» воркер нарезает первые кадры 9:16 (по одному на шот) → сетка карточек.
 * «Запустить все сцены» → Seedance i2v по каждой сцене с первым кадром. Поллинг GET /api/ai/v2/scenes.
 */
const API = '/api/ai/v2/scenes'
const POLL_MS = 3000

type SceneRow = EpisodeSceneV2 & { autoPrompt?: string; videoPrompt?: string; videoRefs?: ScenePromptRef[] }
type JobLite = { id: string; status: string; error?: string | null } | null
type ScenesData = { scenes: SceneRow[]; refs: ScenePromptRef[]; storyboardUrl: string | null; approved: boolean; framesJob: JobLite; videoJob: JobLite; assembleJob: JobLite; final: EpisodeFinalV2 | null; allVideosReady: boolean }

const jobActive = (j: JobLite) => !!j && (j.status === 'pending' || j.status === 'processing')
const busy = (s?: string) => s === 'pending' || s === 'running'

export function ScenesTab({ projectId, n, initialScenes = [], initialApproved = false }: {
  projectId: string; n: number; initialScenes?: EpisodeSceneV2[]; initialApproved?: boolean
}) {
  const { t } = useTranslation()
  const [data, setData] = useState<ScenesData>({ scenes: initialScenes, refs: [], storyboardUrl: null, approved: initialApproved, framesJob: null, videoJob: null, assembleJob: null, final: null, allVideosReady: false })
  const [loaded, setLoaded] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [assembleBusy, setAssembleBusy] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuilt, setRebuilt] = useState<{ rebuilt: number; total: number } | null>(null)
  const [error, setError] = useState('')
  const [promptFor, setPromptFor] = useState<string | null>(null)
  // Лайтбокс-слайдшоу по первым кадрам: индекс в withFrame или null.
  const [lightbox, setLightbox] = useState<number | null>(null)
  const [touchX, setTouchX] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}?projectId=${projectId}&episode=${n}`, { cache: 'no-store' })
      if (!res.ok) return
      const d = await res.json().catch(() => null)
      if (!d || !Array.isArray(d.scenes)) return
      setData({
        scenes: d.scenes, refs: Array.isArray(d.refs) ? d.refs : [], storyboardUrl: d.storyboardUrl ?? null,
        approved: !!d.approved, framesJob: d.framesJob ?? null, videoJob: d.videoJob ?? null,
        assembleJob: d.assembleJob ?? null, final: d.final ?? null, allVideosReady: !!d.allVideosReady,
      })
    } catch { /* транзиентно, следующий тик повторит */ }
    finally { setLoaded(true) }
  }, [projectId, n])

  useEffect(() => { void load() }, [load])

  const { scenes, framesJob, videoJob, assembleJob, final } = data
  const cutting = jobActive(framesJob) || scenes.some((s) => busy(s.firstFrameStatus))
  const videoRunning = jobActive(videoJob) || scenes.some((s) => busy(s.videoStatus))
  const assembling = jobActive(assembleJob) || busy(final?.status)
  const polling = cutting || videoRunning || launching || assembling || assembleBusy

  useEffect(() => {
    if (!polling) return
    const id = setInterval(() => { void load() }, POLL_MS)
    return () => clearInterval(id)
  }, [polling, load])

  const withFrame = scenes.filter((s) => s.firstFrameUrl)
  const lbCount = withFrame.length
  const lbScene = lightbox !== null ? withFrame[lightbox] : null
  const lbPrev = useCallback(() => setLightbox((i) => (i === null ? null : Math.max(0, i - 1))), [])
  const lbNext = useCallback(() => setLightbox((i) => (i === null ? null : Math.min(lbCount - 1, i + 1))), [lbCount])

  useEffect(() => {
    if (lightbox === null) return
    if (lightbox >= lbCount) { setLightbox(lbCount ? lbCount - 1 : null); return }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null)
      else if (e.key === 'ArrowLeft') lbPrev()
      else if (e.key === 'ArrowRight') lbNext()
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prevOverflow }
  }, [lightbox, lbCount, lbPrev, lbNext])
  const videosDone = scenes.filter((s) => s.videoUrl && s.videoStatus === 'done').length

  const launchAll = async () => {
    setLaunching(true); setError('')
    try {
      const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, episode: n, action: 'launch-all' }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) setError(d?.error ?? t('ideaV2.scenesError'))
      await load()
    } catch { setError(t('ideaV2.shotsNetworkError')) }
    finally { setLaunching(false) }
  }

  const assemble = async () => {
    setAssembleBusy(true); setError('')
    try {
      const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, episode: n, action: 'assemble' }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) setError(d?.error ?? t('ideaV2.scenesError'))
      await load()
    } catch { setError(t('ideaV2.shotsNetworkError')) }
    finally { setAssembleBusy(false) }
  }
  const rebuildPrompts = async () => {
    setRebuilding(true); setError(''); setRebuilt(null)
    try {
      const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, episode: n, action: 'rebuild-prompts' }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) setError(d?.error ?? t('ideaV2.scenesError'))
      else setRebuilt({ rebuilt: Number(d?.rebuilt ?? 0), total: Number(d?.total ?? 0) })
      await load()
    } catch { setError(t('ideaV2.shotsNetworkError')) }
    finally { setRebuilding(false) }
  }
  const canAssemble = data.allVideosReady && !videoRunning && !cutting
  const finalReady = !!final?.videoUrl && final.status === 'done'

  const btnPrimary = 'flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50'
  const btnV1 = 'flex items-center gap-1 rounded-lg bg-muted px-3 py-1.5 text-xs transition hover:bg-muted/80 disabled:opacity-50'

  if (!data.approved && !scenes.length) {
    return (
      <div data-testid="episode-v2-scenes-empty">
        {!loaded ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : <p className="text-sm text-muted-foreground">{t('ideaV2.scenesEmpty')}</p>}
      </div>
    )
  }

  const promptScene = promptFor ? scenes.find((s) => s.id === promptFor) : null
  const modalScene: ScenePromptScene | null = promptScene ? {
    id: promptScene.id, index: promptScene.index, action: promptScene.action, endFrame: promptScene.endFrame, promptOverride: promptScene.promptOverride,
    autoPrompt: promptScene.autoPrompt ?? '', videoPrompt: promptScene.videoPrompt ?? promptScene.action,
    firstFrameUrl: promptScene.firstFrameUrl ?? null,
  } : null

  return (
    <div data-testid="episode-v2-scenes">
      <p className="text-sm text-muted-foreground">{t('ideaV2.scenesIntro')}</p>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1 text-xs text-muted-foreground">
          {cutting && <p className="inline-flex items-center gap-2" data-testid="episode-v2-scenes-cutting"><Loader2 className="h-3 w-3 animate-spin text-primary" /> {t('ideaV2.scenesCutting')}</p>}
          {scenes.length > 0 && (
            <p data-testid="episode-v2-scenes-progress">
              {t('ideaV2.scenesVideosProgress', { done: videosDone, total: scenes.length })}
              {videoRunning && <span className="ml-2 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin text-primary" /> {t('ideaV2.scenesVideoRunning')}</span>}
            </p>
          )}
          {!cutting && scenes.length > 0 && !withFrame.length && <p className="text-amber-500">{t('ideaV2.scenesNoFrames')}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void rebuildPrompts()}
            disabled={rebuilding || cutting || videoRunning || !scenes.length}
            title={t('ideaV2.rebuildPromptsHint')}
            className="flex items-center gap-2 rounded-lg bg-muted px-4 py-2.5 text-sm transition hover:bg-muted/80 disabled:opacity-50"
            data-testid="episode-v2-scenes-rebuild-prompts"
          >
            {rebuilding ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} {t('ideaV2.rebuildPrompts')}
          </button>
          <button onClick={() => void launchAll()} disabled={launching || cutting || videoRunning || !withFrame.length} className={btnPrimary} data-testid="episode-v2-scenes-launch-all">
            {launching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} {t('ideaV2.launchAllScenes')}
          </button>
        </div>
      </div>
      {rebuilt && !rebuilding && <p className="mt-2 text-xs text-muted-foreground" data-testid="episode-v2-scenes-rebuilt">{t('ideaV2.rebuildPromptsDone', { rebuilt: rebuilt.rebuilt, total: rebuilt.total })}</p>}

      {scenes.length > 0 && (
        <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3" data-testid="episode-v2-assemble">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 text-xs text-muted-foreground">
              {assembling ? (
                <p className="inline-flex items-center gap-2" data-testid="episode-v2-assembling"><Loader2 className="h-3 w-3 animate-spin text-primary" /> {t('ideaV2.assembling')}</p>
              ) : finalReady ? (
                <p className="font-semibold text-foreground">{t('ideaV2.finalReady')}</p>
              ) : !canAssemble ? (
                <p>{t('ideaV2.assembleNeedAllVideos')}</p>
              ) : null}
              {!assembling && final?.status === 'error' && final.error && <p className="mt-1 text-destructive" title={final.error}>{final.error}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {finalReady && !assembling && (
                <a href={final!.videoUrl} download target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-lg bg-muted px-4 py-2.5 text-sm transition hover:bg-muted/80" data-testid="episode-v2-final-download">
                  <Download className="h-4 w-4" /> {t('ideaV2.download')}
                </a>
              )}
              <button
                onClick={() => void assemble()}
                disabled={!canAssemble || assembling || assembleBusy}
                title={!canAssemble ? t('ideaV2.assembleNeedAllVideos') : undefined}
                className={btnPrimary}
                data-testid="episode-v2-assemble-btn"
              >
                {assembling || assembleBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : finalReady ? <RotateCcw className="h-4 w-4" /> : <Film className="h-4 w-4" />}
                {finalReady ? t('ideaV2.reassemble') : t('ideaV2.assembleEpisode')}
              </button>
            </div>
          </div>
          {finalReady && !assembling && (
            <video key={final!.videoUrl} src={final!.videoUrl} controls playsInline className="mx-auto mt-3 aspect-[9/16] max-h-[70vh] rounded-lg bg-black" data-testid="episode-v2-final-video" />
          )}
        </div>
      )}
      {error && <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="episode-v2-scenes-error">{error}</div>}
      {framesJob?.status === 'failed' && framesJob.error && <p className="mt-3 text-xs text-destructive">{framesJob.error}</p>}

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="episode-v2-scenes-grid">
        {scenes.map((s) => (
          <div key={s.id} className="flex flex-col overflow-hidden rounded-lg border border-border bg-background" data-testid={`episode-v2-scene-${s.index}`}>
            <div className="relative aspect-[9/16] w-full bg-muted">
              {s.videoUrl ? (
                <video src={s.videoUrl} poster={s.firstFrameUrl} controls playsInline className="h-full w-full object-cover" data-testid={`episode-v2-scene-video-${s.index}`} />
              ) : s.firstFrameUrl ? (
                <button
                  type="button"
                  onClick={() => { const i = withFrame.findIndex((w) => w.id === s.id); if (i >= 0) setLightbox(i) }}
                  className="block h-full w-full cursor-zoom-in"
                  title={t('ideaV2.scenesLightboxOpen')}
                  data-testid={`episode-v2-scene-frame-${s.index}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.firstFrameUrl} alt={t('ideaV2.scenesScene', { n: s.index })} className="h-full w-full object-cover" />
                </button>
              ) : null}
              {(busy(s.firstFrameStatus) || (!s.videoUrl && busy(s.videoStatus))) && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/40"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
              )}
              {s.firstFrameStatus === 'error' && !s.firstFrameUrl && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-2 text-center text-[11px] text-destructive">
                  <AlertTriangle className="h-4 w-4" /> {t('ideaV2.scenesFrameError')}
                </div>
              )}
            </div>
            <div className="flex flex-1 flex-col gap-1.5 p-2">
              <p className="text-xs font-semibold text-foreground">{t('ideaV2.scenesScene', { n: s.index })}</p>
              <p className="line-clamp-3 text-[11px] text-muted-foreground" title={s.action}>{s.action}</p>
              {s.endFrame && <p className="line-clamp-2 text-[11px] text-muted-foreground/70" title={s.endFrame}>→ {s.endFrame}</p>}
              {s.firstFrameStatus === 'error' && s.firstFrameError && <p className="line-clamp-2 text-[11px] text-destructive" title={s.firstFrameError}>{s.firstFrameError}</p>}
              {s.videoStatus === 'error' && <p className="line-clamp-2 text-[11px] text-destructive" title={s.videoError}>{t('ideaV2.scenesVideoError')}{s.videoError ? `: ${s.videoError}` : ''}</p>}
              <div className="mt-auto pt-1">
                <button onClick={() => setPromptFor(s.id)} disabled={!s.autoPrompt} className={btnV1} data-testid={`episode-v2-scene-prompt-${s.index}`}>
                  <Eye className="h-3.5 w-3.5" /> {t('ideaV2.scenesPromptTitle')}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {lbScene && lightbox !== null && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90"
          onClick={() => setLightbox(null)}
          onTouchStart={(e) => setTouchX(e.touches[0]?.clientX ?? null)}
          onTouchEnd={(e) => {
            const x0 = touchX; setTouchX(null)
            const x1 = e.changedTouches[0]?.clientX
            if (x0 === null || x1 === undefined) return
            const dx = x1 - x0
            if (dx > 50) lbPrev(); else if (dx < -50) lbNext()
          }}
          role="dialog"
          aria-modal="true"
          data-testid="episode-v2-scenes-lightbox"
        >
          <button type="button" onClick={() => setLightbox(null)} className="absolute right-3 top-3 z-10 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" aria-label={t('common.close')} data-testid="episode-v2-scenes-lightbox-close">
            <X className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); lbPrev() }}
            disabled={lightbox <= 0}
            className="absolute left-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 disabled:opacity-20 disabled:hover:bg-white/10 sm:left-4"
            aria-label={t('ideaV2.scenesLightboxPrev')}
            data-testid="episode-v2-scenes-lightbox-prev"
          >
            <ChevronLeft className="h-7 w-7" />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); lbNext() }}
            disabled={lightbox >= lbCount - 1}
            className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 disabled:opacity-20 disabled:hover:bg-white/10 sm:right-4"
            aria-label={t('ideaV2.scenesLightboxNext')}
            data-testid="episode-v2-scenes-lightbox-next"
          >
            <ChevronRight className="h-7 w-7" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={lbScene.id}
            src={lbScene.firstFrameUrl!}
            alt={t('ideaV2.scenesScene', { n: lbScene.index })}
            className="max-h-[92vh] max-w-[94vw] object-contain"
            onClick={(e) => e.stopPropagation()}
            draggable={false}
          />
          <div className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-xs text-white/80" data-testid="episode-v2-scenes-lightbox-caption">
            {t('ideaV2.scenesScene', { n: lbScene.index })} · {t('ideaV2.scenesLightboxCounter', { k: lightbox + 1, m: lbCount })}
          </div>
        </div>
      )}

      {modalScene && (
        <ScenePromptModal
          projectId={projectId}
          n={n}
          scene={modalScene}
          refs={promptScene?.videoRefs ?? []}
          onSaved={() => void load()}
          onClose={() => setPromptFor(null)}
        />
      )}
    </div>
  )
}
