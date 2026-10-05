'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Play } from 'lucide-react'
import { useTranslation } from '@/lib/i18n/context'
import type { AdminDramaEpisode } from '@/lib/admin-dramas'

/**
 * Плеер серий драмы (админка). Слева — видео 9:16 с накладными кнопками ‹ › и «на весь экран», справа — список серий.
 * На весь экран разворачивается КОНТЕЙНЕР (а не <video>), чтобы в полноэкранном режиме оставались наши стрелки и
 * работали клавиши: ← / → (и ↑ / ↓) — предыдущая / следующая серия, пробел — пауза/плей, F — весь экран.
 * По окончании серии автоматически идёт следующая.
 */
export function DramaPlayer({ episodes, cover }: { episodes: AdminDramaEpisode[]; cover: string | null }) {
  const { t, locale } = useTranslation()
  const [idx, setIdx] = useState(0)
  const [autoplay, setAutoplay] = useState(false)
  const [isFs, setIsFs] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  const count = episodes.length
  const current = episodes[idx] ?? null

  const go = useCallback(
    (next: number) => {
      if (!count) return
      const clamped = Math.max(0, Math.min(count - 1, next))
      if (clamped === idx) return
      setAutoplay(true)
      setIdx(clamped)
    },
    [count, idx],
  )
  const prev = useCallback(() => go(idx - 1), [go, idx])
  const next = useCallback(() => go(idx + 1), [go, idx])

  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current
    if (!el) return
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await el.requestFullscreen()
    } catch {
      /* браузер может отказать — игнорируем */
    }
  }, [])

  useEffect(() => {
    const onChange = () => setIsFs(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // Горячие клавиши — на window в фазе capture, чтобы перехватить стрелки раньше нативных контролов <video> (перемотка).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
          e.preventDefault(); e.stopPropagation(); next(); break
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
          e.preventDefault(); e.stopPropagation(); prev(); break
        case ' ':
        case 'k': {
          const v = videoRef.current
          if (!v) return
          e.preventDefault()
          if (v.paused) void v.play().catch(() => {})
          else v.pause()
          break
        }
        case 'f':
          e.preventDefault(); void toggleFullscreen(); break
        default:
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [next, prev, toggleFullscreen])

  // После смены серии — автоплей (если смена была инициирована пользователем или окончанием предыдущей).
  useEffect(() => {
    if (!autoplay) return
    const v = videoRef.current
    if (!v) return
    const p = v.play()
    if (p && typeof p.catch === 'function') p.catch(() => {})
  }, [idx, autoplay])

  const fmtDate = (iso: string | null) => {
    if (!iso) return null
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return null
    return d.toLocaleString(locale === 'en' ? 'en-US' : locale === 'uk' ? 'uk-UA' : 'ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  if (!count) {
    return <p className="rounded-2xl border border-border bg-card px-5 py-6 text-sm text-muted-foreground" data-testid="admin-drama-empty">{t('admin.dramas.noReadyEpisodes')}</p>
  }

  const navBtn = 'pointer-events-auto inline-flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur transition hover:bg-black/75 disabled:cursor-not-allowed disabled:opacity-25'

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_1fr]" data-testid="admin-drama-player">
      {/* ── Плеер ── */}
      <div
        ref={containerRef}
        className={
          'group relative overflow-hidden rounded-2xl bg-black ' +
          (isFs ? 'flex h-screen w-screen items-center justify-center rounded-none' : 'aspect-[9/16] w-full')
        }
        data-testid="admin-drama-stage"
      >
        {current && (
          <video
            key={current.videoUrl}
            ref={videoRef}
            src={current.videoUrl}
            poster={cover ?? undefined}
            controls
            playsInline
            onEnded={() => { if (idx < count - 1) go(idx + 1) }}
            className={isFs ? 'h-full max-h-screen w-auto max-w-full' : 'h-full w-full object-contain'}
            data-testid="admin-drama-video"
          />
        )}

        {/* Накладные кнопки: ‹ › по бокам, номер серии и весь экран сверху. pointer-events-none на слое, чтобы не мешать контролам видео. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3">
          <div className="flex items-start justify-between">
            <span className="pointer-events-auto rounded-full bg-black/55 px-3 py-1 text-xs font-medium text-white backdrop-blur" data-testid="admin-drama-counter">
              {t('admin.dramas.episodeN', { n: current?.n ?? 0 })} · {idx + 1}/{count}
            </span>
            <button
              type="button"
              onClick={() => void toggleFullscreen()}
              className={navBtn + ' h-9 w-9'}
              title={isFs ? t('admin.dramas.exitFullscreen') : t('admin.dramas.fullscreen')}
              aria-label={isFs ? t('admin.dramas.exitFullscreen') : t('admin.dramas.fullscreen')}
              data-testid="admin-drama-fullscreen"
            >
              {isFs ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
          </div>
          <div className="flex items-center justify-between">
            <button type="button" onClick={prev} disabled={idx <= 0} className={navBtn} title={t('admin.dramas.prevEpisode')} aria-label={t('admin.dramas.prevEpisode')} data-testid="admin-drama-prev">
              <ChevronLeft className="h-6 w-6" />
            </button>
            <button type="button" onClick={next} disabled={idx >= count - 1} className={navBtn} title={t('admin.dramas.nextEpisode')} aria-label={t('admin.dramas.nextEpisode')} data-testid="admin-drama-next">
              <ChevronRight className="h-6 w-6" />
            </button>
          </div>
        </div>
      </div>

      {/* ── Список серий ── */}
      <div className="min-w-0">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold">{t('admin.dramas.episodesList')}</h2>
          <p className="text-[11px] text-muted-foreground">{t('admin.dramas.keysHint')}</p>
        </div>
        <ol className="mt-3 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card" data-testid="admin-drama-episodes">
          {episodes.map((ep, i) => {
            const active = i === idx
            return (
              <li key={ep.n}>
                <button
                  type="button"
                  onClick={() => { if (i === idx) { const v = videoRef.current; if (v) void v.play().catch(() => {}) } else go(i) }}
                  aria-current={active ? 'true' : undefined}
                  className={
                    'flex w-full items-start gap-3 px-4 py-3 text-left transition ' +
                    (active ? 'bg-primary/10' : 'hover:bg-muted/60')
                  }
                  data-testid={`admin-drama-episode-${ep.n}`}
                >
                  <span className={'mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ' + (active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
                    {active ? <Play className="h-3.5 w-3.5" /> : ep.n}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="font-medium">{t('admin.dramas.episodeN', { n: ep.n })}</span>
                      {fmtDate(ep.updatedAt) ? <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{fmtDate(ep.updatedAt)}</span> : null}
                    </span>
                    {ep.summary ? <span className="mt-0.5 block text-xs text-muted-foreground">{ep.summary}</span> : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
