'use client'

/**
 * Stage 234 — "+ Add frame" on reference cards (characters / locations).
 * Shows the manually added frames (Character/Location.imageExtra) with a Delete button and an empty tile that
 * opens a mini-form: English prompt + photo model + "use the current reference as the base" (i2i). The result is
 * appended to imageExtra via POST /api/manual/reference-frame (1 credit, refunded on failure). Repeatable.
 */
import { useState } from 'react'
import { Loader2, Plus, Trash2, Download, X } from 'lucide-react'
import { useTranslation } from '@/lib/i18n/context'
import { MANUAL_IMAGE_MODELS, DEFAULT_MANUAL_IMAGE_MODEL_ID, MANUAL_PHOTO_COST } from '@/lib/manual-image-models'

export function AddFrameTile({
  kind,
  id,
  frames,
  hasBase,
  disabled,
  onChanged,
}: {
  kind: 'character' | 'location'
  id: string
  /** Manually added / extra frame URLs currently stored in imageExtra. */
  frames: string[]
  /** Whether the card has a main image that can serve as the i2i base. */
  hasBase: boolean
  disabled?: boolean
  /** Called with the fresh imageExtra JSON after an append / delete. */
  onChanged: (imageExtra: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState(DEFAULT_MANUAL_IMAGE_MODEL_ID)
  const [useBase, setUseBase] = useState(true)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const generate = async () => {
    if (!prompt.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/manual/reference-frame', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, id, prompt: prompt.trim(), model, useBase: useBase && hasBase }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : t('manual.failed'))
      if (typeof data?.imageExtra === 'string') onChanged(data.imageExtra)
      setPrompt('')
      setOpen(false)
    } catch (e: any) {
      setError(e?.message || t('manual.failed'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (url: string) => {
    if (!confirm(t('refs.addFrameConfirmDelete'))) return
    setDeleting(url)
    try {
      const res = await fetch('/api/manual/reference-frame', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, id, url }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && typeof data?.imageExtra === 'string') onChanged(data.imageExtra)
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="mt-3 border-t border-border/60 pt-3" data-testid={`add-frame-${kind}`}>
      <div className="flex flex-wrap gap-2">
        {frames.map((url, i) => (
          <span key={url} className="group relative block aspect-[9/16] w-24 overflow-hidden rounded bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={`frame ${i + 1}`} className="h-full w-full object-cover" />
            <span className="absolute inset-x-0 bottom-0 flex justify-center gap-1 bg-background/80 p-1 opacity-0 transition group-hover:opacity-100">
              <a href={url} download target="_blank" rel="noreferrer" className="rounded p-0.5 hover:bg-muted" title={t('common.download')}><Download className="h-3 w-3" /></a>
              <button type="button" onClick={() => remove(url)} disabled={!!deleting || disabled} className="rounded p-0.5 text-destructive hover:bg-muted disabled:opacity-50" title={t('refs.addFrameDelete')} data-testid="add-frame-delete">
                {deleting === url ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              </button>
            </span>
          </span>
        ))}
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={disabled || busy}
            className="flex aspect-[9/16] w-24 flex-col items-center justify-center gap-1 rounded border border-dashed border-border text-[11px] text-muted-foreground transition hover:border-primary hover:text-foreground disabled:opacity-50"
            data-testid="add-frame-open"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            <span className="px-1 text-center leading-tight">{t('refs.addFrame')}</span>
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 space-y-2 rounded-lg border border-border bg-background/60 p-2" data-testid="add-frame-form">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">{t('refs.addFrameTitle')}</span>
            <button type="button" onClick={() => setOpen(false)} disabled={busy} className="rounded p-0.5 hover:bg-muted" title={t('common.close')}><X className="h-3.5 w-3.5" /></button>
          </div>
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy} className="w-full rounded-lg border border-input bg-background px-2 py-1 text-xs outline-none focus:border-primary">
            {MANUAL_IMAGE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <label className="flex items-center gap-2 text-[11px]">
            <input type="checkbox" checked={useBase && hasBase} disabled={!hasBase || busy} onChange={(e) => setUseBase(e.target.checked)} />
            {t('refs.addFrameUseBase')}
          </label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            disabled={busy}
            placeholder={t('refs.addFramePlaceholder')}
            className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-xs outline-none focus:border-primary"
            data-testid="add-frame-prompt"
          />
          {error && <p className="text-[11px] text-destructive">{error}</p>}
          <button
            type="button"
            onClick={generate}
            disabled={busy || !prompt.trim()}
            className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
            data-testid="add-frame-generate"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            {busy ? t('manual.generating') : t('refs.addFrameGenerate', { n: MANUAL_PHOTO_COST })}
          </button>
        </div>
      )}
    </div>
  )
}
