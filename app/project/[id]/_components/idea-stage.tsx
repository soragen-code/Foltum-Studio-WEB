'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Wand2, Check, Pencil, User, X, Lightbulb, MessageSquareText, UserPlus, ChevronRight, Upload, FileText, FlaskConical, Undo2 } from 'lucide-react'
import { LocationCard, AddLocationForm, TierBadge, TIER_LABELS, groupByTier, type LocationCardData } from './cast-and-locations'
import { parseStoredShortSynopsis, type ShortSynopsis } from '@/lib/short-synopsis'
import { CancelButton } from './cancel-button'
import { useJobPolling, SmoothProgress } from './use-job-polling'

/** Roughly how long the synopsis step takes — drives the smooth 0→100 % progress bar. */
const SYNOPSIS_EXPECTED_SEC = 45

export interface CharacterCardData {
  id: string
  name: string
  age?: string | null
  role?: string | null
  appearance?: string | null
  personality?: string | null
  firstAppearance?: string | null
  tier?: string | null
  groupSize?: number | null
  hasUndo?: boolean | null
}

const LANGUAGE_LABELS: Record<string, string> = {
  ru: 'Russian', en: 'English', uk: 'Ukrainian', de: 'Deutsch', fr: 'français',
  es: 'español', it: 'italiano', pl: 'polski', pt: 'português', tr: 'Türkçe',
}

/** Genres for AUTO mode. ids must match GENRES in lib/idea.ts. */
const GENRE_OPTIONS: { id: string; label: string }[] = [
  { id: 'detective', label: 'Detective' },
  { id: 'horror', label: 'Horror' },
  { id: 'fantasy', label: 'Magic / Fantasy' },
  { id: 'scifi', label: 'Sci-fi' },
  { id: 'drama', label: 'Drama' },
  { id: 'thriller', label: 'Thriller' },
  { id: 'romance', label: 'Romance' },
  { id: 'comedy', label: 'Comedy' },
  { id: 'adventure', label: 'Adventure' },
  { id: 'postapoc', label: 'Post-apocalypse' },
  { id: 'mystery', label: 'Mystery' },
  { id: 'action', label: 'Action' },
  { id: 'historical', label: 'Historical drama' },
  { id: 'melodrama', label: 'Melodrama' },
]

/** Read-only character card with a pencil → prompt-based rewrite. */
export function CharacterCard({
  char,
  busy,
  onRevise,
  onUndo,
  extra,
  footer,
}: {
  char: CharacterCardData
  busy?: boolean
  onRevise?: (characterId: string, instruction: string) => Promise<void>
  onUndo?: (characterId: string) => Promise<void>
  extra?: React.ReactNode
  footer?: React.ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [saving, setSaving] = useState(false)
  const [undoing, setUndoing] = useState(false)

  const undo = async () => {
    if (!onUndo || undoing) return
    setUndoing(true)
    try {
      await onUndo(char.id)
    } finally {
      setUndoing(false)
    }
  }

  const submit = async () => {
    if (!instruction.trim() || !onRevise) return
    setSaving(true)
    try {
      await onRevise(char.id, instruction.trim())
      setInstruction('')
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="flex min-w-0 flex-col rounded-xl border border-border bg-card p-4"
      style={{ boxShadow: 'var(--shadow-sm)' }}
      data-testid="character-card"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <User className="h-5 w-5 flex-shrink-0 text-primary" />
          <h3 className="break-words font-semibold" data-testid="character-name">{char.name}</h3>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {onUndo && char.hasUndo && (
            <button
              type="button"
              onClick={undo}
              disabled={busy || saving || undoing}
              aria-label="Undo last change"
              title="Undo last change"
              data-testid="character-undo"
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition hover:text-foreground disabled:opacity-50"
            >
              {undoing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
            </button>
          )}
          {onRevise && (
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              disabled={busy || saving}
              aria-label="Edit character using a hint"
              title="Edit character using a hint"
              data-testid="character-edit"
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition hover:text-foreground disabled:opacity-50"
            >
              {editing ? <X className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
            </button>
          )}
        </div>
      </div>

      <TierBadge char={char} />
      {extra}

      <dl className="space-y-1.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
        <div><dt className="inline font-medium text-foreground">Age: </dt><dd className="inline">{char.age || '—'}</dd></div>
        <div><dt className="inline font-medium text-foreground">Role: </dt><dd className="inline">{char.role || '—'}</dd></div>
        <div><dt className="inline font-medium text-foreground">Appearance: </dt><dd className="inline">{char.appearance || '—'}</dd></div>
        <div><dt className="inline font-medium text-foreground">Personality: </dt><dd className="inline">{char.personality || '—'}</dd></div>
        <div><dt className="inline font-medium text-foreground">First appearance: </dt><dd className="inline">{char.firstAppearance || '—'}</dd></div>
      </dl>

      {editing && onRevise && (
        <div className="mt-3 space-y-2 rounded-lg border border-border bg-background p-3">
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="What to change in the character? For example: make them older and add a scar on the cheek"
            rows={2}
            className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            data-testid="character-edit-input"
          />
          <button
            type="button"
            onClick={submit}
            disabled={saving || busy || !instruction.trim()}
            className="flex items-center gap-2 rounded-lg bg-secondary px-3 py-1.5 text-xs font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50"
            data-testid="character-edit-submit"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
            Rewrite card
          </button>
        </div>
      )}

      {footer}
    </div>
  )
}

/**
 * Section wrapper: plain block on the Idea step, collapsible on the season screen.
 * IMPORTANT: this is a module-level component (NOT defined inside IdeaEditor). Defining it inline
 * made React treat it as a new component type on every render, so each poll of the season job
 * remounted the native <details> and reset its open state — the blocks "closed themselves". Now the
 * open/closed state is React-controlled and lives in IdeaEditor, so it survives re-renders/polling.
 */
function Section({
  id, title, collapsible, open, onToggle, children,
}: {
  id: string
  title: string
  collapsible: boolean
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  if (!collapsible) return <div data-testid={`idea-section-${id}`}>{children}</div>
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card" data-testid={`idea-section-${id}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer select-none items-center gap-2 px-4 py-3 text-left font-display text-base font-semibold"
        data-testid={`idea-section-toggle-${id}`}
      >
        <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
        {title}
      </button>
      {open && <div className="border-t border-border p-4">{children}</div>}
    </div>
  )
}

/**
 * Synopsis + locations + cast with prompt-based edits. Used by the Idea step (stacked) and, since
 * stage 5, at the top of the season-script screen (collapsible blocks). `onChanged` fires after every
 * successful edit so the season screen can offer «"Apply changes to the season script".
 */
export function IdeaEditor({
  project,
  synopsis: initialSynopsis,
  language,
  characters: initialCharacters,
  locations: initialLocations,
  collapsible = false,
  disabled = false,
  onChanged,
}: {
  project: { id: string }
  synopsis: string
  language?: string | null
  characters: CharacterCardData[]
  locations: LocationCardData[]
  collapsible?: boolean
  disabled?: boolean
  onChanged?: (what: 'synopsis' | 'characters' | 'locations') => void
}) {
  const [synopsis, setSynopsis] = useState<string>(initialSynopsis)
  const [characters, setCharacters] = useState<CharacterCardData[]>(initialCharacters)
  const [locations, setLocations] = useState<LocationCardData[]>(initialLocations)
  const [addingCast, setAddingCast] = useState(false)
  const [castHint, setCastHint] = useState('')
  const [revising, setRevising] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  // Which collapsible sections are open. Lives here (not in the <details> DOM) so it survives the
  // season-job polling re-renders that previously snapped the blocks shut.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({})
  const toggleSection = (id: string) => setOpenSections((o) => ({ ...o, [id]: !o[id] }))
  const busy = disabled || revising || addingCast

  const addCast = async () => {
    setError(''); setNotice(''); setAddingCast(true)
    try {
      const res = await fetch('/api/ai/characters/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, hint: castHint.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data?.error ?? 'Failed to add characters'); return }
      setCharacters(data.characters ?? characters)
      setNotice(`Characters added: ${data.added}`)
      setCastHint('')
      onChanged?.('characters')
    } catch { setError('Network error') }
    finally { setAddingCast(false) }
  }

  const reviseLocation = async (locationId: string, text: string) => {
    setError(''); setNotice('')
    const res = await fetch(`/api/ai/locations/${locationId}/revise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: text, regenerate: false }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data?.error ?? 'Failed to edit location'); return }
    setLocations((prev) => prev.map((l) => (l.id === locationId ? { ...l, ...data.location, hasUndo: true } : l)))
    onChanged?.('locations')
  }

  // Stage 60: one-step undo — restore the previous version, then hide the undo button.
  const undoLocation = async (locationId: string) => {
    setError(''); setNotice('')
    const res = await fetch(`/api/ai/locations/${locationId}/undo`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data?.error ?? 'Failed to undo change'); return }
    setLocations((prev) => prev.map((l) => (l.id === locationId ? { ...l, ...data.location, hasUndo: false } : l)))
    onChanged?.('locations')
  }

  const reviseSynopsis = async () => {
    if (!instruction.trim()) return
    setError(''); setNotice(''); setRevising(true)
    try {
      const res = await fetch('/api/ai/idea/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, instruction: instruction.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data?.error ?? 'Failed to edit synopsis'); return }
      setSynopsis(data.synopsis ?? synopsis)
      if (data.charactersChanged) {
        setCharacters(data.characters ?? characters)
        setNotice(`Characters updated along with the synopsis. ${data.changeSummary ?? ''}`.trim())
      }
      setInstruction('')
      onChanged?.('synopsis')
    } catch { setError('Network error') }
    finally { setRevising(false) }
  }

  const reviseCharacter = async (characterId: string, text: string) => {
    setError(''); setNotice('')
    const res = await fetch('/api/ai/characters/revise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId, instruction: text }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data?.error ?? 'Failed to edit character'); return }
    setCharacters((prev) => prev.map((c) => (c.id === characterId ? { ...c, ...data.character, hasUndo: true } : c)))
    onChanged?.('characters')
  }

  // Stage 60: one-step undo — restore the previous version, then hide the undo button.
  const undoCharacter = async (characterId: string) => {
    setError(''); setNotice('')
    const res = await fetch(`/api/ai/characters/${characterId}/undo`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data?.error ?? 'Failed to undo change'); return }
    setCharacters((prev) => prev.map((c) => (c.id === characterId ? { ...c, ...data.character, hasUndo: false } : c)))
    onChanged?.('characters')
  }

  return (
    <div className={collapsible ? 'space-y-3' : 'space-y-6'} data-testid="idea-editor">
      {error && <div className="rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}
      <Section id="synopsis" title="Season synopsis" collapsible={collapsible} open={!!openSections['synopsis']} onToggle={() => toggleSection('synopsis')}>
        <div className={collapsible ? '' : 'rounded-xl border border-border bg-card p-4 sm:p-6'} style={collapsible ? undefined : { boxShadow: 'var(--shadow-md)' }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {!collapsible && <h3 className="font-display text-lg font-semibold">Season synopsis</h3>}
            {language && (
              <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground" data-testid="synopsis-language">
                language: {LANGUAGE_LABELS[language] ?? language}
              </span>
            )}
          </div>
          <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]" data-testid="synopsis-text">
            {synopsis}
          </div>
          <div className="mt-5 rounded-lg border border-border bg-background p-3">
            <label className="mb-2 flex items-center gap-2 text-sm font-medium">
              <MessageSquareText className="h-4 w-4 text-primary" /> What to change
            </label>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="For example: make the season finale darker, add a rival’s storyline"
              rows={2}
              disabled={busy}
              className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              data-testid="synopsis-revise-input"
            />
            <button
              onClick={reviseSynopsis}
              disabled={busy || !instruction.trim()}
              className="mt-2 flex items-center gap-2 rounded-lg bg-muted px-4 py-2 text-xs font-semibold transition hover:bg-muted/80 disabled:opacity-50"
              data-testid="synopsis-revise-submit"
            >
              {revising ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
              Rewrite synopsis
            </button>
            {notice && (
              <p className="mt-2 rounded-lg bg-primary/10 px-3 py-2 text-xs text-primary" data-testid="characters-sync-notice">{notice}</p>
            )}
          </div>
        </div>
      </Section>

      <Section id="locations" title={`Locations (${locations.length})`} collapsible={collapsible} open={!!openSections['locations']} onToggle={() => toggleSection('locations')}>
        <div data-testid="idea-locations">
          {!collapsible && <h3 className="mb-1 font-display text-lg font-semibold">Locations ({locations.length})</h3>}
          <p className="mb-3 text-xs text-muted-foreground">Key locations in the season. Photorealistic references for them (and for characters) are in the References tab; the video model uses them together with the characters.</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {locations.map((l) => (
              <LocationCard key={l.id} loc={l} busy={busy} onRevise={reviseLocation} onUndo={undoLocation} />
            ))}
          </div>
          <div className="mt-3">
            <AddLocationForm projectId={project.id} busy={busy} onAdded={(loc) => { setLocations((p) => [...p, loc]); onChanged?.('locations') }} onError={setError} />
          </div>
        </div>
      </Section>

      <Section id="cast" title={`Characters (${characters.length})`} collapsible={collapsible} open={!!openSections['cast']} onToggle={() => toggleSection('cast')}>
        <div data-testid="idea-cast">
          {!collapsible && <h3 className="mb-3 font-display text-lg font-semibold">Characters ({characters.length})</h3>}
          {groupByTier(characters).map((g) => (
            <div key={g.tier} className="mb-5" data-testid={`cast-group-${g.tier}`}>
              <h4 className="mb-2 text-sm font-semibold text-muted-foreground">{TIER_LABELS[g.tier]} · {g.items.length}</h4>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {g.items.map((c) => (
                  <CharacterCard key={c.id} char={c} busy={busy} onRevise={reviseCharacter} onUndo={undoCharacter} />
                ))}
              </div>
            </div>
          ))}
          <div className="rounded-lg border border-border bg-background p-3">
            <label className="mb-2 flex items-center gap-2 text-sm font-medium">
              <UserPlus className="h-4 w-4 text-primary" /> Add more characters
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={castHint}
                onChange={(e) => setCastHint(e.target.value)}
                placeholder={`Optional: who to add (e.g., "the hero's brothers and housemates")`}
                disabled={busy}
                className="min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                data-testid="cast-add-hint"
              />
              <button
                onClick={addCast}
                disabled={busy}
                className="flex items-center justify-center gap-2 rounded-lg bg-muted px-4 py-2 text-xs font-semibold transition hover:bg-muted/80 disabled:opacity-50"
                data-testid="cast-add-submit"
              >
                {addingCast ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserPlus className="h-3 w-3" />}
                Add more characters
              </button>
            </div>
          </div>
        </div>
      </Section>
    </div>
  )
}

/**
 * Step "Idea": idea → synopsis (in the idea's language) + cast + locations, and — stage 5 — the
 * season script starts automatically right after (no extra clicks): approve-idea {next:"structure"}
 * → POST /api/ai/season → the wizard switches to the single «Season script screen.
 * The synopsis / cast / locations stay editable there (collapsible blocks).
 */
export function IdeaStage({ project, onRefresh }: { project: any; onRefresh: () => void }) {
  const [idea, setIdea] = useState<string>(project?.idea ?? '')
  const [result, setResult] = useState<{ synopsis: string; language: string; characters: CharacterCardData[]; locations: LocationCardData[] } | null>(
    project?.synopsis && project?.characters?.length ? { synopsis: project.synopsis, language: project.language ?? '', characters: project.characters, locations: project.locations ?? [] } : null
  )
  const [starting, setStarting] = useState(false)   // POST /api/ai/idea in flight (before the job appears)
  const [chaining, setChaining] = useState(false)
  const [approving, setApproving] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [ideaCanceled, setIdeaCanceled] = useState(false)
  const activeJobIdRef = useRef<string | null>(null)
  // Stage 67: synopsis generation is a background GenerationJob (type "synopsis"). We poll it instead
  // of holding an open fetch, so leaving the page no longer aborts the request / shows «Network error.
  const { job: synopsisJob, start: startPolling, clear: clearSynopsisJob } = useJobPolling({
    onFinish: (res) => {
      activeJobIdRef.current = null
      if (res.job.status === 'completed') {
        setError(''); setIdeaCanceled(false)
        // The route advanced the project to stage="synopsis"; refresh so the wizard renders step 2.
        onRefresh()
      } else if (res.job.status === 'canceled') {
        setIdeaCanceled(true)
      } else {
        setError(res.job.error ?? "Couldn't generate")
      }
    },
  })
  const jobActive = !!synopsisJob && (synopsisJob.status === 'pending' || synopsisJob.status === 'processing')
  const generating = starting || jobActive
  // Stage 67 — resume on mount: if a synopsis job is still running for this project (the producer left
  // and came back), pick it up and keep polling instead of starting a new one. If it finished while
  // away, the project is already on stage="synopsis" and the wizard renders step 2, so this component
  // won't even mount — nothing to do here.
  useEffect(() => {
    let ignore = false
    ;(async () => {
      try {
        const res = await fetch(`/api/ai/idea?projectId=${project.id}`, { cache: 'no-store' })
        if (!res.ok) return
        const d = await res.json().catch(() => null)
        const j = d?.job
        if (!j || ignore) return
        if (j.status === 'pending' || j.status === 'processing') {
          activeJobIdRef.current = j.id
          startPolling(j.id)
        }
      } catch { /* transient — the button still lets the producer start a fresh job */ }
    })()
    return () => { ignore = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])
  // Idea source: 'manual' = producer writes the idea; 'auto' = the AI invents it from a genre;
  // 'upload' = the producer uploads a finished story file (Stage 12).
  // 'test' (Stage 40) = «Test episode: one hand-written scene prompt → one-scene episode, no story pipeline.
  const [mode, setMode] = useState<'manual' | 'auto' | 'upload' | 'test'>('manual')
  const router = useRouter()
  // Stage 46A: the test form is ONE «"Idea" field — the scene prompt / dialogue are invented by the model
  // and every test scene is a fixed 30 s clip (server-enforced).
  const [testIdea, setTestIdea] = useState('')
  const [creatingTest, setCreatingTest] = useState(false)
  // Stage 46A: short synopsis shown between the idea and the season script (approve / rework).
  const [shortSynopsis, setShortSynopsis] = useState<ShortSynopsis | null>(() => parseStoredShortSynopsis(project?.shortSynopsis))
  const [synopsisLoading, setSynopsisLoading] = useState(false)
  const [reworkOpen, setReworkOpen] = useState(false)
  const [reworkComment, setReworkComment] = useState('')
  const [genres, setGenres] = useState<string[]>([])
  // Stage 14 (B): producer-chosen number of episodes (manual/auto). Default = 8; range 3..12.
  const [episodeCount, setEpisodeCount] = useState<number>(
    typeof project?.episodeCount === 'number' && project.episodeCount >= 1 ? project.episodeCount : 8
  )
  const [extras, setExtras] = useState('')
  // Stage 12 — uploaded story file state.
  const [storyText, setStoryText] = useState('')
  const [storyMeta, setStoryMeta] = useState<{ filename: string; kind: string; languageName: string; chars: number } | null>(null)
  const [parsing, setParsing] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)

  const hasResult = !!result
  const busy = generating || approving || chaining || parsing || creatingTest || synopsisLoading
  const toggleGenre = (id: string) =>
    setGenres((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]))
  const canGenerate = mode === 'auto' ? genres.length > 0 : mode === 'upload' ? storyText.trim().length >= 20 : idea.trim().length >= 10
  const canCreateTest = testIdea.trim().length >= 5

  // Stage 40/46A — «"Create a test episode": the model invents the whole scene from the one-line idea
  // (prompt, dialogue, meta), then the one-scene 30 s test episode is created and opened. Nothing to edit by hand.
  const createTestEpisode = async () => {
    setError(''); setNotice(''); setCreatingTest(true)
    try {
      const inv = await fetch('/api/ai/test-scene', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idea: testIdea.trim(), durationSec: 30 }),
      })
      const d = await inv.json().catch(() => ({}))
      if (!inv.ok) throw new Error(d?.error || "Couldn't come up with a scene")
      const res = await fetch(`/api/projects/${project.id}/test-episode`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: d.videoPrompt ?? '',
          dialogue: (d.dialogue ?? '').trim() || undefined,
          durationSec: 30,
          projectTitle: d.projectTitle ?? undefined,
          title: d.title, locationDesc: d.locationDesc, action: d.action, sceneKind: d.sceneKind, startState: d.startState, endState: d.endState,
        }),
      })
      const cd = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(cd?.error || "Couldn't create a test episode")
      router.push(`/project/${project.id}/episode/${cd.episodeId}`)
    } catch (e: any) {
      setError(e?.message || "Couldn't create a test episode")
      setCreatingTest(false)
    }
  }

  // Stage 12 — parse the chosen story file into text on the server (no LLM here).
  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(''); setNotice(''); setStoryText(''); setStoryMeta(null); setParsing(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/ai/idea/parse-file', { method: 'POST', body: fd })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data?.error ?? "Couldn't parse the file"); return }
      setStoryText(data.text ?? '')
      setStoryMeta({ filename: data.filename, kind: data.kind, languageName: data.languageName ?? data.language, chars: data.chars ?? (data.text?.length ?? 0) })
    } catch { setError('Network error while uploading file') }
    finally { setParsing(false) }
  }

  /** Auto-chain: approve (stage → structure) and start the season-script job, then show the season screen. */
  const startSeason = async () => {
    setChaining(true)
    try {
      const a = await fetch(`/api/projects/${project.id}/approve-idea`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ next: 'structure' }) })
      const ad = await a.json().catch(() => ({}))
      if (!a.ok) throw new Error(ad?.error ?? 'Failed to confirm synopsis')
      const s = await fetch('/api/ai/season', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id, ...(mode !== 'upload' ? { episodeCount } : {}) }) })
      const sd = await s.json().catch(() => ({}))
      if (!s.ok) throw new Error(sd?.error ?? 'Failed to start the season script')
      onRefresh()
      return true
    } catch (e: any) {
      setError(`${e?.message ?? 'Error'} — click "Go to season script" to try again.`)
      return false
    } finally { setChaining(false) }
  }

  const generate = async () => {
    if (mode === 'auto') {
      if (genres.length === 0) { setError('Select at least one genre'); return }
    } else if (mode === 'upload') {
      if (storyText.trim().length < 20) { setError('Upload a plot file (.txt, .md, .docx, or .pdf)'); return }
    } else if (idea.trim().length < 10) {
      setError('Describe the idea in at least one or two sentences'); return
    }
    setError(''); setNotice(''); setIdeaCanceled(false); clearSynopsisJob(); setStarting(true)
    try {
      const body = mode === 'auto'
        ? { projectId: project.id, auto: true, genres, extras: extras.trim(), episodeCount }
        : mode === 'upload'
        ? { projectId: project.id, fromStory: true, story: storyText }
        : { projectId: project.id, idea: idea.trim(), episodeCount }
      // Stage 67: the route creates a background job and returns { jobId } immediately. We poll it, so
      // the producer can leave the page — generation continues server-side and resumes on return.
      const res = await fetch('/api/ai/idea', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data?.error ?? "Couldn't generate"); return }
      if (data?.jobId) { activeJobIdRef.current = data.jobId; startPolling(data.jobId) }
    } catch {
      setError('Network error')
    }
    finally { setStarting(false) }
  }

  // Stage 67: stop the (free) synopsis job. The worker marks it "canceled" at its next check;
  // polling then surfaces the canceled state. Nothing was saved or charged.
  const cancelIdea = async () => {
    const id = activeJobIdRef.current
    if (!id) return
    try { await fetch(`/api/ai/jobs/${id}/cancel`, { method: 'POST' }) } catch { /* polling will retry */ }
  }

  /** Stage 46A: (re)write the short synopsis with the fast model. `comment` = the author's rework notes. */
  const generateShortSynopsis = async (comment?: string) => {
    setSynopsisLoading(true); setError('')
    try {
      const res = await fetch('/api/ai/short-synopsis', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, ...(comment?.trim() ? { comment: comment.trim() } : {}), ...(mode !== 'upload' ? { episodeCount } : {}) }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? "Couldn't create a brief synopsis"); return false }
      setShortSynopsis(d.shortSynopsis ?? null); setReworkOpen(false); setReworkComment('')
      return true
    } catch { setError('Network error'); return false }
    finally { setSynopsisLoading(false) }
  }

  const approve = async () => {
    setError(''); setApproving(true)
    try { await startSeason() } finally { setApproving(false) }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-4 sm:p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
        <h2 className="flex items-center gap-2 font-display text-xl font-bold">
          <Lightbulb className="h-5 w-5 text-primary" /> Step 1 — Idea
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Describe your idea — or choose Auto mode, and AI will come up with an original story in the selected genre. In this step, we'll create only the season synopsis: you'll approve it in the next step, and we'll generate the characters, locations, and script later.
        </p>

        {/* Mode toggle: own idea / auto */}
        <div className="mt-4 flex flex-wrap gap-1 rounded-lg border border-border bg-muted/40 p-1" role="tablist" data-testid="idea-mode-toggle">
          <button
            type="button"
            onClick={() => setMode('manual')}
            disabled={busy}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition sm:text-sm ${mode === 'manual' ? 'bg-background text-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}
            data-testid="idea-mode-manual"
          >
            Custom idea
          </button>
          <button
            type="button"
            onClick={() => setMode('auto')}
            disabled={busy}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition sm:text-sm ${mode === 'auto' ? 'bg-background text-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}
            data-testid="idea-mode-auto"
          >
            Auto by genre
          </button>
          <button
            type="button"
            onClick={() => setMode('upload')}
            disabled={busy}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition sm:text-sm ${mode === 'upload' ? 'bg-background text-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}
            data-testid="idea-mode-upload"
          >
            Upload your own plot as a file
          </button>
          <button
            type="button"
            onClick={() => setMode('test')}
            disabled={busy}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition sm:text-sm ${mode === 'test' ? 'bg-background text-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}
            data-testid="idea-mode-test"
          >
            Test episode
          </button>
        </div>

        {error && <div className="mt-4 rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}
        {notice && <div className="mt-4 rounded-lg bg-primary/10 px-4 py-2 text-xs text-primary">{notice}</div>}

        {mode === 'manual' ? (
          <textarea
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="For example: a young lighthouse keeper on a northern island finds the diary of her missing predecessor..."
            rows={5}
            disabled={busy}
            className="mt-4 w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
            data-testid="idea-input"
          />
        ) : mode === 'test' ? (
          <div className="mt-4 space-y-3" data-testid="idea-test-panel">
            <p className="text-xs text-muted-foreground">
              One scene instead of a full season: describe the idea in one phrase — AI will come up with the scene, prompt, and lines. Each test scene is a 30-second video. Character references aren't needed: the model works from text only. The project title will be chosen automatically based on the scene's plot. After creation, you'll go to the episode page, where you can view the prompt and generate the video.
            </p>
            <input
              value={testIdea}
              onChange={(e) => setTestIdea(e.target.value)}
              placeholder="Scene idea, for example: two fishermen argue on a pier about a missing boat"
              disabled={busy}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
              data-testid="test-scene-idea"
            />
            <button
              type="button"
              onClick={createTestEpisode}
              disabled={busy || !canCreateTest}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-secondary px-5 py-2.5 text-sm font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50 sm:w-auto"
              data-testid="test-episode-create"
            >
              {creatingTest ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
              {creatingTest ? 'Coming up with a scene and creating a series...' : 'Create a test episode (30 s)'}
            </button>
          </div>
        ) : mode === 'upload' ? (
          <div className="mt-4 space-y-3" data-testid="idea-upload-panel">
            <p className="text-xs text-muted-foreground">
              Upload an existing plot as a file — <span className="font-medium text-foreground">.txt, .md, .docx or .pdf</span>. AI will treat it as canon: structure it into a season with episodes, locations, and characters, minimally rewriting the core story. The story language will be detected automatically from the file contents. The voiceover will still be in English.
            </p>
            <input
              ref={fileInput}
              type="file"
              accept=".txt,.md,.markdown,.docx,.pdf"
              onChange={onPickFile}
              disabled={busy}
              className="hidden"
              data-testid="idea-file-input"
            />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-background px-4 py-6 text-sm font-medium text-muted-foreground transition hover:border-primary/60 hover:text-foreground disabled:opacity-50"
              data-testid="idea-file-pick"
            >
              {parsing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
              {parsing ? 'Parsing file...' : storyMeta ? 'Choose another file' : 'Choose a plot file'}
            </button>
            {storyMeta && (
              <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs" data-testid="idea-file-info">
                <div className="flex items-center gap-2 font-medium text-foreground">
                  <FileText className="h-4 w-4 flex-shrink-0 text-primary" />
                  <span className="break-all">{storyMeta.filename}</span>
                </div>
                <p className="mt-1 text-muted-foreground">Format: {storyMeta.kind.toUpperCase()} · characters: {storyMeta.chars.toLocaleString('ru')} · language: {storyMeta.languageName}</p>
                <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">{storyText.slice(0, 400)}{storyText.length > 400 ? '…' : ''}</p>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-4 space-y-3" data-testid="idea-auto-panel">
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Select a direction / genre (you can choose several):</p>
              <div className="flex flex-wrap gap-2" data-testid="idea-genres">
                {GENRE_OPTIONS.map((g) => {
                  const on = genres.includes(g.id)
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => toggleGenre(g.id)}
                      disabled={busy}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${on ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-foreground hover:border-primary/60'}`}
                      data-testid={`genre-${g.id}`}
                      aria-pressed={on}
                    >
                      {g.label}
                    </button>
                  )
                })}
              </div>
            </div>
            <textarea
              value={extras}
              onChange={(e) => setExtras(e.target.value)}
              placeholder="Additional preferences (optional): setting, era, tone, things you’d like to avoid… The story language will be determined from this text (default — Russian)."
              rows={3}
              disabled={busy}
              className="w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
              data-testid="idea-extras"
            />
          </div>
        )}
        {mode !== 'upload' && mode !== 'test' && (
          <div className="mt-4 flex flex-wrap items-center gap-3" data-testid="episode-count-field">
            <label htmlFor="episode-count" className="text-sm font-medium text-foreground">Number of episodes</label>
            <div className="inline-flex items-center overflow-hidden rounded-lg border border-border">
              <button
                type="button"
                onClick={() => setEpisodeCount((n) => Math.max(1, n - 1))}
                disabled={busy || episodeCount <= 1}
                className="px-3 py-2 text-sm font-bold text-muted-foreground transition hover:bg-muted disabled:opacity-40"
                data-testid="episode-count-minus"
                aria-label="Fewer episodes"
              >
                −
              </button>
              <input
                id="episode-count"
                type="number"
                min={1}
                max={100}
                value={episodeCount}
                onChange={(e) => {
                  const v = Math.round(Number(e.target.value))
                  if (Number.isFinite(v)) setEpisodeCount(Math.min(100, Math.max(1, v)))
                }}
                disabled={busy}
                className="w-14 border-x border-border bg-background py-2 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                data-testid="episode-count-input"
              />
              <button
                type="button"
                onClick={() => setEpisodeCount((n) => Math.min(100, n + 1))}
                disabled={busy || episodeCount >= 100}
                className="px-3 py-2 text-sm font-bold text-muted-foreground transition hover:bg-muted disabled:opacity-40"
                data-testid="episode-count-plus"
                aria-label="More episodes"
              >
                +
              </button>
            </div>
            <span className="text-xs text-muted-foreground">AI will build the dramatic structure (intro → inciting incident → climax → resolution) for exactly {episodeCount} episodes (1–100).</span>
          </div>
        )}
        {mode !== 'test' && <button
          onClick={generate}
          disabled={busy || !canGenerate}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-secondary px-5 py-2.5 text-sm font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50 sm:w-auto"
          data-testid="idea-generate"
        >
          {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
          {hasResult ? 'Regenerate' : mode === 'auto' ? 'Come up with a story and create a synopsis' : mode === 'upload' ? 'Structure the plot and create a synopsis' : 'Create synopsis'}
        </button>}
        {generating && !chaining && (
          <div className="mt-3 space-y-2" data-testid="idea-progress">
            {synopsisJob ? (
              <SmoothProgress job={synopsisJob} expectedTotalSec={SYNOPSIS_EXPECTED_SEC} />
            ) : (
              <p className="inline-flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin text-primary" /> Starting generation…</p>
            )}
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 text-xs text-muted-foreground">Step 1 of 4 · usually 30–60 seconds: creating the season synopsis. You can close the page — generation will continue in the background, and progress will be restored when you return.</p>
              <CancelButton onCancel={cancelIdea} testId="idea-cancel" className="flex-shrink-0" />
            </div>
          </div>
        )}
        {ideaCanceled && !generating && !chaining && (
          <p className="mt-2 text-xs text-amber-500" data-testid="idea-canceled">Idea generation was canceled. Click the button above to start again.</p>
        )}
        {synopsisLoading && !generating && (
          <p className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground" data-testid="idea-synopsis-loading"><Loader2 className="h-3 w-3 animate-spin text-primary" /> Step 2 of 2 · creating a short season synopsis...</p>
        )}
        {chaining && (
          <p className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground" data-testid="idea-chaining"><Loader2 className="h-3 w-3 animate-spin text-primary" /> Starting season script...</p>
        )}
      </div>

      {/* Stage 59 (step 1 «"Idea"): this screen is idea-only. As soon as the synopsis is ready the route
          advances the project to stage="synopsis" and onRefresh() renders the synopsis screen (step 2),
          so there is no in-place result card here anymore. */}
    </div>
  )
}
