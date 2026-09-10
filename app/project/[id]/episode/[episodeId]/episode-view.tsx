'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Header } from '@/components/header'
import { Loader2, Wand2, ArrowLeft, ArrowRight, MapPin, Film, Download, Play, RefreshCw, Clapperboard, Images, Ban, X, Maximize2, Users, ImageOff } from 'lucide-react'
import { postJobStart, SceneVideoPlayer } from '../../_components/scenes-stage'
import { ScriptView } from '../../_components/season-stage'
import { JobProgressBar, type JobInfo, type JobPollResponse, JOB_POLL_INTERVAL_MS } from '../../_components/use-job-polling'
import { CancelButton } from '../../_components/cancel-button'
import { desiredExtraFrames, locationScale, locationScaleLabel, episodeLocations } from '@/lib/location-scale'
import { EpisodeNavGrid } from './episode-nav-grid'

const VIDEO_EXPECTED_SEC = 600
const REF_POLL_MS = 3500
const SHOT_LABELS = ['Портрет', 'Профиль', 'В полный рост']
const validUrl = (u?: string | null) => typeof u === 'string' && u.startsWith('http') && u.length > 10
const hasAllImages = (c: any) => validUrl(c?.imageFront) && validUrl(c?.imageProfile) && validUrl(c?.imageFull)
function parseExtra(imageExtra?: string | null): string[] {
  if (!imageExtra) return []
  try { const a = JSON.parse(imageExtra); return Array.isArray(a) ? a.filter((u): u is string => typeof u === 'string' && u.startsWith('http')) : [] } catch { return [] }
}

type Scene = { id: string; number: number; shotType?: string | null; durationSec?: number | null; locationDesc?: string | null; action?: string | null; dialogue?: string | null; sceneKind?: string | null; voiceover?: string | null; voiceoverLocal?: string | null; videoPrompt?: string | null; videoUrl?: string | null; audioUrl?: string | null; lastFrameUrl?: string | null; status: string; characters: { character: { id: string; name: string; imageFront?: string | null } }[] }
type Plan = { sceneCount: number; pendingCount: number; duration: number; costPerScene: number; total: number; credits: number; tier: string; resolution: string }
type Sibling = { id: string; number: number; title: string; status?: string | null; videoUrl?: string | null }

export function EpisodeView({ episode: initial, project, siblings = [], credits: initialCredits }: { episode: any; project: any; siblings?: Sibling[]; credits: number }) {
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
  // Stage 13 — «Ассембл» final polish (audit whole episode → re-gen only inconsistent scenes → stitch).
  const [polish, setPolish] = useState<{ phase: 'analyzing' | 'regen' | 'stitching'; issues: { number: number; issue: string }[]; done: number; failed: number } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const polishActiveRef = useRef(false)
  const polishBusy = useRef(false)
  const polishIssuesRef = useRef(0)
  const polishRef = useRef<() => void>(() => {})
  const [activeGen, setActiveGen] = useState<Record<string, boolean>>({})
  const [videoJobs, setVideoJobs] = useState<Record<string, JobInfo>>({})
  const pollTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  // Stage 8: batch auto-continuation (client drives the continue endpoint until every scene is done).
  const [batch, setBatch] = useState<{ active: boolean; total: number; done: number; generating: number; failed: number; pending: number; remaining: number } | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [batchCanceled, setBatchCanceled] = useState(false)
  const canceledRef = useRef(false) // suppress client auto-continue after a cancel
  const continueBusy = useRef(false)
  const continueRef = useRef<() => void>(() => {})

  // Stage 12: per-episode references (characters + locations) with a single "generate all" button.
  const initialChars: any[] = (initial.characters?.length ? initial.characters.map((ec: any) => ec.character) : (project.characters ?? []))
  const [refChars, setRefChars] = useState<any[]>(initialChars)
  const [refLocs, setRefLocs] = useState<any[]>(episodeLocations(initial, project.locations ?? []))
  const [refSession, setRefSession] = useState(false) // polling active while refs are generating
  const [refStarting, setRefStarting] = useState(false)
  const refJobs = useRef<{ char?: string; loc: Record<string, string>; extra: Record<string, string> }>({ loc: {}, extra: {} })
  const refCanceled = useRef(false)
  const [charBusy, setCharBusy] = useState<Record<string, boolean>>({}) // per-character prompt-revise spinner
  const [locBusy, setLocBusy] = useState<Record<string, boolean>>({})   // per-location prompt-revise spinner
  const [charEdit, setCharEdit] = useState<Record<string, string>>({})
  const [locEdit, setLocEdit] = useState<Record<string, string>>({})
  // Fullscreen lightbox for any reference image (mobile-safe: object-contain, tap/Esc to close).
  const [lightbox, setLightbox] = useState<{ url: string; alt: string } | null>(null)
  // Sequential draft playlist.
  const [draftOpen, setDraftOpen] = useState(false)

  const patchScene = (sceneId: string, patch: Partial<Scene>) => setScenes((prev) => prev.map((s) => (s.id === sceneId ? { ...s, ...patch } : s)))
  const stopPolling = (sceneId: string) => { const t = pollTimers.current[sceneId]; if (t) clearTimeout(t); delete pollTimers.current[sceneId] }
  const clearGen = (sceneId: string) => setActiveGen((p) => { const n = { ...p }; delete n[sceneId]; return n })

  const refreshCredits = useCallback(async () => {
    try { const r = await fetch('/api/user/credits', { cache: 'no-store' }); if (r.ok) { const d = await r.json(); if (typeof d?.credits === 'number') setCredits(d.credits) } } catch {}
  }, [])

  // ---- Reference readiness ----
  const locBaseReady = (l: any) => validUrl(l?.imageUrl)
  const locExtraReady = (l: any) => parseExtra(l?.imageExtra).length >= desiredExtraFrames(l)
  const refsReady = refChars.every(hasAllImages) && refLocs.every((l) => locBaseReady(l) && locExtraReady(l))
  const refsCharsDone = refChars.filter(hasAllImages).length
  const refsLocsDone = refLocs.filter(locBaseReady).length

  // Escape closes the lightbox.
  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])

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

  // ---- References: refresh characters + locations from the project, drive extra-angle follow-ups ----
  const refreshRefs = useCallback(async () => {
    try {
      const r = await fetch(`/api/projects/${project.id}`, { cache: 'no-store' })
      if (!r.ok) return
      const d = await r.json()
      const pchars: any[] = d?.project?.characters ?? []
      const plocs: any[] = d?.project?.locations ?? []
      setRefChars((prev) => prev.map((c) => pchars.find((x) => x.id === c.id) ?? c))
      // recompute episode locations from fresh project locations, preserving order/membership
      setRefLocs((prev) => prev.map((l) => plocs.find((x) => x.id === l.id) ?? l))
      return { pchars, plocs }
    } catch { return }
  }, [project.id])

  // Poll while a reference session is active: refresh data, kick extra angles for big locations, stop when ready.
  useEffect(() => {
    if (!refSession) return
    let stopped = false
    const loop = async () => {
      const fresh = await refreshRefs()
      if (stopped || refCanceled.current) return
      // Kick extra angles for big locations whose base is ready but still lack enough extra frames.
      if (fresh) {
        for (const l of refLocs) {
          const loc = fresh.plocs.find((x: any) => x.id === l.id)
          if (!loc) continue
          const want = desiredExtraFrames(loc)
          const have = parseExtra(loc.imageExtra).length
          if (want > 0 && validUrl(loc.imageUrl) && have < want && !refJobs.current.extra[loc.id]) {
            try {
              const res = await fetch(`/api/ai/locations/${loc.id}/extra-images`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: want - have }) })
              const dd = await res.json().catch(() => ({}))
              if (res.ok && dd?.jobId) refJobs.current.extra[loc.id] = dd.jobId
              else if (!res.ok && dd?.error) setError(dd.error)
            } catch {}
          }
        }
      }
      void refreshCredits()
    }
    void loop()
    const id = setInterval(loop, REF_POLL_MS)
    return () => { stopped = true; clearInterval(id) }
  }, [refSession, refreshRefs, refreshCredits, refLocs])

  // Stop the reference session once everything is ready.
  useEffect(() => { if (refSession && refsReady) { setRefSession(false); refJobs.current = { loc: {}, extra: {} } } }, [refSession, refsReady])

  /** Single button: generate every missing reference for this episode's characters and locations. */
  const generateAllRefs = async () => {
    setError(''); setRefStarting(true); refCanceled.current = false
    try {
      const missingChars = refChars.filter((c) => !hasAllImages(c))
      if (missingChars.length > 0) {
        const res = await fetch('/api/ai/characters/references', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id, characterIds: missingChars.map((c) => c.id) }) })
        const d = await res.json()
        if (!res.ok) { setError(d?.error ?? 'Не удалось запустить генерацию персонажей'); setRefStarting(false); return }
        if (d?.jobId) refJobs.current.char = d.jobId
        if (typeof d?.creditsRemaining === 'number') setCredits(d.creditsRemaining)
      }
      for (const l of refLocs) {
        if (!locBaseReady(l) && !refJobs.current.loc[l.id]) {
          const res = await fetch(`/api/ai/locations/${l.id}/image`, { method: 'POST' })
          const d = await res.json().catch(() => ({}))
          if (res.ok && d?.jobId) refJobs.current.loc[l.id] = d.jobId
          else if (!res.ok && d?.error) setError(d.error)
        }
      }
      setRefSession(true)
    } catch { setError('Ошибка сети') } finally { setRefStarting(false) }
  }

  const cancelRefs = async () => {
    refCanceled.current = true
    const ids = [refJobs.current.char, ...Object.values(refJobs.current.loc), ...Object.values(refJobs.current.extra)].filter(Boolean) as string[]
    for (const id of ids) { try { await fetch(`/api/ai/jobs/${id}/cancel`, { method: 'POST' }) } catch {} }
    setRefSession(false); refJobs.current = { loc: {}, extra: {} }
    void refreshRefs(); void refreshCredits()
  }

  /** Prompt-edit a character's appearance (regenerates its references; C2PA preserved in the worker). */
  const reviseCharacter = async (characterId: string) => {
    const instruction = charEdit[characterId]?.trim(); if (!instruction) return
    setCharBusy((b) => ({ ...b, [characterId]: true })); setError('')
    try {
      const res = await fetch('/api/ai/characters/appearance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId, instruction }) })
      const d = await res.json()
      if (!res.ok) { setError(d?.error ?? 'Не удалось изменить персонажа'); return }
      if (d?.character) setRefChars((prev) => prev.map((c) => (c.id === characterId ? { ...c, ...d.character } : c)))
      setCharEdit((t) => ({ ...t, [characterId]: '' }))
      setRefSession(true) // poll until the new references land
    } catch { setError('Ошибка сети') } finally { setCharBusy((b) => { const n = { ...b }; delete n[characterId]; return n }) }
  }

  /** Prompt-edit a location (regenerates its reference; C2PA preserved in the worker). */
  const reviseLocation = async (locationId: string) => {
    const instruction = locEdit[locationId]?.trim(); if (!instruction) return
    setLocBusy((b) => ({ ...b, [locationId]: true })); setError('')
    try {
      const res = await fetch(`/api/ai/locations/${locationId}/revise`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction, regenerate: true }) })
      const d = await res.json()
      if (!res.ok) { setError(d?.error ?? 'Не удалось изменить локацию'); return }
      if (d?.location) setRefLocs((prev) => prev.map((l) => (l.id === locationId ? { ...l, ...d.location } : l)))
      setLocEdit((t) => ({ ...t, [locationId]: '' }))
      setRefSession(true)
    } catch { setError('Ошибка сети') } finally { setLocBusy((b) => { const n = { ...b }; delete n[locationId]; return n }) }
  }

  // Stage 8: one continue "kick". Idempotent server-side; safe to call every few seconds.
  const continueBatch = async (retryFailed = false) => {
    if (!retryFailed && canceledRef.current) return
    if (retryFailed) { canceledRef.current = false; setBatchCanceled(false) }
    if (continueBusy.current) return
    continueBusy.current = true
    try {
      const res = await fetch(`/api/ai/episodes/${episode.id}/generate-all/continue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retryFailed }) })
      if (!res.ok) { if (res.status === 429) return; const e = await res.json().catch(() => ({})); if (e?.error) setError(e.error); return }
      const d = await res.json()
      setBatch({ active: d.remaining > 0, total: d.total, done: d.done, generating: d.generating, failed: d.failed, pending: d.pending, remaining: d.remaining })
      if (typeof d.creditsRemaining === 'number') setCredits(d.creditsRemaining)
      if (d.creditsShort) setError('Недостаточно кредитов для повтора части сцен — пополните баланс и нажмите «Продолжить».')
      for (const s of d.scenes ?? []) {
        if (s.status === 'generating') {
          setActiveGen((p) => (p[s.sceneId] ? p : { ...p, [s.sceneId]: true }))
          if (s.jobId && !pollTimers.current[s.sceneId]) pollVideoJob(s.sceneId, s.jobId)
        }
      }
    } catch {} finally { continueBusy.current = false }
  }
  continueRef.current = () => { void continueBatch(false) }
  const batchActive = batch?.active ?? false
  useEffect(() => {
    if (!batchActive) return
    const id = setInterval(() => continueRef.current(), JOB_POLL_INTERVAL_MS * 3)
    return () => clearInterval(id)
  }, [batchActive])
  useEffect(() => {
    if (scenes.some((s) => !validUrl(s.videoUrl))) void continueBatch(false)
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
  useEffect(() => { loadPlan().catch(() => {}) }, [loadPlan])
  const openModal = async () => {
    setError(null)
    try { await loadPlan(); setModal(true) } catch (e: any) { setError(e?.message ?? 'Ошибка') }
  }
  const generateAll = async () => {
    setStartingAll(true); setError(null); canceledRef.current = false; setBatchCanceled(false)
    try {
      const res = await postJobStart(`/api/ai/episodes/${episode.id}/generate-all`, {})
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Не удалось запустить генерацию')
      setModal(false)
      for (const j of data.jobs ?? []) { setActiveGen((p) => ({ ...p, [j.sceneId]: true })); patchScene(j.sceneId, { status: 'generating' }); pollVideoJob(j.sceneId, j.jobId) }
      if (typeof data.creditsRemaining === 'number') setCredits(data.creditsRemaining)
      setBatch({ active: true, total: scenes.length, done: scenes.filter((s) => validUrl(s.videoUrl)).length, generating: (data.jobs ?? []).length, failed: 0, pending: 0, remaining: scenes.length })
      void continueBatch(false)
    } catch (e: any) { setError(e?.message ?? 'Ошибка') } finally { setStartingAll(false) }
  }

  const cancelBatch = async () => {
    canceledRef.current = true
    try { const res = await fetch(`/api/ai/episodes/${episode.id}/generate-all/cancel`, { method: 'POST' }); await res.json().catch(() => ({})) } catch {}
    setBatch((b) => (b ? { ...b, active: false } : b))
    setBatchCanceled(true)
    setScenes((prev) => prev.map((s) => (activeGen[s.id] && !validUrl(s.videoUrl) ? { ...s, status: 'pending' } : s)))
    void refreshCredits()
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
  const anyClip = scenes.some((s) => validUrl(s.videoUrl))

  // Final stitch of the (now consistent) clips into the episode video — the existing assemble route.
  const doStitch = async (fixedCount: number) => {
    setPolish((p) => (p ? { ...p, phase: 'stitching' } : { phase: 'stitching', issues: [], done: 0, failed: 0 }))
    try {
      const res = await fetch('/api/ai/assemble-episode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ episodeId: episode.id }) })
      const data = await res.json(); if (!res.ok) throw new Error(data?.error ?? 'Сборка не удалась')
      setEpisode((p: any) => ({ ...p, videoUrl: data.videoUrl, status: 'assembled' }))
      setNotice(fixedCount > 0
        ? `Финальная полировка завершена: исправлены логические нестыковки и переходы (${fixedCount} ${fixedCount === 1 ? 'сцена' : 'сцен'}), эпизод собран.`
        : 'Логических нестыковок не найдено — эпизод собран без перегенерации (кредиты не списаны).')
    } catch (e: any) { setError(e?.message ?? 'Ошибка сборки') } finally { setPolish(null); void refreshCredits() }
  }

  // Drive the re-generation of the flagged scenes (reuses the batch /continue planner) until done, then stitch.
  const pollPolish = async () => {
    if (!polishActiveRef.current || polishBusy.current) return
    polishBusy.current = true
    try {
      const res = await fetch(`/api/ai/episodes/${episode.id}/generate-all/continue`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retryFailed: false }) })
      if (!res.ok) { if (res.status === 429) return; const e = await res.json().catch(() => ({})); if (e?.error) setError(e.error); return }
      const d = await res.json()
      const remaining = d.remaining ?? 0
      setPolish((p) => (p ? { ...p, phase: 'regen', done: Math.max(0, polishIssuesRef.current - remaining), failed: d.failed ?? 0 } : p))
      if (typeof d.creditsRemaining === 'number') setCredits(d.creditsRemaining)
      for (const s of d.scenes ?? []) {
        if (s.status === 'generating') {
          setActiveGen((prev) => (prev[s.sceneId] ? prev : { ...prev, [s.sceneId]: true }))
          if (s.jobId && !pollTimers.current[s.sceneId]) pollVideoJob(s.sceneId, s.jobId)
        }
      }
      if (remaining === 0) {
        polishActiveRef.current = false
        if ((d.failed ?? 0) > 0) {
          setError('Часть проблемных сцен не удалось перегенерировать. Проверьте сцены и запустите «Ассембл» ещё раз.')
          setPolish(null)
          return
        }
        await doStitch(polishIssuesRef.current)
      }
    } catch {} finally { polishBusy.current = false }
  }
  polishRef.current = () => { void pollPolish() }
  const polishRegen = polish?.phase === 'regen'
  useEffect(() => {
    if (!polishRegen) return
    const id = setInterval(() => polishRef.current(), JOB_POLL_INTERVAL_MS * 3)
    return () => clearInterval(id)
  }, [polishRegen])

  const cancelPolish = async () => {
    polishActiveRef.current = false
    try { const res = await fetch(`/api/ai/episodes/${episode.id}/generate-all/cancel`, { method: 'POST' }); await res.json().catch(() => ({})) } catch {}
    setScenes((prev) => prev.map((s) => (activeGen[s.id] && !validUrl(s.videoUrl) ? { ...s, status: 'pending' } : s)))
    setPolish(null)
    setNotice('Полировка отменена. Уже готовые сцены сохранены; незавершённые можно достроить кнопкой «Продолжить / повторить незавершённые».')
    void refreshCredits()
  }

  // «Ассембл» → final polish: audit the whole episode, re-generate only inconsistent scenes, then stitch.
  const assemble = async () => {
    setAssembling(true); setError(null); setNotice(null)
    setPolish({ phase: 'analyzing', issues: [], done: 0, failed: 0 })
    try {
      const res = await fetch('/api/ai/assemble-episode/polish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ episodeId: episode.id }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Финальная полировка не удалась')
      const issues: { number: number; issue: string }[] = data.issues ?? []
      polishIssuesRef.current = issues.length
      if (typeof data.creditsRemaining === 'number') setCredits(data.creditsRemaining)
      if (issues.length === 0) {
        // No logical inconsistencies — just stitch the existing clips, no credits spent.
        await doStitch(0)
        return
      }
      // Inconsistencies found → the flagged scenes are being re-generated; drive the continue loop.
      setPolish({ phase: 'regen', issues, done: 0, failed: 0 })
      for (const j of data.jobs ?? []) { setActiveGen((p) => ({ ...p, [j.sceneId]: true })); patchScene(j.sceneId, { status: 'generating', videoUrl: null }); if (j.jobId) pollVideoJob(j.sceneId, j.jobId) }
      polishActiveRef.current = true
      void pollPolish()
    } catch (e: any) { setError(e?.message ?? 'Ошибка'); setPolish(null) } finally { setAssembling(false) }
  }

  const perScene = plan?.costPerScene
  const isAssembled = episode.status === 'assembled' || validUrl(episode.videoUrl)
  const nextEpisode = siblings.filter((s) => s.number > episode.number).sort((a, b) => a.number - b.number)[0] ?? null

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-[1200px] px-4 py-6" data-testid="episode-page">
        {/* Stage 14 (C): episode nav — right-aligned «Эпизоды» dropdown grid (10/row desktop), any order. */}
        <div className="flex flex-wrap items-center gap-4">
          <Link href={`/project/${project.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> К сюжету сезона</Link>
          <EpisodeNavGrid projectId={project.id} episodes={siblings} currentId={episode.id} />
        </div>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase text-muted-foreground">Эпизод {episode.number}{episode.arcRole ? ` · ${episode.arcRole}` : ''}</div>
            <h1 className="font-display text-2xl font-bold tracking-tight">{episode.title}</h1>
            {episode.logline && <p className="mt-1 text-sm text-muted-foreground">{episode.logline}</p>}
          </div>
          <div className="text-sm text-muted-foreground">Кредиты: <span className="font-semibold text-foreground" data-testid="credits">{credits}</span></div>
        </div>

        {/* Episode script + revise-by-prompt */}
        <div className="mt-6 rounded-xl border border-border bg-card p-4">
          <h2 className="mb-3 font-display text-xl font-bold">Сценарий эпизода</h2>
          <ScriptView text={episode.script} scenes={scenes} />
          <div className="mt-4 space-y-2">
            <label className="text-xs font-semibold text-muted-foreground">Что изменить в сценарии эпизода (по промпту)</label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <textarea value={reviseText} onChange={(e) => setReviseText(e.target.value)} rows={2} placeholder="Например: убрать сцену на кухне, усилить конфликт…" className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm" data-testid="episode-revise-input" />
              <button onClick={() => reviseEpisode()} disabled={revising || !reviseText.trim()} className="inline-flex items-center justify-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50" data-testid="episode-revise-submit">
                {revising ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Переписать
              </button>
            </div>
          </div>
        </div>

        {/* Stage 12: references of THIS episode + single "generate all" */}
        <section className="mt-6 rounded-xl border border-border bg-card p-4" data-testid="episode-references">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="inline-flex items-center gap-2 font-display text-xl font-bold"><Images className="h-5 w-5 text-primary" /> Референсы эпизода</h2>
            {refSession ? (
              <span className="inline-flex items-center gap-2 text-xs text-muted-foreground" data-testid="refs-progress">
                <Loader2 className="h-4 w-4 animate-spin text-primary" /> Генерирую референсы: персонажи {refsCharsDone}/{refChars.length}, локации {refsLocsDone}/{refLocs.length}
                <CancelButton onCancel={cancelRefs} testId="refs-cancel" label="Отменить" pendingLabel="Останавливаю…" />
              </span>
            ) : refsReady ? (
              <span className="text-xs font-medium text-emerald-500" data-testid="refs-status">Все референсы готовы</span>
            ) : (
              <button onClick={generateAllRefs} disabled={refStarting} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="generate-all-refs">
                {refStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Сгенерировать всё
              </button>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Персонажи (несколько ракурсов) и локации этого эпизода (несколько кадров, для крупных мест — больше). Все изображения с меткой C2PA. Нажмите на любой кадр, чтобы открыть на весь экран.</p>

          {/* Characters */}
          <h3 className="mt-4 flex items-center gap-2 text-sm font-semibold"><Users className="h-4 w-4" /> Персонажи ({refChars.length})</h3>
          <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {refChars.map((c) => {
              const busy = !!charBusy[c.id] || (refSession && !hasAllImages(c))
              const imgs = [c.imageFront, c.imageProfile, c.imageFull]
              return (
                <div key={c.id} className="rounded-lg border border-border/60 p-3" data-testid="ref-character">
                  <div className="grid grid-cols-3 gap-2">
                    {imgs.map((img, i) => (
                      <button key={i} type="button" onClick={() => validUrl(img) && setLightbox({ url: img as string, alt: `${c.name} — ${SHOT_LABELS[i]}` })} className="group relative aspect-[3/4] overflow-hidden rounded bg-muted" title={SHOT_LABELS[i]} data-testid="ref-image">
                        {validUrl(img) ? (
                          <>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={img as string} alt={`${c.name} — ${SHOT_LABELS[i]}`} className="h-full w-full object-cover" />
                            <span className="absolute right-1 top-1 rounded bg-black/50 p-0.5 opacity-0 transition group-hover:opacity-100"><Maximize2 className="h-3 w-3 text-white" /></span>
                          </>
                        ) : busy ? (
                          <div className="flex h-full w-full items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-primary" /></div>
                        ) : (
                          <div className="flex h-full w-full items-center justify-center"><ImageOff className="h-4 w-4 text-muted-foreground/40" /></div>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 truncate text-sm font-medium">{c.name}</div>
                  {c.role && <div className="truncate text-xs text-muted-foreground">{c.role}</div>}
                  <div className="mt-2 flex flex-col gap-1.5 sm:flex-row">
                    <input value={charEdit[c.id] ?? ''} onChange={(e) => setCharEdit((t) => ({ ...t, [c.id]: e.target.value }))} placeholder="Изменить по промпту…" className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-xs" data-testid="ref-character-input" disabled={busy} />
                    <button onClick={() => reviseCharacter(c.id)} disabled={busy || !(charEdit[c.id] ?? '').trim()} className="inline-flex items-center justify-center gap-1 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50" data-testid="ref-character-submit">
                      {charBusy[c.id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
              )
            })}
            {refChars.length === 0 && <p className="text-sm text-muted-foreground">У эпизода нет привязанных персонажей.</p>}
          </div>

          {/* Locations */}
          <h3 className="mt-6 flex items-center gap-2 text-sm font-semibold"><MapPin className="h-4 w-4" /> Локации ({refLocs.length})</h3>
          <div className="mt-2 grid gap-4 sm:grid-cols-2">
            {refLocs.map((l) => {
              const scale = locationScale(l)
              const want = desiredExtraFrames(l)
              const base = [{ url: l.imageUrl, label: 'Общий план' }, { url: l.imageReverse, label: 'Обратный ракурс' }, { url: l.imageDetail, label: 'Средний план' }].filter((a) => validUrl(a.url))
              const extras = parseExtra(l.imageExtra)
              const busy = !!locBusy[l.id] || (refSession && !(locBaseReady(l) && locExtraReady(l)))
              return (
                <div key={l.id} className="rounded-lg border border-border/60 p-3" data-testid="ref-location">
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-sm font-medium">{l.name}</div>
                    <span className="rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground" title={`Больше кадров для крупных мест`}>{locationScaleLabel(scale)}{want > 0 ? ` · +${want} кадров` : ''}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {base.length > 0 ? [...base.map((a) => ({ url: a.url as string, label: a.label })), ...extras.map((u, i) => ({ url: u, label: `Доп. кадр ${i + 1}` }))].map((a, i) => (
                      <button key={a.url + i} type="button" onClick={() => setLightbox({ url: a.url, alt: `${l.name} — ${a.label}` })} className="group relative h-24 w-16 overflow-hidden rounded bg-muted" title={a.label} data-testid="ref-image">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={a.url} alt={`${l.name} — ${a.label}`} className="h-full w-full object-cover" />
                        <span className="absolute right-0.5 top-0.5 rounded bg-black/50 p-0.5 opacity-0 transition group-hover:opacity-100"><Maximize2 className="h-3 w-3 text-white" /></span>
                      </button>
                    )) : busy ? (
                      <div className="flex h-24 w-16 items-center justify-center rounded bg-muted"><Loader2 className="h-4 w-4 animate-spin text-primary" /></div>
                    ) : (
                      <div className="flex h-24 w-16 items-center justify-center rounded bg-muted"><ImageOff className="h-4 w-4 text-muted-foreground/40" /></div>
                    )}
                  </div>
                  <div className="mt-2 flex flex-col gap-1.5 sm:flex-row">
                    <input value={locEdit[l.id] ?? ''} onChange={(e) => setLocEdit((t) => ({ ...t, [l.id]: e.target.value }))} placeholder="Изменить локацию по промпту…" className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-xs" data-testid="ref-location-input" disabled={busy} />
                    <button onClick={() => reviseLocation(l.id)} disabled={busy || !(locEdit[l.id] ?? '').trim()} className="inline-flex items-center justify-center gap-1 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50" data-testid="ref-location-submit">
                      {locBusy[l.id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
              )
            })}
            {refLocs.length === 0 && <p className="text-sm text-muted-foreground">У эпизода нет привязанных локаций.</p>}
          </div>
        </section>

        {/* Generate all scenes / draft / assemble */}
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
          <button onClick={openModal} disabled={startingAll || scenes.length === 0 || !refsReady} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="generate-all" title={refsReady ? '' : 'Сначала сгенерируйте все референсы эпизода'}>
            <Play className="h-4 w-4" /> Сгенерировать все сцены
          </button>
          <button onClick={() => setDraftOpen(true)} disabled={!anyClip} className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50" data-testid="show-draft" title={anyClip ? '' : 'Появится, когда будет хотя бы один готовый ролик'}>
            <Film className="h-4 w-4" /> Показать черновик
          </button>
          <button onClick={assemble} disabled={!allReady || assembling || !!polish} className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50" data-testid="assemble" title={allReady ? 'Ассембл — финальная полировка: Seedance пересматривает весь эпизод и исправляет логические нестыковки и переходы' : 'Доступно, когда все сцены готовы'}>
            {assembling || polish ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clapperboard className="h-4 w-4" />} Ассембл (финальная полировка)
          </button>
          {batchActive ? (
            <span className="inline-flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="batch-status">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              Генерирую сцены: готово {batch?.done ?? 0} из {batch?.total ?? scenes.length}
              {(batch?.generating ?? 0) > 0 && ` · в работе ${batch!.generating}`}
              {(batch?.failed ?? 0) > 0 && <span className="text-destructive"> · не удалось {batch!.failed}</span>}
              <CancelButton onCancel={cancelBatch} testId="batch-cancel" label="Отменить" pendingLabel="Останавливаю…" />
            </span>
          ) : batchCanceled ? (
            <span className="inline-flex flex-wrap items-center gap-2 text-xs text-amber-500" data-testid="batch-status">
              <Ban className="h-3.5 w-3.5" />
              Генерация отменена · готово {scenes.filter((s) => validUrl(s.videoUrl)).length} из {scenes.length} сцен. Новые сцены не запускаются; уже готовые сохранены.
            </span>
          ) : (
            <span className="text-xs text-muted-foreground" data-testid="batch-status">{scenes.filter((s) => validUrl(s.videoUrl)).length} из {scenes.length} сцен готово{isAssembled ? ' · эпизод собран' : ''}</span>
          )}
          {!batchActive && scenes.length > 0 && scenes.some((s) => !validUrl(s.videoUrl)) && refsReady && (
            <button onClick={async () => { setError(null); setRetrying(true); try { await continueBatch(true) } finally { setRetrying(false) } }} disabled={retrying || startingAll} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium disabled:opacity-50" data-testid="continue-batch" title="Продолжить или повторить незавершённые сцены">
              {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Продолжить / повторить незавершённые
            </button>
          )}
          {/* Stage 13 — what «Ассембл» now does + live polish status */}
          <p className="w-full text-xs text-muted-foreground" data-testid="assemble-hint">
            <b>Ассембл — финальная полировка:</b> Seedance пересматривает весь эпизод и исправляет логические нестыковки и переходы (телепортация/исчезновение персонажей, несогласованные позиции и действия на стыках сцен). Перегенерируются только проблемные сцены — согласованные не трогаются, кредиты на них не тратятся.
          </p>
          {polish && (
            <div className="w-full rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm" data-testid="polish-status">
              <div className="flex flex-wrap items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span className="font-medium">
                  {polish.phase === 'analyzing' && 'Финальная полировка: анализ логики эпизода…'}
                  {polish.phase === 'regen' && `Финальная полировка: перегенерация ${polish.done}/${polish.issues.length} проблемных сцен${polish.failed > 0 ? ` · не удалось ${polish.failed}` : ''}`}
                  {polish.phase === 'stitching' && 'Финальная полировка: сборка эпизода…'}
                </span>
                {polish.phase === 'regen' && (
                  <CancelButton onCancel={cancelPolish} testId="polish-cancel" label="Отменить" pendingLabel="Останавливаю…" />
                )}
              </div>
              {polish.issues.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground" data-testid="polish-issues">
                  {polish.issues.map((it) => (<li key={it.number}>Сцена {it.number}: {it.issue}</li>))}
                </ul>
              )}
            </div>
          )}
          {notice && !polish && <p className="w-full text-sm text-emerald-500" data-testid="polish-notice">{notice}</p>}
          {error && <p className="w-full text-sm text-destructive" data-testid="error">{error}</p>}
        </div>

        {/* Assembled episode + go to next */}
        {validUrl(episode.videoUrl) && (
          <div className="mt-4 rounded-xl border border-border bg-card p-4" data-testid="episode-video">
            <h2 className="mb-2 inline-flex items-center gap-1 font-semibold"><Film className="h-4 w-4" /> Собранный эпизод</h2>
            <video src={episode.videoUrl} controls playsInline className="mx-auto max-h-[70vh] w-full max-w-sm rounded-lg bg-black" />
            <div className="mt-2 flex flex-wrap items-center gap-4">
              <a href={episode.videoUrl} download className="inline-flex items-center gap-1 text-sm text-primary"><Download className="h-4 w-4" /> Скачать mp4</a>
              {nextEpisode && (
                <Link href={`/project/${project.id}/episode/${nextEpisode.id}`} className="inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" data-testid="go-to-next-episode">
                  Перейти к эпизоду {nextEpisode.number} <ArrowRight className="h-4 w-4" />
                </Link>
              )}
            </div>
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
                    <div className="font-semibold">Сцена {scene.number}
                      {scene.sceneKind === 'narration' && <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary align-middle" data-testid="narration-badge">Закадровый голос</span>}
                      <span className="text-xs font-normal text-muted-foreground"> · {scene.shotType} · ~{scene.durationSec ?? 15}с</span>
                    </div>
                    <div className="text-xs text-muted-foreground">{scene.locationDesc}</div>
                  </div>
                  <div className="flex -space-x-1">{scene.characters?.map(({ character: c }) => validUrl(c.imageFront) ? <img key={c.id} src={c.imageFront as string} alt={c.name} title={c.name} className="h-6 w-6 rounded-full border border-background object-cover" /> : null)}</div>
                </div>
                {scene.action && <p className="mt-2 text-sm italic">{scene.action}</p>}
                {scene.sceneKind === 'narration' ? (
                  <div className="mt-2 rounded-lg border border-primary/30 bg-primary/5 p-3" data-testid="scene-voiceover">
                    <div className="text-xs font-semibold uppercase tracking-wide text-primary">Закадровый голос (на видео — на английском)</div>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm">{scene.voiceoverLocal || scene.voiceover}</p>
                    {scene.voiceoverLocal && scene.voiceover && scene.voiceoverLocal !== scene.voiceover && (
                      <p className="mt-1 whitespace-pre-wrap break-words text-xs italic text-muted-foreground">EN: {scene.voiceover}</p>
                    )}
                  </div>
                ) : (
                  <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm">{scene.dialogue}</pre>
                )}

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
      </main>

      {/* Generate-scenes cost modal */}
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
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setModal(false)} className="rounded-lg border border-border px-3 py-1.5 text-sm">Отмена</button>
              <button onClick={generateAll} disabled={startingAll || plan.pendingCount === 0 || plan.credits < plan.total} className="inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50" data-testid="generate-ok">
                {startingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} ОК
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fullscreen reference lightbox */}
      {lightbox && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/95 p-2" data-testid="lightbox" onClick={() => setLightbox(null)}>
          <button className="absolute right-3 top-3 rounded-full bg-white/10 p-2 text-white" data-testid="lightbox-close" onClick={(e) => { e.stopPropagation(); setLightbox(null) }}><X className="h-5 w-5" /></button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox.url} alt={lightbox.alt} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
          <div className="absolute bottom-3 left-0 right-0 text-center text-xs text-white/80">{lightbox.alt}</div>
        </div>
      )}

      {/* Draft sequential playlist */}
      {draftOpen && <DraftPlayer scenes={scenes.filter((s) => validUrl(s.videoUrl))} onClose={() => setDraftOpen(false)} />}
    </div>
  )
}

/** Plays the episode's generated clips back-to-back as a rough draft (no re-encode). */
function DraftPlayer({ scenes, onClose }: { scenes: Scene[]; onClose: () => void }) {
  const [idx, setIdx] = useState(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  useEffect(() => { videoRef.current?.play().catch(() => {}) }, [idx])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const cur = scenes[idx]
  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black/95 p-3" data-testid="draft-player">
      <button className="absolute right-3 top-3 rounded-full bg-white/10 p-2 text-white" onClick={onClose} data-testid="draft-close"><X className="h-5 w-5" /></button>
      <div className="mb-2 text-sm text-white/80">Черновик · сцена {cur?.number ?? idx + 1} ({idx + 1} из {scenes.length})</div>
      {cur && (
        <video
          ref={videoRef}
          src={cur.videoUrl as string}
          controls
          autoPlay
          playsInline
          className="max-h-[80vh] w-full max-w-sm rounded-lg bg-black"
          onEnded={() => setIdx((i) => (i + 1 < scenes.length ? i + 1 : i))}
        />
      )}
      <div className="mt-3 flex items-center gap-3">
        <button onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0} className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-white disabled:opacity-40">Назад</button>
        <button onClick={() => setIdx((i) => Math.min(scenes.length - 1, i + 1))} disabled={idx >= scenes.length - 1} className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-white disabled:opacity-40">Дальше</button>
      </div>
    </div>
  )
}
