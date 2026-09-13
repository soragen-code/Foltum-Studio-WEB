'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { GENERATION_PROVIDERS, GENERATION_PROVIDER_LABELS, type GenerationProvider, isGenerationProvider } from '@/lib/validations'

/**
 * Stage 73/74 — «Провайдер»: ONE native select for a single kind (reference images OR scene videos),
 * persisted per project via PATCH /api/ai/projects/[id]/providers (only the changed field is sent).
 * Stage 74 moved the pickers: the image picker lives on the references stage, the video picker on the
 * scenes stage and next to the episode's «Порядок генерации» control. The model itself is fixed and
 * shown as plain text (images → Seedream 5.0 Pro, video → Seedance 2.5) — there is NO model selector.
 * Keys live in the environment; this only picks the transport.
 */
export type ProviderPickerKind = 'image' | 'video'

const KIND_META: Record<ProviderPickerKind, { title: string; model: string; field: 'imageProvider' | 'videoProvider'; fallback: GenerationProvider }> = {
  image: { title: 'Провайдер референсов', model: 'Seedream 5.0 Pro', field: 'imageProvider', fallback: 'replicate' },
  video: { title: 'Провайдер сцен', model: 'Seedance 2.5', field: 'videoProvider', fallback: 'wavespeed' },
}

export function ProviderPicker({ kind, projectId, value, compact = false, onChange }: {
  kind: ProviderPickerKind
  projectId: string
  /** Current provider for this kind (project.imageProvider / project.videoProvider). */
  value?: string | null
  compact?: boolean
  onChange?: (provider: GenerationProvider) => void
}) {
  const meta = KIND_META[kind]
  const [cur, setCur] = useState<GenerationProvider>(isGenerationProvider(value) ? value : meta.fallback)
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const save = async (next: GenerationProvider) => {
    const prev = cur
    setCur(next)
    setSaving(true); setNote(null)
    try {
      const res = await fetch(`/api/ai/projects/${projectId}/providers`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [meta.field]: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'Не удалось сохранить провайдера')
      const saved: GenerationProvider = isGenerationProvider(data?.[meta.field]) ? data[meta.field] : next
      setCur(saved)
      onChange?.(saved)
      setNote({ kind: 'ok', text: 'Сохранено' })
    } catch (e: any) {
      setCur(prev)
      setNote({ kind: 'error', text: e?.message || 'Ошибка сохранения' })
    } finally {
      setSaving(false)
      setTimeout(() => setNote(null), 2500)
    }
  }

  const selectCls = 'rounded-md border border-border bg-card px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-60'
  const selectId = `provider-select-${kind}-${projectId}`

  return (
    <div
      className={compact ? 'inline-flex flex-wrap items-center gap-2' : 'flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/50 px-3 py-2'}
      data-testid={`provider-picker-${kind}`}
    >
      <label className="text-xs font-medium" htmlFor={selectId}>{meta.title}:</label>
      <select
        id={selectId}
        className={selectCls}
        value={cur}
        disabled={saving}
        onChange={(e) => save(e.target.value as GenerationProvider)}
        data-testid={`${kind}-provider-select`}
        aria-label={meta.title}
      >
        {GENERATION_PROVIDERS.map((p) => <option key={p} value={p}>{GENERATION_PROVIDER_LABELS[p]}</option>)}
      </select>
      {/* Fixed model — plain text, deliberately not selectable. */}
      <span className="text-xs text-muted-foreground" data-testid={`provider-picker-${kind}-model`}>Модель: {meta.model}</span>
      {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      {note && <span className={`text-xs ${note.kind === 'ok' ? 'text-emerald-600' : 'text-destructive'}`} role="status" data-testid="provider-picker-note">{note.text}</span>}
    </div>
  )
}
