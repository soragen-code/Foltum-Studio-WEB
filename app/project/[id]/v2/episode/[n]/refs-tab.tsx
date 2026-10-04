'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Wand2, Eye, RefreshCw, ImageIcon, Sparkles, X, Upload, UserRound, Link2 } from 'lucide-react'
import { FABLE_MODEL_LABEL, stripRefKindPrefixV2, type EpisodeRefV2 } from '@/lib/idea-v2'
import { useTranslation } from '@/lib/i18n/context'
import { CancelButton } from '../../../_components/cancel-button'
import { useJobPolling, SmoothProgress } from '../../../_components/use-job-polling'
import { RefPromptModal } from './ref-prompt-modal'
import { V2_COSTS, refImagesCost } from '@/lib/v2-costs'
import { useFeature, useLockHint, GatedButton } from '@/components/entitlements-context'

/**
 * Поток v2 · вкладка «Референсы» серии n.
 * «Извлечь» → воркер episode_refs_v2 (FABLE_MODEL) раскладывает сценарий на персонажей / локации (INT./EXT.) / реквизит
 * с EN-промптами. Каждый блок: бейдж типа, метка (без префикса типа), «Промпт» → модалка (правка EN + RU-перевод для
 * показа + «Копировать» + «Сохранить»/«Закрыть»), превью + «Перегенерировать». «Сгенерировать все» → episode_ref_images_v2
 * (GPT Image 2.5 flare). Генерация всегда берёт сохранённый промпт из стора.
 * Обе задачи возобновляются при повторном открытии страницы.
 */
const API = { refs: '/api/ai/v2/refs', images: '/api/ai/v2/refs/images', inherit: '/api/ai/v2/refs/inherit', face: '/api/ai/v2/refs/face', appearance: '/api/ai/v2/refs/appearance' }
const EXTRACT_EXPECTED_SEC = 45
const IMAGE_EXPECTED_SEC = 40
const isActive = (j: any) => !!j && (j.status === 'pending' || j.status === 'processing')

export function EpisodeRefsTab({ projectId, n, hasScript, initialRefs }: {
  projectId: string; n: number; hasScript: boolean; initialRefs: EpisodeRefV2[]
}) {
  const { t } = useTranslation()
  const canViewPrompt = useFeature('prompt_view') // Studio: просмотр/правка EN-промпта рефа
  const canInstruct = useFeature('prompt_instruct_edit') // Pro+: правка внешности инструкцией
  const ownFace = useFeature('own_references') // Studio: своё фото-референс персонажа
  const costTag = (c: number) => <span className="ml-0.5 whitespace-nowrap text-[11px] font-normal opacity-80" data-testid="episode-v2-cost">· {t('ideaV2.costCredits', { n: c })}</span>
  const [items, setItems] = useState<EpisodeRefV2[]>(initialRefs)
  const [promptId, setPromptId] = useState('')
  const [lightbox, setLightbox] = useState<{ url: string; alt: string } | null>(null)
  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])
  useEffect(() => {
    if (!lightbox && !promptId) return
    // overflow:hidden не держит прокрутку надёжно (iOS/тач + overflow-x:hidden в globals.css).
    // Фиксируем body через position:fixed, сохраняя и восстанавливая текущую позицию скролла.
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
  }, [lightbox, promptId])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [starting, setStarting] = useState<'' | 'extract' | 'images' | 'inherit'>('')
  const [imagesTotal, setImagesTotal] = useState(0)
  const extractIdRef = useRef<string | null>(null)
  const imagesIdRef = useRef<string | null>(null)
  const lastProgressRef = useRef(-1)

  const refresh = async () => {
    try {
      const res = await fetch(`${API.refs}?projectId=${projectId}&episode=${n}`, { cache: 'no-store' })
      if (!res.ok) return
      const d = await res.json().catch(() => null)
      if (Array.isArray(d?.items)) setItems(d.items)
    } catch { /* транзиентно */ }
  }

  const extract = useJobPolling({
    intervalMs: 1000,
    onFinish: (res: any) => {
      extractIdRef.current = null
      if (res.job.status === 'completed') { setError(''); void refresh() }
      else if (res.job.status === 'canceled') setNotice(t('ideaV2.refsCanceled'))
      else setError(res.job.error ?? t('ideaV2.refsExtractFailed'))
    },
  })
  const images = useJobPolling({
    intervalMs: 1500,
    onUpdate: (res: any) => {
      const p = Number(res?.job?.progress ?? 0)
      if (p !== lastProgressRef.current) { lastProgressRef.current = p; void refresh() }
    },
    onFinish: (res: any) => {
      imagesIdRef.current = null
      lastProgressRef.current = -1
      void refresh()
      if (res.job.status === 'completed') {
        const failed = Number(res.job.result?.failed ?? 0)
        if (failed) setError(t('ideaV2.refsImagesPartial', { failed, total: Number(res.job.result?.total ?? 0) }))
      } else if (res.job.status === 'canceled') setNotice(t('ideaV2.refsCanceled'))
      else setError(res.job.error ?? t('ideaV2.refsImagesFailed'))
    },
  })
  const extracting = starting === 'extract' || isActive(extract.job)
  const generatingImages = starting === 'images' || isActive(images.job)

  // Возобновление идущих задач этой серии (вкладку можно было закрыть).
  useEffect(() => {
    let ignore = false
    ;(async () => {
      try {
        const [a, b] = await Promise.all([
          fetch(`${API.refs}?projectId=${projectId}&episode=${n}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          fetch(`${API.images}?projectId=${projectId}&episode=${n}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ])
        if (ignore) return
        if (Array.isArray(a?.items)) setItems(a.items)
        if (isActive(a?.job)) { extractIdRef.current = a.job.id; extract.start(a.job.id) }
        if (isActive(b?.job)) { imagesIdRef.current = b.job.id; setImagesTotal(Number(b.job.result?.total ?? 0)); images.start(b.job.id) }
      } catch { /* транзиентно */ }
    })()
    return () => { ignore = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, n])

  const runExtract = async () => {
    setError(''); setNotice(''); extract.clear(); setStarting('extract')
    try {
      const res = await fetch(API.refs, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, episode: n }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? t('ideaV2.refsExtractFailed')); return }
      if (d?.jobId) { extractIdRef.current = d.jobId; extract.start(d.jobId) }
    } catch { setError(t('ideaV2.refsNetworkError')) }
    finally { setStarting('') }
  }

  // Взять те же рефы (картинка + промпт) из ранних серий — без генерации и без кредитов.
  const runInherit = async () => {
    setError(''); setNotice(''); setStarting('inherit')
    try {
      const res = await fetch(API.inherit, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, episode: n }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? t('ideaV2.refsInheritFailed')); return }
      if (Array.isArray(d?.items)) setItems(d.items)
      setNotice(t(Number(d?.inherited) > 0 ? 'ideaV2.refsInheritDone' : 'ideaV2.refsInheritNone', { n: Number(d?.inherited ?? 0) }))
    } catch { setError(t('ideaV2.refsNetworkError')) }
    finally { setStarting('') }
  }

  const runImages = async (ids?: string[]) => {
    setError(''); setNotice(''); images.clear(); setStarting('images')
    try {
      const res = await fetch(API.images, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, episode: n, ...(ids ? { ids } : {}) }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? t('ideaV2.refsImagesFailed')); return }
      if (d?.resumed) setNotice(t('ideaV2.refsAlreadyRunning'))
      if (d?.jobId) { imagesIdRef.current = d.jobId; setImagesTotal(Number(d.total ?? ids?.length ?? items.length)); images.start(d.jobId) }
      if (!d?.resumed) {
        const target = new Set(ids ?? items.filter((r) => !(r.inheritedFrom && r.imageUrl)).map((r) => r.id))
        setItems((list) => list.map((r) => (target.has(r.id) ? { ...r, imageStatus: 'generating', imageError: null } : r)))
      }
    } catch { setError(t('ideaV2.refsNetworkError')) }
    finally { setStarting('') }
  }

  const cancelJob = async (ref: { current: string | null }) => {
    const id = ref.current
    if (!id) return
    try { await fetch(`/api/ai/jobs/${id}/cancel`, { method: 'POST' }) } catch { /* поллинг повторит */ }
  }

  // Кнопки блока рефа — как кнопки генерации в v1 (references-stage.tsx): фон bg-muted.
  const btnV1 = 'flex items-center gap-1 rounded-lg bg-muted px-3 py-1.5 text-xs transition hover:bg-muted/80 disabled:opacity-50'
  const btnMain = 'flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-1.5 text-xs font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50'
  const btnPrimary = 'flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50'
  const btnGhost = 'inline-flex items-center gap-1.5 rounded-lg border border-border bg-transparent px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted/60 hover:border-foreground/30 disabled:opacity-50'
  // Верхние кнопки тулбара — прямоугольные, одного размера, на одном уровне.
  const btnBar = 'inline-flex items-center justify-center gap-2 rounded-none border border-border bg-muted px-4 py-2 text-sm font-semibold transition hover:bg-muted/80 disabled:opacity-50'
  // Кнопки блока рефа — прямоугольные, соприкасаются (общий бордюр у обёртки).
  const btnFlat = 'relative flex flex-1 items-center justify-center gap-1 rounded-none bg-muted px-3 py-2 text-xs transition hover:bg-muted/80 disabled:opacity-50'
  const kindBadge: Record<string, string> = {
    character: 'bg-sky-500/15 text-sky-500',
    location: 'bg-emerald-500/15 text-emerald-500',
    prop: 'bg-amber-500/15 text-amber-500',
  }

  if (!hasScript && !items.length) {
    return <p className="text-sm text-muted-foreground" data-testid="episode-v2-refs-need-script">{t('ideaV2.refsNeedScript')}</p>
  }

  const ej = extract.job
  const ij = images.job
  const busy = extracting || generatingImages || starting === 'inherit'
  // «Сгенерировать все» не трогает рефы, унаследованные из ранних серий (та же картинка, 0 кредитов).
  const generateAllCount = items.filter((r) => !(r.inheritedFrom && r.imageUrl)).length

  return (
    <div data-testid="episode-v2-refs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('ideaV2.refsIntro')} <span className="font-semibold text-foreground">{FABLE_MODEL_LABEL}</span></p>
        <div className="flex flex-wrap items-stretch gap-2">
          {hasScript && (
            <button onClick={() => void runExtract()} disabled={busy} className={`${btnBar} min-w-[180px]`} data-testid="episode-v2-refs-extract">
              {extracting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              {items.length ? t('ideaV2.refsReextract') : t('ideaV2.refsExtract')}{costTag(V2_COSTS.refsExtract)}
            </button>
          )}
          {items.length > 0 && n > 1 && (
            <button onClick={() => void runInherit()} disabled={busy} className={`${btnBar} min-w-[180px]`} title={t('ideaV2.refsInheritHint')} data-testid="episode-v2-refs-inherit">
              {starting === 'inherit' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} {t('ideaV2.refsInherit')}
            </button>
          )}
          {items.length > 0 && (
            <button onClick={() => void runImages()} disabled={busy || !generateAllCount} className={`${btnBar} min-w-[180px]`} data-testid="episode-v2-refs-generate-all">
              {generatingImages ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {t('ideaV2.refsGenerateAll')}{costTag(refImagesCost(generateAllCount))}
            </button>
          )}
        </div>
      </div>
      {!hasScript && <p className="mt-2 text-xs text-amber-500">{t('ideaV2.refsNeedScript')}</p>}
      {items.length > 0 && hasScript && <p className="mt-2 text-[11px] text-muted-foreground">{t('ideaV2.refsReextractHint')}</p>}

      {extracting && (
        <div className="mt-4 space-y-2" data-testid="episode-v2-refs-extracting">
          {ej ? <SmoothProgress job={ej} expectedTotalSec={EXTRACT_EXPECTED_SEC} /> : (
            <p className="inline-flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin text-primary" /> {t('ideaV2.refsExtracting')}</p>
          )}
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 text-xs text-muted-foreground">{t('ideaV2.refsExtracting')} {t('ideaV2.refsCanClose')}</p>
            <CancelButton onCancel={() => cancelJob(extractIdRef)} testId="episode-v2-refs-extract-cancel" className="flex-shrink-0" />
          </div>
        </div>
      )}
      {generatingImages && (
        <div className="mt-4 space-y-2" data-testid="episode-v2-refs-images-progress">
          {ij ? <SmoothProgress job={ij} expectedTotalSec={IMAGE_EXPECTED_SEC * Math.max(1, imagesTotal || items.length)} /> : (
            <p className="inline-flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin text-primary" /> {t('ideaV2.refsGeneratingImages')}</p>
          )}
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 text-xs text-muted-foreground">{t('ideaV2.refsGeneratingImages')} {t('ideaV2.refsCanClose')}</p>
            <CancelButton onCancel={() => cancelJob(imagesIdRef)} testId="episode-v2-refs-images-cancel" className="flex-shrink-0" />
          </div>
        </div>
      )}
      {notice && <p className="mt-3 text-xs text-amber-500">{notice}</p>}
      {error && <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="episode-v2-refs-error">{error}</div>}

      {!items.length && hasScript && !extracting && <p className="mt-4 text-sm text-muted-foreground">{t('ideaV2.refsEmpty')}</p>}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((r) => {
          const genBusy = r.imageStatus === 'generating' && generatingImages
          return (
            <div key={r.id} className="flex flex-col rounded-lg border border-border/70 bg-muted/20 p-3 sm:p-4" data-testid={`episode-v2-ref-${r.id}`}>
              <div className="mx-auto flex w-full max-w-[220px] items-center justify-center overflow-hidden rounded-lg border border-border bg-background" style={{ aspectRatio: '9 / 16' }} data-testid="episode-v2-ref-thumb">
                {genBusy ? <Loader2 className="h-5 w-5 animate-spin text-primary" /> : r.imageUrl ? (
                  <button type="button" onClick={() => setLightbox({ url: r.imageUrl!, alt: stripRefKindPrefixV2(r.label) })} className="block h-full w-full cursor-zoom-in" title={t('ideaV2.refsOpenFull')} data-testid="episode-v2-ref-open">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={r.imageUrl} alt={stripRefKindPrefixV2(r.label)} className="h-full w-full object-cover" loading="lazy" />
                  </button>
                ) : <ImageIcon className="h-5 w-5 text-muted-foreground/50" />}
              </div>
              <div className="mt-3" data-testid="episode-v2-ref-header">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${kindBadge[r.kind] ?? 'bg-muted text-muted-foreground'}`}>{t(`ideaV2.refsKind.${r.kind}`)}</span>
                  <span className="min-w-0 break-words text-sm font-semibold text-foreground" data-testid="episode-v2-ref-label">{stripRefKindPrefixV2(r.label)}</span>
                  {r.edited && <span className="text-[10px] text-muted-foreground">· {t('ideaV2.refsEdited')}</span>}
                  {!!r.inheritedFrom && !!r.imageUrl && <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-600 dark:text-sky-400" title={t('ideaV2.refsInheritedHint')} data-testid="episode-v2-ref-inherited">{t('ideaV2.refsInherited', { n: r.inheritedFrom })}</span>}
                </div>
                {r.role?.trim() && <div className="mt-0.5 text-xs text-muted-foreground" data-testid="episode-v2-ref-role">{r.role.trim()}</div>}
              </div>
              {r.kind === 'character' && (
                <FaceRefControl
                  projectId={projectId}
                  n={n}
                  refItem={r}
                  ownFace={ownFace}
                  disabled={busy}
                  onChanged={(userRefUrl) => setItems((list) => list.map((x) => (x.id === r.id ? { ...x, userRefUrl } : x)))}
                />
              )}
              <div className="mt-3 flex overflow-hidden rounded-md border border-border">
                <GatedButton feature="prompt_view" allowed={canViewPrompt} onClick={() => setPromptId(r.id)} className={btnFlat} data-testid="episode-v2-ref-view-prompt">
                  <Eye className="h-3.5 w-3.5" /> {t('ideaV2.refsViewPrompt')}
                  {r.promptDirty && <span className="absolute right-1 top-1 rounded-sm bg-primary px-1 text-[9px] font-bold uppercase leading-tight text-primary-foreground" data-testid="episode-v2-ref-prompt-new">new</span>}
                </GatedButton>
                <button onClick={() => void runImages([r.id])} disabled={busy || !r.prompt.trim()} className={`${btnFlat} border-l border-border`} data-testid="episode-v2-ref-regenerate">
                  {genBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} {r.imageUrl ? t('ideaV2.refsRegenerate') : t('ideaV2.refsGenerateOne')}{costTag(V2_COSTS.refImage)}
                </button>
              </div>
              {r.kind === 'character' && (
                <AppearanceRefineControl
                  projectId={projectId}
                  n={n}
                  refItem={r}
                  disabled={busy}
                  allowed={canInstruct}
                  onRefined={(prompt) => setItems((list) => list.map((x) => (x.id === r.id ? { ...x, prompt, edited: true, promptDirty: true } : x)))}
                />
              )}
              {r.imageStatus === 'failed' && r.imageError && <p className="mt-2 text-xs text-destructive">{t('ideaV2.refsImageFailed')}: {r.imageError}</p>}
            </div>
          )
        })}
      </div>
      {(() => {
        const pr = promptId ? items.find((x) => x.id === promptId) : null
        return pr ? (
          <RefPromptModal
            key={pr.id}
            projectId={projectId}
            n={n}
            refItem={pr}
            onSaved={(prompt) => setItems((list) => list.map((x) => (x.id === pr.id ? { ...x, prompt, edited: true, promptDirty: true } : x)))}
            onClose={() => setPromptId('')}
          />
        ) : null
      })()}
      {lightbox && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4" onClick={() => setLightbox(null)} role="dialog" aria-modal="true" data-testid="episode-v2-ref-lightbox">
          <button type="button" onClick={() => setLightbox(null)} className="absolute right-4 top-4 rounded-full bg-black/50 p-2 text-white transition hover:bg-black/70" aria-label={t('common.close')} data-testid="episode-v2-ref-lightbox-close">
            <X className="h-6 w-6" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox.url} alt={lightbox.alt} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  )
}

/**
 * Контрол «фото-референс внешности» для рефа-персонажа (v2).
 * Пользователь прикрепляет своё фото → при генерации изображения рефа оно подаётся в модель как image_input,
 * чтобы персонаж был похож на человека с фото. Gate own_references (Studio). POST/DELETE → /api/ai/v2/refs/face.
 */
function FaceRefControl({ projectId, n, refItem, ownFace, disabled, onChanged }: {
  projectId: string; n: number; refItem: EpisodeRefV2; ownFace: boolean; disabled: boolean
  onChanged: (userRefUrl: string | null) => void
}) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const url = refItem.userRefUrl?.trim() || ''

  const upload = async (file: File) => {
    setError(''); setBusy(true)
    try {
      const fd = new FormData()
      fd.append('projectId', projectId)
      fd.append('episode', String(n))
      fd.append('id', refItem.id)
      fd.append('file', file)
      const res = await fetch(API.face, { method: 'POST', body: fd })
      const d = await res.json().catch(() => null)
      if (!res.ok || !d?.userRefUrl) { setError(d?.error || t('ideaV2.refsFaceError')); return }
      onChanged(d.userRefUrl as string)
    } catch { setError(t('ideaV2.refsFaceError')) }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = '' }
  }

  const remove = async () => {
    setError(''); setBusy(true)
    try {
      const fd = new FormData()
      fd.append('projectId', projectId)
      fd.append('episode', String(n))
      fd.append('id', refItem.id)
      const res = await fetch(API.face, { method: 'DELETE', body: fd })
      if (!res.ok) { const d = await res.json().catch(() => null); setError(d?.error || t('ideaV2.refsFaceError')); return }
      onChanged(null)
    } catch { setError(t('ideaV2.refsFaceError')) }
    finally { setBusy(false) }
  }

  return (
    <div className="mt-3 rounded-md border border-dashed border-border/80 bg-background/40 p-2.5" data-testid="episode-v2-ref-face">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
        <UserRound className="h-3.5 w-3.5 text-muted-foreground" /> {t('ideaV2.refsFaceTitle')}
      </div>
      {url ? (
        <div className="mt-2 flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={t('ideaV2.refsFaceTitle')} className="h-12 w-12 flex-shrink-0 rounded-md border border-border object-cover" />
          <button type="button" onClick={() => void remove()} disabled={busy || disabled} className="inline-flex items-center gap-1 rounded-md border border-border bg-transparent px-2 py-1 text-[11px] text-foreground transition hover:bg-muted/60 disabled:opacity-50" data-testid="episode-v2-ref-face-remove">
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />} {t('ideaV2.refsFaceRemove')}
          </button>
        </div>
      ) : (
        <div className="mt-2">
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f) }} data-testid="episode-v2-ref-face-input" />
          {/* Без Studio кнопка загрузки остаётся видимой: disabled + бейдж тарифа (единый паттерн GatedButton). */}
          <GatedButton feature="own_references" allowed={ownFace} type="button" onClick={() => inputRef.current?.click()} disabled={busy || disabled} className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-[11px] text-foreground transition hover:bg-muted/60 disabled:opacity-50" data-testid="episode-v2-ref-face-upload">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} {t('ideaV2.refsFaceUpload')}
          </GatedButton>
          <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">{t('ideaV2.refsFaceHint')}</p>
        </div>
      )}
      {error && <p className="mt-1.5 text-[10px] text-destructive" data-testid="episode-v2-ref-face-error">{error}</p>}
    </div>
  )
}

/**
 * Контрол «рефайн внешности промптом» для рефа-персонажа (v2).
 * Пользователь пишет пожелание (на любом языке) → кнопка «Изменить» шлёт текущий EN-промпт + пожелание в LLM
 * (POST /api/ai/v2/refs/appearance), получает обновлённый EN-промпт, который сохраняется с promptDirty=true
 * (на кнопке «Промпт» загорается бейдж «new»). Затем пользователь перегенерирует фото по новому промпту.
 */
function AppearanceRefineControl({ projectId, n, refItem, disabled, allowed, onRefined }: {
  projectId: string; n: number; refItem: EpisodeRefV2; disabled: boolean
  /** prompt_instruct_edit (Pro+): без доступа поле disabled с подсказкой, кнопка — disabled с бейджем тарифа. */
  allowed: boolean
  onRefined: (prompt: string) => void
}) {
  const { t } = useTranslation()
  const lockHint = useLockHint()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const apply = async () => {
    const instruction = text.trim()
    if (!instruction || busy || disabled) return
    setError(''); setBusy(true)
    try {
      const res = await fetch(API.appearance, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, episode: n, id: refItem.id, instruction }),
      })
      const d = await res.json().catch(() => null)
      if (!res.ok || !d?.prompt) { setError(d?.error || t('ideaV2.refsAppearanceError')); return }
      onRefined(d.prompt as string)
      setText('')
    } catch { setError(t('ideaV2.refsAppearanceError')) }
    finally { setBusy(false) }
  }

  return (
    <div className="mt-2" data-testid="episode-v2-ref-appearance">
      <div className="flex items-stretch gap-2">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void apply() } }}
          disabled={busy || disabled || !allowed}
          placeholder={allowed ? t('ideaV2.refsAppearancePlaceholder') : lockHint('prompt_instruct_edit')}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none transition focus:border-foreground/40 disabled:opacity-50"
          data-testid="episode-v2-ref-appearance-input"
        />
        <GatedButton
          feature="prompt_instruct_edit"
          allowed={allowed}
          type="button"
          onClick={() => void apply()}
          disabled={busy || disabled || !text.trim()}
          className="flex basis-1/5 flex-shrink-0 items-center justify-center gap-1 rounded-md bg-amber-400 px-2 py-1.5 text-xs font-semibold text-black transition hover:bg-amber-300 disabled:opacity-50"
          data-testid="episode-v2-ref-appearance-apply"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('ideaV2.refsAppearanceApply')}
        </GatedButton>
      </div>
      {error && <p className="mt-1.5 text-[10px] text-destructive" data-testid="episode-v2-ref-appearance-error">{error}</p>}
    </div>
  )
}
