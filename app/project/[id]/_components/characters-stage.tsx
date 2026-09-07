'use client'

import { useState } from 'react'
import { Loader2, RefreshCw, Upload, Lock, Check, User, Wand2, ImageOff } from 'lucide-react'

/** Renders the 3 character image slots with proper fallback */
function CharacterImages({
  char,
  ImagePlaceholder,
  pending = false,
}: {
  char: any
  ImagePlaceholder: React.FC
  /** true while a generation run is active — empty slots show a spinner instead of "No image" */
  pending?: boolean
}) {
  const [broken, setBroken] = useState<Record<number, boolean>>({})
  const images = [char?.imageFront, char?.imageProfile, char?.imageFull]
  const labels = ['Front', 'Profile', 'Full']

  return (
    <div className="mb-3 grid grid-cols-3 gap-2">
      {images.map((img, i) => {
        const validUrl = typeof img === 'string' && img.startsWith('http') && img.length > 10
        const showImg = validUrl && !broken[i]
        return (
          <div key={i} className="aspect-[3/4] overflow-hidden rounded-lg bg-muted">
            {showImg ? (
              <img
                src={img}
                alt={`${char?.name ?? 'Character'} — ${labels[i]}`}
                className="h-full w-full animate-in fade-in object-cover duration-500"
                onError={() => setBroken((prev) => ({ ...prev, [i]: true }))}
              />
            ) : pending ? (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-muted/50">
                <Loader2 className="h-6 w-6 animate-spin text-primary/60" />
                <span className="text-[10px] text-muted-foreground/60">Generating…</span>
              </div>
            ) : (
              <ImagePlaceholder />
            )}
          </div>
        )
      })}
    </div>
  )
}

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

interface GenProgress {
  current: number
  total: number
  message: string
}

/** Progress bar using the app design tokens (bg-muted track, bg-primary fill) */
function ProgressBar({ progress }: { progress: GenProgress }) {
  const total = Math.max(progress.total, 1)
  const pct = Math.min(100, Math.max(0, Math.round((progress.current / total) * 100)))
  return (
    <div className="mt-4 space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-2 truncate">
          <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-primary" />
          <span className="truncate">{progress.message}</span>
        </span>
        <span className="ml-3 flex-shrink-0 tabular-nums">
          {Math.min(progress.current, total)} / {total} · {pct}%
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

/** Parse SSE `data:` lines from a buffered chunk; returns parsed payloads and the leftover buffer */
function parseSSEChunk(buffer: string): { events: any[]; rest: string } {
  const events: any[] = []
  const blocks = buffer.split('\n\n')
  const rest = blocks.pop() ?? ''
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue
      const json = line.slice(5).trim()
      if (!json) continue
      try { events.push(JSON.parse(json)) } catch {}
    }
  }
  return { events, rest }
}

export function CharactersStage({ project, onRefresh }: { project: any; onRefresh: () => void }) {
  const [characters, setCharacters] = useState<CharacterData[]>(project?.characters ?? [])
  const [generating, setGenerating] = useState(false)
  const [progress, setProgress] = useState<GenProgress | null>(null)
  const [locking, setLocking] = useState(false)
  const [error, setError] = useState('')
  const isLocked = project?.charactersLocked ?? false

  const generateCharacters = async () => {
    setGenerating(true)
    setError('')
    setProgress({ current: 0, total: 1, message: 'Starting character generation...' })
    let gotDone = false
    try {
      const res = await fetch('/api/ai/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ projectId: project?.id, synopsis: project?.synopsis }),
      })

      // Non-stream error responses (401/400/500 before the stream opens)
      const contentType = res.headers.get('content-type') ?? ''
      if (!res.ok || !contentType.includes('text/event-stream') || !res.body) {
        let msg = 'Generation failed'
        try { const data = await res.json(); msg = data?.error ?? msg } catch {}
        setError(msg)
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      const handleEvent = (evt: any) => {
        switch (evt?.type) {
          case 'progress':
            setProgress({ current: evt.current ?? 0, total: evt.total ?? 1, message: evt.message ?? '' })
            break
          case 'characters_text':
            // Show cards immediately with empty images
            setCharacters(Array.isArray(evt.characters) ? evt.characters : [])
            setProgress((p) => ({
              current: evt.current ?? p?.current ?? 1,
              total: evt.total ?? p?.total ?? 1,
              message: p?.message ?? 'Character profiles ready',
            }))
            break
          case 'image':
            // Patch a single image field on the matching character
            setCharacters((prev) =>
              (prev ?? []).map((c) =>
                c?.id === evt.characterId ? { ...c, [evt.field]: evt.url } : c
              )
            )
            setProgress((p) => ({
              current: evt.current ?? p?.current ?? 0,
              total: evt.total ?? p?.total ?? 1,
              message: p?.message ?? '',
            }))
            break
          case 'done':
            gotDone = true
            if (Array.isArray(evt.characters)) setCharacters(evt.characters)
            setProgress({ current: evt.total ?? 1, total: evt.total ?? 1, message: 'All done' })
            break
          case 'error':
            setError(evt.message ?? 'Generation failed')
            break
        }
      }

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const { events, rest } = parseSSEChunk(buffer)
        buffer = rest
        events.forEach(handleEvent)
      }
      // Flush any trailing event without a final blank line
      if (buffer.trim()) {
        const { events } = parseSSEChunk(buffer + '\n\n')
        events.forEach(handleEvent)
      }

      if (!gotDone) {
        // Stream ended without a "done" event (e.g. connection dropped) — refetch persisted state
        onRefresh()
      }
    } catch { setError('Network error') }
    finally {
      setGenerating(false)
      setProgress(null)
    }
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

  // No-image placeholder rendered as a native div (no external URLs, no data-URI)
  const ImagePlaceholder = () => (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-muted/50">
      <User className="h-8 w-8 text-muted-foreground/40" />
      <span className="text-[10px] text-muted-foreground/50">No image</span>
    </div>
  )

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

        {generating && progress && <ProgressBar progress={progress} />}

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
                <CharacterImages char={char} ImagePlaceholder={ImagePlaceholder} pending={generating} />
                {!isLocked && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => regenCharacter(char?.id ?? '')}
                      disabled={generating}
                      className="flex items-center gap-1 rounded-lg bg-muted px-3 py-1.5 text-xs transition hover:bg-muted/80 disabled:opacity-50"
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
                className="flex items-center gap-2 rounded-lg bg-muted px-4 py-2.5 text-sm transition hover:bg-muted/80 disabled:opacity-50"
              >
                {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Regenerate All
              </button>
              <button
                onClick={lockCharacters}
                disabled={locking || generating}
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
