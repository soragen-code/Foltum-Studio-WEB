'use client'

import { useState, useEffect } from 'react'
import { useJobPolling, JobProgressBar } from './use-job-polling'
import { Loader2, RefreshCw, Lock, Check, User, Wand2, ImageOff } from 'lucide-react'
import { CharacterUserRefs } from './character-user-refs'
import { CharacterFacePhoto } from './character-face-photo'

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
  const images = [char?.imageFull, char?.imageFront, char?.imageProfile]
  const labels = ['Full', 'Front', 'Profile']

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

const CHARACTERS_EXPECTED_SEC = 180 // ~9 FLUX images sequentially

export function CharactersStage({ project, onRefresh, entitlements }: { project: any; onRefresh: () => void; entitlements?: import('@/lib/entitlements').Entitlements }) {
  const [characters, setCharacters] = useState<CharacterData[]>(project?.characters ?? [])
  const [starting, setStarting] = useState(false)
  const [locking, setLocking] = useState(false)
  const [error, setError] = useState('')
  const isLocked = project?.charactersLocked ?? false

  const { job, isActive, start: startPolling, clear: clearJob } = useJobPolling({
    onUpdate: (res) => {
      // The poll endpoint returns the current characters with image URLs so far
      if (Array.isArray(res.characters)) setCharacters(res.characters)
    },
    onFinish: (res) => {
      if (res.job.status === 'failed') setError(res.job.error ?? 'Image generation failed')
      if (Array.isArray(res.characters)) setCharacters(res.characters)
      onRefresh()
      // Keep the finished bar visible briefly, then hide it
      setTimeout(() => clearJob(), 2500)
    },
  })

  const generating = starting || isActive

  // Resume polling if a character job is still running for this project (user navigated away and back)
  useEffect(() => {
    if (!project?.id) return
    let cancelled = false
    fetch(`/api/jobs?projectId=${project.id}&type=characters&active=1`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return
        const active = data?.jobs?.[0]
        if (active?.id) startPolling(active.id)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [project?.id, startPolling])

  const generateCharacters = async () => {
    setStarting(true)
    setError('')
    try {
      const res = await fetch('/api/ai/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project?.id, synopsis: project?.synopsis }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.jobId) {
        setError(data?.error ?? 'Generation failed')
        return
      }
      // Show the text profiles immediately; images arrive via polling
      if (Array.isArray(data.characters)) setCharacters(data.characters)
      startPolling(data.jobId)
    } catch { setError('Network error') }
    finally { setStarting(false) }
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

        {starting && !job && (
          <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin text-primary" /> Generating character profiles...
          </div>
        )}
        {job && <JobProgressBar job={job} expectedTotalSec={CHARACTERS_EXPECTED_SEC} className="mt-4" />}

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
                {/* Optional single "face photo": cast your own face in the role — fed FIRST into character generation. */}
                {char?.id && <CharacterFacePhoto characterId={char.id} faceImageUrl={(char as any).faceImageUrl} disabled={isLocked || !!(char as any).refLocked} locked={entitlements ? !entitlements.own_face : false} />}
                {/* Stage 75: user-uploaded photo references (shared component; replaces the old dead "Upload Photo" placeholder) */}
                {char?.id && <CharacterUserRefs characterId={char.id} userRefs={(char as any).userRefs} disabled={isLocked || !!(char as any).refLocked} />}
                {!isLocked && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => regenCharacter(char?.id ?? '')}
                      disabled={generating}
                      className="flex items-center gap-1 rounded-lg bg-muted px-3 py-1.5 text-xs transition hover:bg-muted/80 disabled:opacity-50"
                    >
                      <RefreshCw className="h-3 w-3" /> Regenerate
                    </button>
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
