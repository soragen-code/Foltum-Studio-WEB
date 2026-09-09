'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Header } from '@/components/header'
import { Loader2, Wand2, ArrowLeft, MapPin, Film, Download, Play, RefreshCw, Clapperboard, Images } from 'lucide-react'
import { postJobStart, SceneVideoPlayer } from '../../_components/scenes-stage'
import { ScriptView } from '../../_components/season-stage'
import { JobProgressBar, type JobInfo, type JobPollResponse, JOB_POLL_INTERVAL_MS } from '../../_components/use-job-polling'

const VIDEO_EXPECTED_SEC = 600
const validUrl = (u?: string | null) => typeof u === 'string' && u.startsWith('http') && u.length > 10

type Scene = { id: string; number: number; shotType?: string | null; durationSec?: number | null; locationDesc?: string | null; action?: string | null; dialogue?: string | null; videoPrompt?: string | null; videoUrl?: string | null; audioUrl?: string | null; lastFrameUrl?: string | null; status: string; characters: { character: { id: string; name: string; imageFront?: string | null } }[] }
type Plan = { sceneCount: number; pendingCount: number; duration: number; costPerScene: number; total: number; credits: number; tier: string; resolution: string }

export function EpisodeView({ episode: initial, project, credits: initialCredits }: { episode: any; project: any; credits: number }) {
  const [episode, setEpisode] = useState<any>(initial)
  const [scenes, setScenes] = useState<Scene[]>(initial.scenes ?? [])
  const [credits, setCredits] = useState(initialCredits)
  const [error, setError] = useState<string | null>(null)
  const [reviseText, setReviseText] = useState('')
  const [revising, setRevising] = useState(false)
  const [sceneEdit, setSceneEdit] = useState<Record<string, string>>({})
  const [sceneBusy, setSceneBusy] = useState<Record<string, boolean>>({})
  const [regenAsk, setRegenAsk] = useState<string | null>(null) // sceneId awaiting paid regen confirmation
  const [plan, setPlan] = useState<Plan | null>(null)
  const [modal, setModal] = useState(false)
  const [startingAll, setStartingAll] = useState(false)
  const [assembling, setAssembling] = useState(false)
  const [activeGen, setActiveGen] = useState<Record<string, boolean>>({})
  const [videoJobs, setVideoJobs] = useState<Record<string, JobInfo>>({})
  const pollTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const patchScene = (sceneId: string, patch: Partial<Scene>) => setScenes((prev) => prev.map((s) => (s.id === sceneId ? { ...s, ...patch } : s)))
  const stopPolling = (sceneId: string) => { const t = pollTimers.current[sceneId]; if (t) clearTimeout(t); delete pollTimers.current[sceneId] }
  const clearGen = (sceneId: string) => setActiveGen((p) => { const n = { ...p }; delete n[sceneId]; return n })

  const refreshCredits = useCallback(async () => {
    try { const r = await fetch('/api/user/credits', { cache: 'no-store' }); if (r.ok) { const d = await r.json(); if (typeof d?.credits === 'number') setCredits(d.credits) } } catch {}
  }, [])

  /** Same stable-spinner logic as ScenesStage: poll one scene's job until terminal. */
  const pollVideoJob = (sceneId: string, jobId: string) => {
    stopPolling(sceneId)
    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' })
        if (res.status === 404) { stopPolling(sceneId); clearGen(sceneId); return }
        const data: JobPollResponse = await res.json()
        if (data?.job) {
          setVideoJobs((prev) => ({ ...prev, [sceneId]: data.job }))
          if (data.job.status === 'completed' || data.job.status === 'failed') {
            stopPolling(sceneId); clearGen(sceneId)
            if (data.job.status === 'failed') setError(`Сцена: ${data.job.error ?? 'генерация не удалась'}`)
            const updated = data.scene ?? data.job.result?.scene
            if (updated) patchScene(sceneId, updated)
            void refreshCredits()
            setTimeout(() => setVideoJobs((prev) => { const n = { ...prev }; if (n[sceneId]?.id === jobId) delete n[sceneId]; return n }), 2500)
            return
          }
        }
      } catch {}
      pollTimers.current[sceneId] = setTimeout(tick, JOB_POLL_INTERVAL_MS)
    }
    tick()
  }
  useEffect(() => () => { Object.values(pollTimers.current).forEach(clearTimeout) }, [])
  // Resume polling for active jobs after reload.
  useEffect(() => {
    fetch(`/api/jobs?projectId=${project.id}&type=video&active=1`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((data) => {
      const ids = new Set(scenes.map((s) => s.id))
      for (const j of data?.jobs ?? []) if (j?.sceneId && ids.has(j.sceneId) && !pollTimers.current[j.sceneId]) { setActiveGen((p) => ({ ...p, [j.sceneId]: true })); setVideoJobs((p) => ({ ...p, [j.sceneId]: j })); pollVideoJob(j.sceneId, j.id) }
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const reloadEpisode = async () => {
    try {
      const r = await fetch(`/api/ai/season?projectId=${project.id}`, { cache: 'no-store' })
      if (!r.ok) return
      const d = await r.json()
      const ep = d?.season?.episodes?.find((e: any) => e.id === episode.id)
      if (ep) setEpisode((prev: any) => ({ ...prev, ...ep, scenes: prev.scenes }))
      const r2 = await fetch(`/api/projects/${project.id}`, { cache: 'no-store' })
      if (r2.ok) { const d2 = await r2.json(); const e2 = d2?.project?.seasons?.flatMap((s: any) => s.episodes)?.find((e: any) => e.id === episode.id); if (e2?.scenes) setScenes(e2.scenes) }
    } catch {}
  }

  const reviseEpisode = async (force = false) => {
    const instruction = reviseText.trim(); if (!instruction) return
    setRevising(true); setError(null)
    try {
      const res = await fetch(`/api/ai/episodes/${episode.id}/revise`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction, force }) })
      const data = await res.json()
      if (res.status === 409 && data?.needsForce) { if (confirm(`${data.error}\n\nПродолжить?`)) return reviseEpisode(true); return }
      if (!res.ok) throw new Error(data?.error ?? 'Не удалось переписать эпизод')
      setReviseText(''); await reloadEpisode()
    } catch (e: any) { setError(e?.message ?? 'Ошибка') } finally { setRevising(false) }
  }

  const loadPlan = useCallback(async () => {
    const r = await fetch(`/api/ai/episodes/${episode.id}/generate-all`, { cache: 'no-store' })
    const d = await r.json(); if (!r.ok) throw new Error(d?.error ?? 'Ошибка')
    setPlan(d); return d
  }, [episode.id])
  // Preload the cost plan so "Изменить сцену" → regen confirmation can show the price at once.
  useEffect(() => { loadPlan().catch(() => {}) }, [loadPlan])
  const openModal = async () => {
    setError(null)
    try { await loadPlan(); setModal(true) } catch (e: any) { setError(e?.message ?? 'Ошибка') }
  }
  const generateAll = async () => {
    setStartingAll(true); setError(null)
    try {
      const res = await postJobStart(`/api/ai/episodes/${episode.id}/generate-all`, {})
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Не удалось запустить генерацию')
      setModal(false)
      for (const j of data.jobs ?? []) { setActiveGen((p) => ({ ...p, [j.sceneId]: true })); patchScene(j.sceneId, { status: 'generating' }); pollVideoJob(j.sceneId, j.jobId) }
      if (typeof data.creditsRemaining === 'number') setCredits(data.creditsRemaining)
    } catch (e: any) { setError(e?.message ?? 'Ошибка') } finally { setStartingAll(false) }
  }

  const reviseScene = async (scene: Scene) => {
    const instruction = sceneEdit[scene.id]?.trim(); if (!instruction) return
    setSceneBusy((b) => ({ ...b, [scene.id]: true })); setError(null)
    try {
      const res = await fetch(`/api/ai/scenes/${scene.id}/revise`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction }) })
      const data = await res.json(); if (!res.ok) throw new Error(data?.error ?? 'Не удалось изменить сцену')
      patchScene(scene.id, data.scene); setSceneEdit((t) => ({ ...t, [scene.id]: '' })); setRegenAsk(scene.id)
    } catch (e: any) { setError(e?.message ?? 'Ошибка') } finally { setSceneBusy((b) => { const n = { ...b }; delete n[scene.id]; return n }) }
  }
  const regenScene = async (sceneId: string) => {
    setRegenAsk(null); setActiveGen((p) => ({ ...p, [sceneId]: true })); setError(null)
    try {
      const res = await postJobStart('/api/ai/generate-video', { projectId: project.id, sceneId })
      const data = await res.json(); if (!res.ok) throw new Error(data?.error ?? 'Не удалось запустить генерацию')
      patchScene(sceneId, { status: 'generating' }); pollVideoJob(sceneId, data.jobId); void refreshCredits()
    } catch (e: any) { clearGen(sceneId); setError(e?.message ?? 'Ошибка') }
  }

  const allReady = scenes.length > 0 && scenes.every((s) => validUrl(s.videoUrl) && !activeGen[s.id])
  const assemble = async () => {
    setAssembling(true); setError(null)
    try {
      const res = await fetch('/api/ai/assemble-episode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ episodeId: episode.id }) })
      const data = await res.json(); if (!res.ok) throw new Error(data?.error ?? 'Сборка не удалась')
      setEpisode((p: any) => ({ ...p, videoUrl: data.videoUrl, status: 'assembled' }))
    } catch (e: any) { setError(e?.message ?? 'Ошибка') } finally { setAssembling(false) }
  }

  const perScene = plan?.costPerScene
  const chars = episode.characters?.length ? episode.characters : (project.characters ?? []).map((c: any) => ({ character: c }))
  // Stage 5: references are optional — warn (not block) when scene characters have no reference image yet.
  const missingRefs: string[] = Array.from(new Set<string>(
    scenes.flatMap((sc) => (sc.characters ?? []).filter(({ character: c }: any) => !validUrl(c.imageFront)).map(({ character: c }: any) => c.name as string))
  ))

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-[1200px] px-4 py-6" data-testid="episode-page">
        <div className="flex flex-wrap items-center gap-4">
          <Link href={`/project/${project.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> К сценарию сезона</Link>
          <Link href={`/project/${project.id}?tab=references`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" data-testid="open-references"><Images className="h-4 w-4" /> Референсы</Link>
        </div>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase text-muted-foreground">Эпизод {episode.number}{episode.arcRole ? ` · ${episode.arcRole}` : ''}</div>
            <h1 className="font-display text-2xl font-bold tracking-tight">{episode.title}</h1>
            {episode.logline && <p className="mt-1 text-sm text-muted-foreground">{episode.logline}</p>}
          </div>
          <div className="text-sm text-muted-foreground">Кредиты: <span className="font-semibold text-foreground" data-testid="credits">{credits}</span></div>
        </div>

        {/* Characters + location */}
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-4">
            <h2 className="mb-3 font-semibold">Персонажи эпизода</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {chars.map(({ character: c }: any) => (
                <div key={c.id} className="rounded-lg border border-border/60 p-2" data-testid="episode-character">
                  <div className="aspect-[3/4] overflow-hidden rounded bg-muted">
                    {validUrl(c.imageFront) ? <img src={c.imageFront} alt={c.name} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-xs text-muted-foreground">нет референса</div>}
                  </div>
                  <div className="mt-1 truncate text-sm font-medium">{c.name}</div>
                  {c.role && <div className="truncate text-xs text-muted-foreground">{c.role}</div>}
                  {c.appearance && <p className="mt-1 line-clamp-3 text-[11px] text-muted-foreground">{c.appearance}</p>}
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-border bg-card p-4">
            <h2 className="mb-2 inline-flex items-center gap-1 font-semibold"><MapPin className="h-4 w-4" /> Локация: {episode.locationName}</h2>
            <p className="text-sm text-muted-foreground">{episode.locationDesc}</p>
            {episode.cliffhanger && <p className="mt-3 text-sm"><span className="font-semibold">Клиффхэнгер:</span> {episode.cliffhanger}</p>}
          </div>
        </div>

        {/* Generate all / assemble */}
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
          <button onClick={openModal} disabled={startingAll || scenes.length === 0} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="generate-all">
            <Play className="h-4 w-4" /> Генерировать
          </button>
          <button onClick={assemble} disabled={!allReady || assembling} className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50" data-testid="assemble" title={allReady ? '' : 'Доступно, когда все сцены готовы'}>
            {assembling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clapperboard className="h-4 w-4" />} Собрать эпизод
          </button>
          <span className="text-xs text-muted-foreground">{scenes.filter((s) => validUrl(s.videoUrl)).length} из {scenes.length} сцен готово{episode.status === 'assembled' || episode.videoUrl ? ' · эпизод собран' : ''}</span>
          {error && <p className="w-full text-sm text-destructive" data-testid="error">{error}</p>}
        </div>

        {validUrl(episode.videoUrl) && (
          <div className="mt-4 rounded-xl border border-border bg-card p-4" data-testid="episode-video">
            <h2 className="mb-2 inline-flex items-center gap-1 font-semibold"><Film className="h-4 w-4" /> Собранный эпизод</h2>
            <video src={episode.videoUrl} controls playsInline className="mx-auto max-h-[70vh] w-full max-w-sm rounded-lg bg-black" />
            <a href={episode.videoUrl} download className="mt-2 inline-flex items-center gap-1 text-sm text-primary"><Download className="h-4 w-4" /> Скачать mp4</a>
          </div>
        )}

        {/* Scenes */}
        <h2 className="mt-8 font-display text-xl font-bold">Сцены ({scenes.length})</h2>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          {scenes.map((scene) => {
            const gen = !!activeGen[scene.id]
            const job = videoJobs[scene.id]
            return (
              <div key={scene.id} className="rounded-xl border border-border bg-card p-4" data-testid="scene-card" data-scene-status={gen ? 'generating' : validUrl(scene.videoUrl) ? 'ready' : 'pending'}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold">Сцена {scene.number} <span className="text-xs font-normal text-muted-foreground">· {scene.shotType} · ~{scene.durationSec ?? 15}с</span></div>
                    <div className="text-xs text-muted-foreground">{scene.locationDesc}</div>
                  </div>
                  <div className="flex -space-x-1">{scene.characters?.map(({ character: c }) => validUrl(c.imageFront) ? <img key={c.id} src={c.imageFront as string} alt={c.name} title={c.name} className="h-6 w-6 rounded-full border border-background object-cover" /> : null)}</div>
                </div>
                {scene.action && <p className="mt-2 text-sm italic">{scene.action}</p>}
                <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm">{scene.dialogue}</pre>

                <div className="mt-3 aspect-[9/16] max-h-[420px] overflow-hidden rounded-lg bg-black/80">
                  {gen ? (
                    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center" data-testid="scene-spinner">
                      <Loader2 className="h-8 w-8 animate-spin text-primary" />
                      <div className="text-xs text-muted-foreground">{job?.message ?? 'В очереди…'}</div>
                      {job && <JobProgressBar job={job} expectedTotalSec={VIDEO_EXPECTED_SEC} className="w-full" />}
                    </div>
                  ) : validUrl(scene.videoUrl) ? (
                    <SceneVideoPlayer videoUrl={scene.videoUrl as string} poster={scene.lastFrameUrl} className="h-full w-full object-contain" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Видео ещё не сгенерировано</div>
                  )}
                </div>

                <div className="mt-3 space-y-2">
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input value={sceneEdit[scene.id] ?? ''} onChange={(e) => setSceneEdit((t) => ({ ...t, [scene.id]: e.target.value }))} placeholder="Изменить сцену: что поправить…" className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm" data-testid="scene-revise-input" disabled={gen} />
                    <button onClick={() => reviseScene(scene)} disabled={gen || !!sceneBusy[scene.id] || !(sceneEdit[scene.id] ?? '').trim()} className="inline-flex items-center justify-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50" data-testid="scene-revise-submit">
                      {sceneBusy[scene.id] ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Изменить
                    </button>
                  </div>
                  {regenAsk === scene.id && (
                    <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm" data-testid="regen-confirm">
                      Сцена переписана. Перегенерировать ролик? Стоимость {perScene ?? '…'} кр. {perScene === undefined && <button className="underline" onClick={openModal}>(рассчитать)</button>}
                      <div className="mt-2 flex gap-2">
                        <button onClick={() => regenScene(scene.id)} className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-primary-foreground" data-testid="regen-ok"><RefreshCw className="h-4 w-4" /> Перегенерировать</button>
                        <button onClick={() => setRegenAsk(null)} className="rounded-lg border border-border px-3 py-1.5">Позже</button>
                      </div>
                    </div>
                  )}
                  {!gen && validUrl(scene.videoUrl) && regenAsk !== scene.id && (
                    <button onClick={() => setRegenAsk(scene.id)} className="text-xs text-muted-foreground underline">Перегенерировать ролик</button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Full script + episode revise */}
        <div className="mt-8 rounded-xl border border-border bg-card p-4">
          <h2 className="mb-3 font-display text-xl font-bold">Сценарий эпизода</h2>
          <ScriptView text={episode.script} scenes={scenes} />
          <div className="mt-4 space-y-2">
            <label className="text-xs font-semibold text-muted-foreground">Что изменить в сценарии эпизода</label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <textarea value={reviseText} onChange={(e) => setReviseText(e.target.value)} rows={2} placeholder="Например: убрать сцену на кухне, усилить конфликт…" className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm" data-testid="episode-revise-input" />
              <button onClick={() => reviseEpisode()} disabled={revising || !reviseText.trim()} className="inline-flex items-center justify-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" data-testid="episode-revise-submit">
                {revising ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Переписать
              </button>
            </div>
          </div>
        </div>
      </main>

      {modal && plan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid="generate-modal">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5">
            <h3 className="font-display text-lg font-bold">Генерировать все сцены эпизода?</h3>
            <ul className="mt-3 space-y-1 text-sm">
              <li>Сцен к генерации: <b>{plan.pendingCount}</b> из {plan.sceneCount}</li>
              <li>Длительность клипа: <b>до {plan.duration}с</b> · {plan.resolution} ({plan.tier})</li>
              <li>Стоимость: <b>{plan.total} кр.</b> за {plan.pendingCount} сцен (до {plan.costPerScene} кр. за сцену)</li>
              <li>Остаток кредитов: <b>{plan.credits}</b>{plan.credits < plan.total && <span className="text-destructive"> — недостаточно</span>}</li>
            </ul>
            {missingRefs.length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="missing-references-warning">
                <p><b>Без референсов:</b> {missingRefs.join(', ')}. Без референса внешность персонажа может меняться от сцены к сцене. Можно продолжить или сначала сгенерировать референсы.</p>
                <Link href={`/project/${project.id}?tab=references`} className="mt-2 inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"><Images className="h-4 w-4" /> Перейти к референсам</Link>
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setModal(false)} className="rounded-lg border border-border px-3 py-1.5 text-sm">Отмена</button>
              <button onClick={generateAll} disabled={startingAll || plan.pendingCount === 0 || plan.credits < plan.total} className="inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50" data-testid="generate-ok">
                {startingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} ОК
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
