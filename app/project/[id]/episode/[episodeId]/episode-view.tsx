'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Header } from '@/components/header'
import { Loader2, Wand2, ArrowLeft, ArrowRight, MapPin, Film, Download, Play, RefreshCw, Clapperboard, Images, Ban, X, Maximize2, Users, ImageOff, ChevronLeft, ChevronRight, Lock } from 'lucide-react'
import { postJobStart, SceneVideoPlayer } from '../../_components/scenes-stage'
import { BookScript } from '../../_components/season-stage'
import { StickyReviseBar } from '../../_components/sticky-revise-bar'
import { useJobPolling, JobProgressBar, type JobInfo, type JobPollResponse, JOB_POLL_INTERVAL_MS } from '../../_components/use-job-polling'
import { CancelButton } from '../../_components/cancel-button'
import { desiredExtraFrames, desiredTotalFrames, locationScale, locationScaleLabel, episodeLocations } from '@/lib/location-scale'
import { CHARACTER_PHOTO_COUNT } from '@/lib/reference-counts'
import { EpisodeNavGrid } from './episode-nav-grid'

type EpisodePhase = 'script' | 'references' | 'scenes'

const VIDEO_EXPECTED_SEC = 600
const REF_POLL_MS = 3500
// Stage 18: fixed 3-angle set, in stored order (face, left profile, full front).
const SHOT_LABELS = ['Портрет (лицо)', 'Левый профиль', 'В полный рост (спереди)']
const CHAR_EXTRA_MIN = Math.max(0, CHARACTER_PHOTO_COUNT - 3) // extra angles beyond the 3 base shots → 0 (3 photos)
const validUrl = (u?: string | null) => typeof u === 'string' && u.startsWith('http') && u.length > 10
function parseExtra(imageExtra?: string | null): string[] {
  if (!imageExtra) return []
  try { const a = JSON.parse(imageExtra); return Array.isArray(a) ? a.filter((u): u is string => typeof u === 'string' && u.startsWith('http')) : [] } catch { return [] }
}
// Stage 18: a character reference is complete with the 3 base photos (face, left profile, full front).
const charPhotos = (c: any): string[] => [c?.imageFront, c?.imageProfile, c?.imageFull, ...parseExtra(c?.imageExtra)].filter(validUrl)
const hasAllImages = (c: any) => validUrl(c?.imageFront) && validUrl(c?.imageProfile) && validUrl(c?.imageFull) && parseExtra(c?.imageExtra).length >= CHAR_EXTRA_MIN
// Stage 18: total generated frames of a location = present base angles + extra angles (target = 3/6/9 by scale).
const locationFrames = (l: any): number => [l?.imageUrl, l?.imageReverse, l?.imageDetail].filter(validUrl).length + parseExtra(l?.imageExtra).length
// Stage 17: top up location extras in serverless-safe chunks (a single 12-frame job can overrun the
// serverless window and get killed — chunking + re-firing guarantees the target is actually reached).
const LOCATION_EXTRA_CHUNK = 6

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
  // Stage 19 — «Ассембл» final polish now runs as a SERVER-DRIVEN background job (episode_assemble):
  // the route returns a jobId immediately and the whole orchestration (audit → re-gen only the flagged
  // scenes → stitch) runs on the server, surviving navigation. The client just polls the job and mirrors
  // its resultData (phase/issues/done/total/failed) into this `polish` panel state.
  const [polish, setPolish] = useState<{ phase: 'analyzing' | 'regen' | 'stitching'; issues: { number: number; issue: string }[]; done: number; failed: number } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [assembleJobId, setAssembleJobId] = useState<string | null>(null)
  const assembleJobIdRef = useRef<string | null>(null)
  assembleJobIdRef.current = assembleJobId
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
  // Fullscreen carousel over ALL photos of one reference (mobile-safe: object-contain, arrows/keys/wheel/swipe, tap/Esc to close).
  const [lightbox, setLightbox] = useState<{ images: string[]; index: number; title?: string } | null>(null)
  const openLightbox = (images: (string | null | undefined)[], index = 0, title?: string) => {
    const imgs = images.filter(validUrl) as string[]
    if (imgs.length === 0) return
    setLightbox({ images: imgs, index: Math.max(0, Math.min(index, imgs.length - 1)), title })
  }
  const lightboxTouchX = useRef<number | null>(null)
  const lightboxStep = (dir: number) =>
    setLightbox((lb) => (lb ? { ...lb, index: (lb.index + dir + lb.images.length) % lb.images.length } : lb))
  // Sequential draft playlist.
  const [draftOpen, setDraftOpen] = useState(false)

  // Stage 14 (D4): the episode is a guided flow — script → (confirm) → references → (ready) → scenes.
  // Old episodes that already have generated scenes open straight on the scenes step.
  const [phase, setPhase] = useState<EpisodePhase>(() => {
    const anyScene = ((initial.scenes ?? []) as Scene[]).some((s) => validUrl(s.videoUrl))
    return anyScene || validUrl(initial.videoUrl) ? 'scenes' : 'script'
  })
  const goPhase = (p: EpisodePhase) => { setPhase(p); if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' }) }

  const patchScene = (sceneId: string, patch: Partial<Scene>) => setScenes((prev) => prev.map((s) => (s.id === sceneId ? { ...s, ...patch } : s)))
  const stopPolling = (sceneId: string) => { const t = pollTimers.current[sceneId]; if (t) clearTimeout(t); delete pollTimers.current[sceneId] }
  const clearGen = (sceneId: string) => setActiveGen((p) => { const n = { ...p }; delete n[sceneId]; return n })

  const refreshCredits = useCallback(async () => {
    try { const r = await fetch('/api/user/credits', { cache: 'no-store' }); if (r.ok) { const d = await r.json(); if (typeof d?.credits === 'number') setCredits(d.credits) } } catch {}
  }, [])

  // ---- Reference readiness ----
  const locBaseReady = (l: any) => validUrl(l?.imageUrl)
  const locExtraReady = (l: any) => parseExtra(l?.imageExtra).length >= desiredExtraFrames(l)
  // Stage 21: the scenes step unlocks as soon as the references are ready — every character has its
  // full photo set and every episode location has its full frame set. (Important objects / artifacts
  // were removed in Stage 21 and no longer exist as a reference type.)
  const refsReady = refChars.every(hasAllImages) && refLocs.every((l) => locBaseReady(l) && locExtraReady(l))
  const refsCharsDone = refChars.filter(hasAllImages).length
  const refsLocsDone = refLocs.filter((l) => locBaseReady(l) && locExtraReady(l)).length

  // Fullscreen carousel keyboard nav: Esc closes, ←/→ move between a reference's photos.
  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null)
      else if (e.key === 'ArrowRight') setLightbox((lb) => (lb ? { ...lb, index: (lb.index + 1) % lb.images.length } : lb))
      else if (e.key === 'ArrowLeft') setLightbox((lb) => (lb ? { ...lb, index: (lb.index - 1 + lb.images.length) % lb.images.length } : lb))
    }
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
  }, [project.id, episode.id])

  // Stage 17: mirror the current character/location lists into refs so the poll effect below can read
  // them WITHOUT listing them in its dependency array. refreshRefs() replaces these arrays on every
  // tick (new object references), so if the effect depended on them it would tear down and restart on
  // every refresh — and the `if (stopped) return` right after refreshRefs would bail before firing any
  // job, leaving the loop stuck refreshing forever without ever generating the missing frames.
  const refCharsRef = useRef(refChars); refCharsRef.current = refChars
  const refLocsRef = useRef(refLocs); refLocsRef.current = refLocs

  // Poll while a reference session is active: refresh data, DURABLY resume any incomplete references,
  // stop when the mandatory set is ready.
  // Stage 17: the previous loop fired each location's extra-angle job at most ONCE per session and
  // never re-fired if that job died partway (serverless timeout) — so characters/locations could get
  // stuck at "base only" forever and the scenes gate stayed blocked. Now every tick we look at which
  // reference jobs are actually ACTIVE (from the DB) and re-fire the missing work in serverless-safe
  // chunks: characters that still lack any of their photos are resumed (idempotent — extra-only
  // top-ups are free), and locations short of their frame target get the next chunk of extra angles.
  useEffect(() => {
    if (!refSession) return
    let stopped = false
    const loop = async () => {
      const fresh = await refreshRefs()
      if (stopped || refCanceled.current) return
      if (!fresh) { void refreshCredits(); return }
      const refChars = refCharsRef.current
      const refLocs = refLocsRef.current

      // Which reference jobs are currently running? (avoids duplicate starts across ticks / reloads)
      let activeCharJob = false
      const activeExtraLocs = new Set<string>()
      try {
        const jr = await fetch(`/api/jobs?projectId=${project.id}&active=1`, { cache: 'no-store' })
        if (jr.ok) {
          const jd = await jr.json()
          for (const j of jd?.jobs ?? []) {
            if (j?.type === 'characters') activeCharJob = true
            if (j?.type === 'location_extra_image') { try { const rd = JSON.parse(j?.resultData ?? '{}'); if (rd?.locationId) activeExtraLocs.add(rd.locationId) } catch {} }
          }
        }
      } catch {}
      if (stopped || refCanceled.current) return

      // Characters: resume any episode character that is not fully complete (missing base OR extras).
      const incompleteChars = refChars.filter((c) => !hasAllImages(fresh.pchars.find((x: any) => x.id === c.id) ?? c))
      if (incompleteChars.length > 0 && !activeCharJob) {
        try {
          const res = await fetch('/api/ai/characters/references', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id, characterIds: incompleteChars.map((c) => c.id) }) })
          const d = await res.json().catch(() => ({}))
          if (res.ok && d?.jobId) refJobs.current.char = d.jobId
          else if (!res.ok && d?.error) setError(d.error)
          if (typeof d?.creditsRemaining === 'number') setCredits(d.creditsRemaining)
        } catch {}
      }

      // Locations: top up extra angles in chunks until each reaches its frame target.
      for (const l of refLocs) {
        const loc = fresh.plocs.find((x: any) => x.id === l.id)
        if (!loc) continue
        const want = desiredExtraFrames(loc)
        const have = parseExtra(loc.imageExtra).length
        if (want > 0 && validUrl(loc.imageUrl) && have < want && !activeExtraLocs.has(loc.id)) {
          const chunk = Math.min(LOCATION_EXTRA_CHUNK, want - have)
          try {
            const res = await fetch(`/api/ai/locations/${loc.id}/extra-images`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: chunk }) })
            const dd = await res.json().catch(() => ({}))
            if (res.ok && dd?.jobId) refJobs.current.extra[loc.id] = dd.jobId
            else if (!res.ok && dd?.error) setError(dd.error)
          } catch {}
        }
      }
      void refreshCredits()
    }
    void loop()
    const id = setInterval(loop, REF_POLL_MS)
    return () => { stopped = true; clearInterval(id) }
  }, [refSession, refreshRefs, refreshCredits, project.id])

  // Stop the reference session once everything is ready.
  useEffect(() => { if (refSession && refsReady) { setRefSession(false); refJobs.current = { loc: {}, extra: {} } } }, [refSession, refsReady])

  // Stage 17: self-heal a stuck episode. If references were already initiated in a previous session
  // (some character/location already has a base image) but the mandatory set is NOT complete and no
  // session is running, auto-start the polling session on open. This drives the durable resume loop
  // above to completion after a reload / serverless timeout, so the scenes gate reliably unlocks
  // without the user having to click "generate" again. Runs once per mount.
  const autoResumedRef = useRef(false)
  useEffect(() => {
    if (autoResumedRef.current) return
    if (refSession || refStarting || refsReady) return
    const initiated = refChars.some((c) => validUrl(c?.imageFront)) || refLocs.some((l) => validUrl(l?.imageUrl))
    if (initiated) { autoResumedRef.current = true; refCanceled.current = false; setRefSession(true) }
  }, [refSession, refStarting, refsReady, refChars, refLocs])

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
      if (d?.jobId) setRefSession(true) // poll only when a regeneration job actually started
    } catch { setError('Ошибка сети') } finally { setLocBusy((b) => { const n = { ...b }; delete n[locationId]; return n }) }
  }

  /** Stage 22 — "Сохранить навсегда": lock a character reference without regeneration. */
  const lockCharacter = async (characterId: string) => {
    setCharBusy((b) => ({ ...b, [characterId]: true })); setError('')
    try {
      const res = await fetch('/api/ai/characters/lock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ characterId }) })
      const d = await res.json()
      if (!res.ok) { setError(d?.error ?? 'Не удалось зафиксировать персонажа'); return }
      if (d?.character) setRefChars((prev) => prev.map((c) => (c.id === characterId ? { ...c, ...d.character } : c)))
    } catch { setError('Ошибка сети') } finally { setCharBusy((b) => { const n = { ...b }; delete n[characterId]; return n }) }
  }

  /** Stage 22 — "Сохранить навсегда": lock a location reference without regeneration. */
  const lockLocation = async (locationId: string) => {
    setLocBusy((b) => ({ ...b, [locationId]: true })); setError('')
    try {
      const res = await fetch(`/api/ai/locations/${locationId}/lock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      const d = await res.json()
      if (!res.ok) { setError(d?.error ?? 'Не удалось зафиксировать локацию'); return }
      if (d?.location) setRefLocs((prev) => prev.map((l) => (l.id === locationId ? { ...l, ...d.location } : l)))
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

  // Stage 19 — mirror the background episode_assemble job's resultData into the local `polish` panel.
  const applyAssembleJob = (job?: JobInfo | null) => {
    if (!job) return
    const rd = job.result ?? {}
    const phase = rd.phase as 'analyzing' | 'regen' | 'stitching' | 'done' | undefined
    if (!phase || phase === 'done') return // terminal state is handled by finishAssembleJob
    setPolish({
      phase,
      issues: Array.isArray(rd.issues) ? rd.issues : [],
      done: typeof rd.done === 'number' ? rd.done : 0,
      failed: typeof rd.failed === 'number' ? rd.failed : 0,
    })
  }

  // The job reached a terminal state (completed / failed / canceled) — settle the UI.
  const finishAssembleJob = (job?: JobInfo | null) => {
    setPolish(null)
    setAssembling(false)
    setAssembleJobId(null)
    void refreshCredits()
    if (!job) return
    if (job.status === 'completed') {
      const rd = job.result ?? {}
      const fixed: number = typeof rd.fixedCount === 'number' ? rd.fixedCount : 0
      if (validUrl(rd.videoUrl)) setEpisode((p: any) => ({ ...p, videoUrl: rd.videoUrl, status: 'assembled' }))
      setNotice(fixed > 0
        ? `Финальная полировка завершена: исправлены логические нестыковки и переходы (${fixed} ${fixed === 1 ? 'сцена' : 'сцен'}), эпизод собран.`
        : 'Логических нестыковок не найдено — эпизод собран без перегенерации (кредиты не списаны).')
      // The flagged scenes were re-generated on the server — refresh so the cards show the new clips.
      void reloadEpisode()
    } else if (job.status === 'canceled') {
      setNotice('Полировка отменена. Уже готовые сцены сохранены; незавершённые можно достроить кнопкой «Продолжить / повторить незавершённые».')
      void reloadEpisode()
    } else if (job.status === 'failed') {
      setError(job.error ?? 'Финальная полировка не удалась')
      void reloadEpisode()
    }
  }

  const assemblePoll = useJobPolling({
    onUpdate: (res: JobPollResponse) => applyAssembleJob(res.job),
    onFinish: (res: JobPollResponse) => finishAssembleJob(res.job),
  })

  // «Ассембл» → kick off the server-driven final-polish job and poll it.
  const assemble = async () => {
    setAssembling(true); setError(null); setNotice(null)
    setPolish({ phase: 'analyzing', issues: [], done: 0, failed: 0 })
    try {
      const res = await fetch('/api/ai/assemble-episode/polish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ episodeId: episode.id }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Финальная полировка не удалась')
      if (!data?.jobId) throw new Error('Не удалось запустить финальную полировку')
      setAssembleJobId(data.jobId)
      assemblePoll.start(data.jobId)
    } catch (e: any) { setError(e?.message ?? 'Ошибка'); setPolish(null); setAssembling(false); setAssembleJobId(null) }
  }

  const cancelAssemble = async () => {
    const id = assembleJobIdRef.current
    if (!id) return
    try { await fetch(`/api/ai/jobs/${id}/cancel`, { method: 'POST' }) } catch {}
    // The poll's onFinish will settle the UI once the job flips to canceled.
  }

  // Auto-resume: if a background assemble job is still running for this episode (e.g. after a reload
  // or navigating back), pick it up and keep showing live progress.
  useEffect(() => {
    let stale = false
    ;(async () => {
      try {
        const r = await fetch(`/api/ai/assemble-episode/status?episodeId=${episode.id}`, { cache: 'no-store' })
        if (!r.ok) return
        const d = await r.json()
        if (stale || !d?.activeJobId) return
        setAssembleJobId(d.activeJobId)
        setAssembling(true)
        setPolish((p) => p ?? { phase: 'analyzing', issues: [], done: 0, failed: 0 })
        assemblePoll.start(d.activeJobId)
      } catch {}
    })()
    return () => { stale = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const perScene = plan?.costPerScene
  const isAssembled = episode.status === 'assembled' || validUrl(episode.videoUrl)
  const nextEpisode = siblings.filter((s) => s.number > episode.number).sort((a, b) => a.number - b.number)[0] ?? null

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className={`mx-auto max-w-[1200px] px-4 py-6 ${phase === 'script' ? 'pb-44' : ''}`} data-testid="episode-page">
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

        {/* Stage 14 (D): guided steps — script → references → scenes */}
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs" data-testid="phase-steps">
          {(([['references', '1 · Референсы'], ['script', '2 · Сценарий'], ['scenes', '3 · Сцены']]) as [EpisodePhase, string][]).map(([key, label]) => {
            const reached = key === 'script' || key === 'references' || refsReady || scenes.some((s) => validUrl(s.videoUrl))
            const active = phase === key
            return (
              <button
                key={key}
                type="button"
                onClick={() => reached && goPhase(key)}
                disabled={!reached}
                data-testid={`phase-step-${key}`}
                data-active={active}
                className={`rounded-full border px-3 py-1 font-medium transition ${active ? 'border-primary bg-primary text-primary-foreground' : reached ? 'border-border hover:bg-muted' : 'border-border/50 text-muted-foreground/50'}`}
              >
                {label}
              </button>
            )
          })}
        </div>

        {/* Step 1 — episode script in book format (D1/D2) */}
        {phase === 'script' && (
          <div className="mt-4 rounded-xl border border-border bg-card p-4" data-testid="phase-script">
            <h2 className="mb-3 font-display text-xl font-bold">Сценарий эпизода</h2>
            <BookScript text={episode.script} scenes={scenes} />
            {/* Stage 21 navigation — Сценарий is step 2: back to references · forward to scenes. */}
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <button onClick={() => goPhase('references')} className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted" data-testid="script-to-references">
                <ArrowLeft className="h-4 w-4" /> Референсы
              </button>
              <button onClick={() => goPhase('scenes')} disabled={!refsReady} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="script-to-scenes" title={refsReady ? '' : 'Сначала сгенерируйте все референсы эпизода'}>
                К сценам <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {/* Step 2 — Stage 12: references of THIS episode + single "generate all" */}
        {phase === 'references' && (
        <section className="mt-4 rounded-xl border border-border bg-card p-4" data-testid="episode-references">
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
              // 5 photo slots: 3 base shots + 2 extra angles. Clicking any opens the carousel over all of them.
              const slots = [c.imageFront, c.imageProfile, c.imageFull, ...parseExtra(c.imageExtra)].slice(0, CHARACTER_PHOTO_COUNT)
              while (slots.length < CHARACTER_PHOTO_COUNT) slots.push(null)
              const photos = charPhotos(c)
              return (
                <div key={c.id} className="rounded-lg border border-border/60 p-3" data-testid="ref-character">
                  <div className="grid grid-cols-3 gap-2">
                    {slots.map((img, i) => (
                      <button key={i} type="button" onClick={() => validUrl(img) && openLightbox(photos, photos.indexOf(img as string), `${c.name} — ${SHOT_LABELS[i] ?? 'фото'}`)} className="group relative aspect-[3/4] overflow-hidden rounded bg-muted" title={SHOT_LABELS[i]} data-testid="ref-image">
                        {validUrl(img) ? (
                          <>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={img as string} alt={`${c.name} — ${SHOT_LABELS[i] ?? 'фото'}`} className="h-full w-full object-cover" />
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
                  <div className="mt-2 truncate text-sm font-medium">{c.name} <span className="font-normal text-muted-foreground">· {photos.length}/{CHARACTER_PHOTO_COUNT} фото</span></div>
                  {c.role && <div className="truncate text-xs text-muted-foreground">{c.role}</div>}
                  {c.refLocked ? (
                    <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-2 py-1 text-xs text-muted-foreground" data-testid="ref-character-locked">
                      <Lock className="h-3.5 w-3.5" /> Зафиксировано
                    </div>
                  ) : (
                    <>
                      <div className="mt-2 flex flex-col gap-1.5 sm:flex-row">
                        <input value={charEdit[c.id] ?? ''} onChange={(e) => setCharEdit((t) => ({ ...t, [c.id]: e.target.value }))} placeholder="Изменить по промпту…" className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-xs" data-testid="ref-character-input" disabled={busy} />
                        <button onClick={() => reviseCharacter(c.id)} disabled={busy || !(charEdit[c.id] ?? '').trim()} className="inline-flex items-center justify-center gap-1 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50" data-testid="ref-character-submit" title="Изменить по промпту (после правки референс фиксируется)">
                          {charBusy[c.id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                      <button onClick={() => lockCharacter(c.id)} disabled={busy || refSession || !hasAllImages(c)} className="mt-1.5 inline-flex w-full items-center justify-center gap-1 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50" data-testid="ref-character-lock" title="Зафиксировать без изменений">
                        <Lock className="h-3.5 w-3.5" /> Сохранить навсегда
                      </button>
                    </>
                  )}
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
                    <div className="min-w-0 truncate text-sm font-medium">{l.name} <span className="font-normal text-muted-foreground">· {Math.min(locationFrames(l), desiredTotalFrames(l))}/{desiredTotalFrames(l)} кадров</span></div>
                    <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground" title={`Больше кадров для крупных мест`}>{locationScaleLabel(scale)}{want > 0 ? ` · +${want} кадров` : ''}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(() => { const all = [...base.map((a) => ({ url: a.url as string, label: a.label })), ...extras.map((u, i) => ({ url: u, label: `Доп. кадр ${i + 1}` }))]; const urls = all.map((a) => a.url); return base.length > 0 ? all.map((a, i) => (
                      <button key={a.url + i} type="button" onClick={() => openLightbox(urls, i, `${l.name} — ${a.label}`)} className="group relative h-24 w-16 overflow-hidden rounded bg-muted" title={a.label} data-testid="ref-image">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={a.url} alt={`${l.name} — ${a.label}`} className="h-full w-full object-cover" />
                        <span className="absolute right-0.5 top-0.5 rounded bg-black/50 p-0.5 opacity-0 transition group-hover:opacity-100"><Maximize2 className="h-3 w-3 text-white" /></span>
                      </button>
                    )) : busy ? (
                      <div className="flex h-24 w-16 items-center justify-center rounded bg-muted"><Loader2 className="h-4 w-4 animate-spin text-primary" /></div>
                    ) : (
                      <div className="flex h-24 w-16 items-center justify-center rounded bg-muted"><ImageOff className="h-4 w-4 text-muted-foreground/40" /></div>
                    ) })()}
                  </div>
                  {l.refLocked ? (
                    <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-2 py-1 text-xs text-muted-foreground" data-testid="ref-location-locked">
                      <Lock className="h-3.5 w-3.5" /> Зафиксировано
                    </div>
                  ) : (
                    <>
                      <div className="mt-2 flex flex-col gap-1.5 sm:flex-row">
                        <input value={locEdit[l.id] ?? ''} onChange={(e) => setLocEdit((t) => ({ ...t, [l.id]: e.target.value }))} placeholder="Изменить локацию по промпту…" className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-xs" data-testid="ref-location-input" disabled={busy} />
                        <button onClick={() => reviseLocation(l.id)} disabled={busy || !(locEdit[l.id] ?? '').trim()} className="inline-flex items-center justify-center gap-1 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50" data-testid="ref-location-submit" title="Изменить по промпту (после правки референс фиксируется)">
                          {locBusy[l.id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                      <button onClick={() => lockLocation(l.id)} disabled={busy || refSession || !(locBaseReady(l) && locExtraReady(l))} className="mt-1.5 inline-flex w-full items-center justify-center gap-1 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50" data-testid="ref-location-lock" title="Зафиксировать без изменений">
                        <Lock className="h-3.5 w-3.5" /> Сохранить навсегда
                      </button>
                    </>
                  )}
                </div>
              )
            })}
            {refLocs.length === 0 && <p className="text-sm text-muted-foreground">У эпизода нет привязанных локаций.</p>}
          </div>

          {/* Stage 21 navigation — Референсы is step 1: only a forward button to the script.
              Enabled once all references (characters + locations) are ready. */}
          <div className="mt-5 flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
            <button onClick={() => goPhase('script')} disabled={!refsReady} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="refs-to-script" title={refsReady ? '' : 'Сначала сгенерируйте все референсы эпизода'}>
              К сценарию <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </section>
        )}

        {/* Step 3 — scenes: generate all / draft / assemble */}
        {phase === 'scenes' && (
        <>
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
          <button onClick={() => goPhase('script')} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted" data-testid="back-to-script">
            <ArrowLeft className="h-4 w-4" /> Сценарий
          </button>
          <button onClick={openModal} disabled={startingAll || scenes.length === 0 || !refsReady} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="generate-all" title={refsReady ? '' : 'Сначала сгенерируйте все референсы эпизода'}>
            <Play className="h-4 w-4" /> Сгенерировать все сцены
          </button>
          <button onClick={() => setDraftOpen(true)} disabled={!anyClip} className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50" data-testid="show-draft" title={anyClip ? '' : 'Появится, когда будет хотя бы один готовый ролик'}>
            <Film className="h-4 w-4" /> Показать черновик
          </button>
          <button onClick={assemble} disabled={!allReady || assembling || !!polish || !!assembleJobId} className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50" data-testid="assemble" title={allReady ? 'Ассембл — финальная полировка: Seedance пересматривает весь эпизод и исправляет логические нестыковки и переходы' : 'Доступно, когда все сцены готовы'}>
            {assembling || polish || assembleJobId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clapperboard className="h-4 w-4" />} Ассембл (финальная полировка)
          </button>
          {/* Stage 23 — the assembled clip is shown only in the dedicated «Собранный эпизод» frame
              below; the duplicate inline preview next to the «Ассембл» button was removed. */}
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
                {(polish.phase === 'analyzing' || polish.phase === 'regen') && (
                  <CancelButton onCancel={cancelAssemble} testId="polish-cancel" label="Отменить" pendingLabel="Останавливаю…" />
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
                      <span className="text-xs font-normal text-muted-foreground"> · ~{scene.durationSec ?? 15}с</span>
                    </div>
                  </div>
                  <div className="flex -space-x-1">{scene.characters?.map(({ character: c }) => validUrl(c.imageFront) ? <img key={c.id} src={c.imageFront as string} alt={c.name} title={c.name} className="h-6 w-6 rounded-full border border-background object-cover" /> : null)}</div>
                </div>

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
        </>
        )}
      </main>

      {/* Stage 14 (D3): episode-level revise-by-prompt as a sticky bottom bar (whole episode or a named scene) */}
      {phase === 'script' && (
        <StickyReviseBar
          value={reviseText}
          onChange={setReviseText}
          onSubmit={() => reviseEpisode()}
          busy={revising}
          testId="episode-revise"
          label="Изменить сценарий эпизода по промпту (весь эпизод или конкретную сцену)"
          placeholder="Например: убрать сцену на кухне, усилить конфликт в сцене 3…"
          submitLabel="Переписать"
          hint="Правки применяются ко всему сценарию. Можно указать сцену по номеру. Ctrl/⌘+Enter — отправить."
        />
      )}

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

      {/* Fullscreen reference carousel: swipe/arrows/wheel across ALL photos of one reference. */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[60] flex touch-none select-none items-center justify-center overflow-hidden bg-black/95 p-2"
          data-testid="lightbox"
          onClick={() => setLightbox(null)}
          onWheel={(e) => { if (lightbox.images.length > 1) lightboxStep(e.deltaY > 0 || e.deltaX > 0 ? 1 : -1) }}
          onTouchStart={(e) => { lightboxTouchX.current = e.touches[0]?.clientX ?? null }}
          onTouchEnd={(e) => {
            const start = lightboxTouchX.current
            lightboxTouchX.current = null
            if (start == null || lightbox.images.length < 2) return
            const dx = (e.changedTouches[0]?.clientX ?? start) - start
            if (Math.abs(dx) > 40) lightboxStep(dx < 0 ? 1 : -1)
          }}
        >
          <button className="absolute right-3 top-3 rounded-full bg-white/10 p-2 text-white" data-testid="lightbox-close" onClick={(e) => { e.stopPropagation(); setLightbox(null) }}><X className="h-5 w-5" /></button>
          {lightbox.images.length > 1 && (
            <button className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 sm:left-4" data-testid="lightbox-prev" onClick={(e) => { e.stopPropagation(); lightboxStep(-1) }}><ChevronLeft className="h-6 w-6" /></button>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox.images[lightbox.index]} alt={lightbox.title ?? ''} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
          {lightbox.images.length > 1 && (
            <button className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 sm:right-4" data-testid="lightbox-next" onClick={(e) => { e.stopPropagation(); lightboxStep(1) }}><ChevronRight className="h-6 w-6" /></button>
          )}
          <div className="absolute bottom-3 left-0 right-0 text-center text-xs text-white/80">
            {lightbox.title ? `${lightbox.title} · ` : ''}{lightbox.index + 1}/{lightbox.images.length}
          </div>
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
