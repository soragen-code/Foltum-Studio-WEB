'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Loader2, Wand2, ChevronDown, ChevronRight, MapPin, Pencil, ArrowRight, Film, Check, Camera, Images, RefreshCw } from 'lucide-react'
import { JOB_POLL_INTERVAL_MS } from './use-job-polling'
import { IdeaEditor } from './idea-stage'

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

/** Which episode the season worker is writing right now (first one without a script), or null. */
export function writingEpisodeNumber(episodes: { number: number; script?: string | null }[], jobActive: boolean): number | null {
  if (!jobActive) return null
  const next = [...episodes].sort((a, b) => a.number - b.number).find((e) => !e.script)
  return next ? next.number : null
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
export function ScriptView({ text, scenes }: { text?: string | null; scenes?: { number: number; shotType?: string | null; durationSec?: number | null; locationDesc?: string | null; action?: string | null; dialogue?: string | null; dialogueEn?: string | null; videoPrompt?: string | null }[] }) {
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
              {s.dialogueEn && s.dialogueEn.trim() !== (s.dialogue ?? '').trim() && (
                <details className="mt-2 text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Озвучка (English) — текст сцены на языке сценария</summary>
                  <pre className="mt-1 whitespace-pre-wrap break-words font-sans">{s.dialogueEn}</pre>
                </details>
              )}
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

export function SeasonStage({ project, onRefresh }: { project: any; onRefresh?: () => void }) {
  const [season, setSeason] = useState<SeasonData>(null)
  const [job, setJob] = useState<Job>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Season-level prompt editing (stage 5) and «apply idea edits to the season script».
  const [seasonText, setSeasonText] = useState('')
  const [seasonBusy, setSeasonBusy] = useState(false)
  const [seasonNotice, setSeasonNotice] = useState('')
  const [ideaChanged, setIdeaChanged] = useState<string[]>([])
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
  // Auto-continue when the worker paused on the time budget: the client POSTs again until done
  // (one request per pause — the ref guards against duplicate starts while the POST is in flight).
  const continuedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!paused || jobActive || starting || !job) return
    if (continuedFor.current === job.id) return
    continuedFor.current = job.id
    void start()
  }, [paused, jobActive, starting, job]) // eslint-disable-line react-hooks/exhaustive-deps
  // Once the whole season is written, let the wizard refresh the project (stage badges, cast).
  const wasActive = useRef(false)
  useEffect(() => {
    if (jobActive) { wasActive.current = true; return }
    if (wasActive.current) { wasActive.current = false; onRefresh?.() }
  }, [jobActive]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Season-level revise: LLM rewrites the season structure by instruction, the worker regenerates affected episodes. */
  const reviseSeason = async (opts: { instruction?: string; sync?: boolean; force?: boolean }) => {
    setSeasonBusy(true); setError(null); setSeasonNotice('')
    try {
      const res = await fetch('/api/ai/season/revise', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, instruction: opts.instruction, sync: !!opts.sync, force: !!opts.force }),
      })
      const data = await res.json()
      if (res.status === 409 && data?.needsForce) {
        if (confirm(`${data.error}\n\nПродолжить и переписать эти эпизоды?`)) return reviseSeason({ ...opts, force: true })
        return
      }
      if (!res.ok) throw new Error(data?.error ?? 'Не удалось изменить сезон')
      setSeasonText(''); setIdeaChanged([])
      const affected: number[] = Array.isArray(data?.affected) ? data.affected : []
      setSeasonNotice(affected.length
        ? `Структура сезона обновлена. Переписываю эпизоды: ${affected.join(', ')} — остальные не тронуты.`
        : 'Структура сезона обновлена (названия/описания). Сценарии эпизодов не изменились.')
      if (data?.jobId) setJob({ id: data.jobId, status: 'processing', progress: 1, message: 'Запуск…' })
      await load()
    } catch (e: any) { setError(e?.message ?? 'Ошибка') }
    finally { setSeasonBusy(false) }
  }

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
      if (res.status === 409 && data?.writing) throw new Error(data.error)
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

  const writingNo = writingEpisodeNumber(season?.episodes ?? [], jobActive)
  const seasonLocked = jobActive || starting || seasonBusy

  return (
    <div className="space-y-6" data-testid="season-stage">
      {project?.synopsis && (
        <div className="rounded-xl border border-border bg-card p-4 sm:p-6" data-testid="season-idea-block">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-xl font-bold">Идея сезона</h2>
            <Link href={`/project/${project.id}?tab=references`} className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted" data-testid="open-references">
              <Images className="h-4 w-4" /> Референсы и трейлер
            </Link>
          </div>
          <p className="mt-1 mb-3 text-sm text-muted-foreground">Синопсис, локации и персонажи — редактируются промптами. Раскройте блок, чтобы изменить.</p>
          <IdeaEditor
            project={project}
            synopsis={project.synopsis}
            language={project.language}
            characters={project.characters ?? []}
            locations={project.locations ?? []}
            collapsible
            disabled={seasonLocked}
            onChanged={(what) => setIdeaChanged((c) => (c.includes(what) ? c : [...c, what]))}
          />
          {ideaChanged.length > 0 && season && !seasonLocked && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm" data-testid="season-sync-hint">
              <span>Идея изменилась — сценарий сезона пока не синхронизирован.</span>
              <button onClick={() => reviseSeason({ sync: true })} className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground" data-testid="season-sync">
                <RefreshCw className="h-4 w-4" /> Применить изменения к сценарию сезона
              </button>
            </div>
          )}
        </div>
      )}
      <div className="rounded-xl border border-border bg-card p-4 sm:p-6">
        <h2 className="font-display text-xl font-bold">Сценарий сезона</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Полный сценарий первого сезона: 6–10 эпизодов, в каждом 6–15 сцен (длину решает драматургия) с полноценными диалогами и раскадровкой для ИИ-экранизации. Эпизоды появляются по мере написания — готовые можно раскрыть и править промптом, не дожидаясь остальных.
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
              <span>{writingNo ? `Пишу эпизод ${writingNo} из ${total}` : (job?.message ?? 'Запуск…')}</span>
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
        {season && allDone && !jobActive && (
          <div className="mt-4 space-y-2" data-testid="season-revise">
            <label className="text-xs font-semibold text-muted-foreground">Что изменить в сезоне</label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <textarea value={seasonText} onChange={(e) => setSeasonText(e.target.value)} rows={2} disabled={seasonBusy}
                placeholder="Например: сделай финал 8-го эпизода открытым и добавь второстепенного персонажа-детектива…"
                className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm" data-testid="season-revise-input" />
              <button onClick={() => reviseSeason({ instruction: seasonText.trim() })} disabled={seasonBusy || !seasonText.trim()}
                className="inline-flex items-center justify-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" data-testid="season-revise-submit">
                {seasonBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Изменить сезон
              </button>
            </div>
            <p className="text-xs text-muted-foreground">ИИ перестроит структуру сезона (арки, локации, персонажи по эпизодам) и перепишет только затронутые эпизоды. Если в них уже есть видео — спросит подтверждение.</p>
            {seasonBusy && <p className="text-xs text-muted-foreground">Перестраиваю структуру сезона (около минуты)…</p>}
          </div>
        )}
        {seasonNotice && <p className="mt-3 text-sm text-primary" data-testid="season-notice">{seasonNotice}</p>}
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
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]" data-testid="episode-status">
                      {!ep.script && jobActive ? (writingNo === ep.number ? 'пишется…' : 'в очереди') : episodeStatusLabel(ep)}
                    </span>
                    {!ep.script && jobActive && writingNo === ep.number && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
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
                  {ep.script ? <ScriptView text={ep.script} /> : <p className="text-sm text-muted-foreground">{jobActive ? 'Сценарий эпизода ещё пишется — править его можно будет, когда он появится.' : 'Сценарий эпизода ещё не написан.'}</p>}
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
