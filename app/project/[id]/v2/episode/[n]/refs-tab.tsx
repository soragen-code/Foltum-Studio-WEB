'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Wand2, Copy, Check, Languages, RefreshCw, ImageIcon, Sparkles } from 'lucide-react'
import { FABLE_MODEL_LABEL, type EpisodeRefV2 } from '@/lib/idea-v2'
import { useTranslation } from '@/lib/i18n/context'
import { CancelButton } from '../../../_components/cancel-button'
import { useJobPolling, SmoothProgress } from '../../../_components/use-job-polling'

/**
 * Поток v2 · вкладка «Референсы» серии n.
 * «Извлечь» → воркер episode_refs_v2 (FABLE_MODEL) раскладывает сценарий на персонажей / локации (INT./EXT.) / реквизит
 * с EN-промптами. Каждый блок: метка, редактируемый EN-промпт (сохраняется по blur, edited=true), «RU» — перевод только
 * для показа, «Копировать», превью + «Перегенерировать». «Сгенерировать все» → воркер episode_ref_images_v2.
 * Обе задачи возобновляются при повторном открытии страницы.
 */
const API = { refs: '/api/ai/v2/refs', images: '/api/ai/v2/refs/images' }
const EXTRACT_EXPECTED_SEC = 45
const IMAGE_EXPECTED_SEC = 40
const isActive = (j: any) => !!j && (j.status === 'pending' || j.status === 'processing')

export function EpisodeRefsTab({ projectId, n, hasScript, initialRefs }: {
  projectId: string; n: number; hasScript: boolean; initialRefs: EpisodeRefV2[]
}) {
  const { t } = useTranslation()
  const [items, setItems] = useState<EpisodeRefV2[]>(initialRefs)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [ruOn, setRuOn] = useState<Record<string, boolean>>({})
  const [ru, setRu] = useState<Record<string, { src: string; text: string }>>({})
  const [ruLoading, setRuLoading] = useState<Record<string, boolean>>({})
  const [copiedId, setCopiedId] = useState('')
  const [savingId, setSavingId] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [starting, setStarting] = useState<'' | 'extract' | 'images'>('')
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

  const runImages = async (ids?: string[]) => {
    setError(''); setNotice(''); images.clear(); setStarting('images')
    try {
      const res = await fetch(API.images, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, episode: n, ...(ids ? { ids } : {}) }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? t('ideaV2.refsImagesFailed')); return }
      if (d?.resumed) setNotice(t('ideaV2.refsAlreadyRunning'))
      if (d?.jobId) { imagesIdRef.current = d.jobId; setImagesTotal(Number(d.total ?? ids?.length ?? items.length)); images.start(d.jobId) }
      if (!d?.resumed) {
        const target = new Set(ids ?? items.map((r) => r.id))
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

  const currentPrompt = (r: EpisodeRefV2) => drafts[r.id] ?? r.prompt

  const savePrompt = async (r: EpisodeRefV2) => {
    const next = drafts[r.id]
    if (next === undefined || next === r.prompt) return
    setSavingId(r.id)
    try {
      const res = await fetch(API.refs, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, episode: n, id: r.id, prompt: next }) })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d?.error ?? t('ideaV2.refsSaveFailed')); return }
      setItems((list) => list.map((x) => (x.id === r.id ? { ...x, prompt: next, edited: true } : x)))
      setDrafts((d) => { const c = { ...d }; delete c[r.id]; return c })
    } catch { setError(t('ideaV2.refsNetworkError')) }
    finally { setSavingId('') }
  }

  const toggleRu = async (r: EpisodeRefV2) => {
    const next = !ruOn[r.id]
    setRuOn((s) => ({ ...s, [r.id]: next }))
    const src = currentPrompt(r)
    if (!next || ru[r.id]?.src === src) return
    setRuLoading((s) => ({ ...s, [r.id]: true }))
    try {
      const res = await fetch('/api/ai/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: src }) })
      const d = await res.json().catch(() => ({}))
      const text = res.ok && typeof d?.text === 'string' && d.text.trim() ? d.text : src
      setRu((s) => ({ ...s, [r.id]: { src, text } }))
    } catch { setRu((s) => ({ ...s, [r.id]: { src, text: src } })) }
    finally { setRuLoading((s) => ({ ...s, [r.id]: false })) }
  }

  const copy = async (r: EpisodeRefV2) => {
    try { await navigator.clipboard.writeText(currentPrompt(r)); setCopiedId(r.id); setTimeout(() => setCopiedId(''), 1500) } catch { /* буфер недоступен */ }
  }

  const btnMain = 'flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-1.5 text-xs font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50'
  const btnPrimary = 'flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50'
  const btnGhost = 'inline-flex items-center gap-1.5 rounded-lg border border-border bg-transparent px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted/60 hover:border-foreground/30 disabled:opacity-50'
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
  const busy = extracting || generatingImages

  return (
    <div data-testid="episode-v2-refs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('ideaV2.refsIntro')} <span className="font-semibold text-foreground">{FABLE_MODEL_LABEL}</span></p>
        <div className="flex flex-wrap items-center gap-2">
          {hasScript && (
            <button onClick={() => void runExtract()} disabled={busy} className={items.length ? btnGhost : btnPrimary} data-testid="episode-v2-refs-extract">
              {extracting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              {items.length ? t('ideaV2.refsReextract') : t('ideaV2.refsExtract')}
            </button>
          )}
          {items.length > 0 && (
            <button onClick={() => void runImages()} disabled={busy} className={btnPrimary} data-testid="episode-v2-refs-generate-all">
              {generatingImages ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {t('ideaV2.refsGenerateAll')}
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

      <div className="mt-4 space-y-3">
        {items.map((r) => {
          const showRu = !!ruOn[r.id]
          const value = currentPrompt(r)
          const genBusy = r.imageStatus === 'generating' && generatingImages
          return (
            <div key={r.id} className="rounded-lg border border-border/70 bg-muted/20 p-3 sm:p-4" data-testid={`episode-v2-ref-${r.id}`}>
              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${kindBadge[r.kind] ?? 'bg-muted text-muted-foreground'}`}>{t(`ideaV2.refsKind.${r.kind}`)}</span>
                    <span className="text-sm font-semibold text-foreground" data-testid="episode-v2-ref-label">{r.label}</span>
                    {r.edited && <span className="text-[10px] text-muted-foreground">· {t('ideaV2.refsEdited')}</span>}
                    {savingId === r.id && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
                  </div>
                  {showRu ? (
                    <div className="mt-2 min-h-[96px] whitespace-pre-wrap break-words rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" data-testid="episode-v2-ref-ru">
                      {ruLoading[r.id] ? <span className="inline-flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> {t('ideaV2.refsTranslating')}</span> : (ru[r.id]?.text ?? value)}
                    </div>
                  ) : (
                    <textarea
                      value={value}
                      onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                      onBlur={() => void savePrompt(r)}
                      rows={4}
                      className="mt-2 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
                      data-testid="episode-v2-ref-prompt"
                    />
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button onClick={() => void toggleRu(r)} className={btnGhost} aria-pressed={showRu} data-testid="episode-v2-ref-ru-toggle" title={t('ideaV2.refsRuHint')}>
                      <Languages className="h-3.5 w-3.5" /> {showRu ? 'EN' : 'RU'}
                    </button>
                    <button onClick={() => void copy(r)} className={btnGhost} data-testid="episode-v2-ref-copy">
                      {copiedId === r.id ? <><Check className="h-3.5 w-3.5" /> {t('ideaV2.refsCopied')}</> : <><Copy className="h-3.5 w-3.5" /> {t('ideaV2.refsCopy')}</>}
                    </button>
                    <button onClick={() => void runImages([r.id])} disabled={busy || !value.trim() || drafts[r.id] !== undefined} className={btnMain} data-testid="episode-v2-ref-regenerate" title={drafts[r.id] !== undefined ? t('ideaV2.refsSaveFirst') : undefined}>
                      <RefreshCw className="h-3.5 w-3.5" /> {r.imageUrl ? t('ideaV2.refsRegenerate') : t('ideaV2.refsGenerateOne')}
                    </button>
                  </div>
                  {r.imageStatus === 'failed' && r.imageError && <p className="mt-2 text-xs text-destructive">{t('ideaV2.refsImageFailed')}: {r.imageError}</p>}
                </div>
                <div className="flex w-full flex-shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-background sm:w-[120px]" style={{ aspectRatio: '9 / 16' }} data-testid="episode-v2-ref-thumb">
                  {genBusy ? <Loader2 className="h-5 w-5 animate-spin text-primary" /> : r.imageUrl ? (
                    <a href={r.imageUrl} target="_blank" rel="noreferrer" className="block h-full w-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={r.imageUrl} alt={r.label} className="h-full w-full object-cover" loading="lazy" />
                    </a>
                  ) : <ImageIcon className="h-5 w-5 text-muted-foreground/50" />}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
