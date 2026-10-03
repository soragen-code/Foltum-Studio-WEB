'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, LayoutGrid, RefreshCw, X, Eye, CheckCircle2, Film } from 'lucide-react'
import { syncStoryboardV2RefsBlock, type EpisodeStoryboardV2 } from '@/lib/idea-v2'
import { useTranslation } from '@/lib/i18n/context'
import { CancelButton } from '../../../_components/cancel-button'
import { useJobPolling, SmoothProgress } from '../../../_components/use-job-polling'
import { StoryboardPromptModal, type StoryboardPromptRef } from './storyboard-prompt-modal'

const draftKey = (pid: string, n: number) => `foltum:v2:storyboard-prompt:${pid}:${n}`

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

const SCENES_API = '/api/ai/v2/scenes'

export function StoryboardTab({ projectId, n, hasShots, initialStoryboard, onOpenScenes }: {
  projectId: string; n: number; hasShots: boolean; initialStoryboard: EpisodeStoryboardV2 | null; onOpenScenes?: () => void
}) {
  const { t } = useTranslation()
  const [storyboard, setStoryboard] = useState<EpisodeStoryboardV2 | null>(initialStoryboard)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [starting, setStarting] = useState(false)
  const [photoOpen, setPhotoOpen] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const [autoPrompt, setAutoPrompt] = useState('')
  const [promptDraft, setPromptDraft] = useState('')
  const [refs, setRefs] = useState<StoryboardPromptRef[]>([])
  const [promptLoading, setPromptLoading] = useState(false)
  const [promptError, setPromptError] = useState('')
  const jobIdRef = useRef<string | null>(null)
  // Аппрув → нарезка первых кадров сцен (job episode_scene_frames_v2, статус через общий поллинг задач).
  const [approving, setApproving] = useState(false)
  const [cutState, setCutState] = useState<'idle' | 'done' | 'error'>('idle')

  // Черновик промпта из localStorage (per-episode).
  useEffect(() => {
    try { const v = localStorage.getItem(draftKey(projectId, n)); if (v) setPromptDraft(v) } catch { /* недоступно */ }
  }, [projectId, n])

  // Блокировка вертикального скролла при открытом полноэкранном фото или модалке промпта.
  useEffect(() => {
    if (!photoOpen && !promptOpen) return
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
  }, [photoOpen, promptOpen])

  // Подтянуть состояние листа с сервера. attempts > 1 — повтор при сетевой/транзиентной ошибке (после
  // завершения задачи лист ОБЯЗАН появиться без перезагрузки страницы).
  const refresh = async (attempts = 1): Promise<boolean> => {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(`${API}?projectId=${projectId}&episode=${n}`, { cache: 'no-store' })
        const d = res.ok ? await res.json().catch(() => null) : null
        if (d) {
          if ('storyboard' in d) setStoryboard(d.storyboard ?? null)
          if (typeof d.autoPrompt === 'string') setAutoPrompt(d.autoPrompt)
          if (Array.isArray(d.refs)) setRefs(d.refs)
          return true
        }
      } catch { /* транзиентно */ }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)))
    }
    return false
  }

  const poll = useJobPolling({
    intervalMs: 1000,
    onFinish: (res: any) => {
      jobIdRef.current = null
      if (res.job.status === 'completed') {
        setError('')
        // Готовый лист — сразу из результата задачи (не ждём GET), затем сверка с сервером с повторами.
        const url = typeof res.job.result?.imageUrl === 'string' ? res.job.result.imageUrl : ''
        if (url) setStoryboard((s) => ({ ...(s ?? {}), imageUrl: url, status: 'done', error: null, approved: false }))
        void refresh(3)
      }
      else if (res.job.status === 'canceled') { setNotice(t('ideaV2.storyboardCanceled')); void refresh() }
      else { setError(res.job.error ?? t('ideaV2.storyboardError')); void refresh() }
    },
  })
  const building = starting || isActive(poll.job)

  const cutPoll = useJobPolling({
    intervalMs: 2000,
    onFinish: (res: any) => {
      if (res.job.status === 'completed') setCutState('done')
      else if (res.job.status === 'canceled') setCutState('idle')
      else { setCutState('error'); setError(res.job.error ?? t('ideaV2.scenesError')) }
    },
  })
  const cutting = approving || isActive(cutPoll.job)

  const approve = async () => {
    setError(''); setNotice(''); cutPoll.clear(); setCutState('idle'); setApproving(true)
    try {
      const res = await fetch(SCENES_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, episode: n, action: 'approve' }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? t('ideaV2.scenesError')); return }
      setStoryboard((s) => (s ? { ...s, approved: true } : s))
      if (d?.jobId) cutPoll.start(d.jobId)
    } catch { setError(t('ideaV2.shotsNetworkError')) }
    finally { setApproving(false) }
  }

  // Возобновление идущей задачи при открытии страницы.
  useEffect(() => {
    let ignore = false
    ;(async () => {
      try {
        const d = await fetch(`${API}?projectId=${projectId}&episode=${n}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
        if (ignore || !d) return
        if ('storyboard' in d) setStoryboard(d.storyboard ?? null)
        if (typeof d.autoPrompt === 'string') setAutoPrompt(d.autoPrompt)
        if (Array.isArray(d.refs)) setRefs(d.refs)
        if (isActive(d.job)) { jobIdRef.current = d.job.id; poll.start(d.job.id) }
        // Идущая нарезка первых кадров (после аппрува) — продолжить показ статуса.
        const sc = await fetch(`${SCENES_API}?projectId=${projectId}&episode=${n}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
        if (!ignore && sc && isActive(sc.framesJob)) cutPoll.start(sc.framesJob.id)
      } catch { /* транзиентно */ }
    })()
    return () => { ignore = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, n])

  const build = async () => {
    setError(''); setNotice(''); poll.clear(); setStarting(true)
    // Правка промпта (если отличается от авто) уходит как override; иначе пустая строка сбрасывает к авто.
    // Блок «References:» в правке всегда синхронизируется с актуальным авто-промптом (актуальные рефы).
    const synced = autoPrompt ? syncStoryboardV2RefsBlock(promptDraft, autoPrompt) : promptDraft
    const edited = synced.trim() && autoPrompt && synced.trim() !== autoPrompt.trim()
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, episode: n, prompt: edited ? synced : '' }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? t('ideaV2.storyboardError')); return }
      if (d?.jobId) { jobIdRef.current = d.jobId; poll.start(d.jobId) }
    } catch { setError(t('ideaV2.shotsNetworkError')) }
    finally { setStarting(false) }
  }

  // Кнопка «Промпт»: модалка открывается сразу; промпт уже построен (кэш на сервере актуален) → показывается
  // мгновенно, иначе строится по запросу (перевод фреймов/меток) и подставляется, пока в модалке крутится лоадер.
  // Рефы/промпт ВСЕГДА сверяются с сервером при открытии (актуальные картинки со вкладки «Референсы»):
  // уже показанный промпт остаётся на экране без лоадера, а если сервер вернул обновлённый (рефы или шоты
  // изменились — ключ кэша не совпал) — он подменяется на лету.
  const openPrompt = async (force = false) => {
    setPromptOpen(true)
    const silent = !!autoPrompt && !force
    if (!silent) setPromptLoading(true)
    setPromptError('')
    try {
      const res = await fetch(`${API}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, episode: n, force }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || typeof d?.autoPrompt !== 'string') { if (!silent) setPromptError(d?.error ?? t('ideaV2.storyboardError')); return }
      setAutoPrompt(d.autoPrompt)
      if (Array.isArray(d.refs)) setRefs(d.refs)
    } catch { if (!silent) setPromptError(t('ideaV2.shotsNetworkError')) }
    finally { if (!silent) setPromptLoading(false) }
  }

  const cancelJob = async () => {
    const id = jobIdRef.current
    if (!id) return
    try { await fetch(`/api/ai/jobs/${id}/cancel`, { method: 'POST' }) } catch { /* поллинг повторит */ }
  }

  // Сохранение черновика промпта: если отличается от авто — в localStorage; иначе снимаем override.
  const savePromptDraft = (prompt: string) => {
    setPromptDraft(prompt)
    try {
      if (prompt.trim() && autoPrompt && prompt.trim() !== autoPrompt.trim()) localStorage.setItem(draftKey(projectId, n), prompt)
      else localStorage.removeItem(draftKey(projectId, n))
    } catch { /* недоступно */ }
  }

  const promptEdited = !!(promptDraft.trim() && autoPrompt && syncStoryboardV2RefsBlock(promptDraft, autoPrompt).trim() !== autoPrompt.trim())

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
          <div className="flex flex-wrap items-stretch gap-2">
            <button onClick={() => void openPrompt()} disabled={building} className={btnBar} data-testid="episode-v2-storyboard-view-prompt">
              <Eye className="h-4 w-4" /> {t('ideaV2.shotsViewPrompt')}
              {promptEdited && (
                <span className="rounded-sm bg-primary px-1 text-[9px] font-bold uppercase leading-tight text-primary-foreground">{t('ideaV2.refsEdited')}</span>
              )}
            </button>
            <button onClick={() => void build()} disabled={building} className={`${btnBar} min-w-[180px]`} data-testid="episode-v2-storyboard-build">
              {building ? <Loader2 className="h-4 w-4 animate-spin" /> : img ? <RefreshCw className="h-4 w-4" /> : <LayoutGrid className="h-4 w-4" />}
              {img ? t('ideaV2.storyboardRebuild') : t('ideaV2.storyboardBuild')}
            </button>
          </div>
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
          {!building && (
            <div className="mt-3 flex max-w-md flex-col gap-2" data-testid="episode-v2-storyboard-approve-box">
              <div className="flex flex-wrap items-center gap-2">
                <button onClick={() => void approve()} disabled={cutting} className={btnBar} data-testid="episode-v2-storyboard-approve">
                  {cutting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} {t('ideaV2.approveStoryboard')}
                </button>
                {storyboard?.approved && !cutting && (
                  <span className="inline-flex items-center gap-1 text-xs text-emerald-500" data-testid="episode-v2-storyboard-approved"><CheckCircle2 className="h-3.5 w-3.5" /> {t('ideaV2.storyboardApproved')}</span>
                )}
              </div>
              {cutting && (
                <div className="space-y-1" data-testid="episode-v2-storyboard-cutting">
                  {cutPoll.job && <SmoothProgress job={cutPoll.job} expectedTotalSec={120} />}
                  <p className="inline-flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin text-primary" /> {t('ideaV2.scenesCutting')} {t('ideaV2.storyboardCanClose')}</p>
                </div>
              )}
              {(cutting || cutState === 'done' || storyboard?.approved) && onOpenScenes && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {cutState === 'done' && <span data-testid="episode-v2-storyboard-cut-done">{t('ideaV2.scenesCutDone')}</span>}
                  <button onClick={onOpenScenes} className="inline-flex items-center gap-1 font-semibold text-primary hover:underline" data-testid="episode-v2-storyboard-open-scenes">
                    <Film className="h-3.5 w-3.5" /> {t('ideaV2.scenesOpenTab')}
                  </button>
                </div>
              )}
            </div>
          )}
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

      {promptOpen && (
        <StoryboardPromptModal
          key={autoPrompt ? 'ready' : 'pending'}
          autoPrompt={autoPrompt}
          promptDraft={promptDraft}
          refs={refs}
          loading={promptLoading}
          loadError={promptError}
          onRetry={() => void openPrompt(true)}
          onRebuild={() => { savePromptDraft(''); void openPrompt(true) }}
          onSave={savePromptDraft}
          onClose={() => setPromptOpen(false)}
        />
      )}
    </div>
  )
}
