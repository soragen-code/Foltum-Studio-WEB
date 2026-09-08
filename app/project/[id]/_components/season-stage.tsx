'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Loader2, Wand2, ChevronDown, ChevronRight, MapPin, Pencil, ArrowRight, Film, Check, Camera } from 'lucide-react'
import { JOB_POLL_INTERVAL_MS } from './use-job-polling'
import { TrailerCard } from './trailer-card'

type EpChar = { character: { id: string; name: string; imageFront?: string | null } }
export type SeasonEpisode = {
  id: string
  number: number
  title: string
  logline?: string | null
  arcRole?: string | null
  locationName?: string | null
  locationDesc?: string | null
  locationId?: string | null
  cliffhanger?: string | null
  script?: string | null
  status: string
  videoUrl?: string | null
  characters: EpChar[]
  scenes: { id: string; number: number; status: string; videoUrl?: string | null }[]
}
type SeasonData = { id: string; title?: string | null; logline?: string | null; status: string; episodes: SeasonEpisode[] } | null
type Job = { id: string; status: string; progress: number; message?: string | null; error?: string | null; resultData?: string | null } | null

const validUrl = (u?: string | null) => typeof u === 'string' && u.startsWith('http') && u.length > 10

export function episodeStatusLabel(ep: SeasonEpisode): string {
  if (ep.status === 'assembled' || ep.videoUrl) return 'собран'
  const total = ep.scenes.length
  const ready = ep.scenes.filter((s) => s.videoUrl).length
  if (total && ready === total) return 'все сцены готовы'
  if (ready > 0) return `сцен готово ${ready}/${total}`
  if (ep.script) return 'сценарий готов'
  return 'ожидает сценарий'
}

export function CharacterAvatars({ chars, size = 'h-8 w-8' }: { chars: EpChar[]; size?: string }) {
  return (
    <div className="flex -space-x-2">
      {chars.map(({ character: c }) => (
        <div key={c.id} title={c.name} className={`${size} overflow-hidden rounded-full border-2 border-background bg-muted ring-1 ring-border`}>
          {validUrl(c.imageFront) ? (
            <img src={c.imageFront as string} alt={c.name} className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[10px] font-semibold">{c.name.slice(0, 1)}</div>
          )}
        </div>
      ))}
    </div>
  )
}

/** Readable script with light structure (scene headers, action, dialogue, prompt technical lines). */
export function ScriptView({ text, scenes }: { text?: string | null; scenes?: { number: number; shotType?: string | null; durationSec?: number | null; locationDesc?: string | null; action?: string | null; dialogue?: string | null; videoPrompt?: string | null }[] }) {
  if (scenes && scenes.length) {
    return (
      <div className="space-y-4 text-sm leading-relaxed">
        {scenes.map((s) => {
          const tech = (s.videoPrompt ?? '').split('\n').filter((l) => /^\[(LIGHTING|BLOCKING|GAZE|NON-VERBAL)\]/.test(l))
          return (
            <div key={s.number} className="rounded-lg border border-border/60 bg-muted/20 p-3">
              <div className="font-semibold">Сцена {s.number} · {s.shotType} · ~{s.durationSec ?? 15}с</div>
              <div className="text-xs text-muted-foreground">{s.locationDesc}</div>
              {s.action && <p className="mt-2 italic">{s.action}</p>}
              <pre className="mt-2 whitespace-pre-wrap break-words font-sans">{s.dialogue}</pre>
              {tech.length > 0 && (
                <details className="mt-2 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Кадр: свет / мизансцена / взгляд / невербалика</summary>
                  <pre className="mt-1 whitespace-pre-wrap break-words font-sans">{tech.join('\n')}</pre>
                </details>
              )}
            </div>
          )
        })}
      </div>
    )
  }
  return <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">{text ?? ''}</pre>
}

export function SeasonStage({ project }: { project: any; onRefresh?: () => void }) {
  const [season, setSeason] = useState<SeasonData>(null)
  const [job, setJob] = useState<Job>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [reviseText, setReviseText] = useState<Record<string, string>>({})
  const [locText, setLocText] = useState<Record<string, string>>({})
  const [locOpen, setLocOpen] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<Record<string, string>>({}) // episodeId -> 'revise' | 'location'
  // Location references (id → imageUrl); refreshed while a location image job runs.
  const [locImages, setLocImages] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(((project?.locations ?? []) as { id: string; imageUrl?: string | null }[]).map((l) => [l.id, l.imageUrl ?? null]))
  )
  const [locGen, setLocGen] = useState<Record<string, boolean>>({}) // locationId → generating

  const loadLocations = useCallback(async () => {
    try {
      const res = await fetch(`/api/ai/locations?projectId=${project.id}`, { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      const list: { id: string; imageUrl?: string | null }[] = Array.isArray(data?.locations) ? data.locations : []
      setLocImages(Object.fromEntries(list.map((l) => [l.id, l.imageUrl ?? null])))
      setLocGen((g) => { const n = { ...g }; for (const l of list) if (validUrl(l.imageUrl)) delete n[l.id]; return n })
    } catch {}
  }, [project.id])
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/ai/season?projectId=${project.id}`, { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setSeason(data.season ?? null)
      setJob(data.job ?? null)
      // the worker may bind episodes to newly created locations — keep the id → image map in sync
      void loadLocations()
    } catch {}
    finally { setLoading(false) }
  }, [project.id, loadLocations])

  const anyLocGen = Object.values(locGen).some(Boolean)
  useEffect(() => {
    if (!anyLocGen) return
    const id = setInterval(loadLocations, JOB_POLL_INTERVAL_MS * 2)
    return () => clearInterval(id)
  }, [anyLocGen, loadLocations])

  const generateLocationRef = async (locationId: string) => {
    setError(null); setLocGen((g) => ({ ...g, [locationId]: true }))
    try {
      const res = await fetch(`/api/ai/locations/${locationId}/image`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Не удалось запустить генерацию референса локации')
    } catch (e: any) {
      setError(e?.message ?? 'Ошибка')
      setLocGen((g) => { const n = { ...g }; delete n[locationId]; return n })
    }
  }

  const jobActive = !!job && (job.status === 'pending' || job.status === 'processing')
  const result = (() => { try { return job?.resultData ? JSON.parse(job.resultData) : null } catch { return null } })()
  const paused = !!job && job.status === 'completed' && result && result.done === false
  const total = season?.episodes.length ?? 0
  const done = season?.episodes.filter((e) => e.script).length ?? 0
  const allDone = total > 0 && done === total

  useEffect(() => { load() }, [load])
  // Poll while a job runs (stable interval, no flicker: state only replaced on successful fetch).
  useEffect(() => {
    if (!jobActive) return
    const id = setInterval(load, JOB_POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [jobActive, load])

  const start = async () => {
    setStarting(true); setError(null)
    try {
      const res = await fetch('/api/ai/season', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Не удалось запустить генерацию')
      setJob({ id: data.jobId, status: 'processing', progress: 1, message: 'Запуск…' })
    } catch (e: any) { setError(e?.message ?? 'Ошибка') }
    finally { setStarting(false) }
  }
  // Auto-continue when the worker paused on the time budget.
  useEffect(() => { if (paused && !starting) void start() }, [paused]) // eslint-disable-line react-hooks/exhaustive-deps

  const revise = async (ep: SeasonEpisode, force = false) => {
    const instruction = reviseText[ep.id]?.trim()
    if (!instruction) return
    setBusy((b) => ({ ...b, [ep.id]: 'revise' })); setError(null)
    try {
      const res = await fetch(`/api/ai/episodes/${ep.id}/revise`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction, force }) })
      const data = await res.json()
      if (res.status === 409 && data?.needsForce) {
        if (confirm(`${data.error}\n\nПродолжить и переписать эпизод?`)) return revise(ep, true)
        return
      }
      if (!res.ok) throw new Error(data?.error ?? 'Не удалось переписать эпизод')
      setReviseText((t) => ({ ...t, [ep.id]: '' }))
      await load()
    } catch (e: any) { setError(e?.message ?? 'Ошибка') }
    finally { setBusy((b) => { const n = { ...b }; delete n[ep.id]; return n }) }
  }

  const reviseLocation = async (ep: SeasonEpisode) => {
    const instruction = locText[ep.id]?.trim()
    if (!instruction) return
    setBusy((b) => ({ ...b, [ep.id]: 'location' })); setError(null)
    try {
      const res = await fetch(`/api/ai/episodes/${ep.id}/location/revise`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Не удалось изменить локацию')
      setLocText((t) => ({ ...t, [ep.id]: '' })); setLocOpen((o) => ({ ...o, [ep.id]: false }))
      await load()
    } catch (e: any) { setError(e?.message ?? 'Ошибка') }
    finally { setBusy((b) => { const n = { ...b }; delete n[ep.id]; return n }) }
  }

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>

  return (
    <div className="space-y-6" data-testid="season-stage">
      <TrailerCard project={project} />
      <div className="rounded-xl border border-border bg-card p-4 sm:p-6">
        <h2 className="font-display text-xl font-bold">Сценарий сезона</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Полный сценарий первого сезона: 6–10 эпизодов, в каждом 10–15 сцен с полноценными диалогами (5–7 реплик-предложений) и раскадровкой для ИИ-экранизации. Каждый эпизод привязан к локации из списка референсов.
        </p>
        {season?.title && (
          <div className="mt-3">
            <div className="font-semibold">{season.title}</div>
            {season.logline && <p className="text-sm text-muted-foreground">{season.logline}</p>}
          </div>
        )}
        {!season && !jobActive && (
          <button onClick={start} disabled={starting} className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="season-generate">
            {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            Сгенерировать сценарий сезона
          </button>
        )}
        {(jobActive || starting) && (
          <div className="mt-4 space-y-2" data-testid="season-progress">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span>{job?.message ?? 'Запуск…'}</span>
              {total > 0 && <span className="text-muted-foreground">· готово {done} из {total}</span>}
            </div>
            <div className="h-2 w-full overflow-hidden rounded bg-muted">
              <div className="h-full rounded bg-primary transition-all duration-700" style={{ width: `${Math.max(2, job?.progress ?? 0)}%` }} />
            </div>
          </div>
        )}
        {job?.status === 'failed' && (
          <div className="mt-4 space-y-2">
            <p className="text-sm text-destructive">Ошибка: {job.error ?? 'генерация прервана'}</p>
            <button onClick={start} disabled={starting} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm" data-testid="season-continue">
              <Wand2 className="h-4 w-4" /> Продолжить генерацию
            </button>
          </div>
        )}
        {paused && !jobActive && (
          <button onClick={start} disabled={starting} className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-sm" data-testid="season-continue">
            <Wand2 className="h-4 w-4" /> Продолжить генерацию ({result?.remaining} эпизодов осталось)
          </button>
        )}
        {allDone && !jobActive && <p className="mt-3 inline-flex items-center gap-1 text-sm text-primary"><Check className="h-4 w-4" /> Все {total} эпизодов написаны</p>}
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>

      <div className="space-y-3">
        {season?.episodes.map((ep) => {
          const isOpen = !!open[ep.id]
          const b = busy[ep.id]
          return (
            <div key={ep.id} className="rounded-xl border border-border bg-card" data-testid="episode-card">
              <div className="flex items-start gap-3 p-4">
                <button onClick={() => setOpen((o) => ({ ...o, [ep.id]: !isOpen }))} className="mt-0.5 shrink-0 text-muted-foreground" aria-label="Раскрыть">
                  {isOpen ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold uppercase text-muted-foreground">Эпизод {ep.number}</span>
                    {ep.arcRole && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{ep.arcRole}</span>}
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]" data-testid="episode-status">{episodeStatusLabel(ep)}</span>
                  </div>
                  <h3 className="mt-1 font-semibold">{ep.title}</h3>
                  {ep.logline && <p className="mt-1 text-sm text-muted-foreground">{ep.logline}</p>}
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{ep.locationName || '—'}
                      <button onClick={() => setLocOpen((o) => ({ ...o, [ep.id]: !o[ep.id] }))} className="ml-1 rounded p-0.5 hover:bg-muted" aria-label="Изменить локацию" data-testid="location-edit"><Pencil className="h-3 w-3" /></button>
                    </span>
                    {ep.locationId && ep.locationId in locImages && !validUrl(locImages[ep.locationId]) && (
                      <button
                        onClick={() => generateLocationRef(ep.locationId as string)}
                        disabled={!!locGen[ep.locationId]}
                        className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
                        title="Локация появилась в сценарии и пока без референса — сгенерировать фотореалистичный кадр (1 кредит)"
                        data-testid="location-ref-generate"
                      >
                        {locGen[ep.locationId] ? <Loader2 className="h-3 w-3 animate-spin" /> : <Camera className="h-3 w-3" />}
                        {locGen[ep.locationId] ? 'референс локации…' : 'Сгенерировать референс локации'}
                      </button>
                    )}
                    {ep.locationId && validUrl(locImages[ep.locationId]) && (
                      <img src={locImages[ep.locationId] as string} alt={ep.locationName ?? ''} className="h-6 w-6 rounded object-cover ring-1 ring-border" title="Референс локации" data-testid="location-ref-thumb" />
                    )}
                    <CharacterAvatars chars={ep.characters} size="h-6 w-6" />
                    {ep.script && <span>{ep.scenes.length} сцен</span>}
                  </div>
                  {locOpen[ep.id] && (
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                      <input value={locText[ep.id] ?? ''} onChange={(e) => setLocText((t) => ({ ...t, [ep.id]: e.target.value }))} placeholder="Что изменить в локации…" className="flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm" data-testid="location-input" />
                      <button onClick={() => reviseLocation(ep)} disabled={!!b || !(locText[ep.id] ?? '').trim()} className="inline-flex items-center justify-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50" data-testid="location-submit">
                        {b === 'location' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Применить
                      </button>
                    </div>
                  )}
                </div>
                {ep.script && (
                  <Link href={`/project/${project.id}/episode/${ep.id}`} className="hidden shrink-0 items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted sm:inline-flex" data-testid="open-episode">
                    <Film className="h-4 w-4" /> Открыть эпизод
                  </Link>
                )}
              </div>
              {isOpen && (
                <div className="border-t border-border p-4">
                  {ep.locationDesc && <p className="mb-3 text-xs text-muted-foreground"><span className="font-semibold">Локация:</span> {ep.locationDesc}</p>}
                  {ep.script ? <ScriptView text={ep.script} /> : <p className="text-sm text-muted-foreground">Сценарий эпизода ещё пишется…</p>}
                  {ep.script && (
                    <div className="mt-4 space-y-2">
                      <label className="text-xs font-semibold text-muted-foreground">Что изменить в эпизоде</label>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <textarea value={reviseText[ep.id] ?? ''} onChange={(e) => setReviseText((t) => ({ ...t, [ep.id]: e.target.value }))} rows={2} placeholder="Например: сделать финал жёстче, добавить конфликт между героями…" className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm" data-testid="episode-revise-input" />
                        <button onClick={() => revise(ep)} disabled={!!b || !(reviseText[ep.id] ?? '').trim()} className="inline-flex items-center justify-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" data-testid="episode-revise-submit">
                          {b === 'revise' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Переписать
                        </button>
                      </div>
                      {b === 'revise' && <p className="text-xs text-muted-foreground">Переписываю сценарий эпизода (1–2 минуты)…</p>}
                    </div>
                  )}
                  {ep.script && (
                    <Link href={`/project/${project.id}/episode/${ep.id}`} className="mt-4 inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted sm:hidden">
                      <Film className="h-4 w-4" /> Открыть эпизод <ArrowRight className="h-4 w-4" />
                    </Link>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
