'use client'

import { useRef, useState } from 'react'
import { Loader2, Upload, X } from 'lucide-react'
import { parseUserRefs, USER_REFS_MAX } from '@/lib/character-user-refs'

/**
 * Stage 75 — «Фото-референсы»: up to 4 user-uploaded photos per character, shown as thumbnails with a
 * remove button and an upload button. They are fed as image_input to every character reference
 * generation. Always visible on the card (not hover-only). Disabled when the reference is locked.
 */
export function CharacterUserRefs({
  characterId,
  userRefs,
  disabled,
  onChange,
}: {
  characterId: string
  /** Character.userRefs JSON (or an already-parsed list). */
  userRefs?: string | string[] | null
  disabled?: boolean
  onChange?: (userRefs: string[]) => void
}) {
  const initial = Array.isArray(userRefs) ? userRefs : parseUserRefs(userRefs)
  const [refs, setRefs] = useState<string[]>(initial)
  const [lastProp, setLastProp] = useState(JSON.stringify(initial))
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync from props when the parent refreshes the project (without clobbering optimistic local state).
  const propKey = JSON.stringify(initial)
  if (propKey !== lastProp) {
    setLastProp(propKey)
    setRefs(initial)
  }

  const apply = (list: string[]) => {
    setRefs(list)
    onChange?.(list)
  }

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setError(null)
    setBusy(true)
    try {
      let current = refs
      const room = Math.max(0, USER_REFS_MAX - current.length)
      const picked = Array.from(files).slice(0, room)
      if (picked.length === 0) {
        setError('Максимум 4 фото-референса')
        return
      }
      for (const file of picked) {
        const fd = new FormData()
        fd.append('file', file)
        const res = await fetch(`/api/ai/characters/${characterId}/refs`, { method: 'POST', body: fd })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          setError(data?.error || 'Не удалось загрузить фото')
          if (Array.isArray(data?.userRefs)) current = data.userRefs
          break
        }
        if (Array.isArray(data?.userRefs)) current = data.userRefs
      }
      apply(current)
    } catch (e: any) {
      setError(e?.message || 'Не удалось загрузить фото')
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const remove = async (url: string) => {
    if (disabled || removing) return
    setError(null)
    setRemoving(url)
    try {
      const res = await fetch(`/api/ai/characters/${characterId}/refs`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error || 'Не удалось удалить фото')
        return
      }
      apply(Array.isArray(data?.userRefs) ? data.userRefs : refs.filter((u) => u !== url))
    } catch (e: any) {
      setError(e?.message || 'Не удалось удалить фото')
    } finally {
      setRemoving(null)
    }
  }

  const full = refs.length >= USER_REFS_MAX

  return (
    <div className="mb-3 rounded-lg border border-border bg-muted/30 p-2" data-testid="char-user-refs">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Фото-референсы</span>
        <span className="text-[11px] text-muted-foreground">{refs.length}/{USER_REFS_MAX}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {refs.map((url) => (
          <div key={url} className="relative h-14 w-14 overflow-hidden rounded-md bg-muted" data-testid="char-user-ref">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="Фото-референс" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => remove(url)}
              disabled={disabled || !!removing || busy}
              className="absolute right-0 top-0 flex h-5 w-5 items-center justify-center rounded-bl-md bg-background/85 text-foreground hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
              title="Удалить фото"
              aria-label="Удалить фото"
              data-testid="char-user-ref-remove"
            >
              {removing === url ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
            </button>
          </div>
        ))}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => upload(e.target.files)}
          disabled={disabled || busy || full}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || busy || full}
          className="inline-flex h-14 items-center gap-1 rounded-md border border-dashed border-border px-2 text-xs transition hover:bg-muted disabled:opacity-50"
          title={full ? 'Максимум 4 фото-референса' : 'Загрузить фото (JPEG, PNG, WebP до 8 МБ)'}
          data-testid="char-user-ref-upload"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          Загрузить фото
        </button>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">До 4 фото. Используются как референс внешности при генерации персонажа</p>
      {disabled && <p className="mt-0.5 text-[11px] text-muted-foreground">Референс зафиксирован — фото нельзя изменить.</p>}
      {error && <p className="mt-1 text-[11px] text-destructive" data-testid="char-user-refs-error">{error}</p>}
    </div>
  )
}
