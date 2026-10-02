'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, LayoutGrid, RefreshCw, X } from 'lucide-react'
import type { EpisodeStoryboardV2 } from '@/lib/idea-v2'
import { useTranslation } from '@/lib/i18n/context'
import { CancelButton } from '../../../_components/cancel-button'
import { useJobPolling, SmoothProgress } from '../../../_components/use-job-polling'

/**
 * Поток v2 · вкладка «Сториборд» серии n.
 * «Собрать сториборд» → воркер episode_storyboard_v2: берёт весь шот-лист серии, собирает единый промпт
 * (все кадры как пронумерованные панели в один grid-лист) и шлёт в GPT Image 2.5 flare. Результат — одно
 * изображение (лист-сториборд), грузится в S3 и показывается здесь; клик открывает его на весь экран.
 * Задача возобновляется при повторном открытии страницы.
 */
const API = '/api/ai/v2/storyboard'
const EXPECTED_SEC = 90
const isActive = (j: any) => !!j && (j.status === 'pending' || j.status === 'processing')

export function StoryboardTab({ projectId, n, hasShots, initialStoryboard }: {
  projectId: string; n: number; hasShots: boolean; initialStoryboard: EpisodeStoryboardV2 | null
}) {
  const { t } = useTranslation()
  const [storyboard, setStoryboard] = useState<EpisodeStoryboardV2 | null>(initialStoryboard)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [starting, setStarting] = useState(false)
  const [photoOpen, setPhotoOpen] = useState(false)
  const jobIdRef = useRef<string | null>(null)

  // Блокировка вертикального скролла при открытом полноэкранном фото.
  useEffect(() => {
    if (!photoOpen) return
    const body = document.body
    const scrollY = window.scrollY
    const prev = { position: body.style.position, top: body.style.top, left: body.style.left, right: body.style.right, width: body.style.width, overflow: body.style.overflow }
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.left = '0'
    body.style.right = '0'
    body.style.width = '100%'
    body.style.overflow = 'hidden'
    return () => {
      body.style.position = prev.position
      body.style.top = prev.top
      body.style.left = prev.left
      body.style.right = prev.right
      body.style.width = prev.width
      body.style.overflow = prev.overflow
      window.scrollTo(0, scrollY)
    }
  }, [photoOpen])

  const refresh = async () => {
    try {
      const res = await fetch(`${API}?projectId=${projectId}&episode=${n}`, { cache: 'no-store' })
      if (!res.ok) return
      const d = await res.json().catch(() => null)
      if (d && 'storyboard' in d) setStoryboard(d.storyboard ?? null)
    } catch { /* транзиентно */ }
  }

  const poll = useJobPolling({
    intervalMs: 1000,
    onFinish: (res: any) => {
      jobIdRef.current = null
      if (res.job.status === 'completed') { setError(''); void refresh() }
      else if (res.job.status === 'canceled') { setNotice(t('ideaV2.storyboardCanceled')); void refresh() }
      else { setError(res.job.error ?? t('ideaV2.storyboardError')); void refresh() }
    },
  })
  const building = starting || isActive(poll.job)

  // Возобновление идущей задачи при открытии страницы.
  useEffect(() => {
    let ignore = false
    ;(async () => {
      try {
        const d = await fetch(`${API}?projectId=${projectId}&episode=${n}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
        if (ignore || !d) return
        if ('storyboard' in d) setStoryboard(d.storyboard ?? null)
        if (isActive(d.job)) { jobIdRef.current = d.job.id; poll.start(d.job.id) }
      } catch { /* транзиентно */ }
    })()
    return () => { ignore = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, n])

  const build = async () => {
    setError(''); setNotice(''); poll.clear(); setStarting(true)
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, episode: n }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? t('ideaV2.storyboardError')); return }
      if (d?.jobId) { jobIdRef.current = d.jobId; poll.start(d.jobId) }
    } catch { setError(t('ideaV2.shotsNetworkError')) }
    finally { setStarting(false) }
  }

  const cancelJob = async () => {
    const id = jobIdRef.current
    if (!id) return
    try { await fetch(`/api/ai/jobs/${id}/cancel`, { method: 'POST' }) } catch { /* поллинг повторит */ }
  }

  const btnBar = 'inline-flex items-center justify-center gap-2 rounded-none border border-border bg-muted px-4 py-2 text-sm font-semibold transition hover:bg-muted/80 disabled:opacity-50'

  if (!hasShots && !storyboard?.imageUrl) {
    return <p className="text-sm text-muted-foreground" data-testid="episode-v2-storyboard-need-shots">{t('ideaV2.storyboardNeedShots')}</p>
  }

  const img = storyboard?.imageUrl
  const pj = poll.job

  return (
    <div data-testid="episode-v2-storyboard">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('ideaV2.storyboardIntro')}</p>
        {hasShots && (
          <button onClick={() => void build()} disabled={building} className={`${btnBar} min-w-[180px]`} data-testid="episode-v2-storyboard-build">
            {building ? <Loader2 className="h-4 w-4 animate-spin" /> : img ? <RefreshCw className="h-4 w-4" /> : <LayoutGrid className="h-4 w-4" />}
            {img ? t('ideaV2.storyboardRebuild') : t('ideaV2.storyboardBuild')}
          </button>
        )}
      </div>
      {!hasShots && <p className="mt-2 text-xs text-amber-500">{t('ideaV2.storyboardNeedShots')}</p>}

      {building && (
        <div className="mt-4 space-y-2" data-testid="episode-v2-storyboard-building">
          {pj ? <SmoothProgress job={pj} expectedTotalSec={EXPECTED_SEC} /> : (
            <p className="inline-flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin text-primary" /> {t('ideaV2.storyboardBuilding')}</p>
          )}
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 text-xs text-muted-foreground">{t('ideaV2.storyboardBuilding')} {t('ideaV2.storyboardCanClose')}</p>
            <CancelButton onCancel={cancelJob} testId="episode-v2-storyboard-cancel" className="flex-shrink-0" />
          </div>
        </div>
      )}
      {notice && <p className="mt-3 text-xs text-amber-500">{notice}</p>}
      {error && <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="episode-v2-storyboard-error">{error}</div>}

      {!img && hasShots && !building && <p className="mt-4 text-sm text-muted-foreground" data-testid="episode-v2-storyboard-empty">{t('ideaV2.storyboardEmpty')}</p>}

      {img && (
        <div className="mt-4">
          <button
            onClick={() => setPhotoOpen(true)}
            className="group block w-full max-w-md overflow-hidden rounded-lg border border-border bg-muted/20 transition hover:border-primary"
            data-testid="episode-v2-storyboard-image"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img} alt={t('ideaV2.storyboardTab')} className="block w-full" />
          </button>
        </div>
      )}

      {photoOpen && img && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={() => setPhotoOpen(false)}
          data-testid="episode-v2-storyboard-lightbox"
        >
          <button
            onClick={() => setPhotoOpen(false)}
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20"
            aria-label={t('common.close')}
            data-testid="episode-v2-storyboard-lightbox-close"
          >
            <X className="h-5 w-5" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={img} alt={t('ideaV2.storyboardTab')} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  )
}
