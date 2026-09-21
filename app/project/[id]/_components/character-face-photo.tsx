'use client'

import { useRef, useState } from 'react'
import { Loader2, Upload, X, UserRound } from 'lucide-react'

/**
 * Optional single «фото лица» for a character. The user attaches their own face so the character is
 * generated to look like them (e.g. casting yourself in the lead role). The photo is stored on
 * Character.faceImageUrl and fed FIRST into every character reference generation.
 *
 * Uses the existing project upload mechanism (S3 via /api/ai/characters/[id]/face). Optional — the
 * character generates exactly as before when no photo is attached. Disabled once the reference is locked.
 */
export function CharacterFacePhoto({
  characterId,
  faceImageUrl,
  disabled,
  onChange,
}: {
  characterId: string
  faceImageUrl?: string | null
  disabled?: boolean
  onChange?: (faceImageUrl: string | null) => void
}) {
  const [face, setFace] = useState<string | null>(faceImageUrl ?? null)
  const [lastProp, setLastProp] = useState(faceImageUrl ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync from props when the parent refreshes the project (without clobbering optimistic local state).
  if ((faceImageUrl ?? null) !== lastProp) {
    setLastProp(faceImageUrl ?? null)
    setFace(faceImageUrl ?? null)
  }

  const apply = (url: string | null) => {
    setFace(url)
    onChange?.(url)
  }

  const upload = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    setError(null)
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch(`/api/ai/characters/${characterId}/face`, { method: 'POST', body: fd })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error || 'Не удалось загрузить фото')
        return
      }
      apply(typeof data?.faceImageUrl === 'string' ? data.faceImageUrl : null)
    } catch (e: any) {
      setError(e?.message || 'Не удалось загрузить фото')
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  const remove = async () => {
    if (disabled || busy) return
    setError(null)
    setBusy(true)
    try {
      const res = await fetch(`/api/ai/characters/${characterId}/face`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error || 'Не удалось удалить фото')
        return
      }
      apply(null)
    } catch (e: any) {
      setError(e?.message || 'Не удалось удалить фото')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-3 rounded-lg border border-border bg-muted/30 p-2" data-testid="char-face-photo">
      <div className="mb-1.5 flex items-center gap-1.5">
        <UserRound className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Фото лица (необязательно)</span>
      </div>
      <div className="flex items-center gap-1.5">
        {face && (
          <div className="relative h-14 w-14 overflow-hidden rounded-md bg-muted" data-testid="char-face-photo-thumb">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={face} alt="Фото лица" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={remove}
              disabled={disabled || busy}
              className="absolute right-0 top-0 flex h-5 w-5 items-center justify-center rounded-bl-md bg-background/85 text-foreground hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50"
              title="Удалить фото"
              aria-label="Удалить фото"
              data-testid="char-face-photo-remove"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
            </button>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => upload(e.target.files)}
          disabled={disabled || busy}
        />
        {!face && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={disabled || busy}
            className="inline-flex h-14 items-center gap-1 rounded-md border border-dashed border-border px-2 text-xs transition hover:bg-muted disabled:opacity-50"
            title="Загрузить фото лица (JPEG, PNG, WebP до 8 МБ)"
            data-testid="char-face-photo-upload"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            Загрузить фото
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Прикрепите фото лица — персонаж будет сгенерирован похожим на него (например, чтобы поставить себя в главную роль).
      </p>
      {disabled && <p className="mt-0.5 text-[11px] text-muted-foreground">Референс зафиксирован — фото изменить нельзя.</p>}
      {error && <p className="mt-1 text-[11px] text-destructive" data-testid="char-face-photo-error">{error}</p>}
    </div>
  )
}
