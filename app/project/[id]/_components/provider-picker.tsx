'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { GENERATION_PROVIDERS, GENERATION_PROVIDER_LABELS, type GenerationProvider, isGenerationProvider } from '@/lib/validations'

/**
 * Stage 73 — «Провайдеры генерации»: two native selects (reference images / scene videos), persisted per
 * project via PATCH /api/ai/projects/[id]/providers. Shown on the project header and next to the episode's
 * «Порядок генерации» control. Keys live in the environment; this only picks the transport.
 */
export function ProviderPicker({ projectId, imageProvider, videoProvider, compact = false, onChange }: {
  projectId: string
  imageProvider?: string | null
  videoProvider?: string | null
  compact?: boolean
  onChange?: (v: { imageProvider: GenerationProvider; videoProvider: GenerationProvider }) => void
}) {
  const [img, setImg] = useState<GenerationProvider>(isGenerationProvider(imageProvider) ? imageProvider : 'replicate')
  const [vid, setVid] = useState<GenerationProvider>(isGenerationProvider(videoProvider) ? videoProvider : 'wavespeed')
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const save = async (patch: { imageProvider?: GenerationProvider; videoProvider?: GenerationProvider }) => {
    const prev = { img, vid }
    if (patch.imageProvider) setImg(patch.imageProvider)
    if (patch.videoProvider) setVid(patch.videoProvider)
    setSaving(true); setNote(null)
    try {
      const res = await fetch(`/api/ai/projects/${projectId}/providers`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'Не удалось сохранить провайдера')
      const next = { imageProvider: isGenerationProvider(data.imageProvider) ? data.imageProvider : prev.img, videoProvider: isGenerationProvider(data.videoProvider) ? data.videoProvider : prev.vid }
      setImg(next.imageProvider); setVid(next.videoProvider)
      onChange?.(next)
      setNote({ kind: 'ok', text: 'Сохранено' })
    } catch (e: any) {
      setImg(prev.img); setVid(prev.vid)
      setNote({ kind: 'error', text: e?.message || 'Ошибка сохранения' })
    } finally {
      setSaving(false)
      setTimeout(() => setNote(null), 2500)
    }
  }

  const selectCls = 'rounded-md border border-border bg-card px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-60'
  const options = GENERATION_PROVIDERS.map((p) => <option key={p} value={p}>{GENERATION_PROVIDER_LABELS[p]}</option>)

  return (
    <div className={compact ? 'inline-flex flex-wrap items-center gap-2' : 'flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card/50 px-3 py-2'} data-testid="provider-picker">
      <span className="text-xs font-medium">Провайдеры генерации:</span>
      <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        Референсы (изображения)
        <select className={selectCls} value={img} disabled={saving} onChange={(e) => save({ imageProvider: e.target.value as GenerationProvider })} data-testid="image-provider-select" aria-label="Провайдер референсов (изображения)">
          {options}
        </select>
      </label>
      <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        Сцены (видео)
        <select className={selectCls} value={vid} disabled={saving} onChange={(e) => save({ videoProvider: e.target.value as GenerationProvider })} data-testid="video-provider-select" aria-label="Провайдер сцен (видео)">
          {options}
        </select>
      </label>
      {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      {note && <span className={`text-xs ${note.kind === 'ok' ? 'text-emerald-600' : 'text-destructive'}`} role="status" data-testid="provider-picker-note">{note.text}</span>}
      {!compact && (
        <p className="w-full text-[11px] text-muted-foreground">Ключи провайдеров задаются в окружении. ModelArk и Replicate имеют собственную модерацию входных изображений.</p>
      )}
    </div>
  )
}
