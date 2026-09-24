'use client'

/**
 * Stage 234h — "Location Generator" (/manual, third block).
 *
 * Generates four consistent 9:16 plates of one location — FRONT (text-to-image) first, then BACK / LEFT / RIGHT
 * as image-edits that use the FRONT plate as the reference image (so the four views stay one continuous room).
 * Each plate is a real manual photo job (reuses /api/manual/photo → runManualJob), so it runs server-side and is
 * resumable. The location can be saved as an entity and reused from the video-prompt builder.
 *
 * IMPORTANT: the English prompt templates below are sent to the provider verbatim (NOT localized). Only the UI
 * chrome is localized. Reference chaining passes the FRONT plate's stored S3 URL directly — it never depends on
 * the (separate, still-buggy) manual reference-image upload endpoint.
 */
import { useCallback, useMemo, useState } from 'react'
import { usePersistentState } from '@/lib/use-persistent-state'
import { AlertCircle, Copy, Check, Download, Loader2, MapPin, RefreshCw, Save, Trash2, X } from 'lucide-react'
import { useTranslation } from '@/lib/i18n/context'
import { MANUAL_IMAGE_MODELS, DEFAULT_MANUAL_IMAGE_MODEL_ID, MANUAL_PHOTO_COST } from '@/lib/manual-image-models'

export interface ManualLocation {
  id: string
  name: string
  description: string
  frontLabel: string
  backLabel: string
  leftLabel: string
  rightLabel: string
  frontUrl?: string | null
  backUrl?: string | null
  leftUrl?: string | null
  rightUrl?: string | null
  createdAt: string
}

type PlateKind = 'front' | 'back' | 'left' | 'right'
const PLATE_ORDER: PlateKind[] = ['front', 'back', 'left', 'right']

/* ── English prompt templates (verbatim, NOT localized) ─────────────────────── */
function frontPrompt(front: string, back: string, left: string, right: string, description: string): string {
  return `Empty location, no people. Camera at the center of the space, eye level, wide shot, looking toward ${front}.
${description}
In this view: ${front} is centered. ${left} is on the left edge of frame, ${right} on the right edge.
No text, watermarks, split screen.`
}
function sidePrompt(rotation: string, target: string, edgeRule: string): string {
  return `Same location as the reference image, same lighting and time of day, no people. Camera at the exact same point in the center of the space, eye level, wide shot, turned ${rotation} from the reference view, now looking toward ${target}.
Walls, floor, materials and fixtures continuous with the reference; no new doors, gates, windows or passages. ${edgeRule}
No text, watermarks, split screen.`
}
/** Copy-able reference block for the video-prompt builder (verbatim). */
export function buildReferenceBlock(loc: {
  frontLabel: string; backLabel: string; leftLabel: string; rightLabel: string
}, n: number): string {
  return `Location, one room, four walls: ${loc.frontLabel} — image ${n}; ${loc.backLabel}, opposite — image ${n + 1}; ${loc.leftLabel}, left side — image ${n + 2}; ${loc.rightLabel}, right side — image ${n + 3}. No new doors or openings.`
}

async function readError(res: Response, fallback: string): Promise<string> {
  try { const d = await res.json(); return typeof d?.error === 'string' ? d.error : fallback } catch { return fallback }
}

export function LocationGenerator({
  locations,
  reloadLocations,
  onUseInVideo,
}: {
  locations: ManualLocation[]
  reloadLocations: () => void
  onUseInVideo: (loc: ManualLocation, n: number) => void
}) {
  const { t } = useTranslation()

  const [name, setName] = usePersistentState('foltum.location.name', '')
  const [description, setDescription] = usePersistentState('foltum.location.description', '')
  const [frontLabel, setFrontLabel] = usePersistentState('foltum.location.frontLabel', '')
  const [backLabel, setBackLabel] = usePersistentState('foltum.location.backLabel', '')
  const [leftLabel, setLeftLabel] = usePersistentState('foltum.location.leftLabel', '')
  const [rightLabel, setRightLabel] = usePersistentState('foltum.location.rightLabel', '')
  const [model, setModel] = usePersistentState('foltum.location.model', DEFAULT_MANUAL_IMAGE_MODEL_ID)
  const [refIndex, setRefIndex] = usePersistentState('foltum.location.refIndex', 2)

  const [urls, setUrls] = usePersistentState<Record<PlateKind, string | null>>('foltum.location.urls', { front: null, back: null, left: null, right: null })
  const [busy, setBusy] = useState<Record<PlateKind, boolean>>({ front: false, back: false, left: false, right: false })
  const [error, setError] = useState<string | null>(null)
  const [savedId, setSavedId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [plateLightbox, setPlateLightbox] = useState<string | null>(null)

  const anyBusy = busy.front || busy.back || busy.left || busy.right
  const labelsReady = !!(frontLabel.trim() && backLabel.trim() && leftLabel.trim() && rightLabel.trim())

  const plateLabel = useCallback((k: PlateKind) => {
    switch (k) {
      case 'front': return frontLabel
      case 'back': return backLabel
      case 'left': return leftLabel
      case 'right': return rightLabel
    }
  }, [frontLabel, backLabel, leftLabel, rightLabel])

  const promptFor = useCallback((k: PlateKind): string => {
    const f = frontLabel.trim(), b = backLabel.trim(), l = leftLabel.trim(), r = rightLabel.trim(), d = description.trim()
    if (k === 'front') return frontPrompt(f, b, l, r, d)
    if (k === 'back') return sidePrompt('180°', b, 'Objects on the left edge of the reference are now on the right edge, and vice versa.')
    if (k === 'left') return sidePrompt('90° left', l, 'The left edge of the reference is now the right edge of this view.')
    return sidePrompt('90° right', r, 'The right edge of the reference is now the left edge of this view.')
  }, [frontLabel, backLabel, leftLabel, rightLabel, description])

  /** Poll GET /api/jobs/[id] until terminal; resolve with the completed resultUrl or throw. */
  const pollJob = useCallback(async (jobId: string): Promise<string> => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000))
      let job: any
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' })
        if (res.status === 404) throw new Error(t('manual.loc.plateFailed'))
        const data = await res.json()
        job = data?.job
      } catch (e: any) {
        // transient network error — keep polling
        continue
      }
      if (!job) continue
      if (job.status === 'completed') {
        const url = job.result?.resultUrl
        if (typeof url === 'string' && url) return url
        throw new Error(t('manual.loc.plateFailed'))
      }
      if (job.status === 'failed' || job.status === 'canceled') throw new Error(job.error || t('manual.loc.plateFailed'))
    }
  }, [t])

  /** Generate one plate through the manual photo pipeline; returns its stored S3 URL. */
  const genPlate = useCallback(async (k: PlateKind, referenceUrls: string[]): Promise<string> => {
    const res = await fetch('/api/manual/photo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: promptFor(k), model, referenceUrls }),
    })
    if (!res.ok) throw new Error(await readError(res, t('manual.loc.plateFailed')))
    const data = await res.json()
    return pollJob(data.jobId)
  }, [promptFor, model, pollJob, t])

  const generateAll = useCallback(async () => {
    if (!labelsReady || anyBusy) return
    setError(null)
    setSavedId(null)
    setUrls({ front: null, back: null, left: null, right: null })
    setBusy({ front: true, back: true, left: true, right: true })
    try {
      // 1) FRONT first (text-to-image) — its result is the reference for the other three.
      const front = await genPlate('front', [])
      setUrls((u) => ({ ...u, front }))
      setBusy((b) => ({ ...b, front: false }))
      // 2) BACK / LEFT / RIGHT sequentially (image-edit, reference = FRONT plate).
      for (const k of ['back', 'left', 'right'] as PlateKind[]) {
        try {
          const url = await genPlate(k, [front])
          setUrls((u) => ({ ...u, [k]: url }))
        } catch (e: any) {
          setError(e?.message || t('manual.loc.plateFailed'))
        } finally {
          setBusy((b) => ({ ...b, [k]: false }))
        }
      }
    } catch (e: any) {
      setError(e?.message || t('manual.loc.plateFailed'))
      setBusy({ front: false, back: false, left: false, right: false })
    }
  }, [labelsReady, anyBusy, genPlate, t])

  const regenPlate = useCallback(async (k: PlateKind) => {
    if (anyBusy) return
    if (k !== 'front' && !urls.front) { setError(t('manual.loc.needFrontFirst')); return }
    setError(null)
    setBusy((b) => ({ ...b, [k]: true }))
    try {
      const refs = k === 'front' ? [] : [urls.front as string]
      const url = await genPlate(k, refs)
      setUrls((u) => ({ ...u, [k]: url }))
    } catch (e: any) {
      setError(e?.message || t('manual.loc.plateFailed'))
    } finally {
      setBusy((b) => ({ ...b, [k]: false }))
    }
  }, [anyBusy, urls.front, genPlate, t])

  const save = useCallback(async () => {
    if (!name.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      const payload = {
        name: name.trim(), description: description.trim(),
        frontLabel: frontLabel.trim(), backLabel: backLabel.trim(), leftLabel: leftLabel.trim(), rightLabel: rightLabel.trim(),
        frontUrl: urls.front, backUrl: urls.back, leftUrl: urls.left, rightUrl: urls.right,
      }
      const res = savedId
        ? await fetch(`/api/manual/locations/${savedId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        : await fetch('/api/manual/locations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!res.ok) throw new Error(await readError(res, t('manual.loc.saveFailed')))
      const data = await res.json()
      if (data?.location?.id) setSavedId(data.location.id)
      reloadLocations()
    } catch (e: any) {
      setError(e?.message || t('manual.loc.saveFailed'))
    } finally {
      setSaving(false)
    }
  }, [name, description, frontLabel, backLabel, leftLabel, rightLabel, urls, savedId, saving, reloadLocations, t])

  const loadLocation = useCallback((loc: ManualLocation) => {
    setSavedId(loc.id)
    setName(loc.name)
    setDescription(loc.description || '')
    setFrontLabel(loc.frontLabel || '')
    setBackLabel(loc.backLabel || '')
    setLeftLabel(loc.leftLabel || '')
    setRightLabel(loc.rightLabel || '')
    setUrls({ front: loc.frontUrl || null, back: loc.backUrl || null, left: loc.leftUrl || null, right: loc.rightUrl || null })
    setError(null)
  }, [])

  const deleteLocation = useCallback(async (id: string) => {
    if (!confirm(t('manual.loc.confirmDelete'))) return
    const res = await fetch(`/api/manual/locations/${id}`, { method: 'DELETE' })
    if (res.ok) {
      if (savedId === id) setSavedId(null)
      reloadLocations()
    }
  }, [savedId, reloadLocations, t])

  const newLocation = useCallback(() => {
    setSavedId(null); setName(''); setDescription('')
    setFrontLabel(''); setBackLabel(''); setLeftLabel(''); setRightLabel('')
    setUrls({ front: null, back: null, left: null, right: null }); setError(null)
  }, [])

  const referenceBlock = useMemo(
    () => buildReferenceBlock({ frontLabel, backLabel, leftLabel, rightLabel }, refIndex),
    [frontLabel, backLabel, leftLabel, rightLabel, refIndex],
  )

  const copyBlock = useCallback(async () => {
    try { await navigator.clipboard.writeText(referenceBlock); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* ignore */ }
  }, [referenceBlock])

  const downloadAll = useCallback(() => {
    PLATE_ORDER.forEach((k, i) => {
      const url = urls[k]
      if (!url) return
      setTimeout(() => {
        const a = document.createElement('a')
        a.href = url; a.download = `${(name.trim() || 'location')}-${k}.png`; a.target = '_blank'; a.rel = 'noreferrer'
        document.body.appendChild(a); a.click(); a.remove()
      }, i * 350)
    })
  }, [urls, name])

  const hasAnyPlate = !!(urls.front || urls.back || urls.left || urls.right)

  const tileBox = 'rounded-xl border border-border bg-card p-4'
  const selectCls = 'w-full rounded-lg border border-input bg-background px-2 py-1.5 text-xs outline-none focus:border-primary'
  const inputCls = 'w-full rounded-lg border border-input bg-background px-3 py-2 text-xs outline-none focus:border-primary'
  const textareaCls = 'w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-xs outline-none focus:border-primary'
  const primaryBtn = 'flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50'
  const smallBtn = 'inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50'

  const totalCost = MANUAL_PHOTO_COST * 4

  return (
    <section className={`${tileBox} mt-6`} id="manual-location-tile" data-testid="manual-location-tile">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-display text-lg font-bold"><MapPin className="h-5 w-5 text-primary" /> {t('manual.loc.title')}</h2>
        {savedId && <button type="button" onClick={newLocation} className={smallBtn} disabled={anyBusy}>{t('manual.loc.new')}</button>}
      </div>
      <p className="mb-4 text-xs text-muted-foreground">{t('manual.loc.subtitle')}</p>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_1fr]">
        {/* ── Inputs ── */}
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium">{t('manual.loc.name')}</label>
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={anyBusy} placeholder={t('manual.loc.namePlaceholder')} className={inputCls} data-testid="manual-loc-name" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">{t('manual.loc.description')}</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} disabled={anyBusy} placeholder={t('manual.loc.descriptionPlaceholder')} className={textareaCls} data-testid="manual-loc-description" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium">{t('manual.loc.front')}</label>
              <input value={frontLabel} onChange={(e) => setFrontLabel(e.target.value)} disabled={anyBusy} placeholder={t('manual.loc.frontPlaceholder')} className={inputCls} data-testid="manual-loc-front" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">{t('manual.loc.back')}</label>
              <input value={backLabel} onChange={(e) => setBackLabel(e.target.value)} disabled={anyBusy} placeholder={t('manual.loc.backPlaceholder')} className={inputCls} data-testid="manual-loc-back" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">{t('manual.loc.left')}</label>
              <input value={leftLabel} onChange={(e) => setLeftLabel(e.target.value)} disabled={anyBusy} placeholder={t('manual.loc.leftPlaceholder')} className={inputCls} data-testid="manual-loc-left" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">{t('manual.loc.right')}</label>
              <input value={rightLabel} onChange={(e) => setRightLabel(e.target.value)} disabled={anyBusy} placeholder={t('manual.loc.rightPlaceholder')} className={inputCls} data-testid="manual-loc-right" />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">{t('manual.model')}</label>
            <select value={model} onChange={(e) => setModel(e.target.value)} className={selectCls} disabled={anyBusy} data-testid="manual-loc-model">
              {MANUAL_IMAGE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
          {error && <p className="flex items-center gap-1 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5" /> {error}</p>}
          <button type="button" onClick={generateAll} disabled={anyBusy || !labelsReady} className={`${primaryBtn} w-full`} data-testid="manual-loc-generate">
            {anyBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MapPin className="h-4 w-4" />}
            {anyBusy ? t('manual.generating') : t('manual.loc.generateCost', { n: totalCost })}
          </button>
          <p className="text-[11px] text-muted-foreground">{t('manual.loc.sequenceHint')}</p>
        </div>

        {/* ── Plates 2×2 ── */}
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {PLATE_ORDER.map((k) => (
              <div key={k} className="space-y-1.5" data-testid={`manual-loc-plate-${k}`}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">{t(`manual.loc.${k}`)}{plateLabel(k).trim() ? ` · ${plateLabel(k).trim()}` : ''}</span>
                </div>
                <div className="relative aspect-[9/16] w-full overflow-hidden rounded-lg bg-muted">
                  {urls[k] ? (
                    <button type="button" onClick={() => setPlateLightbox(urls[k])} className="group block h-full w-full" title={t('manual.openFullscreen')}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={urls[k] as string} alt={k} className="h-full w-full object-cover transition group-hover:brightness-90" />
                    </button>
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-muted-foreground/40">
                      {busy[k] ? <Loader2 className="h-6 w-6 animate-spin text-primary" /> : <MapPin className="h-6 w-6" />}
                    </div>
                  )}
                  {urls[k] && busy[k] && <div className="absolute inset-0 flex items-center justify-center bg-background/60"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>}
                </div>
                <button type="button" onClick={() => regenPlate(k)} disabled={anyBusy || (k !== 'front' && !urls.front)} className={`${smallBtn} w-full justify-center`} data-testid={`manual-loc-regen-${k}`}>
                  <RefreshCw className="h-3 w-3" /> {t('manual.loc.regenPlate')}
                </button>
              </div>
            ))}
          </div>

          {/* Reference block + actions */}
          <div className="rounded-lg border border-border p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <label className="text-xs font-medium">{t('manual.loc.refBlock')}</label>
              <div className="flex items-center gap-1.5">
                <label className="text-[11px] text-muted-foreground">{t('manual.loc.startImage')}</label>
                <input type="number" min={1} max={20} value={refIndex} onChange={(e) => setRefIndex(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} className="w-14 rounded-lg border border-input bg-background px-2 py-1 text-xs outline-none focus:border-primary" data-testid="manual-loc-refindex" />
              </div>
            </div>
            <textarea readOnly value={referenceBlock} rows={3} className={`${textareaCls} mb-2`} data-testid="manual-loc-refblock" />
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={copyBlock} className={smallBtn}>{copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />} {copied ? t('manual.loc.copied') : t('manual.loc.copyBlock')}</button>
              <button type="button" onClick={downloadAll} disabled={!hasAnyPlate} className={smallBtn}><Download className="h-3.5 w-3.5" /> {t('manual.loc.downloadAll')}</button>
              <button type="button" onClick={save} disabled={saving || !name.trim()} className={smallBtn} data-testid="manual-loc-save">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} {savedId ? t('manual.loc.update') : t('manual.loc.save')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Saved locations ── */}
      {locations.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-sm font-semibold">{t('manual.loc.saved')}</h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {locations.map((loc) => (
              <div key={loc.id} className="flex items-center gap-2 rounded-lg border border-border bg-background p-2" data-testid="manual-loc-saved-item">
                <div className="flex -space-x-2">
                  {[loc.frontUrl, loc.backUrl].filter(Boolean).slice(0, 2).map((u, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={i} src={u as string} alt="" className="h-9 w-9 rounded border border-card object-cover" />
                  ))}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium" title={loc.name}>{loc.name}</p>
                  <p className="truncate text-[11px] text-muted-foreground">{loc.frontLabel} · {loc.backLabel} · {loc.leftLabel} · {loc.rightLabel}</p>
                </div>
                <div className="flex flex-shrink-0 flex-col gap-1">
                  <button type="button" onClick={() => loadLocation(loc)} className={smallBtn} title={t('manual.loc.load')}><RefreshCw className="h-3 w-3" /></button>
                  <button type="button" onClick={() => onUseInVideo(loc, refIndex)} className={smallBtn} title={t('manual.loc.useInVideo')}><MapPin className="h-3 w-3" /></button>
                  <button type="button" onClick={() => deleteLocation(loc.id)} className={`${smallBtn} text-destructive`} title={t('manual.loc.delete')}><Trash2 className="h-3 w-3" /></button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Plate lightbox ── */}
      {plateLightbox && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4" onClick={() => setPlateLightbox(null)} data-testid="manual-loc-lightbox">
          <button type="button" onClick={() => setPlateLightbox(null)} aria-label={t('manual.viewerClose')} className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20">
            <X className="h-5 w-5" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={plateLightbox} alt="" className="max-h-[90vh] max-w-[95vw] rounded-lg object-contain" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </section>
  )
}
