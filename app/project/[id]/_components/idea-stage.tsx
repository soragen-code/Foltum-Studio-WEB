'use client'

import { useRef, useState } from 'react'
import { Loader2, Wand2, Check, Pencil, User, X, Lightbulb, MessageSquareText, UserPlus, ChevronRight } from 'lucide-react'
import { LocationCard, AddLocationForm, TierBadge, TIER_LABELS, groupByTier, type LocationCardData } from './cast-and-locations'
import { CancelButton } from './cancel-button'

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
}

const LANGUAGE_LABELS: Record<string, string> = {
  ru: 'русский', en: 'English', uk: 'українська', de: 'Deutsch', fr: 'français',
  es: 'español', it: 'italiano', pl: 'polski', pt: 'português', tr: 'Türkçe',
}

/** Genres for AUTO mode. ids must match GENRES in lib/idea.ts. */
const GENRE_OPTIONS: { id: string; label: string }[] = [
  { id: 'detective', label: 'Детектив' },
  { id: 'horror', label: 'Ужасы' },
  { id: 'fantasy', label: 'Магия / Фэнтези' },
  { id: 'scifi', label: 'Сай-фай' },
  { id: 'drama', label: 'Драма' },
  { id: 'thriller', label: 'Триллер' },
  { id: 'romance', label: 'Романтика' },
  { id: 'comedy', label: 'Комедия' },
  { id: 'adventure', label: 'Приключения' },
  { id: 'postapoc', label: 'Постапокалипсис' },
  { id: 'mystery', label: 'Мистика' },
  { id: 'action', label: 'Боевик' },
  { id: 'historical', label: 'Историческая драма' },
  { id: 'melodrama', label: 'Мелодрама' },
]

/** Read-only character card with a pencil → prompt-based rewrite. */
export function CharacterCard({
  char,
  busy,
  onRevise,
  extra,
  footer,
}: {
  char: CharacterCardData
  busy?: boolean
  onRevise?: (characterId: string, instruction: string) => Promise<void>
  extra?: React.ReactNode
  footer?: React.ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [saving, setSaving] = useState(false)

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
        {onRevise && (
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            disabled={busy || saving}
            aria-label="Изменить персонажа по подсказке"
            title="Изменить персонажа по подсказке"
            data-testid="character-edit"
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition hover:text-foreground disabled:opacity-50"
          >
            {editing ? <X className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
          </button>
        )}
      </div>

      <TierBadge char={char} />
      {extra}

      <dl className="space-y-1.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
        <div><dt className="inline font-medium text-foreground">Возраст: </dt><dd className="inline">{char.age || '—'}</dd></div>
        <div><dt className="inline font-medium text-foreground">Роль: </dt><dd className="inline">{char.role || '—'}</dd></div>
        <div><dt className="inline font-medium text-foreground">Внешность: </dt><dd className="inline">{char.appearance || '—'}</dd></div>
        <div><dt className="inline font-medium text-foreground">Характер: </dt><dd className="inline">{char.personality || '—'}</dd></div>
        <div><dt className="inline font-medium text-foreground">Первое появление: </dt><dd className="inline">{char.firstAppearance || '—'}</dd></div>
      </dl>

      {editing && onRevise && (
        <div className="mt-3 space-y-2 rounded-lg border border-border bg-background p-3">
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="Что изменить в персонаже? Например: сделать старше и добавить шрам на щеке"
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
            Переписать карточку
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
 * successful edit so the season screen can offer «Применить изменения к сценарию сезона».
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
      if (!res.ok) { setError(data?.error ?? 'Не удалось добавить персонажей'); return }
      setCharacters(data.characters ?? characters)
      setNotice(`Добавлено персонажей: ${data.added}`)
      setCastHint('')
      onChanged?.('characters')
    } catch { setError('Ошибка сети') }
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
    if (!res.ok) { setError(data?.error ?? 'Не удалось изменить локацию'); return }
    setLocations((prev) => prev.map((l) => (l.id === locationId ? { ...l, ...data.location } : l)))
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
      if (!res.ok) { setError(data?.error ?? 'Не удалось изменить синопсис'); return }
      setSynopsis(data.synopsis ?? synopsis)
      if (data.charactersChanged) {
        setCharacters(data.characters ?? characters)
        setNotice(`Персонажи обновлены вместе с синопсисом. ${data.changeSummary ?? ''}`.trim())
      }
      setInstruction('')
      onChanged?.('synopsis')
    } catch { setError('Ошибка сети') }
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
    if (!res.ok) { setError(data?.error ?? 'Не удалось изменить персонажа'); return }
    setCharacters((prev) => prev.map((c) => (c.id === characterId ? { ...c, ...data.character } : c)))
    onChanged?.('characters')
  }

  return (
    <div className={collapsible ? 'space-y-3' : 'space-y-6'} data-testid="idea-editor">
      {error && <div className="rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}
      <Section id="synopsis" title="Синопсис сезона" collapsible={collapsible} open={!!openSections['synopsis']} onToggle={() => toggleSection('synopsis')}>
        <div className={collapsible ? '' : 'rounded-xl border border-border bg-card p-4 sm:p-6'} style={collapsible ? undefined : { boxShadow: 'var(--shadow-md)' }}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {!collapsible && <h3 className="font-display text-lg font-semibold">Синопсис сезона</h3>}
            {language && (
              <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground" data-testid="synopsis-language">
                язык: {LANGUAGE_LABELS[language] ?? language}
              </span>
            )}
          </div>
          <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]" data-testid="synopsis-text">
            {synopsis}
          </div>
          <div className="mt-5 rounded-lg border border-border bg-background p-3">
            <label className="mb-2 flex items-center gap-2 text-sm font-medium">
              <MessageSquareText className="h-4 w-4 text-primary" /> Что изменить
            </label>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Например: сделать финал сезона более мрачным, добавить линию соперницы"
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
              Переписать синопсис
            </button>
            {notice && (
              <p className="mt-2 rounded-lg bg-primary/10 px-3 py-2 text-xs text-primary" data-testid="characters-sync-notice">{notice}</p>
            )}
          </div>
        </div>
      </Section>

      <Section id="locations" title={`Локации (${locations.length})`} collapsible={collapsible} open={!!openSections['locations']} onToggle={() => toggleSection('locations')}>
        <div data-testid="idea-locations">
          {!collapsible && <h3 className="mb-1 font-display text-lg font-semibold">Локации ({locations.length})</h3>}
          <p className="mb-3 text-xs text-muted-foreground">Ключевые места сезона. Фотореалистичные референсы для них (и для персонажей) — на вкладке «Референсы»; видеомодель использует их вместе с персонажами.</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {locations.map((l) => (
              <LocationCard key={l.id} loc={l} busy={busy} onRevise={reviseLocation} />
            ))}
          </div>
          <div className="mt-3">
            <AddLocationForm projectId={project.id} busy={busy} onAdded={(loc) => { setLocations((p) => [...p, loc]); onChanged?.('locations') }} onError={setError} />
          </div>
        </div>
      </Section>

      <Section id="cast" title={`Персонажи (${characters.length})`} collapsible={collapsible} open={!!openSections['cast']} onToggle={() => toggleSection('cast')}>
        <div data-testid="idea-cast">
          {!collapsible && <h3 className="mb-3 font-display text-lg font-semibold">Персонажи ({characters.length})</h3>}
          {groupByTier(characters).map((g) => (
            <div key={g.tier} className="mb-5" data-testid={`cast-group-${g.tier}`}>
              <h4 className="mb-2 text-sm font-semibold text-muted-foreground">{TIER_LABELS[g.tier]} · {g.items.length}</h4>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {g.items.map((c) => (
                  <CharacterCard key={c.id} char={c} busy={busy} onRevise={reviseCharacter} />
                ))}
              </div>
            </div>
          ))}
          <div className="rounded-lg border border-border bg-background p-3">
            <label className="mb-2 flex items-center gap-2 text-sm font-medium">
              <UserPlus className="h-4 w-4 text-primary" /> Добавить ещё персонажей
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={castHint}
                onChange={(e) => setCastHint(e.target.value)}
                placeholder="Необязательно: кого добавить (например, «братья героя и соседи по дому»)"
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
                Добавить ещё персонажей
              </button>
            </div>
          </div>
        </div>
      </Section>
    </div>
  )
}

/**
 * Step "Идея": idea → synopsis (in the idea's language) + cast + locations, and — stage 5 — the
 * season script starts automatically right after (no extra clicks): approve-idea {next:"structure"}
 * → POST /api/ai/season → the wizard switches to the single «Сценарий сезона» screen.
 * The synopsis / cast / locations stay editable there (collapsible blocks).
 */
export function IdeaStage({ project, onRefresh }: { project: any; onRefresh: () => void }) {
  const [idea, setIdea] = useState<string>(project?.idea ?? '')
  const [result, setResult] = useState<{ synopsis: string; language: string; characters: CharacterCardData[]; locations: LocationCardData[] } | null>(
    project?.synopsis && project?.characters?.length ? { synopsis: project.synopsis, language: project.language ?? '', characters: project.characters, locations: project.locations ?? [] } : null
  )
  const [generating, setGenerating] = useState(false)
  const [chaining, setChaining] = useState(false)
  const [approving, setApproving] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [ideaCanceled, setIdeaCanceled] = useState(false)
  const ideaAbort = useRef<AbortController | null>(null)
  // Idea source: 'manual' = producer writes the idea; 'auto' = the AI invents it from a genre.
  const [mode, setMode] = useState<'manual' | 'auto'>('manual')
  const [genres, setGenres] = useState<string[]>([])
  const [extras, setExtras] = useState('')

  const hasResult = !!result
  const busy = generating || approving || chaining
  const toggleGenre = (id: string) =>
    setGenres((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]))
  const canGenerate = mode === 'auto' ? genres.length > 0 : idea.trim().length >= 10

  /** Auto-chain: approve (stage → structure) and start the season-script job, then show the season screen. */
  const startSeason = async () => {
    setChaining(true)
    try {
      const a = await fetch(`/api/projects/${project.id}/approve-idea`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ next: 'structure' }) })
      const ad = await a.json().catch(() => ({}))
      if (!a.ok) throw new Error(ad?.error ?? 'Не удалось подтвердить синопсис')
      const s = await fetch('/api/ai/season', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id }) })
      const sd = await s.json().catch(() => ({}))
      if (!s.ok) throw new Error(sd?.error ?? 'Не удалось запустить сценарий сезона')
      onRefresh()
      return true
    } catch (e: any) {
      setError(`${e?.message ?? 'Ошибка'} — нажмите «Перейти к сценарию сезона», чтобы повторить.`)
      return false
    } finally { setChaining(false) }
  }

  const generate = async () => {
    if (mode === 'auto') {
      if (genres.length === 0) { setError('Выберите хотя бы один жанр'); return }
    } else if (idea.trim().length < 10) {
      setError('Опишите идею хотя бы одним-двумя предложениями'); return
    }
    setError(''); setNotice(''); setIdeaCanceled(false); setGenerating(true)
    const controller = new AbortController()
    ideaAbort.current = controller
    try {
      const body = mode === 'auto'
        ? { projectId: project.id, auto: true, genres, extras: extras.trim() }
        : { projectId: project.id, idea: idea.trim() }
      const res = await fetch('/api/ai/idea', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const data = await res.json()
      if (!res.ok) { setError(data?.error ?? 'Не удалось сгенерировать'); return }
      setResult({ synopsis: data.synopsis ?? '', language: data.language ?? '', characters: data.characters ?? [], locations: data.locations ?? [] })
      if (data.castWarning) setNotice('Расширенный каст не удалось сгенерировать автоматически — нажмите «Добавить ещё персонажей».')
      await startSeason()
    } catch (e: any) {
      // Stage 11: the author canceled — the request is abandoned, nothing was saved or charged.
      if (e?.name === 'AbortError') setIdeaCanceled(true)
      else setError('Ошибка сети')
    }
    finally { setGenerating(false); ideaAbort.current = null }
  }

  // Stage 11: stop waiting for the (free) idea generation and abandon the request.
  const cancelIdea = async () => { ideaAbort.current?.abort() }

  const approve = async () => {
    setError(''); setApproving(true)
    try { await startSeason() } finally { setApproving(false) }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-4 sm:p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
        <h2 className="flex items-center gap-2 font-display text-xl font-bold">
          <Lightbulb className="h-5 w-5 text-primary" /> Шаг 1 — Идея
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Опишите свою идею — или выберите режим «Авто», и ИИ сам придумает оригинальную историю по выбранному жанру. Мы напишем синопсис, персонажей и локации, а затем сразу начнём полный сценарий сезона со сценами и диалогами.
        </p>

        {/* Mode toggle: своя идея / авто */}
        <div className="mt-4 inline-flex rounded-lg border border-border bg-muted/40 p-1" role="tablist" data-testid="idea-mode-toggle">
          <button
            type="button"
            onClick={() => setMode('manual')}
            disabled={busy}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition sm:text-sm ${mode === 'manual' ? 'bg-background text-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}
            data-testid="idea-mode-manual"
          >
            Своя идея
          </button>
          <button
            type="button"
            onClick={() => setMode('auto')}
            disabled={busy}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition sm:text-sm ${mode === 'auto' ? 'bg-background text-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}
            data-testid="idea-mode-auto"
          >
            Авто (ИИ придумывает историю)
          </button>
        </div>

        {error && <div className="mt-4 rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}
        {notice && <div className="mt-4 rounded-lg bg-primary/10 px-4 py-2 text-xs text-primary">{notice}</div>}

        {mode === 'manual' ? (
          <textarea
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="Например: молодая смотрительница маяка на северном острове находит дневник исчезнувшего предшественника..."
            rows={5}
            disabled={busy}
            className="mt-4 w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
            data-testid="idea-input"
          />
        ) : (
          <div className="mt-4 space-y-3" data-testid="idea-auto-panel">
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Выберите направление / жанр (можно несколько):</p>
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
              placeholder="Доп. пожелания (необязательно): сеттинг, эпоха, тон, чего хотелось бы избежать… Язык истории определится по этому тексту (по умолчанию — русский)."
              rows={3}
              disabled={busy}
              className="w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
              data-testid="idea-extras"
            />
          </div>
        )}
        <button
          onClick={generate}
          disabled={busy || !canGenerate}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-secondary px-5 py-2.5 text-sm font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50 sm:w-auto"
          data-testid="idea-generate"
        >
          {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
          {hasResult ? 'Сгенерировать заново' : mode === 'auto' ? 'Придумать историю и написать сезон' : 'Написать сценарий сезона'}
        </button>
        {generating && !chaining && (
          <div className="mt-2 flex items-center justify-between gap-2" data-testid="idea-progress">
            <p className="min-w-0 text-xs text-muted-foreground">Шаг 1 из 2 · обычно 40–90 секунд: синопсис, локации и полный каст (главные, семья и окружение, эпизодические, массовка)...</p>
            <CancelButton onCancel={cancelIdea} testId="idea-cancel" className="flex-shrink-0" />
          </div>
        )}
        {ideaCanceled && !generating && !chaining && (
          <p className="mt-2 text-xs text-amber-500" data-testid="idea-canceled">Генерация идеи отменена. Нажмите кнопку выше, чтобы запустить заново.</p>
        )}
        {chaining && (
          <p className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground" data-testid="idea-chaining"><Loader2 className="h-3 w-3 animate-spin text-primary" /> Шаг 2 из 2 · запускаю сценарий сезона…</p>
        )}
      </div>

      {hasResult && !generating && !chaining && (
        <>
          <IdeaEditor key={result.synopsis} project={project} synopsis={result.synopsis} language={result.language} characters={result.characters} locations={result.locations} disabled={busy} />
          <button
            onClick={approve}
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-3 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
            data-testid="approve-idea"
          >
            {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Перейти к сценарию сезона
          </button>
        </>
      )}
    </div>
  )
}
