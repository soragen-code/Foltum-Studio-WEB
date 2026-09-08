'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Wand2, ArrowRight, User, ImageOff, Users, RefreshCw } from 'lucide-react'
import { CharacterCard, type CharacterCardData } from './idea-stage'
import type { JobInfo } from './use-job-polling'

interface RefCharacter extends CharacterCardData {
  imageFront?: string | null
  imageProfile?: string | null
  imageFull?: string | null
}

const POLL_MS = 3000
const SHOT_LABELS = ['Портрет', 'Профиль', 'В полный рост']

function validUrl(u?: string | null) {
  return typeof u === 'string' && u.startsWith('http') && u.length > 10
}
function hasAllImages(c: RefCharacter) {
  return validUrl(c.imageFront) && validUrl(c.imageProfile) && validUrl(c.imageFull)
}
function hasAnyImage(c: RefCharacter) {
  return validUrl(c.imageFront) || validUrl(c.imageProfile) || validUrl(c.imageFull)
}

/**
 * Step "Персонажи (референсы)": Seedream references per character, a stable
 * per-character spinner (activeGen map), prompt-based appearance edits that
 * regenerate that character's references, and "Продолжить к сценарию".
 */
export function ReferencesStage({ project, onRefresh }: { project: any; onRefresh: () => void }) {
  const [characters, setCharacters] = useState<RefCharacter[]>(project?.characters ?? [])
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [error, setError] = useState('')
  const [continuing, setContinuing] = useState(false)
  const [starting, setStarting] = useState(false)
  // characterId → jobId of a regeneration we started locally (kept until the server confirms the job)
  const [localGen, setLocalGen] = useState<Record<string, string>>({})
  const mounted = useRef(true)

  /** One tick: active character jobs + fresh character rows. */
  const tick = useCallback(async () => {
    try {
      const [jobsRes, projRes] = await Promise.all([
        fetch(`/api/jobs?projectId=${project.id}&type=characters&active=1`, { cache: 'no-store' }),
        fetch(`/api/projects/${project.id}`, { cache: 'no-store' }),
      ])
      if (!mounted.current) return
      if (jobsRes.ok) {
        const data = await jobsRes.json()
        const list: JobInfo[] = Array.isArray(data?.jobs) ? data.jobs : []
        setJobs(list)
        // drop local markers once the server knows about the job (or it finished)
        setLocalGen((prev) => {
          const next: Record<string, string> = {}
          for (const [cid, jid] of Object.entries(prev)) if (list.some((j) => j.id === jid)) next[cid] = jid
          return Object.keys(next).length === Object.keys(prev).length ? prev : next
        })
      }
      if (projRes.ok) {
        const data = await projRes.json()
        if (Array.isArray(data?.project?.characters)) setCharacters(data.project.characters)
      }
    } catch {
      /* transient — keep polling */
    }
  }, [project.id])

  useEffect(() => {
    mounted.current = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const loop = async () => {
      await tick()
      if (mounted.current) timer = setTimeout(loop, POLL_MS)
    }
    loop()
    return () => {
      mounted.current = false
      if (timer) clearTimeout(timer)
    }
  }, [tick])

  const projectJob = jobs.find((j) => !j.characterId)
  const activeGen: Record<string, JobInfo | 'local'> = {}
  for (const j of jobs) if (j.characterId) activeGen[j.characterId] = j
  for (const cid of Object.keys(localGen)) if (!activeGen[cid]) activeGen[cid] = 'local'
  if (projectJob) for (const c of characters) if (!hasAllImages(c) && !activeGen[c.id]) activeGen[c.id] = projectJob

  const anyActive = jobs.length > 0 || Object.keys(localGen).length > 0
  const readyCount = characters.filter(hasAnyImage).length
  const missing = characters.filter((c) => !hasAllImages(c))

  /** (Re)start the project-wide reference job — idempotent on the server. */
  const startReferences = async () => {
    setError(''); setStarting(true)
    try {
      const res = await fetch(`/api/projects/${project.id}/approve-idea`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) { setError(data?.error ?? 'Не удалось запустить генерацию'); return }
      await tick()
    } catch { setError('Ошибка сети') }
    finally { setStarting(false) }
  }

  const changeAppearance = async (characterId: string, instruction: string) => {
    setError('')
    const res = await fetch('/api/ai/characters/appearance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ characterId, instruction }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data?.error ?? 'Не удалось изменить внешность'); return }
    if (data?.character) setCharacters((prev) => prev.map((c) => (c.id === characterId ? { ...c, ...data.character } : c)))
    if (data?.jobId) setLocalGen((prev) => ({ ...prev, [characterId]: data.jobId }))
    await tick()
  }

  const continueToScript = async () => {
    setError(''); setContinuing(true)
    try {
      const res = await fetch(`/api/projects/${project.id}/continue-to-script`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) { setError(data?.error ?? 'Не удалось продолжить'); return }
      onRefresh()
    } catch { setError('Ошибка сети') }
    finally { setContinuing(false) }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-4 sm:p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
        <h2 className="flex items-center gap-2 font-display text-xl font-bold">
          <Users className="h-5 w-5 text-primary" /> Шаг 2 — Персонажи (референсы)
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Фотореалистичные референсы генерируются по описанию внешности каждого персонажа. Готово: {readyCount} из {characters.length}.
        </p>
        {error && <div className="mt-4 rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}
        {projectJob && (
          <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground" data-testid="references-progress">
            <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-primary" />
            <span className="truncate">{projectJob.message ?? 'Генерация референсов...'}</span>
            <span className="ml-auto flex-shrink-0 tabular-nums">{Math.round(projectJob.progress)}%</span>
          </div>
        )}
        {!anyActive && missing.length > 0 && (
          <button
            onClick={startReferences}
            disabled={starting}
            className="mt-4 flex items-center gap-2 rounded-lg bg-secondary px-4 py-2 text-xs font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50"
            data-testid="references-start"
          >
            {starting ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Догенерировать недостающие референсы
          </button>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {characters.map((c) => {
          const gen = activeGen[c.id]
          return (
            <CharacterCard
              key={c.id}
              char={c}
              busy={!!gen}
              extra={<ReferenceImages char={c} generating={!!gen} message={gen && gen !== 'local' ? gen.message : null} />}
              footer={
                <AppearanceEditor characterId={c.id} disabled={!!gen} onSubmit={changeAppearance} />
              }
            />
          )
        })}
      </div>

      <button
        onClick={continueToScript}
        disabled={continuing || readyCount === 0}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-3 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
        data-testid="continue-to-script"
      >
        {continuing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
        Продолжить к сценарию
      </button>
      {readyCount === 0 && (
        <p className="-mt-3 text-center text-xs text-muted-foreground">
          Кнопка станет доступна, когда будет готов хотя бы один референс.
        </p>
      )}
    </div>
  )
}

function ReferenceImages({ char, generating, message }: { char: RefCharacter; generating: boolean; message?: string | null }) {
  const images = [char.imageFront, char.imageProfile, char.imageFull]
  return (
    <div className="mb-3">
      <div className="grid grid-cols-3 gap-2">
        {images.map((img, i) => (
          <div key={i} className="relative aspect-[3/4] overflow-hidden rounded-lg bg-muted" title={SHOT_LABELS[i]}>
            {validUrl(img) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={img as string} alt={`${char.name} — ${SHOT_LABELS[i]}`} className="h-full w-full object-cover" data-testid="reference-image" />
            ) : generating ? (
              <div className="flex h-full w-full items-center justify-center" data-testid="reference-spinner">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-muted/50">
                <ImageOff className="h-5 w-5 text-muted-foreground/40" />
              </div>
            )}
            {generating && validUrl(img) && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/60">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            )}
          </div>
        ))}
      </div>
      {generating && (
        <p className="mt-1.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground" data-testid="reference-status">
          <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-primary" />
          <span className="truncate">{message || 'Генерация референсов...'}</span>
        </p>
      )}
    </div>
  )
}

function AppearanceEditor({
  characterId,
  disabled,
  onSubmit,
}: {
  characterId: string
  disabled: boolean
  onSubmit: (characterId: string, instruction: string) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const submit = async () => {
    if (!text.trim()) return
    setSending(true)
    try {
      await onSubmit(characterId, text.trim())
      setText('')
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3">
      <label className="block text-xs font-medium">Изменить внешность</label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        disabled={disabled || sending}
        placeholder="Например: короткая седая стрижка, очки в тонкой оправе"
        className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-xs outline-none focus:border-primary"
        data-testid="appearance-input"
      />
      <button
        type="button"
        onClick={submit}
        disabled={disabled || sending || !text.trim()}
        className="flex items-center gap-1 rounded-lg bg-muted px-3 py-1.5 text-xs transition hover:bg-muted/80 disabled:opacity-50"
        data-testid="appearance-submit"
        title="Обновит описание внешности и перегенерирует референсы (1 кредит)"
      >
        {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
        Обновить и перегенерировать (1 кредит)
      </button>
    </div>
  )
}
