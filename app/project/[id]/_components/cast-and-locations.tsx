'use client'

import { useState } from 'react'
import { Loader2, Wand2, Pencil, X, MapPin, Users } from 'lucide-react'

/** Cast tiers (mirrors lib/idea.ts CHARACTER_TIERS — kept client-side to avoid pulling server deps). */
export const TIERS = ['MAIN', 'SUPPORTING', 'MINOR', 'CROWD'] as const
export type Tier = (typeof TIERS)[number]
export const TIER_LABELS: Record<Tier, string> = {
  MAIN: 'Главные',
  SUPPORTING: 'Второстепенные (семья, окружение)',
  MINOR: 'Эпизодические',
  CROWD: 'Массовка и группы',
}
export function tierOf(c: { tier?: string | null }): Tier {
  const t = (c.tier ?? 'MAIN').toUpperCase()
  return (TIERS as readonly string[]).includes(t) ? (t as Tier) : 'MAIN'
}
export function groupByTier<T extends { tier?: string | null }>(list: T[]): Array<{ tier: Tier; items: T[] }> {
  return TIERS.map((tier) => ({ tier, items: list.filter((c) => tierOf(c) === tier) })).filter((g) => g.items.length > 0)
}

export interface LocationCardData {
  id: string
  name: string
  description?: string | null
  visualPrompt?: string | null
  imageUrl?: string | null
}

/** Tier badge (and group size for crowds) shown on character cards. */
export function TierBadge({ char }: { char: { tier?: string | null; groupSize?: number | null } }) {
  const tier = tierOf(char)
  const short: Record<Tier, string> = { MAIN: 'главный', SUPPORTING: 'второстепенный', MINOR: 'эпизодический', CROWD: 'группа' }
  return (
    <span className="mb-2 inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground" data-testid="character-tier">
      {tier === 'CROWD' && <Users className="h-3 w-3" />}
      {short[tier]}{tier === 'CROWD' && char.groupSize ? ` · ${char.groupSize} чел.` : ''}
    </span>
  )
}

/** Read-only location card with a pencil → prompt-based rewrite; optional image/footer slots (References stage). */
export function LocationCard({
  loc,
  busy,
  onRevise,
  media,
  footer,
}: {
  loc: LocationCardData
  busy?: boolean
  onRevise?: (locationId: string, instruction: string) => Promise<void>
  media?: React.ReactNode
  footer?: React.ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    if (!instruction.trim() || !onRevise) return
    setSaving(true)
    try {
      await onRevise(loc.id, instruction.trim())
      setInstruction('')
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-border bg-card p-4" style={{ boxShadow: 'var(--shadow-sm)' }} data-testid="location-card">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <MapPin className="h-5 w-5 flex-shrink-0 text-primary" />
          <h3 className="break-words font-semibold" data-testid="location-name">{loc.name}</h3>
        </div>
        {onRevise && (
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            disabled={busy || saving}
            aria-label="Изменить локацию по подсказке"
            title="Изменить локацию по подсказке"
            data-testid="location-edit"
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition hover:text-foreground disabled:opacity-50"
          >
            {editing ? <X className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
          </button>
        )}
      </div>
      {media}
      <dl className="space-y-1.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
        <div><dt className="inline font-medium text-foreground">Описание: </dt><dd className="inline">{loc.description || '—'}</dd></div>
        <div><dt className="inline font-medium text-foreground">Визуал (EN): </dt><dd className="inline">{loc.visualPrompt || '—'}</dd></div>
      </dl>
      {editing && onRevise && (
        <div className="mt-3 space-y-2 rounded-lg border border-border bg-background p-3">
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Что изменить в локации? Например: сделать зиму и ночь, добавить старый причал"
            rows={2}
            className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            data-testid="location-edit-input"
          />
          <button
            type="button"
            onClick={submit}
            disabled={saving || busy || !instruction.trim()}
            className="flex items-center gap-2 rounded-lg bg-secondary px-3 py-1.5 text-xs font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50"
            data-testid="location-edit-submit"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
            Переписать локацию
          </button>
        </div>
      )}
      {footer}
    </div>
  )
}

/** Inline "add a location by name" form (LLM writes the card). */
export function AddLocationForm({ projectId, busy, onAdded, onError }: { projectId: string; busy?: boolean; onAdded: (loc: LocationCardData) => void; onError: (msg: string) => void }) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    if (name.trim().length < 2) return
    setSaving(true)
    try {
      const res = await fetch('/api/ai/locations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, name: name.trim() }) })
      const data = await res.json()
      if (!res.ok) { onError(data?.error ?? 'Не удалось добавить локацию'); return }
      onAdded(data.location)
      setName('')
    } catch { onError('Ошибка сети') } finally { setSaving(false) }
  }
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Добавить локацию: например, «Кухня в квартире Анны»"
        disabled={busy || saving}
        className="min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
        data-testid="location-add-input"
      />
      <button type="button" onClick={submit} disabled={busy || saving || name.trim().length < 2}
        className="flex items-center justify-center gap-2 rounded-lg bg-muted px-4 py-2 text-xs font-semibold transition hover:bg-muted/80 disabled:opacity-50" data-testid="location-add-submit">
        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <MapPin className="h-3 w-3" />} Добавить локацию
      </button>
    </div>
  )
}
