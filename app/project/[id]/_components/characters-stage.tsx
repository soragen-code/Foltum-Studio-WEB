'use client'

import { useState } from 'react'
import { Loader2, RefreshCw, Upload, Lock, Check, User, Wand2 } from 'lucide-react'

interface CharacterData {
  id?: string
  name: string
  description: string | null
  role: string | null
  personality: string | null
  appearance: string | null
  imageFront: string | null
  imageProfile: string | null
  imageFull: string | null
  isLocked: boolean
}

export function CharactersStage({ project, onRefresh }: { project: any; onRefresh: () => void }) {
  const [characters, setCharacters] = useState<CharacterData[]>(project?.characters ?? [])
  const [generating, setGenerating] = useState(false)
  const [locking, setLocking] = useState(false)
  const [error, setError] = useState('')
  const isLocked = project?.charactersLocked ?? false

  const generateCharacters = async () => {
    setGenerating(true)
    setError('')
    try {
      const res = await fetch('/api/ai/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project?.id, synopsis: project?.synopsis }),
      })
      const data = await res.json()
      if (data?.characters) {
        setCharacters(data.characters)
      } else {
        setError(data?.error ?? 'Generation failed')
      }
    } catch { setError('Network error') }
    finally { setGenerating(false) }
  }

  const regenCharacter = async (charId: string) => {
    if (isLocked) return
    try {
      const res = await fetch('/api/ai/characters/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId: charId, projectId: project?.id }),
      })
      const data = await res.json()
      if (data?.character) {
        setCharacters((prev) =>
          (prev ?? []).map((c: CharacterData) => (c?.id === charId ? data.character : c))
        )
      }
    } catch {}
  }

  const lockCharacters = async () => {
    if ((characters?.length ?? 0) === 0) return
    setLocking(true)
    try {
      await fetch(`/api/projects/${project?.id}/lock-characters`, { method: 'POST' })
      onRefresh()
    } catch { setError('Failed to lock') }
    finally { setLocking(false) }
  }

  const placeholder = 'https://placehold.co/300x400/1a1a2e/eab308?text=Character'

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl font-bold">Stage 2 — Characters</h2>
          {isLocked && (
            <span className="flex items-center gap-1 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              <Lock className="h-3 w-3" /> Locked
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          AI extracts characters from your synopsis. Review and approve them.
        </p>

        {error && <div className="mt-4 rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}

        {!isLocked && (characters?.length ?? 0) === 0 && (
          <button
            onClick={generateCharacters}
            disabled={generating}
            className="mt-4 flex items-center gap-2 rounded-lg bg-secondary px-5 py-2.5 text-sm font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50"
          >
            {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            Generate Characters
          </button>
        )}
      </div>

      {(characters?.length ?? 0) > 0 && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(characters ?? []).map((char: CharacterData) => (
              <div
                key={char?.id ?? char?.name}
                className="rounded-xl border border-border bg-card p-4"
                style={{ boxShadow: 'var(--shadow-sm)' }}
              >
                <div className="mb-3 flex items-center gap-2">
                  <User className="h-5 w-5 text-primary" />
                  <h3 className="font-semibold">{char?.name ?? 'Unknown'}</h3>
                </div>
                <div className="mb-3 space-y-1 text-xs text-muted-foreground">
                  <p><span className="font-medium text-foreground">Role:</span> {char?.role ?? 'N/A'}</p>
                  <p><span className="font-medium text-foreground">Appearance:</span> {char?.appearance ?? 'N/A'}</p>
                  <p><span className="font-medium text-foreground">Personality:</span> {char?.personality ?? 'N/A'}</p>
                </div>
                <div className="mb-3 grid grid-cols-3 gap-2">
                  {[char?.imageFront, char?.imageProfile, char?.imageFull].map((img, i) => {
                    const src = img && img.length > 0 ? img : placeholder
                    return (
                      <div key={i} className="aspect-[3/4] overflow-hidden rounded-lg bg-muted">
                        <img
                          src={src}
                          alt={`${char?.name ?? 'Character'} view ${i + 1}`}
                          className="h-full w-full object-cover"
                          onError={(e: any) => { e.target.src = placeholder }}
                        />
                      </div>
                    )
                  })}
                </div>
                {!isLocked && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => regenCharacter(char?.id ?? '')}
                      className="flex items-center gap-1 rounded-lg bg-muted px-3 py-1.5 text-xs transition hover:bg-muted/80"
                    >
                      <RefreshCw className="h-3 w-3" /> Regenerate
                    </button>
                    <label className="flex cursor-pointer items-center gap-1 rounded-lg bg-muted px-3 py-1.5 text-xs transition hover:bg-muted/80">
                      <Upload className="h-3 w-3" /> Upload Photo
                      <input type="file" accept="image/*" className="hidden" />
                    </label>
                  </div>
                )}
              </div>
            ))}
          </div>

          {!isLocked && (
            <div className="flex gap-3">
              <button
                onClick={generateCharacters}
                disabled={generating}
                className="flex items-center gap-2 rounded-lg bg-muted px-4 py-2.5 text-sm transition hover:bg-muted/80"
              >
                {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Regenerate All
              </button>
              <button
                onClick={lockCharacters}
                disabled={locking}
                className="flex items-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
              >
                {locking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
                Approve & Lock Characters
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
