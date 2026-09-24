'use client'

/**
 * Stage 234 — "Manual mode" (/manual): two 9:16 tiles (PHOTO → VIDEO) with free English prompts and a
 * history feed of the user's manual generations. Generation prompts are NOT localized (sent as-is).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Camera, Clapperboard, Download, Loader2, Plus, RefreshCw, Send, Trash2, Upload, X, ImageOff, AlertCircle } from 'lucide-react'
import { Header } from '@/components/header'
import { useTranslation } from '@/lib/i18n/context'
import { MANUAL_IMAGE_MODELS, DEFAULT_MANUAL_IMAGE_MODEL_ID, MANUAL_PHOTO_COST, MANUAL_VIDEO_COST_PER_SEC } from '@/lib/manual-image-models'
import { VIDEO_FAMILIES, DEFAULT_VIDEO_MODEL_ID, getVideoModel } from '@/lib/video-models'
import { useJobPolling, JobProgressBar, type JobPollResponse } from '@/app/project/[id]/_components/use-job-polling'

interface ManualItem {
  id: string
  kind: 'photo' | 'video'
  model: string
  mode: string
  prompt: string
  referenceUrls?: string[] | null
  sourceImageUrl?: string | null
  resultUrl?: string | null
  status: string
  jobId?: string | null
  cost: number
  error?: string | null
  createdAt: string
}

const PHOTO_MAX_REFS = 4
const VIDEO_MAX_REFS = 4

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json()
    return typeof data?.error === 'string' ? data.error : fallback
  } catch {
    return fallback
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Reference image slots (upload → S3 or paste URL)                          */
/* ────────────────────────────────────────────────────────────────────────── */
function RefSlots({
  urls,
  onChange,
  max,
  disabled,
  hint,
  testId,
}: {
  urls: string[]
  onChange: (next: string[]) => void
  max: number
  disabled?: boolean
  hint?: string
  testId: string
}) {
  const { t } = useTranslation()
  const [urlInput, setUrlInput] = useState('')
  const [uploading, setUploading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const addUrl = () => {
    const u = urlInput.trim()
    if (!/^https?:\/\//i.test(u)) { setErr(t('manual.invalidUrl')); return }
    if (urls.length >= max || urls.includes(u)) return
    onChange([...urls, u])
    setUrlInput('')
    setErr(null)
  }

  const upload = async (file: File) => {
    setUploading(true)
    setErr(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/manual/upload', { method: 'POST', body: fd })
      if (!res.ok) throw new Error(await readError(res, t('manual.uploadFailed')))
      const data = await res.json()
      if (typeof data?.url === 'string') onChange([...urls, data.url].slice(0, max))
    } catch (e: any) {
      setErr(e?.message || t('manual.uploadFailed'))
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="flex flex-wrap gap-2">
        {urls.map((u) => (
          <span key={u} className="relative block aspect-[9/16] w-14 overflow-hidden rounded bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={u} alt="" className="h-full w-full object-cover" />
            {!disabled && (
              <button type="button" onClick={() => onChange(urls.filter((x) => x !== u))} className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5" title={t('common.delete')}>
                <X className="h-3 w-3" />
              </button>
            )}
          </span>
        ))}
        {urls.length < max && !disabled && (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
            className="flex aspect-[9/16] w-14 flex-col items-center justify-center gap-1 rounded border border-dashed border-border text-[10px] text-muted-foreground hover:border-primary disabled:opacity-50"
            title={t('manual.uploadRef')}
          >
            {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          </button>
        )}
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f) }} />
      </div>
      {urls.length < max && !disabled && (
        <div className="flex gap-1">
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addUrl() } }}
            placeholder={t('manual.pasteUrl')}
            className="min-w-0 flex-1 rounded-lg border border-input bg-background px-2 py-1 text-xs outline-none focus:border-primary"
          />
          <button type="button" onClick={addUrl} className="rounded-lg bg-muted px-2 py-1 text-xs hover:bg-muted/80" disabled={!urlInput.trim()}>
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      {err && <p className="text-[11px] text-destructive">{err}</p>}
    </div>
  )
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Page                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */
export function ManualClient() {
  const { t } = useTranslation()

  // ── photo tile ──
  const [photoPrompt, setPhotoPrompt] = useState('')
  const [photoModel, setPhotoModel] = useState(DEFAULT_MANUAL_IMAGE_MODEL_ID)
  const [photoRefs, setPhotoRefs] = useState<string[]>([])
  const [photoResult, setPhotoResult] = useState<string | null>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [photoSubmitting, setPhotoSubmitting] = useState(false)

  // ── video tile ──
  const [videoPrompt, setVideoPrompt] = useState('')
  const [videoMode, setVideoMode] = useState<'i2v' | 't2v'>('i2v')
  const [videoModelId, setVideoModelId] = useState(DEFAULT_VIDEO_MODEL_ID)
  const [videoDuration, setVideoDuration] = useState(5)
  const [firstFrame, setFirstFrame] = useState<string[]>([])
  const [videoRefs, setVideoRefs] = useState<string[]>([])
  const [videoResult, setVideoResult] = useState<string | null>(null)
  const [videoError, setVideoError] = useState<string | null>(null)
  const [videoSubmitting, setVideoSubmitting] = useState(false)

  // ── history ──
  const [items, setItems] = useState<ManualItem[]>([])
  const [credits, setCredits] = useState<number | null>(null)
  const [historyLoading, setHistoryLoading] = useState(true)

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/manual/history', { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      if (Array.isArray(data?.items)) setItems(data.items)
      if (typeof data?.credits === 'number') setCredits(data.credits)
    } finally {
      setHistoryLoading(false)
    }
  }, [])
  useEffect(() => { loadHistory() }, [loadHistory])

  const photoJob = useJobPolling({
    onFinish: (res: JobPollResponse) => {
      if (res.job.status === 'completed' && typeof res.job.result?.resultUrl === 'string') setPhotoResult(res.job.result.resultUrl)
      else setPhotoError(res.job.error || t('manual.failed'))
      loadHistory()
    },
  })
  const videoJob = useJobPolling({
    onFinish: (res: JobPollResponse) => {
      if (res.job.status === 'completed' && typeof res.job.result?.resultUrl === 'string') setVideoResult(res.job.result.resultUrl)
      else setVideoError(res.job.error || t('manual.failed'))
      loadHistory()
    },
  })

  const videoDef = useMemo(() => getVideoModel(videoModelId), [videoModelId])
  const durationOptions = useMemo(() => {
    if (videoDef.fixedDurations) {
      const opts = videoDef.durations.filter((d) => d >= 4 && d <= 10)
      return opts.length ? opts : [videoDef.durations[0]]
    }
    const [min, max] = videoDef.durations
    const lo = Math.max(4, min), hi = Math.min(10, max)
    const out: number[] = []
    for (let d = lo; d <= hi; d++) out.push(d)
    return out
  }, [videoDef])
  useEffect(() => {
    if (!durationOptions.includes(videoDuration)) setVideoDuration(durationOptions[0])
  }, [durationOptions, videoDuration])
  useEffect(() => {
    if (videoMode === 'i2v' && !videoDef.slugI2V) setVideoMode('t2v')
    if (videoMode === 't2v' && !videoDef.slugT2V) setVideoMode('i2v')
  }, [videoDef, videoMode])

  const videoCost = videoDuration * MANUAL_VIDEO_COST_PER_SEC
  const photoBusy = photoSubmitting || photoJob.isActive
  const videoBusy = videoSubmitting || videoJob.isActive

  const generatePhoto = async () => {
    if (!photoPrompt.trim() || photoBusy) return
    setPhotoError(null)
    setPhotoSubmitting(true)
    try {
      const res = await fetch('/api/manual/photo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: photoPrompt.trim(), model: photoModel, referenceUrls: photoRefs }),
      })
      if (!res.ok) throw new Error(await readError(res, t('manual.failed')))
      const data = await res.json()
      setPhotoResult(null)
      photoJob.start(data.jobId)
      loadHistory()
    } catch (e: any) {
      setPhotoError(e?.message || t('manual.failed'))
    } finally {
      setPhotoSubmitting(false)
    }
  }

  const generateVideo = async () => {
    if (!videoPrompt.trim() || videoBusy) return
    if (videoMode === 'i2v' && !firstFrame[0]) { setVideoError(t('manual.needFirstFrame')); return }
    setVideoError(null)
    setVideoSubmitting(true)
    try {
      const res = await fetch('/api/manual/video', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: videoPrompt.trim(), videoModelId, mode: videoMode, duration: videoDuration,
          sourceImageUrl: videoMode === 'i2v' ? firstFrame[0] : undefined,
          referenceUrls: videoMode === 't2v' ? videoRefs : [],
        }),
      })
      if (!res.ok) throw new Error(await readError(res, t('manual.failed')))
      const data = await res.json()
      setVideoResult(null)
      videoJob.start(data.jobId)
      loadHistory()
    } catch (e: any) {
      setVideoError(e?.message || t('manual.failed'))
    } finally {
      setVideoSubmitting(false)
    }
  }

  const sendToVideo = (url: string) => {
    if (videoMode === 'i2v') setFirstFrame([url])
    else setVideoRefs((prev) => (prev.includes(url) || prev.length >= VIDEO_MAX_REFS ? prev : [...prev, url]))
    document.getElementById('manual-video-tile')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  const deleteItem = async (id: string) => {
    if (!confirm(t('manual.confirmDelete'))) return
    const res = await fetch(`/api/manual/history/${id}`, { method: 'DELETE' })
    if (res.ok) setItems((prev) => prev.filter((i) => i.id !== id))
  }

  const reuseItem = (it: ManualItem) => {
    if (it.kind === 'photo') {
      setPhotoPrompt(it.prompt)
      if (MANUAL_IMAGE_MODELS.some((m) => m.id === it.model)) setPhotoModel(it.model)
      setPhotoRefs(Array.isArray(it.referenceUrls) ? it.referenceUrls.slice(0, PHOTO_MAX_REFS) : [])
      if (it.resultUrl) setPhotoResult(it.resultUrl)
    } else {
      setVideoPrompt(it.prompt)
      setVideoModelId(it.model)
      const mode = it.mode === 'i2v' ? 'i2v' : 't2v'
      setVideoMode(mode)
      if (mode === 'i2v') setFirstFrame(it.sourceImageUrl ? [it.sourceImageUrl] : [])
      else setVideoRefs(Array.isArray(it.referenceUrls) ? it.referenceUrls.slice(0, VIDEO_MAX_REFS) : [])
      if (it.resultUrl) setVideoResult(it.resultUrl)
    }
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const tileBox = 'rounded-xl border border-border bg-card p-4'
  const selectCls = 'w-full rounded-lg border border-input bg-background px-2 py-1.5 text-xs outline-none focus:border-primary'
  const textareaCls = 'w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-xs outline-none focus:border-primary'
  const primaryBtn = 'flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50'
  const smallBtn = 'inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50'

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-[1200px] px-4 py-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <Link href="/dashboard" className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-3.5 w-3.5" /> {t('manual.backToDashboard')}
            </Link>
            <h1 className="font-display text-3xl font-bold tracking-tight"><span className="text-primary">{t('manual.title')}</span></h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('manual.subtitle')}</p>
          </div>
          {credits !== null && <span className="rounded-full bg-muted px-3 py-1 text-xs" data-testid="manual-credits">{t('manual.credits', { n: credits })}</span>}
        </div>

        <div className="grid gap-6 md:grid-cols-2">
          {/* ── PHOTO tile ── */}
          <section className={tileBox} data-testid="manual-photo-tile">
            <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-bold"><Camera className="h-5 w-5 text-primary" /> {t('manual.photoTitle')}</h2>
            <div className="relative mx-auto mb-3 aspect-[9/16] w-full max-w-[18rem] overflow-hidden rounded-lg bg-muted">
              {photoResult ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photoResult} alt="" className="h-full w-full object-cover" data-testid="manual-photo-result" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-muted-foreground/40"><ImageOff className="h-8 w-8" /></div>
              )}
              {photoJob.isActive && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/60"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
              )}
            </div>
            {photoJob.job && photoJob.isActive && <JobProgressBar job={photoJob.job} expectedTotalSec={60} className="mb-3" />}
            {photoResult && !photoBusy && (
              <div className="mb-3 flex flex-wrap justify-center gap-1.5">
                <a href={photoResult} download target="_blank" rel="noreferrer" className={smallBtn}><Download className="h-3.5 w-3.5" /> {t('common.download')}</a>
                <button type="button" onClick={generatePhoto} className={smallBtn}><RefreshCw className="h-3.5 w-3.5" /> {t('manual.regenerate')}</button>
                <button type="button" onClick={() => sendToVideo(photoResult)} className={smallBtn} data-testid="manual-send-to-video"><Send className="h-3.5 w-3.5" /> {t('manual.sendToVideo')}</button>
              </div>
            )}
            <label className="mb-1 block text-xs font-medium">{t('manual.model')}</label>
            <select value={photoModel} onChange={(e) => setPhotoModel(e.target.value)} className={`${selectCls} mb-3`} disabled={photoBusy} data-testid="manual-photo-model">
              {MANUAL_IMAGE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <label className="mb-1 block text-xs font-medium">{t('manual.references')}</label>
            <div className="mb-3">
              <RefSlots urls={photoRefs} onChange={setPhotoRefs} max={PHOTO_MAX_REFS} disabled={photoBusy} hint={t('manual.photoRefsHint')} testId="manual-photo-refs" />
            </div>
            <label className="mb-1 block text-xs font-medium">{t('manual.promptEn')}</label>
            <textarea value={photoPrompt} onChange={(e) => setPhotoPrompt(e.target.value)} rows={4} disabled={photoBusy} placeholder={t('manual.photoPlaceholder')} className={`${textareaCls} mb-3`} data-testid="manual-photo-prompt" />
            {photoError && <p className="mb-2 flex items-center gap-1 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5" /> {photoError}</p>}
            <button type="button" onClick={generatePhoto} disabled={photoBusy || !photoPrompt.trim()} className={`${primaryBtn} w-full`} data-testid="manual-photo-generate">
              {photoBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
              {photoBusy ? t('manual.generating') : t('manual.generateCost', { n: MANUAL_PHOTO_COST })}
            </button>
          </section>

          {/* ── VIDEO tile ── */}
          <section className={tileBox} id="manual-video-tile" data-testid="manual-video-tile">
            <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-bold"><Clapperboard className="h-5 w-5 text-primary" /> {t('manual.videoTitle')}</h2>
            <div className="relative mx-auto mb-3 aspect-[9/16] w-full max-w-[18rem] overflow-hidden rounded-lg bg-muted">
              {videoResult ? (
                <video src={videoResult} controls playsInline className="h-full w-full object-cover" data-testid="manual-video-result" />
              ) : videoMode === 'i2v' && firstFrame[0] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={firstFrame[0]} alt="" className="h-full w-full object-cover opacity-70" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-muted-foreground/40"><Clapperboard className="h-8 w-8" /></div>
              )}
              {videoJob.isActive && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/60"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
              )}
            </div>
            {videoJob.job && videoJob.isActive && <JobProgressBar job={videoJob.job} expectedTotalSec={180} className="mb-3" />}
            {videoResult && !videoBusy && (
              <div className="mb-3 flex flex-wrap justify-center gap-1.5">
                <a href={videoResult} download target="_blank" rel="noreferrer" className={smallBtn}><Download className="h-3.5 w-3.5" /> {t('common.download')}</a>
                <button type="button" onClick={generateVideo} className={smallBtn}><RefreshCw className="h-3.5 w-3.5" /> {t('manual.regenerate')}</button>
              </div>
            )}
            <div className="mb-3 flex rounded-lg border border-border p-0.5 text-xs" data-testid="manual-video-mode">
              {(['i2v', 't2v'] as const).map((m) => {
                const supported = m === 'i2v' ? !!videoDef.slugI2V : !!videoDef.slugT2V
                return (
                  <button key={m} type="button" disabled={videoBusy || !supported} onClick={() => setVideoMode(m)} className={`flex-1 rounded-md px-2 py-1.5 transition disabled:opacity-40 ${videoMode === m ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}>
                    {m === 'i2v' ? t('manual.modeI2V') : t('manual.modeT2V')}
                  </button>
                )
              })}
            </div>
            <div className="mb-3 grid grid-cols-[1fr_auto] gap-2">
              <div>
                <label className="mb-1 block text-xs font-medium">{t('manual.model')}</label>
                <select value={videoModelId} onChange={(e) => setVideoModelId(e.target.value)} className={selectCls} disabled={videoBusy} data-testid="manual-video-model">
                  {VIDEO_FAMILIES.map((f) => (
                    <optgroup key={f.id} label={f.label}>
                      {f.versions.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
                    </optgroup>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium">{t('manual.duration')}</label>
                <select value={videoDuration} onChange={(e) => setVideoDuration(Number(e.target.value))} className={selectCls} disabled={videoBusy} data-testid="manual-video-duration">
                  {durationOptions.map((d) => <option key={d} value={d}>{d}s</option>)}
                </select>
              </div>
            </div>
            {videoMode === 'i2v' ? (
              <>
                <label className="mb-1 block text-xs font-medium">{t('manual.firstFrame')}</label>
                <div className="mb-3"><RefSlots urls={firstFrame} onChange={(n) => setFirstFrame(n.slice(-1))} max={1} disabled={videoBusy} hint={t('manual.firstFrameHint')} testId="manual-first-frame" /></div>
              </>
            ) : (
              <>
                <label className="mb-1 block text-xs font-medium">{t('manual.videoRefs')}</label>
                <div className="mb-3">
                  {videoDef.refImages ? (
                    <RefSlots urls={videoRefs} onChange={setVideoRefs} max={VIDEO_MAX_REFS} disabled={videoBusy} hint={t('manual.videoRefsHint')} testId="manual-video-refs" />
                  ) : (
                    <p className="rounded-lg border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground">{t('manual.noRefsModel')}</p>
                  )}
                </div>
              </>
            )}
            <label className="mb-1 block text-xs font-medium">{t('manual.promptEn')}</label>
            <textarea value={videoPrompt} onChange={(e) => setVideoPrompt(e.target.value)} rows={4} disabled={videoBusy} placeholder={t('manual.videoPlaceholder')} className={`${textareaCls} mb-3`} data-testid="manual-video-prompt" />
            {videoError && <p className="mb-2 flex items-center gap-1 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5" /> {videoError}</p>}
            <button type="button" onClick={generateVideo} disabled={videoBusy || !videoPrompt.trim()} className={`${primaryBtn} w-full`} data-testid="manual-video-generate">
              {videoBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clapperboard className="h-4 w-4" />}
              {videoBusy ? t('manual.generating') : t('manual.generateCost', { n: videoCost })}
            </button>
          </section>
        </div>

        {/* ── History ── */}
        <section className="mt-8" data-testid="manual-history">
          <h2 className="mb-3 font-display text-lg font-bold">{t('manual.history')}</h2>
          {historyLoading ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : items.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{t('manual.historyEmpty')}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {items.map((it) => (
                <div key={it.id} className="flex flex-col overflow-hidden rounded-xl border border-border bg-card" data-testid="manual-history-item">
                  <div className="relative aspect-[9/16] w-full bg-muted">
                    {it.resultUrl && it.kind === 'photo' ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={it.resultUrl} alt="" className="h-full w-full object-cover" />
                    ) : it.resultUrl && it.kind === 'video' ? (
                      <video src={it.resultUrl} controls playsInline preload="metadata" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-muted-foreground/40">
                        {it.status === 'pending' || it.status === 'processing' ? <Loader2 className="h-6 w-6 animate-spin text-primary" /> : <ImageOff className="h-6 w-6" />}
                      </div>
                    )}
                    <span className="absolute left-1.5 top-1.5 rounded bg-background/80 px-1.5 py-0.5 text-[10px] font-medium uppercase">{it.kind === 'photo' ? t('manual.kindPhoto') : t('manual.kindVideo')}</span>
                    <span className={`absolute right-1.5 top-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium ${it.status === 'completed' ? 'bg-emerald-500/20 text-emerald-600' : it.status === 'failed' ? 'bg-destructive/20 text-destructive' : 'bg-background/80'}`}>
                      {t(`manual.status.${['pending', 'processing', 'completed', 'failed'].includes(it.status) ? it.status : 'failed'}`)}
                    </span>
                  </div>
                  <div className="flex flex-1 flex-col gap-1.5 p-2.5">
                    <p className="text-[11px] text-muted-foreground">{it.model} · {it.mode.toUpperCase()} · {it.cost} cr.</p>
                    <p className="line-clamp-3 text-xs" title={it.prompt}>{it.prompt}</p>
                    {it.error && <p className="line-clamp-2 text-[11px] text-destructive" title={it.error}>{it.error}</p>}
                    <div className="mt-auto flex flex-wrap gap-1 pt-1">
                      <button type="button" onClick={() => reuseItem(it)} className={smallBtn} title={t('manual.reuse')}><RefreshCw className="h-3 w-3" /> {t('manual.reuse')}</button>
                      {it.kind === 'photo' && it.resultUrl && (
                        <>
                          <button type="button" onClick={() => setPhotoRefs((p) => (p.includes(it.resultUrl!) || p.length >= PHOTO_MAX_REFS ? p : [...p, it.resultUrl!]))} className={smallBtn} title={t('manual.useAsPhotoRef')}><Plus className="h-3 w-3" /> {t('manual.useAsPhotoRef')}</button>
                          <button type="button" onClick={() => sendToVideo(it.resultUrl!)} className={smallBtn} title={t('manual.sendToVideo')}><Send className="h-3 w-3" /> {t('manual.sendToVideo')}</button>
                        </>
                      )}
                      {it.resultUrl && <a href={it.resultUrl} download target="_blank" rel="noreferrer" className={smallBtn}><Download className="h-3 w-3" /></a>}
                      <button type="button" onClick={() => deleteItem(it.id)} className={`${smallBtn} text-destructive`} title={t('common.delete')}><Trash2 className="h-3 w-3" /></button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
