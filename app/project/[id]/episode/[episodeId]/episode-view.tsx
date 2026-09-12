'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Header } from '@/components/header'
import { Loader2, Wand2, ArrowLeft, ArrowRight, MapPin, Film, Download, RefreshCw, Images, X, Maximize2, Users, ImageOff, ChevronLeft, ChevronRight, Copy, Check, FileText, RotateCcw, Save, Plus } from 'lucide-react'
import { FrameToolbar, DownloadAllButton } from '@/app/project/[id]/_components/frame-toolbar'
import { PromptModal, CHARACTER_PROMPT_DESCRIPTION, LOCATION_PROMPT_DESCRIPTION } from '@/app/project/[id]/_components/prompt-modal'
import { referenceFileName } from '@/lib/download-name'
import { VIDEO_PROVIDERS, VIDEO_PROVIDER_LABEL, normalizeVideoProvider, videoModelBadge, type VideoProvider } from '@/lib/video-provider'
import { postJobStart, SceneVideoPlayer } from '../../_components/scenes-stage'
import { BookScript } from '../../_components/season-stage'
import { StickyReviseBar } from '../../_components/sticky-revise-bar'
import { JobProgressBar, useJobPolling, type JobInfo, type JobPollResponse, JOB_POLL_INTERVAL_MS } from '../../_components/use-job-polling'
import { CancelButton } from '../../_components/cancel-button'
import { desiredTotalFrames, locationDetailLevel, locationDetailLabel, episodeLocations } from '@/lib/location-scale'
import { CHARACTER_PHOTO_COUNT } from '@/lib/reference-counts'
import { CHARACTER_REFERENCE_COST } from '@/lib/power-tier'
import { IMAGE_MODELS, DEFAULT_IMAGE_MODEL, type ImageModelId } from '@/lib/ai-models'
import { EpisodeNavGrid } from './episode-nav-grid'
import { locationExtraLabel } from '@/lib/visual-style'
import { episodeTotalSeconds, EPISODE_MAX_TOTAL_SECONDS } from '@/lib/season'
import { ASSEMBLE_QUALITIES, ASSEMBLE_FPS, DEFAULT_ASSEMBLE_QUALITY, DEFAULT_ASSEMBLE_FPS, type AssembleQuality, type AssembleFps } from '@/lib/assemble-options'

type EpisodePhase = 'script' | 'references' | 'scenes'

const VIDEO_EXPECTED_SEC = 600
const REF_POLL_MS = 3500
// Stage 53: full-body front is the primary photo, shown first; front/profile are optional manual slots.
const SHOT_LABELS = ['В полный рост (референс)', 'Портрет (лицо)', 'Левый профиль']
// Stage 36 — a reference image the video job actually submitted (job.result.submittedReferences).
type SubmittedReference = { url: string; kind: string }
const REFERENCE_KIND_LABELS: Record<string, string> = {
  character: 'Портрет',
  location: 'Локация',
  crowd: 'Массовка',
  previous_frame: 'Кадр предыдущей сцены',
  scene: 'Кадр сцены',
}
const referenceKindLabel = (kind: string) => REFERENCE_KIND_LABELS[kind] ?? 'Референс'
const CHAR_EXTRA_MIN = Math.max(0, CHARACTER_PHOTO_COUNT - 3) // extra angles beyond the 3 base shots → 0 (3 photos)
const validUrl = (u?: string | null) => typeof u === 'string' && u.startsWith('http') && u.length > 10
function parseExtra(imageExtra?: string | null): string[] {
  if (!imageExtra) return []
  try { const a = JSON.parse(imageExtra); return Array.isArray(a) ? a.filter((u): u is string => typeof u === 'string' && u.startsWith('http')) : [] } catch { return [] }
}
// Stage 53: a character reference is a single photo — the full-body front shot (imageFull). Legacy
// characters that only have imageFront fall back to it. Full-body is listed first as the primary photo.
// Stage 56: build the list of a character's ACTUAL reference photos as {url, shot, idx?, label}
// objects, preserving the correct url->shot mapping so per-shot regen/download target the right slot.
// Invalid/empty urls are dropped — the UI renders only real photos, with no padded placeholder slots.
export type CharPhotoSlot = { url: string; shot: 'full' | 'front' | 'profile' | 'extra'; idx?: number; label: string }
export function characterPhotoSlots(c: any): CharPhotoSlot[] {
  const out: CharPhotoSlot[] = []
  if (validUrl(c?.imageFull)) out.push({ url: c.imageFull, shot: 'full', label: SHOT_LABELS[0] })
  if (validUrl(c?.imageFront)) out.push({ url: c.imageFront, shot: 'front', label: SHOT_LABELS[1] })
  if (validUrl(c?.imageProfile)) out.push({ url: c.imageProfile, shot: 'profile', label: SHOT_LABELS[2] })
  parseExtra(c?.imageExtra).forEach((u, i) => out.push({ url: u, shot: 'extra', idx: i, label: `Ракурс ${i + 1}` }))
  return out
}
const charPhotos = (c: any): string[] => characterPhotoSlots(c).map((s) => s.url)
const hasAllImages = (c: any) => validUrl(c?.imageFull) || validUrl(c?.imageFront)
// Stage 18: total generated frames of a location = present base angles + extra angles (target = 3/6/9 by scale).
const locationFrames = (l: any): number => [l?.imageUrl, l?.imageReverse, l?.imageDetail].filter(validUrl).length + parseExtra(l?.imageExtra).length
// Stage 17: top up location extras in serverless-safe chunks (a single 12-frame job can overrun the
// serverless window and get killed — chunking + re-firing guarantees the target is actually reached).

type Scene = { id: string; number: number; shotType?: string | null; durationSec?: number | null; locationDesc?: string | null; action?: string | null; dialogue?: string | null; sceneKind?: string | null; voiceover?: string | null; voiceoverLocal?: string | null; videoPrompt?: string | null; promptOverride?: string | null; skipReferences?: boolean | null; videoUrl?: string | null; audioUrl?: string | null; lastFrameUrl?: string | null; lookStale?: boolean | null; videoModel?: string | null; status: string; characters: { character: { id: string; name: string; imageFront?: string | null } }[] }
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
  const [cancelAsk, setCancelAsk] = useState<string | null>(null) // sceneId awaiting «Отменить генерацию» confirmation
  const [cancelling, setCancelling] = useState<Record<string, boolean>>({}) // per-scene: cancel request in flight
  const [sceneError, setSceneError] = useState<Record<string, string>>({}) // per-scene generation error shown on the card
  // Stage 36 — the reference images the failed job actually submitted (from job.result.submittedReferences), for previews under the error.
  const [sceneErrorRefs, setSceneErrorRefs] = useState<Record<string, SubmittedReference[]>>({})
  // Stage 31 — "Смотреть промпт" modal: view / copy / manually override the scene's final prompt.
  const [promptModal, setPromptModal] = useState<{ sceneId: string; number: number } | null>(null)
  const [promptText, setPromptText] = useState('')          // editable textarea content
  const [promptLoading, setPromptLoading] = useState(false) // GET in flight
  const [promptErr, setPromptErr] = useState<string | null>(null)
  const [promptHasOverride, setPromptHasOverride] = useState(false) // scene currently uses a manual override
  const [promptSaving, setPromptSaving] = useState(false)   // PUT in flight (save or reset)
  const [promptCopied, setPromptCopied] = useState(false)   // flashed «Скопировано» inside the modal
  const [promptSaved, setPromptSaved] = useState(false)     // flashed «Сохранено» inside the modal
  // Reference strategy the builder resolved for this scene (character_references | new_scene_reference | text_only).
  const [promptRefKind, setPromptRefKind] = useState<string | null>(null)
  // «Собрать» — pure concatenation of the ready scene clips into one episode (no audit / no polish / no re-gen).
  const [stitching, setStitching] = useState(false)
  // Stage 46B: «Собрать» opens a dialog — production quality / fps of the FINAL file (scenes are always 480p);
  // the stitch runs as a background job whose real stages are shown in a progress bar.
  const [assembleDialogOpen, setAssembleDialogOpen] = useState(false)
  const [assembleQuality, setAssembleQuality] = useState<AssembleQuality>(DEFAULT_ASSEMBLE_QUALITY)
  const [assembleFps, setAssembleFps] = useState<AssembleFps>(DEFAULT_ASSEMBLE_FPS)
  const [assembleNote, setAssembleNote] = useState<string | null>(null)
  const stitchJob = useJobPolling({
    onFinish: (res) => {
      setStitching(false)
      const j = res.job
      if (j.status === 'completed') {
        if (validUrl(j.result?.videoUrl)) setEpisode((p: any) => ({ ...p, videoUrl: j.result.videoUrl, status: 'assembled', assembleQuality: j.result?.quality ?? null, assembleFps: j.result?.fps ?? null }))
        setAssembleNote(j.result?.note ?? null)
      } else {
        setError(j.error ?? j.message ?? 'Не удалось собрать эпизод')
      }
    },
  })
  // AI image model chosen for reference generation (EDIT 1). `refModalOpen` gates the picker
  // shown before «Сгенерировать всё»; the ref keeps the choice available to the resume poll loop.
  const [imageModel, setImageModel] = useState<ImageModelId>(DEFAULT_IMAGE_MODEL)
  const [refModalOpen, setRefModalOpen] = useState(false)
  const imageModelRef = useRef<ImageModelId>(DEFAULT_IMAGE_MODEL)
  imageModelRef.current = imageModel
  const [activeGen, setActiveGen] = useState<Record<string, boolean>>({})
  const [videoJobs, setVideoJobs] = useState<Record<string, JobInfo>>({})
  const pollTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  // Stage 12: per-episode references (characters + locations) with a single "generate all" button.
  const initialChars: any[] = (initial.characters?.length ? initial.characters.map((ec: any) => ec.character) : (project.characters ?? []))
  const [refChars, setRefChars] = useState<any[]>(initialChars)
  const [refLocs, setRefLocs] = useState<any[]>(episodeLocations(initial, project.locations ?? []))
  const [refSession, setRefSession] = useState(false) // polling active while refs are generating
  const [refStarting, setRefStarting] = useState(false)
  // Scope of the running reference session (Stage 46A): «Сгенерировать персонажей» (characters only —
  // locations are never touched) or a locations session started from ONE location card («Сгенерировать
  // мастер-кадр» / «+ Ракурс») — characters are never touched there.
  const [refScope, setRefScope] = useState<'characters' | 'locations'>('characters')
  const refScopeRef = useRef<'characters' | 'locations'>('characters')
  // Server truth refreshed every tick: ids of locations with a running master-frame / extra-angle job,
  // whether a characters job is running, and whether at least one tick has been observed this session
  // (the session must not end before the first tick — the just-started job may not be visible yet).
  const [locActive, setLocActive] = useState<Set<string>>(new Set())
  const [charJobActive, setCharJobActive] = useState(false)
  const [tickSeen, setTickSeen] = useState(false)
  const refJobs = useRef<{ char?: string; loc: Record<string, string>; extra: Record<string, string> }>({ loc: {}, extra: {} })
  const refCanceled = useRef(false)
  // Per-location cancel («Отменить генерацию» on the location card): locations whose generation the
  // author canceled in the current session — the session loop starts no more angle chunks for them and
  // they no longer count as pending for the session-end check. Cleared when a new session starts.
  const locCanceled = useRef<Set<string>>(new Set())
  const [locCancelAsk, setLocCancelAsk] = useState<string | null>(null) // locationId awaiting cancel confirmation
  const [locCancelling, setLocCancelling] = useState<Record<string, boolean>>({}) // cancel requested, job not yet terminal
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

  // Stage 14 (D4): the episode is a guided flow — script → (confirm) → references → (ready) → scenes.
  // Old episodes that already have generated scenes open straight on the scenes step.
  const [phase, setPhase] = useState<EpisodePhase>(() => {
    const anyScene = ((initial.scenes ?? []) as Scene[]).some((s) => validUrl(s.videoUrl))
    // Open on «Референсы» by default; only jump straight to «Сцены» when the episode already has generated video.
    return anyScene || validUrl(initial.videoUrl) ? 'scenes' : 'references'
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
  // Stage 46A: a location is "ready" with its MASTER frame alone — extra angles are optional and are
  // added one by one with the «+ Ракурс» button. The scenes step unlocks as soon as every character
  // has its full photo set and every episode location has a master frame.
  const refsReady = refChars.every(hasAllImages) && refLocs.every(locBaseReady)
  const refsCharsDone = refChars.filter(hasAllImages).length
  const refsLocsDone = refLocs.filter(locBaseReady).length

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
          if (data.job.status === 'completed' || data.job.status === 'failed' || data.job.status === 'canceled') {
            stopPolling(sceneId); clearGen(sceneId)
            setCancelling((prev) => { const n = { ...prev }; delete n[sceneId]; return n })
            if (data.job.status === 'canceled') {
              // The worker reset the scene to «pending» and refunded the credits; drop the stale «generating» flag.
              patchScene(sceneId, { status: 'pending' })
            }
            if (data.job.status === 'failed') {
              setSceneError((prev) => ({ ...prev, [sceneId]: data.job.error ?? 'Генерация не удалась' }))
              // Stage 36: show which reference images were actually sent with the failed submission.
              const refs = Array.isArray(data.job.result?.submittedReferences) ? (data.job.result.submittedReferences as SubmittedReference[]).filter((r) => r && typeof r.url === 'string') : []
              setSceneErrorRefs((prev) => ({ ...prev, [sceneId]: refs }))
            }
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

  // ---- Stage 46B-2: per-photo «Перегенерировать» (one frame = CHARACTER_REFERENCE_COST), polled until done ----
  const [shotBusy, setShotBusy] = useState<Record<string, boolean>>({}) // key `${entityId}:${slot}`
  const regenShot = useCallback(async (kind: 'character' | 'location', entityId: string, slot: string, index?: number) => {
    const key = `${entityId}:${slot}${index !== undefined ? `-${index}` : ''}`
    if (shotBusy[key]) return
    setError(''); setShotBusy((b) => ({ ...b, [key]: true }))
    try {
      const body = kind === 'character' ? { shot: slot, index, imageModel: imageModelRef.current } : { slot, index, imageModel: imageModelRef.current }
      const res = await fetch(`/api/ai/${kind === 'character' ? 'characters' : 'locations'}/${entityId}/shot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? 'Не удалось перегенерировать фото'); return }
      if (typeof d?.creditsRemaining === 'number') setCredits(d.creditsRemaining)
      // Poll the single-shot job until it reaches a terminal state, then pull the fresh references.
      for (let i = 0; i < 400 && d?.jobId; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        const jr = await fetch(`/api/jobs/${d.jobId}`, { cache: 'no-store' }).catch(() => null)
        if (!jr || !jr.ok) continue
        const jd = await jr.json().catch(() => ({}))
        const st = jd?.job?.status
        if (st === 'completed') break
        if (st === 'failed' || st === 'canceled') { setError(jd?.job?.error ?? 'Перегенерация фото не удалась'); break }
      }
      await refreshRefs()
    } catch { setError('Ошибка сети') } finally { setShotBusy((b) => { const n = { ...b }; delete n[key]; return n }) }
  }, [shotBusy, refreshRefs])
  const shotIsBusy = (entityId: string, slot: string, index?: number) => !!shotBusy[`${entityId}:${slot}${index !== undefined ? `-${index}` : ''}`]
  // ---- Stage 46E: prompt modal (characters + locations), delete location frame, reset location prompt ----
  const [promptFor, setPromptFor] = useState<{ kind: 'character' | 'location'; id: string; name: string } | null>(null)
  const deleteFrame = useCallback(async (locationId: string, slot: string, index?: number) => {
    setError('')
    const res = await fetch(`/api/ai/locations/${locationId}/frame`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot, index }) })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) { setError(d?.error ?? 'Не удалось удалить кадр'); return }
    if (d?.location) setRefLocs((prev) => prev.map((l) => (l.id === locationId ? { ...l, ...d.location } : l)))
  }, [])
  const resetLocationPrompt = useCallback(async (locationId: string) => {
    setError('')
    const res = await fetch(`/api/ai/locations/${locationId}/prompt`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }) })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) { setError(d?.error ?? 'Не удалось сбросить промпт'); return }
    setRefLocs((prev) => prev.map((l) => (l.id === locationId ? { ...l, visualPrompt: d.prompt, visualPromptAuto: d.autoPrompt } : l)))
  }, [])
  const [locResetting, setLocResetting] = useState<Record<string, boolean>>({})
  // Stage 46E-1: reset character prompt override straight from the card (no modal)
  const [charResetting, setCharResetting] = useState<Record<string, boolean>>({})
  const resetCharacterPrompt = useCallback(async (characterId: string) => {
    setError('')
    setCharResetting((prev) => ({ ...prev, [characterId]: true }))
    try {
      const res = await fetch(`/api/ai/characters/${characterId}/prompt`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: '' }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? 'Не удалось сбросить промпт'); return }
      setRefChars((prev) => prev.map((c) => (c.id === characterId ? { ...c, promptOverride: null } : c)))
    } finally {
      setCharResetting((prev) => ({ ...prev, [characterId]: false }))
    }
  }, [])
  const locHasPromptOverride = (l: any) => l?.visualPromptAuto != null && String(l.visualPrompt ?? '').trim() !== String(l.visualPromptAuto ?? '').trim()

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
      let activeLocBase = false
      const activeLocs = new Set<string>()
      try {
        const jr = await fetch(`/api/jobs?projectId=${project.id}&active=1`, { cache: 'no-store' })
        if (jr.ok) {
          const jd = await jr.json()
          for (const j of jd?.jobs ?? []) {
            if (j?.type === 'characters') activeCharJob = true
            if (j?.type === 'location_image') activeLocBase = true
            if (j?.type === 'location_image' || j?.type === 'location_extra_image') {
              try {
                const rd = JSON.parse(j?.resultData ?? '{}')
                if (rd?.locationId) activeLocs.add(rd.locationId)
                if (Array.isArray(rd?.locationIds)) for (const id of rd.locationIds) activeLocs.add(id)
              } catch {}
            }
          }
        }
      } catch {}
      if (stopped || refCanceled.current) return
      void activeLocBase
      setLocActive(activeLocs); setCharJobActive(activeCharJob); setTickSeen(true)

      // Characters: resume any episode character that is not fully complete (missing base OR extras).
      // Skipped entirely in a locations-only session.
      const incompleteChars = refScopeRef.current === 'characters' ? refChars.filter((c) => !hasAllImages(fresh.pchars.find((x: any) => x.id === c.id) ?? c)) : []
      if (incompleteChars.length > 0 && !activeCharJob) {
        try {
          const res = await fetch('/api/ai/characters/references', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id, characterIds: incompleteChars.map((c) => c.id), imageModel: imageModelRef.current }) })
          const d = await res.json().catch(() => ({}))
          if (res.ok && d?.jobId) refJobs.current.char = d.jobId
          else if (!res.ok && d?.error) setError(d.error)
          if (typeof d?.creditsRemaining === 'number') setCredits(d.creditsRemaining)
        } catch {}
      }

      // Stage 46A: locations are NEVER topped up automatically — only the master frame requested by the
      // author is generated; extra angles are added one at a time with «+ Ракурс».
      void refLocs
      void refreshCredits()
    }
    void loop()
    const id = setInterval(loop, REF_POLL_MS)
    return () => { stopped = true; clearInterval(id) }
  }, [refSession, refreshRefs, refreshCredits, project.id])

  // Stop the reference session once the server shows no running reference job (after at least one tick)
  // and — in a characters session — every character has its full photo set.
  const refsCharsReady = refChars.every(hasAllImages)
  useEffect(() => {
    if (!refSession || !tickSeen) return
    const idle = !charJobActive && locActive.size === 0
    if (idle && (refScope === 'locations' || refsCharsReady)) { setRefSession(false); refJobs.current = { loc: {}, extra: {} } }
  }, [refSession, tickSeen, charJobActive, locActive, refScope, refsCharsReady])

  // Stage 17: self-heal a stuck episode. If references were already initiated in a previous session
  // (some character/location already has a base image) but the mandatory set is NOT complete and no
  // session is running, auto-start the polling session on open. This drives the durable resume loop
  // above to completion after a reload / serverless timeout, so the scenes gate reliably unlocks
  // without the user having to click "generate" again. Runs once per mount.
  const autoResumedRef = useRef(false)
  useEffect(() => {
    if (autoResumedRef.current) return
    if (refSession || refStarting || refsCharsReady) return
    // Stage 46A: only CHARACTERS self-heal (their photo set is mandatory and resumable); locations are
    // generated strictly on request (one master frame per click).
    const initiated = refChars.some((c) => validUrl(c?.imageFront) || validUrl(c?.imageFull))
    if (initiated) { autoResumedRef.current = true; refCanceled.current = false; refScopeRef.current = 'characters'; setRefScope('characters'); setTickSeen(false); setRefSession(true) }
  }, [refSession, refStarting, refsCharsReady, refChars])

  /** «Сгенерировать персонажей» (Stage 46A): generate every missing photo of this episode's CHARACTERS only.
   *  Locations are never touched here. The AI image model chosen in the picker is threaded into the request. */
  const generateCharacterRefs = async () => {
    setRefModalOpen(false)
    setError(''); setRefStarting(true); refCanceled.current = false; locCanceled.current = new Set()
    refScopeRef.current = 'characters'; setRefScope('characters'); setTickSeen(false)
    const model = imageModelRef.current
    try {
      const missingChars = refChars.filter((c) => !hasAllImages(c))
      if (missingChars.length === 0) return
      const res = await fetch('/api/ai/characters/references', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id, characterIds: missingChars.map((c) => c.id), imageModel: model }) })
      const d = await res.json()
      if (!res.ok) { setError(d?.error ?? 'Не удалось запустить генерацию персонажей'); return }
      if (d?.jobId) refJobs.current.char = d.jobId
      if (typeof d?.creditsRemaining === 'number') setCredits(d.creditsRemaining)
      setRefSession(true)
    } catch { setError('Ошибка сети') } finally { setRefStarting(false) }
  }

  /** «Сгенерировать мастер-кадр» on ONE location card (Stage 46A): exactly ONE master frame of this location,
   *  nothing else — extra angles are added later, one per click, with «+ Ракурс». Characters are not touched. */
  const generateLocationRefs = async (locationId: string) => {
    setError(''); setRefStarting(true); refCanceled.current = false; locCanceled.current = new Set()
    refScopeRef.current = 'locations'; setRefScope('locations'); setTickSeen(false)
    try {
      const res = await fetch(`/api/ai/locations/${locationId}/image`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageModel: imageModelRef.current }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? 'Не удалось запустить генерацию локации'); return }
      if (d?.jobId) refJobs.current.loc[locationId] = d.jobId
      if (typeof d?.creditsRemaining === 'number') setCredits(d.creditsRemaining)
      // A new master frame replaces the whole photo set: drop the old angles locally (the server resets them too).
      setRefLocs((prev) => prev.map((l) => (l.id === locationId ? { ...l, imageReverse: null, imageDetail: null, imageExtra: null } : l)))
      setLocActive((p) => new Set(p).add(locationId))
      setRefSession(true)
    } catch { setError('Ошибка сети') } finally { setRefStarting(false) }
  }

  /** «+ Ракурс» (Stage 46A): ONE additional angle of a location, chained on its master frame. */
  const addLocationAngle = async (locationId: string) => {
    setError(''); setRefStarting(true); refCanceled.current = false; locCanceled.current = new Set()
    refScopeRef.current = 'locations'; setRefScope('locations'); setTickSeen(false)
    try {
      const res = await fetch(`/api/ai/locations/${locationId}/extra-images`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 1, imageModel: imageModelRef.current }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? 'Не удалось запустить генерацию ракурса'); return }
      if (d?.jobId) refJobs.current.extra[locationId] = d.jobId
      if (typeof d?.creditsRemaining === 'number') setCredits(d.creditsRemaining)
      setLocActive((p) => new Set(p).add(locationId))
      setRefSession(true)
    } catch { setError('Ошибка сети') } finally { setRefStarting(false) }
  }

    const cancelRefs = async () => {
    refCanceled.current = true; autoResumedRef.current = true // don't let the self-heal effect restart what was just canceled
    const ids = [refJobs.current.char, ...Object.values(refJobs.current.loc), ...Object.values(refJobs.current.extra)].filter(Boolean) as string[]
    for (const id of ids) { try { await fetch(`/api/ai/jobs/${id}/cancel`, { method: 'POST' }) } catch {} }
    setRefSession(false); refJobs.current = { loc: {}, extra: {} }
    void refreshRefs(); void refreshCredits()
  }

  /** «Отменить генерацию» on ONE location card (confirmed): cancel the active master-frame / extra-angle
   *  job(s) of this location via the jobs cancel API, stop the session loop for this location, and keep
   *  the button in «Останавливаю...» until those jobs are terminal (canceled / failed / completed). In a
   *  «Сгенерировать всё» session the other characters / locations keep going; a locations-only session
   *  (single-location button) ends because this location was its only work. */
  const cancelLocationGen = async (locationId: string) => {
    setLocCancelAsk(null)
    locCanceled.current.add(locationId)
    autoResumedRef.current = true // don't let the self-heal effect restart what was just canceled
    setLocCancelling((p) => ({ ...p, [locationId]: true }))
    const ids = new Set<string>()
    if (refJobs.current.loc[locationId]) ids.add(refJobs.current.loc[locationId])
    if (refJobs.current.extra[locationId]) ids.add(refJobs.current.extra[locationId])
    // Server truth: jobs started before a reload / by the auto-resume loop are not in refJobs.
    try {
      const jr = await fetch(`/api/jobs?projectId=${project.id}&active=1`, { cache: 'no-store' })
      if (jr.ok) {
        const jd = await jr.json()
        for (const j of jd?.jobs ?? []) {
          if (j?.type !== 'location_image' && j?.type !== 'location_extra_image') continue
          try {
            const rd = JSON.parse(j?.resultData ?? '{}')
            if (rd?.locationId === locationId || (Array.isArray(rd?.locationIds) && rd.locationIds.includes(locationId))) ids.add(j.id)
          } catch {}
        }
      }
    } catch {}
    delete refJobs.current.loc[locationId]; delete refJobs.current.extra[locationId]
    for (const id of ids) { try { await fetch(`/api/ai/jobs/${id}/cancel`, { method: 'POST' }) } catch {} }
    // Wait (bounded) until every canceled job is terminal so the spinner never outlives the job.
    const deadline = Date.now() + 4 * 60_000
    const pending = new Set(ids)
    while (pending.size && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500))
      for (const id of Array.from(pending)) {
        try {
          const r = await fetch(`/api/jobs/${id}`, { cache: 'no-store' })
          if (r.status === 404) { pending.delete(id); continue }
          const d: JobPollResponse = await r.json()
          const st = d?.job?.status
          if (!st || st === 'canceled' || st === 'failed' || st === 'completed') pending.delete(id)
        } catch {}
      }
    }
    setLocCancelling((p) => { const n = { ...p }; delete n[locationId]; return n })
    setLocActive((p) => { const n = new Set(p); n.delete(locationId); return n })
    if (refScopeRef.current === 'locations') { setRefSession(false); refJobs.current = { loc: {}, extra: {} } }
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

  const reviseScene = async (scene: Scene) => {
    const instruction = sceneEdit[scene.id]?.trim(); if (!instruction) return
    setSceneBusy((b) => ({ ...b, [scene.id]: true })); setError(null)
    try {
      const res = await fetch(`/api/ai/scenes/${scene.id}/revise`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction }) })
      const data = await res.json(); if (!res.ok) throw new Error(data?.error ?? 'Не удалось изменить сцену')
      patchScene(scene.id, data.scene); setSceneEdit((t) => ({ ...t, [scene.id]: '' })); setRegenAsk(scene.id)
    } catch (e: any) { setError(e?.message ?? 'Ошибка') } finally { setSceneBusy((b) => { const n = { ...b }; delete n[scene.id]; return n }) }
  }

  // Single-scene background generation (POST /api/ai/generate-video → runVideoJob).
  // Stage 33: Seedance 2.5 is the only video model — no `provider` is sent; the route resolves it.
  const generateScene = async (sceneId: string, _withModel: boolean) => {
    setRegenAsk(null); setActiveGen((p) => ({ ...p, [sceneId]: true })); setError(null)
    setSceneError((prev) => { const n = { ...prev }; delete n[sceneId]; return n })
    setSceneErrorRefs((prev) => { const n = { ...prev }; delete n[sceneId]; return n })
    try {
      const body: Record<string, unknown> = { projectId: project.id, sceneId }
      const res = await postJobStart('/api/ai/generate-video', body)
      const data = await res.json(); if (!res.ok) throw new Error(data?.error ?? 'Не удалось запустить генерацию')
      patchScene(sceneId, { status: 'generating' }); pollVideoJob(sceneId, data.jobId); void refreshCredits()
    } catch (e: any) { clearGen(sceneId); setError(e?.message ?? 'Ошибка') }
  }
  const regenScene = (sceneId: string) => generateScene(sceneId, false)

  // «Отменить генерацию» (confirmed): flag the running video job; the worker cancels the provider
  // prediction at its next check, refunds the credits and marks the job «canceled» — the poller then
  // clears the spinner. If the job is unknown/finished the card is unlocked immediately.
  const cancelSceneGen = async (sceneId: string) => {
    setCancelAsk(null)
    const jobId = videoJobs[sceneId]?.id
    if (!jobId) { stopPolling(sceneId); clearGen(sceneId); return }
    setCancelling((p) => ({ ...p, [sceneId]: true }))
    try {
      const res = await fetch(`/api/ai/jobs/${jobId}/cancel`, { method: 'POST' })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error ?? 'Не удалось отменить генерацию')
      if (data?.result === 'already-finished' || data?.result === 'not-found') {
        // Nothing left to cancel — unlock the card right away.
        stopPolling(sceneId); clearGen(sceneId)
        setCancelling((p) => { const n = { ...p }; delete n[sceneId]; return n })
        setVideoJobs((prev) => { const n = { ...prev }; delete n[sceneId]; return n })
        if (data?.result === 'not-found') patchScene(sceneId, { status: 'pending' })
        void refreshCredits()
      }
      // Otherwise keep polling: the job turns «canceled» within one worker tick and the poller cleans up.
    } catch (e: any) {
      setCancelling((p) => { const n = { ...p }; delete n[sceneId]; return n })
      setError(e?.message ?? 'Ошибка')
    }
  }

  // Stage 39 — «Сгенерировать все сцены»: POST /api/ai/episodes/[id]/generate-all starts EVERY pending /
  // failed scene at once (server-side fan-out); the client polls all returned jobs simultaneously so each
  // card shows its own progress / error. `genAllAsk` holds the cost estimate for the confirmation box.
  const [genAllAsk, setGenAllAsk] = useState<{ pendingCount: number; total: number; costPerScene: number; credits: number } | null>(null)
  const [genAllStarting, setGenAllStarting] = useState(false)
  const generatingCount = Object.values(activeGen).filter(Boolean).length
  // Stage 46A — the «По цепочке» switch is gone from the UI; the episode always runs in the default
  // (parallel) mode. The server-side chain run path is kept intact and still reported here if active.
  const [chainRunActive, setChainRunActive] = useState<boolean>(!!initial.chainRunActive)
  const [chainRunNote, setChainRunNote] = useState<string | null>(initial.chainRunNote ?? null)
  // Stage 47 — per-episode video model: Seedance 2.5 (default) | Kling 3.0. Saved immediately; the
  // worker reads it at job start, so the switch is locked while any scene is generating.
  const [videoProvider, setVideoProvider] = useState<VideoProvider>(normalizeVideoProvider(initial.videoProvider))
  const [providerSaving, setProviderSaving] = useState(false)
  const changeVideoProvider = useCallback(async (next: VideoProvider) => {
    if (next === videoProvider || providerSaving) return
    setProviderSaving(true); setError(null)
    const prev = videoProvider
    setVideoProvider(next)
    try {
      const res = await fetch(`/api/ai/episodes/${episode.id}/video-provider`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoProvider: next }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Не удалось сохранить модель видео')
      setVideoProvider(normalizeVideoProvider(data.videoProvider))
      setEpisode((e: any) => ({ ...e, videoProvider: normalizeVideoProvider(data.videoProvider) }))
    } catch (e: any) {
      setVideoProvider(prev)
      setError(e.message || 'Не удалось сохранить модель видео')
    } finally {
      setProviderSaving(false)
    }
  }, [videoProvider, providerSaving, episode.id])
  // While a chain run is active the server starts the next scene itself (after the previous one is
  // published) — pick up every newly started job so its card shows progress, and read the run status.
  useEffect(() => {
    if (!chainRunActive) return
    let stopped = false
    const tick = async () => {
      try {
        const [jr, sr] = await Promise.all([
          fetch(`/api/jobs?projectId=${project.id}&type=video&active=1`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
          fetch(`/api/ai/episodes/${episode.id}/generate-all`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
        ])
        if (stopped) return
        const ids = new Set(scenes.map((s) => s.id))
        for (const j of jr?.jobs ?? []) if (j?.sceneId && ids.has(j.sceneId) && !pollTimers.current[j.sceneId]) { setActiveGen((p) => ({ ...p, [j.sceneId]: true })); setVideoJobs((p) => ({ ...p, [j.sceneId]: j })); patchScene(j.sceneId, { status: 'generating' }); pollVideoJob(j.sceneId, j.id) }
        if (sr && typeof sr.chainRunActive === 'boolean') {
          setChainRunNote(sr.chainRunNote ?? null)
          if (!sr.chainRunActive && !(jr?.jobs ?? []).some((j: any) => j?.sceneId && ids.has(j.sceneId))) { setChainRunActive(false); void refreshCredits() }
        }
      } catch {}
    }
    const t = setInterval(tick, 6000)
    return () => { stopped = true; clearInterval(t) }
  }, [chainRunActive]) // eslint-disable-line react-hooks/exhaustive-deps
  const openGenerateAll = async () => {
    setError(null); setGenAllStarting(true)
    try {
      const res = await fetch(`/api/ai/episodes/${episode.id}/generate-all`, { cache: 'no-store' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d?.error ?? 'Не удалось получить оценку стоимости')
      if (!d.pendingCount) { setError('Все сцены уже готовы или генерируются'); return }
      setGenAllAsk({ pendingCount: d.pendingCount, total: d.total ?? 0, costPerScene: d.costPerScene ?? 0, credits: d.credits ?? credits })
    } catch (e: any) { setError(e?.message ?? 'Ошибка') }
    finally { setGenAllStarting(false) }
  }
  const generateAllScenes = async () => {
    setGenAllAsk(null); setGenAllStarting(true); setError(null)
    try {
      const res = await postJobStart(`/api/ai/episodes/${episode.id}/generate-all`, {})
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !Array.isArray(d?.jobs)) throw new Error(d?.error ?? 'Не удалось запустить генерацию')
      if (d.chain) { setChainRunActive(true); setChainRunNote(null) }
      for (const j of d.jobs as Array<{ sceneId: string; jobId: string }>) {
        setActiveGen((p) => ({ ...p, [j.sceneId]: true }))
        setSceneError((prev) => { const n = { ...prev }; delete n[j.sceneId]; return n })
        setSceneErrorRefs((prev) => { const n = { ...prev }; delete n[j.sceneId]; return n })
        patchScene(j.sceneId, { status: 'generating' })
        pollVideoJob(j.sceneId, j.jobId)
      }
      // Scenes the balance could not cover are reported per card as «Недостаточно кредитов».
      for (const u of (d.insufficient ?? []) as Array<{ sceneId: string; error?: string }>) {
        setSceneError((prev) => ({ ...prev, [u.sceneId]: u.error ?? 'Недостаточно кредитов' }))
      }
      if (typeof d?.creditsRemaining === 'number') setCredits(d.creditsRemaining); else void refreshCredits()
    } catch (e: any) { setError(e?.message ?? 'Ошибка') }
    finally { setGenAllStarting(false) }
  }

  // Stage 31 — open the "Смотреть промпт" modal and load the scene's FINAL prompt (override if set,
  // else the auto-assembled prompt). The prompt is exactly what the worker submits (with [ImageN]
  // placeholders instead of real reference URLs and no LLM translation).
  const openPromptModal = async (scene: Scene) => {
    setPromptModal({ sceneId: scene.id, number: scene.number })
    setPromptText(''); setPromptErr(null); setPromptHasOverride(false)
    setPromptCopied(false); setPromptSaved(false); setPromptLoading(true)
    setPromptRefKind(null)
    try {
      const res = await fetch(`/api/ai/scenes/${scene.id}/prompt`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'Не удалось загрузить промпт')
      setPromptText(String(data.prompt ?? ''))
      setPromptHasOverride(!!data.hasOverride)
      setPromptRefKind(typeof data.referenceKind === 'string' ? data.referenceKind : null)
    } catch (e: any) {
      setPromptErr(e?.message ?? 'Не удалось загрузить промпт')
    } finally {
      setPromptLoading(false)
    }
  }

  // Copy the current textarea contents (so a hand-edited prompt is copied as shown) and flash «Скопировано».
  const copyPromptModal = async () => {
    try {
      await navigator.clipboard.writeText(promptText)
      setPromptCopied(true)
      setTimeout(() => setPromptCopied(false), 2000)
    } catch { setPromptErr('Не удалось скопировать') }
  }


  // Save the textarea as a manual override (reset=false), or reset to the auto prompt (reset=true).
  // The override persists until changed and is used verbatim on the next generation(s) of the scene.
  const savePromptOverride = async (reset = false) => {
    if (!promptModal) return
    const sceneId = promptModal.sceneId
    setPromptSaving(true); setPromptErr(null); setPromptSaved(false)
    try {
      const res = await fetch(`/api/ai/scenes/${sceneId}/prompt`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: reset ? '' : promptText }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'Не удалось сохранить')
      setPromptHasOverride(!!data.hasOverride)
      // Stage 36: the server normalizes the override (fences / preamble stripped) — reflect what was actually saved.
      const savedPrompt: string | null = reset ? null : (typeof data.prompt === 'string' && data.prompt.trim() ? data.prompt : null)
      if (!reset && savedPrompt) setPromptText(savedPrompt)
      // Reflect the override flag on the scene card without an extra fetch.
      setScenes((list) => list.map((s) => (s.id === sceneId ? { ...s, promptOverride: savedPrompt } : s)))
      if (reset) {
        // Reload the freshly-auto-assembled prompt into the textarea.
        const g = await fetch(`/api/ai/scenes/${sceneId}/prompt`)
        const gd = await g.json().catch(() => ({}))
        if (g.ok) { setPromptText(String(gd.prompt ?? '')); setPromptHasOverride(!!gd.hasOverride) }
      } else {
        // Stage 35: a successful manual save closes the modal right away (the card badge reflects it).
        setPromptSaved(false)
        setPromptModal(null)
      }
    } catch (e: any) {
      setPromptErr(e?.message ?? 'Не удалось сохранить')
    } finally {
      setPromptSaving(false)
    }
  }

  const allReady = scenes.length > 0 && scenes.every((s) => validUrl(s.videoUrl) && !activeGen[s.id])

  // «Собрать» — pure concatenation of the ready scene clips into a single episode video.
  // No audit, no polish, no re-generation: just stitches the existing clips together and
  // stores the result on the episode. The button is enabled only when every scene is ready.
  // Stage 46B: the POST returns a jobId; progress comes from GET /api/jobs/[id].
  const stitch = async () => {
    setAssembleDialogOpen(false)
    setStitching(true); setError(null); setAssembleNote(null)
    try {
      const res = await fetch('/api/ai/assemble-episode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ episodeId: episode.id, quality: assembleQuality, fps: assembleFps }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Не удалось собрать эпизод')
      if (!data?.jobId) throw new Error('Сборка не запустилась')
      stitchJob.start(data.jobId)
    } catch (e: any) { setError(e?.message ?? 'Ошибка'); setStitching(false) }
  }

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
                <Loader2 className="h-4 w-4 animate-spin text-primary" /> {refScope === 'locations' ? <>Генерирую локацию: {refsLocsDone}/{refLocs.length}</> : <>Генерирую персонажей: {refsCharsDone}/{refChars.length}</>}
                <CancelButton onCancel={cancelRefs} testId="refs-cancel" label="Отменить" pendingLabel="Останавливаю…" />
              </span>
            ) : (
              <span className="inline-flex flex-wrap items-center gap-2">
                {refsReady && <span className="text-xs font-medium text-emerald-500" data-testid="refs-status">Все референсы готовы</span>}
                {!refsCharsReady && (
                  <button onClick={() => setRefModalOpen(true)} disabled={refStarting} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="generate-all-refs" title="Сгенерировать фото всех персонажей эпизода (локации — отдельно, на карточке локации)">
                    {refStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Сгенерировать персонажей
                  </button>
                )}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Персонажи (несколько ракурсов) генерируются кнопкой «Сгенерировать персонажей». Локации — отдельно: один мастер-кадр по кнопке на карточке, дополнительные ракурсы — по «+». Все изображения с меткой C2PA. Нажмите на любой кадр, чтобы открыть на весь экран.</p>

          {/* Characters */}
          <h3 className="mt-4 flex items-center gap-2 text-sm font-semibold"><Users className="h-4 w-4" /> Персонажи ({refChars.length})</h3>
          <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {refChars.map((c) => {
              const busy = !!charBusy[c.id] || (refSession && refScope === 'characters' && !hasAllImages(c))
              // Stage 56: render ONLY the character's actual reference photos (usually one full-body imageFull),
              // with no padded empty placeholder slots. Each slot keeps its true url->shot mapping so
              // per-shot regen/download target the right image; the 9:16 photo is shown object-contain (no crop).
              const slots = characterPhotoSlots(c)
              const photos = slots.map((s) => s.url)
              return (
                <div key={c.id} className="rounded-lg border border-border/60 p-3" data-testid="ref-character">
                  {slots.length > 0 ? (
                    <div className={slots.length > 1 ? 'grid grid-cols-2 gap-2' : ''}>
                      {slots.map((s, i) => (
                        <button key={`${s.shot}-${s.idx ?? 0}`} type="button" onClick={() => openLightbox(photos, i, `${c.name} — ${s.label}`)} className={`group relative aspect-[9/16] overflow-hidden rounded bg-muted ${slots.length === 1 ? 'mx-auto w-full max-w-[13rem]' : ''}`} title={s.label} data-testid="ref-image">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={s.url} alt={`${c.name} — ${s.label}`} className="h-full w-full object-contain" />
                          <span className="absolute right-1 top-1 rounded bg-black/50 p-0.5 opacity-0 transition group-hover:opacity-100"><Maximize2 className="h-3 w-3 text-white" /></span>
                          <FrameToolbar
                            regen={{ testId: `regen-shot-${s.shot}${s.idx !== undefined ? `-${s.idx}` : ''}`, busy, spinning: shotIsBusy(c.id, s.shot, s.idx), onClick: () => regenShot('character', c.id, s.shot, s.idx) }}
                            download={{ url: s.url, name: referenceFileName('character', c.name, s.shot, s.url, s.idx) }}
                          />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="mx-auto flex aspect-[9/16] w-full max-w-[13rem] items-center justify-center rounded bg-muted" data-testid="ref-image">
                      {busy ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : <ImageOff className="h-4 w-4 text-muted-foreground/40" />}
                    </div>
                  )}
                  <div className="mt-2 truncate text-sm font-medium">{c.name} <span className="font-normal text-muted-foreground">· {photos.length} фото</span></div>
                  {c.role && <div className="truncate text-xs text-muted-foreground">{c.role}</div>}
                      {/* Stage 46E: prompt view/edit + download all */}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <button type="button" onClick={() => setPromptFor({ kind: 'character', id: c.id, name: c.name })} className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs" data-testid="character-prompt" title="Посмотреть, скопировать или изменить промпт персонажа">
                          <FileText className="h-3.5 w-3.5" /> Промпт
                        </button>
                        <DownloadAllButton kind="character" id={c.id} count={photos.length} />
                        <button type="button" disabled={busy || !!charResetting[c.id]} onClick={() => resetCharacterPrompt(c.id)} className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50" data-testid="char-prompt-reset" title="Убрать ручной промпт и вернуть автоматический">
                            {charResetting[c.id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Сбросить промпт на авто
                          </button>
                        {!!(c.promptOverride && String(c.promptOverride).trim()) && <span className="rounded bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary" data-testid="character-prompt-override">Промпт изменён вручную</span>}
                      </div>
                      <div className="mt-2 flex flex-col gap-1.5 sm:flex-row">
                        <input value={charEdit[c.id] ?? ''} onChange={(e) => setCharEdit((t) => ({ ...t, [c.id]: e.target.value }))} placeholder="Изменить по промпту…" className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-xs" data-testid="ref-character-input" disabled={busy} />
                        <button onClick={() => reviseCharacter(c.id)} disabled={busy || !(charEdit[c.id] ?? '').trim()} className="inline-flex items-center justify-center gap-1 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50" data-testid="ref-character-submit" title="Изменить по промпту">
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
              const detail = locationDetailLevel(l)
              const base = [{ url: l.imageUrl, label: 'Общий план', slot: 'master' }, { url: l.imageReverse, label: 'Обратный ракурс', slot: 'reverse' }, { url: l.imageDetail, label: 'Средний план', slot: 'detail' }].filter((a) => validUrl(a.url))
              const extras = parseExtra(l.imageExtra)
              // This location has a running master-frame / extra-angle job (server truth; before the first tick — the job we just started).
              const locGen = refSession && !locCanceled.current.has(l.id) && (locActive.has(l.id) || (!tickSeen && (!!refJobs.current.loc[l.id] || !!refJobs.current.extra[l.id])))
              const cancelling = !!locCancelling[l.id]
              const busy = !!locBusy[l.id] || locGen || cancelling
              return (
                <div key={l.id} className="rounded-lg border border-border/60 p-3" data-testid="ref-location">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 truncate text-sm font-medium">{l.name} <span className="font-normal text-muted-foreground">· {locationFrames(l)} {locationFrames(l) === 1 ? 'кадр' : 'кадров'}</span></div>
                    <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground" title="Рекомендуемое число кадров зависит от требуемой детализации локации; добавляйте ракурсы по «+» при необходимости" data-testid="location-detail-badge">детализация: {locationDetailLabel(detail)} · рекомендуется {desiredTotalFrames(l)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(() => { const all = [...base.map((a) => ({ url: a.url as string, label: a.label, slot: a.slot, idx: undefined as number | undefined })), ...extras.map((u, i) => ({ url: u, label: `${i + 1}. ${locationExtraLabel(i)}`, slot: 'extra', idx: i }))]; const urls = all.map((a) => a.url); return base.length > 0 ? all.map((a, i) => (
                      <button key={a.url + i} type="button" onClick={() => openLightbox(urls, i, `${l.name} — ${a.label}`)} className="group relative h-40 w-24 overflow-hidden rounded bg-muted" title={a.label} data-testid="ref-image">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={a.url} alt={`${l.name} — ${a.label}`} className="h-full w-full object-cover" />
                        <span className="absolute right-0.5 top-0.5 rounded bg-black/50 p-0.5 opacity-0 transition group-hover:opacity-100"><Maximize2 className="h-3 w-3 text-white" /></span>
                        <FrameToolbar
                          regen={{ testId: `regen-shot-${a.slot}${a.idx !== undefined ? `-${a.idx}` : ''}`, busy, spinning: shotIsBusy(l.id, a.slot, a.idx), onClick: () => regenShot('location', l.id, a.slot, a.idx) }}
                          download={{ url: a.url, name: referenceFileName('location', l.name, a.slot, a.url, a.idx) }}
                          del={{ testId: `delete-shot-${a.slot}${a.idx !== undefined ? `-${a.idx}` : ''}`, onClick: () => deleteFrame(l.id, a.slot, a.idx), disabled: busy || all.length <= 1, disabledTitle: all.length <= 1 ? 'Минимум один кадр' : 'Дождитесь окончания генерации' }}
                        />
                      </button>
                    )) : busy ? (
                      <div className="flex h-40 w-24 items-center justify-center rounded bg-muted"><Loader2 className="h-4 w-4 animate-spin text-primary" /></div>
                    ) : (
                      <div className="flex h-40 w-24 items-center justify-center rounded bg-muted"><ImageOff className="h-4 w-4 text-muted-foreground/40" /></div>
                    ) })()}
                  </div>
                  {/* Stage 46E: prompt tools + download all */}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="location-prompt-tools">
                    <button type="button" onClick={() => setPromptFor({ kind: 'location', id: l.id, name: l.name })} className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs" data-testid="location-prompt" title="Посмотреть, скопировать или изменить визуальный промпт локации">
                      <FileText className="h-3.5 w-3.5" /> Промпт
                    </button>
                    <button
                      type="button"
                      disabled={busy || !!locResetting[l.id]}
                      onClick={async () => { setLocResetting((m) => ({ ...m, [l.id]: true })); try { await resetLocationPrompt(l.id) } finally { setLocResetting((m) => { const n = { ...m }; delete n[l.id]; return n }) } }}
                      className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50"
                      data-testid="location-prompt-reset"
                      title="Вернуть первоначальный промпт локации, написанный ИИ"
                    >
                      {locResetting[l.id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Сбросить промпт на авто
                    </button>
                    <DownloadAllButton kind="location" id={l.id} count={locationFrames(l)} />
                    {locHasPromptOverride(l) && <span className="rounded bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary" data-testid="location-prompt-override">Промпт изменён вручную</span>}
                  </div>
                      {locGen || cancelling ? (
                        /* While THIS location is generating the button becomes «Отменить генерацию» (confirmed below),
                           mirroring the scene-video cancel. */
                        <button
                          onClick={() => setLocCancelAsk(l.id)}
                          disabled={cancelling || locCancelAsk === l.id}
                          className="mt-2 inline-flex w-full items-center justify-center gap-1 rounded-lg border border-destructive/50 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                          data-testid="ref-location-cancel"
                          title="Остановить генерацию этой локации"
                        >
                          {cancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                          {cancelling ? 'Останавливаю...' : 'Отменить генерацию'}
                        </button>
                      ) : (
                        /* Stage 46A: «Сгенерировать» makes exactly ONE master frame of THIS location; «+ Ракурс» adds one angle. */
                        <div className="mt-2 flex gap-1.5">
                          <button
                            onClick={() => generateLocationRefs(l.id)}
                            disabled={busy || refSession || refStarting}
                            className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
                            data-testid="ref-location-generate"
                            title={locBaseReady(l) ? 'Снять новый мастер-кадр локации (старые ракурсы будут сброшены)' : 'Сгенерировать один мастер-кадр этой локации'}
                          >
                            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : locBaseReady(l) ? <RefreshCw className="h-3.5 w-3.5" /> : <Wand2 className="h-3.5 w-3.5" />}
                            {busy ? 'Генерирую...' : `${locBaseReady(l) ? 'Перегенерировать' : 'Сгенерировать'} мастер-кадр (${CHARACTER_REFERENCE_COST} кр.)`}
                          </button>
                          {locBaseReady(l) && (
                            <button
                              onClick={() => addLocationAngle(l.id)}
                              disabled={busy || refSession || refStarting}
                              className="inline-flex items-center justify-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium disabled:opacity-50"
                              data-testid="ref-location-add-angle"
                              title={`Добавить ещё один ракурс этой локации (${CHARACTER_REFERENCE_COST} кр.)`}
                            >
                              <Plus className="h-3.5 w-3.5" /> Ракурс
                            </button>
                          )}
                        </div>
                      )}
                      {locCancelAsk === l.id && locGen && (
                        <div className="mt-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs" data-testid="ref-location-cancel-confirm">
                          Остановить генерацию этой локации? Кредиты за несделанные кадры вернутся.
                          <div className="mt-1.5 flex gap-1.5">
                            <button onClick={() => cancelLocationGen(l.id)} className="inline-flex items-center gap-1 rounded-lg bg-destructive px-2 py-1 text-destructive-foreground" data-testid="ref-location-cancel-ok"><X className="h-3.5 w-3.5" /> Да, отменить</button>
                            <button onClick={() => setLocCancelAsk(null)} className="rounded-lg border border-border px-2 py-1" data-testid="ref-location-cancel-keep">Продолжить генерацию</button>
                          </div>
                        </div>
                      )}
                      <div className="mt-2 flex flex-col gap-1.5 sm:flex-row">
                        <input value={locEdit[l.id] ?? ''} onChange={(e) => setLocEdit((t) => ({ ...t, [l.id]: e.target.value }))} placeholder="Изменить локацию по промпту…" className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-xs" data-testid="ref-location-input" disabled={busy} />
                        <button onClick={() => reviseLocation(l.id)} disabled={busy || !(locEdit[l.id] ?? '').trim()} className="inline-flex items-center justify-center gap-1 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50" data-testid="ref-location-submit" title="Изменить по промпту">
                          {locBusy[l.id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                        </button>
                      </div>
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

        {/* Step 3 — scenes: per-scene generation + «Сгенерировать все сцены» (parallel, Stage 39) + собрать */}
        {phase === 'scenes' && (
        <>
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
          <button onClick={() => goPhase('script')} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted" data-testid="back-to-script">
            <ArrowLeft className="h-4 w-4" /> Сценарий
          </button>
          {/* Stage 39 — «Сгенерировать все сцены»: every pending / failed scene is started at once (parallel). */}
          {!allReady && (
            <button onClick={openGenerateAll} disabled={genAllStarting || genAllAsk !== null || chainRunActive} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="generate-all-scenes" title="Запустить генерацию всех ещё не готовых сцен одновременно">
              {genAllStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Сгенерировать все сцены
            </button>
          )}
          <button onClick={() => setAssembleDialogOpen(true)} disabled={!allReady || stitching} className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50" data-testid="assemble" title={allReady ? 'Склеить готовые сцены в один эпизод' : 'Доступно, когда все сцены готовы'}>
            {stitching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />} Собрать
          </button>
          <span className="text-xs text-muted-foreground" data-testid="batch-status">{scenes.filter((s) => validUrl(s.videoUrl)).length} из {scenes.length} сцен готово{generatingCount > 0 ? ` · генерируется: ${generatingCount}` : ''}{isAssembled ? ' · эпизод собран' : ''}</span>
          {chainRunActive && <span className="inline-flex items-center gap-1 text-xs text-primary" data-testid="chain-run-active"><Loader2 className="h-3 w-3 animate-spin" /> Цепочка идёт: сцены генерируются по очереди</span>}
          {/* Stage 47 — video model switch (always visible, labelled buttons). */}
          <div className="flex w-full flex-wrap items-center gap-2" data-testid="video-provider-switch">
            <span className="text-sm font-medium">Модель видео:</span>
            <div className="inline-flex overflow-hidden rounded-lg border border-border">
              {VIDEO_PROVIDERS.map((p) => (
                <button key={p} type="button" onClick={() => changeVideoProvider(p)} disabled={providerSaving || generatingCount > 0 || chainRunActive}
                  className={`px-3 py-2 text-sm font-medium disabled:opacity-50 ${videoProvider === p ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'}`}
                  data-testid={`video-provider-${p}`} data-active={videoProvider === p ? 'true' : 'false'} aria-pressed={videoProvider === p}>
                  {VIDEO_PROVIDER_LABEL[p]}
                </button>
              ))}
            </div>
            {providerSaving && <Loader2 className="h-4 w-4 animate-spin text-primary" data-testid="video-provider-saving" />}
            <span className="text-xs text-muted-foreground">
              {generatingCount > 0 || chainRunActive ? 'Смена модели доступна после завершения генерации' : videoProvider === 'kling' ? 'Kling 3.0: 720p, клип 3–15 с, до 7 референсов' : 'Seedance 2.5: по умолчанию, клип до 30 с'}
            </span>
          </div>
          <p className="w-full text-xs text-muted-foreground" data-testid="scenes-hint">
            Все сцены стартуют сразу, стыковка между сценами — по сценарному описанию финального кадра предыдущей сцены («Финал кадра»). <b>Сгенерировать все сцены:</b> запускает все ещё не готовые сцены сразу (кредиты списываются за каждую сцену).{' '}
            <b>Собрать:</b> склеивает готовые ролики всех сцен в один эпизод без перегенерации — доступно, когда все сцены готовы. Качество серии (480p/720p/1080p, 30/60 кадров/с) и фоновая музыка выбираются при сборке.
          </p>
          {stitching && stitchJob.job && <div className="w-full" data-testid="assemble-progress"><JobProgressBar job={stitchJob.job} expectedTotalSec={180} /></div>}
          {assembleNote && <p className="w-full text-sm text-amber-400" data-testid="assemble-note">{assembleNote}</p>}
          {chainRunNote && !chainRunActive && <p className="w-full text-sm text-destructive" data-testid="chain-run-note">{chainRunNote}</p>}
          {error && <p className="w-full text-sm text-destructive" data-testid="error">{error}</p>}
        </div>

        {/* Assembled episode + go to next */}
        {validUrl(episode.videoUrl) && (
          <div className="mt-4 rounded-xl border border-border bg-card p-4" data-testid="episode-video">
            <h2 className="mb-2 inline-flex items-center gap-1 font-semibold"><Film className="h-4 w-4" /> Собранный эпизод{episode.assembleQuality ? <span className="ml-1 text-xs font-normal text-muted-foreground" data-testid="assembled-settings">· {episode.assembleQuality}{episode.assembleFps ? ` · ${episode.assembleFps} к/с` : ''}</span> : null}</h2>
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
        {/* Stage 45 — running-time budget: the whole episode must stay under 2 minutes. */}
        {(() => {
          const total = episodeTotalSeconds(scenes)
          const over = total > EPISODE_MAX_TOTAL_SECONDS
          const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
          return (
            <div className="mt-8 flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <h2 className="font-display text-xl font-bold">Сцены ({scenes.length})</h2>
              <span className={`text-sm ${over ? 'font-semibold text-destructive' : 'text-muted-foreground'}`} title={over ? 'Эпизод длиннее 2 минут — сократите сцены' : 'Лимит эпизода — 2 минуты'}>
                Общая длительность: {mmss(total)} / {mmss(EPISODE_MAX_TOTAL_SECONDS)}{over ? ' — длиннее 2 минут, сократите сцены' : ''}
              </span>
            </div>
          )
        })()}
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          {scenes.map((scene) => {
            const gen = !!activeGen[scene.id]
            const job = videoJobs[scene.id]
            const ready = validUrl(scene.videoUrl)
            // Stage 39: no sequential gate — any scene can start at any time (scenes are independent);
            // the button is disabled only while THIS scene is generating.
            return (
              <div key={scene.id} className="rounded-xl border border-border bg-card p-4" data-testid="scene-card" data-scene-status={gen ? 'generating' : validUrl(scene.videoUrl) ? 'ready' : 'pending'}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold">Сцена {scene.number}
                      {scene.sceneKind === 'narration' && <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary align-middle" data-testid="narration-badge">Закадровый голос</span>}
                      {scene.sceneKind === 'action' && <span className="ml-2 rounded bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-600 align-middle" data-testid="scene-kind-action">Экшен</span>}
                      <span className="text-xs font-normal text-muted-foreground"> · ~{scene.durationSec ?? 15}с</span>
                      {(validUrl(scene.videoUrl) || gen) && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground align-middle" data-testid="scene-provider-badge">{videoModelBadge(scene.videoModel)}</span>}
                    </div>
                    {scene.lookStale && validUrl(scene.videoUrl) && (
                      <div className="mt-1 inline-flex items-center rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-700" data-testid="scene-look-stale">Облик персонажа изменён — перегенерируйте</div>
                    )}
                  </div>
                  <div className="flex -space-x-1">{scene.characters?.map(({ character: c }) => validUrl(c.imageFront) ? <img key={c.id} src={c.imageFront as string} alt={c.name} title={c.name} className="h-6 w-6 rounded-full border border-background object-cover" /> : null)}</div>
                </div>

                {/* Stage 34: the 9:16 preview is centered horizontally inside the card (height-driven width). */}
                <div className="mt-3 flex justify-center">
                <div className="aspect-[9/16] h-[420px] max-h-[420px] max-w-full overflow-hidden rounded-lg bg-black/80" data-testid="scene-preview">
                  {gen ? (
                    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center" data-testid="scene-spinner">
                      <Loader2 className="h-8 w-8 animate-spin text-primary" />
                      <div className="text-xs text-muted-foreground">{job?.message ?? 'В очереди…'}</div>
                      {job?.result?.providerNote && <div className="text-[11px] text-amber-500" data-testid="kling-duration-note">{job.result.providerNote}</div>}
                      {job && <JobProgressBar job={job} expectedTotalSec={VIDEO_EXPECTED_SEC} className="w-full" />}
                    </div>
                  ) : validUrl(scene.videoUrl) ? (
                    <SceneVideoPlayer videoUrl={scene.videoUrl as string} poster={scene.lastFrameUrl} className="h-full w-full object-contain" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Видео ещё не сгенерировано</div>
                  )}
                </div>
                </div>

                {sceneError[scene.id] && (
                  <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    <p data-testid="scene-error">{sceneError[scene.id]}</p>
                    {/* Stage 36 — thumbnails of the reference images that were actually submitted with the failed job. */}
                    {(sceneErrorRefs[scene.id]?.length ?? 0) > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5" data-testid="scene-error-refs">
                        {sceneErrorRefs[scene.id].map((r, i) => (
                          <img key={`${r.url}-${i}`} src={r.url} alt={referenceKindLabel(r.kind)} title={`${i + 1}. ${referenceKindLabel(r.kind)}`} className="h-12 w-auto rounded object-cover" />
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="mt-3 space-y-2">
                  {/* Stage 35 — one row, two half-width buttons under the preview: the primary action
                      (generate / regenerate — Stage 39: no sequential gate) and «Смотреть промпт». */}
                  <div className="grid grid-cols-2 gap-2">
                    {gen ? (
                      /* While THIS scene is generating the primary button becomes «Отменить генерацию»
                         (confirmed in the box below). */
                      <button
                        onClick={() => setCancelAsk(scene.id)}
                        disabled={cancelAsk === scene.id || !!cancelling[scene.id]}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-destructive/50 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                        data-testid="scene-cancel-gen"
                        title="Остановить генерацию этой сцены"
                      >
                        {cancelling[scene.id] ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} {cancelling[scene.id] ? 'Останавливаю...' : 'Отменить генерацию'}
                      </button>
                    ) : !ready ? (
                      <button
                        onClick={() => generateScene(scene.id, true)}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                        data-testid="scene-generate"
                        title="Сгенерировать эту сцену"
                      >
                        <Wand2 className="h-4 w-4" /> Сгенерировать сцену
                      </button>
                    ) : (
                      <button
                        onClick={() => setRegenAsk(scene.id)}
                        disabled={regenAsk === scene.id}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
                        data-testid="scene-regenerate"
                      >
                        <RefreshCw className="h-4 w-4" /> Перегенерировать
                      </button>
                    )}
                    <button
                      onClick={() => openPromptModal(scene)}
                      disabled={!scene.videoPrompt}
                      className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
                      data-testid="scene-view-prompt"
                      title="Посмотреть, скопировать или изменить полный промпт"
                    >
                      <FileText className="h-4 w-4 shrink-0" />
                      Смотреть промпт
                      {scene.promptOverride ? <span className="ml-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary" data-testid="scene-override-badge">изменён</span> : null}
                    </button>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input value={sceneEdit[scene.id] ?? ''} onChange={(e) => setSceneEdit((t) => ({ ...t, [scene.id]: e.target.value }))} placeholder="Изменить сцену: что поправить…" className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm" data-testid="scene-revise-input" disabled={gen} />
                    <button onClick={() => reviseScene(scene)} disabled={gen || !!sceneBusy[scene.id] || !(sceneEdit[scene.id] ?? '').trim()} className="inline-flex items-center justify-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50" data-testid="scene-revise-submit">
                      {sceneBusy[scene.id] ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Изменить
                    </button>
                  </div>
                  {cancelAsk === scene.id && gen && (
                    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm" data-testid="cancel-confirm">
                      Остановить генерацию этой сцены? Списанные кредиты вернутся.
                      <div className="mt-2 flex gap-2">
                        <button onClick={() => cancelSceneGen(scene.id)} className="inline-flex items-center gap-1 rounded-lg bg-destructive px-3 py-1.5 text-destructive-foreground" data-testid="cancel-ok"><X className="h-4 w-4" /> Да, отменить</button>
                        <button onClick={() => setCancelAsk(null)} className="rounded-lg border border-border px-3 py-1.5" data-testid="cancel-keep">Продолжить генерацию</button>
                      </div>
                    </div>
                  )}
                  {regenAsk === scene.id && (
                    <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm" data-testid="regen-confirm">
                      Сцена переписана. Перегенерировать ролик?
                      <div className="mt-2 flex gap-2">
                        <button onClick={() => regenScene(scene.id)} disabled={gen} className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50" data-testid="regen-ok">{gen ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Перегенерировать</button>
                        <button onClick={() => setRegenAsk(null)} className="rounded-lg border border-border px-3 py-1.5">Позже</button>
                      </div>
                    </div>
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

      {/* Stage 39 — confirmation before starting every pending scene at once. */}
      {genAllAsk && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid="generate-all-modal">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5">
            <h3 className="font-display text-lg font-bold">Сгенерировать все сцены</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Будет запущено сразу <b>{genAllAsk.pendingCount}</b> сцен параллельно — примерно <b>{genAllAsk.total}</b> кр. ({genAllAsk.costPerScene} кр. за сцену). На балансе: {genAllAsk.credits} кр.
              {genAllAsk.credits < genAllAsk.total && <span className="mt-1 block text-destructive">Кредитов хватит не на все сцены: запустятся только те, которые можно оплатить, остальные будут отмечены «Недостаточно кредитов».</span>}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setGenAllAsk(null)} className="rounded-lg border border-border px-3 py-1.5 text-sm">Отмена</button>
              <button onClick={generateAllScenes} className="inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50" data-testid="generate-all-ok">
                <Wand2 className="h-4 w-4" /> Запустить
              </button>
            </div>
          </div>
        </div>
      )}

      {/* EDIT 1 — AI image model picker shown before generating all references. */}
      {refModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid="ref-model-modal">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5">
            <h3 className="font-display text-lg font-bold">Выберите модель ИИ</h3>
            <p className="mt-1 text-sm text-muted-foreground">Модель, которой будут сгенерированы все референсы персонажей и локаций эпизода.</p>
            <label className="mt-4 block text-sm font-medium" htmlFor="image-model-select">Модель ИИ (изображения)</label>
            <select
              id="image-model-select"
              data-testid="image-model-select"
              value={imageModel}
              onChange={(e) => setImageModel(e.target.value as ImageModelId)}
              className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            >
              {IMAGE_MODELS.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
            </select>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setRefModalOpen(false)} className="rounded-lg border border-border px-3 py-1.5 text-sm">Отмена</button>
              <button onClick={generateCharacterRefs} className="inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50" data-testid="ref-model-ok">
                <Wand2 className="h-4 w-4" /> Сгенерировать
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stage 46B — «Собрать» dialog: production quality / fps of the final episode file. */}
      {assembleDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid="assemble-dialog">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5">
            <h3 className="font-display text-lg font-bold">Собрать эпизод</h3>
            <p className="mt-1 text-sm text-muted-foreground">Сцены отрендерены в 480p. Здесь выбирается качество готовой серии: масштабируется только собранный файл. 480p / 30 — без перекодирования, быстрее всего.</p>
            <label className="mt-4 block text-sm font-medium" htmlFor="assemble-quality">Качество продакшн-серии</label>
            <select id="assemble-quality" data-testid="assemble-quality" value={assembleQuality} onChange={(e) => setAssembleQuality(e.target.value as AssembleQuality)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
              {ASSEMBLE_QUALITIES.map((q) => (<option key={q} value={q}>{q}</option>))}
            </select>
            <label className="mt-3 block text-sm font-medium" htmlFor="assemble-fps">Частота кадров</label>
            <select id="assemble-fps" data-testid="assemble-fps" value={assembleFps} onChange={(e) => setAssembleFps(Number(e.target.value) as AssembleFps)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
              {ASSEMBLE_FPS.map((f) => (<option key={f} value={f}>{f} кадров/с</option>))}
            </select>
            <p className="mt-3 text-xs text-muted-foreground">Фоновая музыка подбирается по настроению серии автоматически; если музыка недоступна, эпизод собирается без неё.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setAssembleDialogOpen(false)} className="rounded-lg border border-border px-3 py-1.5 text-sm" data-testid="assemble-cancel">Отмена</button>
              <button onClick={stitch} className="inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-1.5 text-sm text-primary-foreground" data-testid="assemble-ok">
                <Film className="h-4 w-4" /> Собрать
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stage 46E — character / location prompt modal (shared component). */}
      {promptFor && (
        <PromptModal
          title={promptFor.kind === 'character' ? `Промпт персонажа · ${promptFor.name}` : `Промпт локации · ${promptFor.name}`}
          description={promptFor.kind === 'character' ? CHARACTER_PROMPT_DESCRIPTION : LOCATION_PROMPT_DESCRIPTION}
          endpoint={`/api/ai/${promptFor.kind === 'character' ? 'characters' : 'locations'}/${promptFor.id}/prompt`}
          resetBody={promptFor.kind === 'character' ? { prompt: '' } : { reset: true }}
          alwaysShowReset={promptFor.kind === 'location'}
          testId={promptFor.kind === 'character' ? 'character-prompt-modal' : 'location-prompt-modal'}
          onClose={() => setPromptFor(null)}
          onChange={({ prompt, hasOverride }) => {
            if (promptFor.kind === 'character') setRefChars((prev) => prev.map((c) => (c.id === promptFor.id ? { ...c, promptOverride: hasOverride ? prompt : null } : c)))
            else setRefLocs((prev) => prev.map((l) => (l.id === promptFor.id ? { ...l, visualPrompt: prompt, visualPromptAuto: hasOverride ? l.visualPromptAuto ?? null : prompt } : l)))
          }}
        />
      )}

      {/* Stage 31 — "Смотреть промпт" modal: view / copy / manually override the scene's final prompt. */}
      {promptModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" data-testid="scene-prompt-modal">
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div>
                <h3 className="flex items-center gap-2 font-display text-lg font-bold"><FileText className="h-5 w-5" /> Полный промпт · Сцена {promptModal.number}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Это точный текст, который отправляется модели. Референсы показаны как <code className="rounded bg-muted px-1">[Image1]…[ImageN]</code>. Можно скопировать, изменить своим ИИ и сохранить — сохранённый текст будет использоваться при следующей генерации сцены (кадровая склейка сохраняется).
                </p>
                {promptHasOverride && (
                  <p className="mt-2 inline-flex items-center gap-1 rounded bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary" data-testid="scene-prompt-override-indicator">Промпт изменён вручную</p>
                )}
              </div>
              <button onClick={() => setPromptModal(null)} className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Закрыть" data-testid="scene-prompt-close"><X className="h-5 w-5" /></button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {promptLoading ? (
                <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Загрузка промпта…</div>
              ) : (
                <>
                  {promptErr && <p className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="scene-prompt-error">{promptErr}</p>}
                  <textarea
                    value={promptText}
                    onChange={(e) => setPromptText(e.target.value)}
                    spellCheck={false}
                    className="h-[45vh] w-full resize-none whitespace-pre-wrap rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs leading-relaxed"
                    data-testid="scene-prompt-text"
                    placeholder="Промпт сцены…"
                  />
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4">
              {promptHasOverride && (
                <button
                  onClick={() => savePromptOverride(true)}
                  disabled={promptSaving || promptLoading}
                  className="mr-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
                  data-testid="scene-reset-prompt"
                >
                  {promptSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Сбросить к авто
                </button>
              )}
              <button
                onClick={copyPromptModal}
                disabled={promptLoading || !promptText}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                data-testid="scene-copy-prompt"
              >
                {promptCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {promptCopied ? 'Скопировано' : 'Копировать'}
              </button>
              <button
                onClick={() => savePromptOverride(false)}
                disabled={promptSaving || promptLoading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
                data-testid="scene-save-prompt"
              >
                {promptSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : promptSaved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />} {promptSaved ? 'Сохранено' : 'Сохранить'}
              </button>
              <button onClick={() => setPromptModal(null)} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted">Закрыть</button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
