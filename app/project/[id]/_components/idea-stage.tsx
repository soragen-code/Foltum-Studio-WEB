'use client'

import { useState } from 'react'
import { Loader2, Wand2, Check, Pencil, User, X, Lightbulb, MessageSquareText } from 'lucide-react'

export interface CharacterCardData {
  id: string
  name: string
  age?: string | null
  role?: string | null
  appearance?: string | null
  personality?: string | null
  firstAppearance?: string | null
}

const LANGUAGE_LABELS: Record<string, string> = {
  ru: 'русский', en: 'English', uk: 'українська', de: 'Deutsch', fr: 'français',
  es: 'español', it: 'italiano', pl: 'polski', pt: 'português', tr: 'Türkçe',
}

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
 * Step "Идея": idea → synopsis (in the idea's language) + character cards,
 * prompt-based edits for both, then "Подтвердить синопсис и персонажей".
 */
export function IdeaStage({ project, onRefresh }: { project: any; onRefresh: () => void }) {
  const [idea, setIdea] = useState<string>(project?.idea ?? '')
  const [synopsis, setSynopsis] = useState<string>(project?.synopsis ?? '')
  const [language, setLanguage] = useState<string>(project?.language ?? '')
  const [characters, setCharacters] = useState<CharacterCardData[]>(project?.characters ?? [])
  const [generating, setGenerating] = useState(false)
  const [revising, setRevising] = useState(false)
  const [approving, setApproving] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const hasResult = synopsis.trim().length > 0 && characters.length > 0
  const busy = generating || revising || approving

  const generate = async () => {
    if (idea.trim().length < 10) { setError('Опишите идею хотя бы одним-двумя предложениями'); return }
    setError(''); setNotice(''); setGenerating(true)
    try {
      const res = await fetch('/api/ai/idea', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, idea: idea.trim() }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data?.error ?? 'Не удалось сгенерировать'); return }
      setSynopsis(data.synopsis ?? '')
      setLanguage(data.language ?? '')
      setCharacters(data.characters ?? [])
    } catch { setError('Ошибка сети') }
    finally { setGenerating(false) }
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
  }

  const approve = async () => {
    setError(''); setApproving(true)
    try {
      const res = await fetch(`/api/projects/${project.id}/approve-idea`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) { setError(data?.error ?? 'Не удалось подтвердить'); return }
      onRefresh()
    } catch { setError('Ошибка сети') }
    finally { setApproving(false) }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-4 sm:p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
        <h2 className="flex items-center gap-2 font-display text-xl font-bold">
          <Lightbulb className="h-5 w-5 text-primary" /> Шаг 1 — Идея
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Опишите идею сериала на любом языке. Мы напишем короткий синопсис сезона на этом же языке и предложим персонажей.
        </p>

        {error && <div className="mt-4 rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}

        <textarea
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          placeholder="Например: молодая смотрительница маяка на северном острове находит дневник исчезнувшего предшественника..."
          rows={5}
          disabled={busy}
          className="mt-4 w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
          data-testid="idea-input"
        />
        <button
          onClick={generate}
          disabled={busy || idea.trim().length < 10}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-secondary px-5 py-2.5 text-sm font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50 sm:w-auto"
          data-testid="idea-generate"
        >
          {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
          {hasResult ? 'Сгенерировать заново' : 'Сгенерировать синопсис и персонажей'}
        </button>
        {generating && (
          <p className="mt-2 text-xs text-muted-foreground">Обычно это занимает 20–40 секунд...</p>
        )}
      </div>

      {hasResult && (
        <>
          <div className="rounded-xl border border-border bg-card p-4 sm:p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-display text-lg font-semibold">Синопсис сезона</h3>
              {language && (
                <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground" data-testid="synopsis-language">
                  язык: {LANGUAGE_LABELS[language] ?? language}
                </span>
              )}
            </div>
            <div
              className="mt-3 whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]"
              data-testid="synopsis-text"
            >
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
                <p className="mt-2 rounded-lg bg-primary/10 px-3 py-2 text-xs text-primary" data-testid="characters-sync-notice">
                  {notice}
                </p>
              )}
            </div>
          </div>

          <div>
            <h3 className="mb-3 font-display text-lg font-semibold">Персонажи ({characters.length})</h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {characters.map((c) => (
                <CharacterCard key={c.id} char={c} busy={busy} onRevise={reviseCharacter} />
              ))}
            </div>
          </div>

          <button
            onClick={approve}
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-3 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
            data-testid="approve-idea"
          >
            {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Подтвердить синопсис и персонажей
          </button>
        </>
      )}
    </div>
  )
}
