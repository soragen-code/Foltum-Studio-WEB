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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePersistentState } from '@/lib/use-persistent-state'
import { AlertCircle, Copy, Check, Download, Loader2, MapPin, RefreshCw, Save, Trash2, X } from 'lucide-react'
import { useTranslation } from '@/lib/i18n/context'
import { DEFAULT_MANUAL_IMAGE_MODEL_ID, MANUAL_PHOTO_COST } from '@/lib/manual-image-models'

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
/** FRONT plate — text-to-image master. Generic front-wall wording (no per-wall labels). */
function frontPrompt(description: string): string {
  return `Empty location, no people. Camera at the center of the space, eye level, wide shot, looking toward the front wall.
${description}
The front wall is centered; the left wall is on the left edge of frame, the right wall on the right edge.
No text, watermarks, split screen.`
}
/** BACK / LEFT / RIGHT plates — image-edit from the FRONT plate. Generic wall wording. */
function sidePrompt(rotation: string, target: string, edgeRule: string): string {
  return `Same location as the reference image, same lighting and time of day, no people. Camera at the exact same point in the center of the space, eye level, wide shot, turned ${rotation} from the reference view, now looking toward the ${target} wall.
Walls, floor, materials and fixtures continuous with the reference; no new doors, gates, windows or passages. ${edgeRule}
No text, watermarks, split screen.`
}
/** Copy-able reference block for the video-prompt builder (verbatim, generic wall wording). */
export function buildReferenceBlock(n: number): string {
  return `Location, one room, four walls: front wall — image ${n}; back wall, opposite — image ${n + 1}; left wall, left side — image ${n + 2}; right wall, right side — image ${n + 3}. No new doors or openings.`
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

  // Stage 234j — the ONLY user input is the description. Model is defaulted internally.
  const [description, setDescription] = usePersistentState('foltum.location.description', '')
  const [refIndex, setRefIndex] = usePersistentState('foltum.location.refIndex', 2)

  const [urls, setUrls] = usePersistentState<Record<PlateKind, string | null>>('foltum.location.urls', { front: null, back: null, left: null, right: null })
  const [busy, setBusy] = useState<Record<PlateKind, boolean>>({ front: false, back: false, left: false, right: false })
  const [error, setError] = useState<string | null>(null)
  const [savedId, setSavedId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [plateLightbox, setPlateLightbox] = useState<string | null>(null)

  // Stage 234j — drop stale drafts for fields removed from the simplified form so nothing stale is read back.
  useEffect(() => {
    if (typeof window === 'undefined') return
    for (const k of ['name', 'frontLabel', 'backLabel', 'leftLabel', 'rightLabel', 'model']) {
      try { window.localStorage.removeItem(`foltum.location.${k}`) } catch { /* ignore */ }
    }
  }, [])

  const anyBusy = busy.front || busy.back || busy.left || busy.right
  const descriptionReady = !!description.trim()

  const promptFor = useCallback((k: PlateKind): string => {
    const d = description.trim()
    if (k === 'front') return frontPrompt(d)
    if (k === 'back') return sidePrompt('180°', 'back', 'Objects on the left edge of the reference are now on the right edge, and vice versa.')
    if (k === 'left') return sidePrompt('90° left', 'left', 'The left edge of the reference is now the right edge of this view.')
    return sidePrompt('90° right', 'right', 'The right edge of the reference is now the left edge of this view.')
  }, [description])

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
      body: JSON.stringify({ prompt: promptFor(k), model: DEFAULT_MANUAL_IMAGE_MODEL_ID, referenceUrls }),
    })
    if (!res.ok) throw new Error(await readError(res, t('manual.loc.plateFailed')))
    const data = await res.json()
    return pollJob(data.jobId)
  }, [promptFor, pollJob, t])

  const generateAll = useCallback(async () => {
    if (!descriptionReady || anyBusy) return
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
  }, [descriptionReady, anyBusy, genPlate, t])

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

  /** Derive an entity name from the description (first ~40 chars), or a dated fallback. */
  const derivedName = useCallback((): string => {
    const d = description.trim().replace(/\s+/g, ' ')
    if (d) return d.length > 40 ? `${d.slice(0, 40).trim()}…` : d
    return `${t('manual.loc.defaultName')} ${new Date().toLocaleDateString()}`
  }, [description, t])

  const save = useCallback(async () => {
    if (saving || !description.trim()) return
    setSaving(true)
    setError(null)
    try {
      // No name/label inputs anymore — derive a name and store generic wall labels.
      const payload = {
        name: derivedName(), description: description.trim(),
        frontLabel: 'front', backLabel: 'back', leftLabel: 'left', rightLabel: 'right',
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
  }, [description, derivedName, urls, savedId, saving, reloadLocations, t])

  const loadLocation = useCallback((loc: ManualLocation) => {
    setSavedId(loc.id)
    setDescription(loc.description || '')
    setUrls({ front: loc.frontUrl || null, back: loc.backUrl || null, left: loc.leftUrl || null, right: loc.rightUrl || null })
    setError(null)
  }, [setDescription, setUrls])

  const deleteLocation = useCallback(async (id: string) => {
    if (!confirm(t('manual.loc.confirmDelete'))) return
    const res = await fetch(`/api/manual/locations/${id}`, { method: 'DELETE' })
    if (res.ok) {
      if (savedId === id) setSavedId(null)
      reloadLocations()
    }
  }, [savedId, reloadLocations, t])

  const newLocation = useCallback(() => {
    setSavedId(null); setDescription('')
    setUrls({ front: null, back: null, left: null, right: null }); setError(null)
  }, [setDescription, setUrls])

  const referenceBlock = useMemo(() => buildReferenceBlock(refIndex), [refIndex])

  const copyBlock = useCallback(async () => {
    try { await navigator.clipboard.writeText(referenceBlock); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* ignore */ }
  }, [referenceBlock])

  const downloadAll = useCallback(() => {
    PLATE_ORDER.forEach((k, i) => {
      const url = urls[k]
      if (!url) return
      setTimeout(() => {
        const a = document.createElement('a')
        a.href = url; a.download = `location-${k}.png`; a.target = '_blank'; a.rel = 'noreferrer'
        document.body.appendChild(a); a.click(); a.remove()
      }, i * 350)
    })
  }, [urls])

  const hasAnyPlate = !!(urls.front || urls.back || urls.left || urls.right)

  const tileBox = 'rounded-xl border border-border bg-card p-4'
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
        {/* ── Input (description only) ── */}
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium">{t('manual.loc.description')}</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={6} disabled={anyBusy} placeholder={t('manual.loc.descriptionPlaceholder')} className={textareaCls} data-testid="manual-loc-description" />
          </div>
          {error && <p className="flex items-center gap-1 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5" /> {error}</p>}
          <button type="button" onClick={generateAll} disabled={anyBusy || !descriptionReady} className={`${primaryBtn} w-full`} data-testid="manual-loc-generate">
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
                  <span className="text-xs font-medium">{t(`manual.loc.${k}`)}</span>
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
              <button type="button" onClick={save} disabled={saving || !descriptionReady} className={smallBtn} data-testid="manual-loc-save">
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
                  {loc.description && <p className="truncate text-[11px] text-muted-foreground" title={loc.description}>{loc.description}</p>}
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
