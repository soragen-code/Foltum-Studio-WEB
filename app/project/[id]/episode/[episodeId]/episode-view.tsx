'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Header } from '@/components/header'
import { Loader2, Wand2, ArrowLeft, ArrowRight, MapPin, Film, Download, RefreshCw, Images, X, Maximize2, Users, ImageOff, ChevronLeft, ChevronRight, Copy, Check, FileText, RotateCcw, Save, Plus, Undo2 } from 'lucide-react'
import { FrameToolbar, DownloadAllButton } from '@/app/project/[id]/_components/frame-toolbar'
import { PromptModal, CHARACTER_PROMPT_DESCRIPTION, LOCATION_PROMPT_DESCRIPTION } from '@/app/project/[id]/_components/prompt-modal'
import { referenceFileName } from '@/lib/download-name'
import { postJobStart, SceneVideoPlayer } from '../../_components/scenes-stage'
import { BookScript } from '../../_components/season-stage'
import { StickyReviseBar } from '../../_components/sticky-revise-bar'
import { JobProgressBar, SmoothProgress, useJobPolling, type JobInfo, type JobPollResponse, JOB_POLL_INTERVAL_MS } from '../../_components/use-job-polling'
import { RewritePlaceholder } from '../../_components/rewrite-placeholder'
import { isEpisodeRevisePending } from '@/lib/episode-revise-state'
import { SCENE_RESET_CONFIRM_MESSAGE, needsSceneResetConfirm } from '@/lib/scene-reset-confirm'
import { rewriteViewState } from '@/lib/rewrite-view-state'
import { CancelButton } from '../../_components/cancel-button'
import { desiredTotalFrames, locationDetailLevel, locationDetailLabel, episodeLocations } from '@/lib/location-scale'
import { CHARACTER_PHOTO_COUNT } from '@/lib/reference-counts'
import { CHARACTER_REFERENCE_COST, POWER_TIERS, POWER_TIER_CONFIG, DEFAULT_POWER_TIER, legacyTierToPower, isPowerTier, type PowerTier } from '@/lib/power-tier'
import { IMAGE_MODELS, DEFAULT_IMAGE_MODEL, VIDEO_MODEL_LABEL, type ImageModelId } from '@/lib/ai-models'
import { EpisodeNavGrid } from './episode-nav-grid'
import { locationExtraLabel } from '@/lib/visual-style'
import { episodeTotalSeconds, EPISODE_MAX_TOTAL_SECONDS, EPISODE_TOTAL_LABEL } from '@/lib/season'
import { ASSEMBLE_QUALITIES, ASSEMBLE_FPS, DEFAULT_ASSEMBLE_QUALITY, DEFAULT_ASSEMBLE_FPS, type AssembleQuality, type AssembleFps } from '@/lib/assemble-options'

type EpisodePhase = 'script' | 'references' | 'scenes'

const VIDEO_EXPECTED_SEC = 600
// Stage 77: rough duration of a whole-episode script rewrite (drives the smooth 0→100 % bar).
const EPISODE_REVISE_EXPECTED_SEC = 180
const REF_POLL_MS = 3500
// Stage 53: full-body front is the primary photo, shown first; front/profile are optional manual slots.
const SHOT_LABELS = ['Full-body (reference)', 'Portrait (face)', 'Left profile']
// Stage 36 — a reference image the video job actually submitted (job.result.submittedReferences).
type SubmittedReference = { url: string; kind: string }
const REFERENCE_KIND_LABELS: Record<string, string> = {
  character: 'Portrait',
  location: 'Location',
  crowd: 'Extras',
  previous_frame: 'Previous scene frame',
  scene: 'Scene frame',
}
const referenceKindLabel = (kind: string) => REFERENCE_KIND_LABELS[kind] ?? 'Reference'
// Stage 89 — a single "Quality & speed" selector on the episode top panel maps to the power tier
// (lib/power-tier.ts). One control reflects BOTH facets: higher tiers render at a higher resolution
// (quality) and take longer / cost more (speed). No model selector — Seedance 2.5 / Seedream 5.0 are fixed.
const QUALITY_SPEED: Record<PowerTier, { label: string; hint: string }> = {
  LOW: { label: 'Draft · 480p', hint: 'Draft quality — fastest, lowest cost. Best for quick tests and previews.' },
  MEDIUM: { label: 'Standard · 720p', hint: 'Full Seedance 2.5 quality — for the finished series (recommended).' },
  HIGH: { label: 'High · 720p+', hint: '720p with an extended per-scene budget — slower and pricier.' },
}
/** Resolve a project's current power tier id (LOW/MEDIUM/HIGH) for the selector's initial value. */
function initialPowerTier(project: any): PowerTier {
  if (isPowerTier(project?.powerTier)) return project.powerTier
  if (project?.tier) return legacyTierToPower(project.tier)
  return DEFAULT_POWER_TIER
}
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
  parseExtra(c?.imageExtra).forEach((u, i) => out.push({ url: u, shot: 'extra', idx: i, label: `Angle ${i + 1}` }))
  return out
}
const charPhotos = (c: any): string[] => characterPhotoSlots(c).map((s) => s.url)
const hasAllImages = (c: any) => validUrl(c?.imageFull) || validUrl(c?.imageFront)
// Stage 18: total generated frames of a location = present base angles + extra angles (target = 3/6/9 by scale).
const locationFrames = (l: any): number => [l?.imageUrl, l?.imageReverse, l?.imageDetail].filter(validUrl).length + parseExtra(l?.imageExtra).length
// Stage 17: top up location extras in serverless-safe chunks (a single 12-frame job can overrun the
// serverless window and get killed — chunking + re-firing guarantees the target is actually reached).

type Scene = { id: string; number: number; shotType?: string | null; durationSec?: number | null; locationDesc?: string | null; action?: string | null; dialogue?: string | null; sceneKind?: string | null; voiceover?: string | null; voiceoverLocal?: string | null; videoPrompt?: string | null; promptOverride?: string | null; skipReferences?: boolean | null; videoUrl?: string | null; audioUrl?: string | null; lastFrameUrl?: string | null; keyframeUrl?: string | null; keyframePrompt?: string | null; keyframeStatus?: string | null; keyframeError?: string | null; lookStale?: boolean | null; videoModel?: string | null; status: string; hasUndo?: boolean | null; characters: { character: { id: string; name: string; imageFront?: string | null } }[] }
type Sibling = { id: string; number: number; title: string; status?: string | null; videoUrl?: string | null }

export function EpisodeView({ episode: initial, project, siblings = [], credits: initialCredits }: { episode: any; project: any; siblings?: Sibling[]; credits: number }) {
  const [episode, setEpisode] = useState<any>(initial)
  const [scenes, setScenes] = useState<Scene[]>(initial.scenes ?? [])
  const [credits, setCredits] = useState(initialCredits)
  const [error, setError] = useState<string | null>(null)
  const [reviseText, setReviseText] = useState('')
  const [revising, setRevising] = useState(false)
  const [reviseNotice, setReviseNotice] = useState<string | null>(null)
  // Stage 83 — the episode-wide rewrite RESETS all scenes; ask before that destructive step when
  // scenes already exist (per-scene «"Edit"/"Regenerate" stay instant, not gated here).
  const [resetAsk, setResetAsk] = useState(false)
  // Stage 77 — the episode rewrite is a background season_script job; poll it and swap the old
  // script for a placeholder until the job is terminal (see RewritePlaceholder).
  const revisePoll = useJobPolling({
    onFinish: async (res) => {
      const j = res.job
      if (j.status === 'completed') {
        await reloadEpisode()
        setReviseText('')
        setRevising(false)
      } else if (j.status === 'failed') {
        setError(j.error ?? 'Failed to rewrite episode')
        setRevising(false)
      } else if (j.status === 'canceled') {
        setReviseNotice('Change canceled.')
        setRevising(false)
      }
    },
  })
  const [sceneEdit, setSceneEdit] = useState<Record<string, string>>({})
  const [sceneBusy, setSceneBusy] = useState<Record<string, boolean>>({})
  // Stage 104: per-scene keyframe (Seedream opening still) generation — polled until the job is terminal.
  const [kfBusy, setKfBusy] = useState<Record<string, boolean>>({})
  const [cancelAsk, setCancelAsk] = useState<string | null>(null) // sceneId awaiting «Cancel generation confirmation
  const [cancelling, setCancelling] = useState<Record<string, boolean>>({}) // per-scene: cancel request in flight
  const [sceneError, setSceneError] = useState<Record<string, string>>({}) // per-scene generation error shown on the card
  // Stage 36 — the reference images the failed job actually submitted (from job.result.submittedReferences), for previews under the error.
  const [sceneErrorRefs, setSceneErrorRefs] = useState<Record<string, SubmittedReference[]>>({})
  // Stage 31 — "View prompt" modal: view / copy / manually override the scene's final prompt.
  const [promptModal, setPromptModal] = useState<{ sceneId: string; number: number } | null>(null)
  const [promptText, setPromptText] = useState('')          // editable textarea content
  const [promptLoading, setPromptLoading] = useState(false) // GET in flight
  const [promptErr, setPromptErr] = useState<string | null>(null)
  const [promptHasOverride, setPromptHasOverride] = useState(false) // scene currently uses a manual override
  const [promptSaving, setPromptSaving] = useState(false)   // PUT in flight (save or reset)
  const [promptCopied, setPromptCopied] = useState(false)   // flashed «"Copied" inside the modal
  const [promptSaved, setPromptSaved] = useState(false)     // flashed «"Saved" inside the modal
  // Reference strategy the builder resolved for this scene (character_references | new_scene_reference | text_only).
  const [promptRefKind, setPromptRefKind] = useState<string | null>(null)
  // «"Assemble" — pure concatenation of the ready scene clips into one episode (no audit / no polish / no re-gen).
  const [stitching, setStitching] = useState(false)
  // Stage 46B: «"Assemble" opens a dialog — production quality / fps of the FINAL file (scenes are always 480p);
  // the stitch runs as a background job whose real stages are shown in a progress bar.
  const [assembleDialogOpen, setAssembleDialogOpen] = useState(false)
  const [assembleQuality, setAssembleQuality] = useState<AssembleQuality>(DEFAULT_ASSEMBLE_QUALITY)
  const [assembleFps, setAssembleFps] = useState<AssembleFps>(DEFAULT_ASSEMBLE_FPS)
  const [assembleNote, setAssembleNote] = useState<string | null>(null)
  // Stage 79: music status of the LAST assembly, shown in the «"Assemble" dialog.
  const [assembleMusic, setAssembleMusic] = useState<{ musicApplied?: boolean; musicSummary?: string | null; musicError?: string | null } | null>(null)
  // Stage 89 — "Quality & speed" (power tier) chosen right on the episode top panel, applied to scene
  // generation, «Generate all» and per-frame Edit/Regenerate. Initialized from the project's current tier.
  const [powerTier, setPowerTier] = useState<PowerTier>(() => initialPowerTier(project))
  const powerTierRef = useRef<PowerTier>(powerTier)
  useEffect(() => { powerTierRef.current = powerTier }, [powerTier])
  const stitchJob = useJobPolling({
    onFinish: (res) => {
      setStitching(false)
      const j = res.job
      if (j.status === 'completed') {
        if (validUrl(j.result?.videoUrl)) setEpisode((p: any) => ({ ...p, videoUrl: j.result.videoUrl, status: 'assembled', assembleQuality: j.result?.quality ?? null, assembleFps: j.result?.fps ?? null }))
        setAssembleNote(j.result?.note ?? null)
        setAssembleMusic({ musicApplied: j.result?.musicApplied, musicSummary: j.result?.musicSummary ?? null, musicError: j.result?.musicError ?? null })
      } else {
        setError(j.error ?? j.message ?? "Couldn't assemble the episode")
      }
    },
  })
  // AI image model chosen for reference generation (EDIT 1). `refModalOpen` gates the picker
  // shown before «Generate all"; the ref keeps the choice available to the resume poll loop.
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
  // Scope of the running reference session (Stage 46A): «Generate characters" (characters only —
  // locations are never touched) or a locations session started from ONE location card («Generate
  // master frame" / "+ Angle") — characters are never touched there.
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
  // Per-location cancel («Cancel generation on the location card): locations whose generation the
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
    // Stage 59 (step 4): tabs are ordered Script → References → Scenes, so an unfilled episode opens on
    // «Script by default; only jump straight to Scenes when the episode already has generated video.
    return anyScene || validUrl(initial.videoUrl) ? 'scenes' : 'script'
  })
  const goPhase = (p: EpisodePhase) => { setPhase(p); if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' }) }

  const patchScene = (sceneId: string, patch: Partial<Scene>) => setScenes((prev) => prev.map((s) => (s.id === sceneId ? { ...s, ...patch } : s)))
  /** Stage 104: POST /api/ai/scenes/[id]/keyframe, then poll the "scene-keyframe" job; the video is never touched. */
  const generateKeyframe = async (sceneId: string) => {
    if (kfBusy[sceneId]) return
    setError(''); setKfBusy((b) => ({ ...b, [sceneId]: true }))
    patchScene(sceneId, { keyframeStatus: 'pending', keyframeError: null })
    try {
      const res = await fetch(`/api/ai/scenes/${sceneId}/keyframe`, { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok && res.status !== 409) { setError(d?.error ?? 'Failed to start the keyframe'); patchScene(sceneId, { keyframeStatus: 'error', keyframeError: d?.error ?? 'Failed to start the keyframe' }); return }
      for (let i = 0; i < 400 && d?.jobId; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        const jr = await fetch(`/api/jobs/${d.jobId}`, { cache: 'no-store' }).catch(() => null)
        if (!jr || !jr.ok) continue
        const jd = await jr.json().catch(() => ({}))
        const sc = jd?.scene
        if (sc) patchScene(sceneId, { keyframeUrl: sc.keyframeUrl ?? null, keyframePrompt: sc.keyframePrompt ?? null, keyframeStatus: sc.keyframeStatus ?? null, keyframeError: sc.keyframeError ?? null })
        const st = jd?.job?.status
        if (st === 'completed' || st === 'failed' || st === 'canceled') break
      }
    } catch { setError('Network error') } finally { setKfBusy((b) => { const n = { ...b }; delete n[sceneId]; return n }) }
  }
  const stopPolling = (sceneId: string) => { const t = pollTimers.current[sceneId]; if (t) clearTimeout(t); delete pollTimers.current[sceneId] }
  const clearGen = (sceneId: string) => setActiveGen((p) => { const n = { ...p }; delete n[sceneId]; return n })

  const refreshCredits = useCallback(async () => {
    try { const r = await fetch('/api/user/credits', { cache: 'no-store' }); if (r.ok) { const d = await r.json(); if (typeof d?.credits === 'number') setCredits(d.credits) } } catch {}
  }, [])

  // ---- Reference readiness ----
  const locBaseReady = (l: any) => validUrl(l?.imageUrl)
  // Stage 46A: a location is "ready" with its MASTER frame alone — extra angles are optional and are
  // added one by one with the «+ "Angle" button. The scenes step unlocks as soon as every character
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
              setSceneError((prev) => ({ ...prev, [sceneId]: data.job.error ?? 'Generation failed' }))
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

  // ---- Stage 46B-2: per-photo «Regenerate (one frame = CHARACTER_REFERENCE_COST), polled until done ----
  const [shotBusy, setShotBusy] = useState<Record<string, boolean>>({}) // key `${entityId}:${slot}`
  const regenShot = useCallback(async (kind: 'character' | 'location', entityId: string, slot: string, index?: number) => {
    const key = `${entityId}:${slot}${index !== undefined ? `-${index}` : ''}`
    if (shotBusy[key]) return
    setError(''); setShotBusy((b) => ({ ...b, [key]: true }))
    try {
      const body = kind === 'character' ? { shot: slot, index, imageModel: imageModelRef.current } : { slot, index, imageModel: imageModelRef.current }
      const res = await fetch(`/api/ai/${kind === 'character' ? 'characters' : 'locations'}/${entityId}/shot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? 'Failed to regenerate photo'); return }
      if (typeof d?.creditsRemaining === 'number') setCredits(d.creditsRemaining)
      // Poll the single-shot job until it reaches a terminal state, then pull the fresh references.
      for (let i = 0; i < 400 && d?.jobId; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        const jr = await fetch(`/api/jobs/${d.jobId}`, { cache: 'no-store' }).catch(() => null)
        if (!jr || !jr.ok) continue
        const jd = await jr.json().catch(() => ({}))
        const st = jd?.job?.status
        if (st === 'completed') break
        if (st === 'failed' || st === 'canceled') { setError(jd?.job?.error ?? 'Photo regeneration failed'); break }
      }
      await refreshRefs()
    } catch { setError('Network error') } finally { setShotBusy((b) => { const n = { ...b }; delete n[key]; return n }) }
  }, [shotBusy, refreshRefs])
  const shotIsBusy = (entityId: string, slot: string, index?: number) => !!shotBusy[`${entityId}:${slot}${index !== undefined ? `-${index}` : ''}`]
  // ---- Stage 46E: prompt modal (characters + locations), delete location frame, reset location prompt ----
  const [promptFor, setPromptFor] = useState<{ kind: 'character' | 'location'; id: string; name: string } | null>(null)
  const deleteFrame = useCallback(async (locationId: string, slot: string, index?: number) => {
    setError('')
    const res = await fetch(`/api/ai/locations/${locationId}/frame`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot, index }) })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) { setError(d?.error ?? "Couldn't delete the shot"); return }
    if (d?.location) setRefLocs((prev) => prev.map((l) => (l.id === locationId ? { ...l, ...d.location } : l)))
  }, [])
  const resetLocationPrompt = useCallback(async (locationId: string) => {
    setError('')
    const res = await fetch(`/api/ai/locations/${locationId}/prompt`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }) })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) { setError(d?.error ?? "Couldn't reset the prompt"); return }
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
      if (!res.ok) { setError(d?.error ?? "Couldn't reset the prompt"); return }
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
      // author is generated; extra angles are added one at a time with «+ Angle.
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

  /** «Generate characters" (Stage 46A): generate every missing photo of this episode's CHARACTERS only.
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
      if (!res.ok) { setError(d?.error ?? 'Failed to start character generation'); return }
      if (d?.jobId) refJobs.current.char = d.jobId
      if (typeof d?.creditsRemaining === 'number') setCredits(d.creditsRemaining)
      setRefSession(true)
    } catch { setError('Network error') } finally { setRefStarting(false) }
  }

  /** «Generate master frame" on ONE location card (Stage 46A): exactly ONE master frame of this location,
   *  nothing else — extra angles are added later, one per click, with «+ Angle. Characters are not touched. */
  const generateLocationRefs = async (locationId: string) => {
    setError(''); setRefStarting(true); refCanceled.current = false; locCanceled.current = new Set()
    // Stage 60: a location may be generated WITHOUT waiting for a running character session.
    // Only take over the polling scope when characters aren't already generating — otherwise
    // keep 'characters' so the character resume loop / banner stay intact; the location job
    // runs concurrently, tracked via locActive.
    const keepChars = refSession && refScope === 'characters' && !refsCharsReady
    if (!keepChars) { refScopeRef.current = 'locations'; setRefScope('locations') }
    setTickSeen(false)
    try {
      const res = await fetch(`/api/ai/locations/${locationId}/image`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageModel: imageModelRef.current }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? 'Failed to start location generation'); return }
      if (d?.jobId) refJobs.current.loc[locationId] = d.jobId
      if (typeof d?.creditsRemaining === 'number') setCredits(d.creditsRemaining)
      // A new master frame replaces the whole photo set: drop the old angles locally (the server resets them too).
      setRefLocs((prev) => prev.map((l) => (l.id === locationId ? { ...l, imageReverse: null, imageDetail: null, imageExtra: null } : l)))
      setLocActive((p) => new Set(p).add(locationId))
      setRefSession(true)
    } catch { setError('Network error') } finally { setRefStarting(false) }
  }

  /** «+ "Angle" (Stage 46A): ONE additional angle of a location, chained on its master frame. */
  const addLocationAngle = async (locationId: string) => {
    setError(''); setRefStarting(true); refCanceled.current = false; locCanceled.current = new Set()
    // Stage 60: allow adding a location angle without waiting for a running character session.
    const keepChars = refSession && refScope === 'characters' && !refsCharsReady
    if (!keepChars) { refScopeRef.current = 'locations'; setRefScope('locations') }
    setTickSeen(false)
    try {
      const res = await fetch(`/api/ai/locations/${locationId}/extra-images`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 1, imageModel: imageModelRef.current }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? 'Failed to start angle generation'); return }
      if (d?.jobId) refJobs.current.extra[locationId] = d.jobId
      if (typeof d?.creditsRemaining === 'number') setCredits(d.creditsRemaining)
      setLocActive((p) => new Set(p).add(locationId))
      setRefSession(true)
    } catch { setError('Network error') } finally { setRefStarting(false) }
  }

    const cancelRefs = async () => {
    refCanceled.current = true; autoResumedRef.current = true // don't let the self-heal effect restart what was just canceled
    const ids = [refJobs.current.char, ...Object.values(refJobs.current.loc), ...Object.values(refJobs.current.extra)].filter(Boolean) as string[]
    for (const id of ids) { try { await fetch(`/api/ai/jobs/${id}/cancel`, { method: 'POST' }) } catch {} }
    setRefSession(false); refJobs.current = { loc: {}, extra: {} }
    void refreshRefs(); void refreshCredits()
  }

  /** «Cancel generation on ONE location card (confirmed): cancel the active master-frame / extra-angle
   *  job(s) of this location via the jobs cancel API, stop the session loop for this location, and keep
   *  the button in «Stopping..." until those jobs are terminal (canceled / failed / completed). In a
   *  «Generate all" session the other characters / locations keep going; a locations-only session
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
      if (!res.ok) { setError(d?.error ?? 'Failed to edit character'); return }
      if (d?.character) setRefChars((prev) => prev.map((c) => (c.id === characterId ? { ...c, ...d.character, hasUndo: true } : c)))
      setCharEdit((t) => ({ ...t, [characterId]: '' }))
      setRefSession(true) // poll until the new references land
    } catch { setError('Network error') } finally { setCharBusy((b) => { const n = { ...b }; delete n[characterId]; return n }) }
  }

  // Stage 60: one-step undo — restore the previous character version (appearance + references).
  const undoCharacter = async (characterId: string) => {
    setCharBusy((b) => ({ ...b, [characterId]: true })); setError('')
    try {
      const res = await fetch(`/api/ai/characters/${characterId}/undo`, { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? 'Failed to undo change'); return }
      if (d?.character) setRefChars((prev) => prev.map((c) => (c.id === characterId ? { ...c, ...d.character, hasUndo: false } : c)))
    } catch { setError('Network error') } finally { setCharBusy((b) => { const n = { ...b }; delete n[characterId]; return n }) }
  }

  /** Prompt-edit a location (regenerates its reference; C2PA preserved in the worker). */
  const reviseLocation = async (locationId: string) => {
    const instruction = locEdit[locationId]?.trim(); if (!instruction) return
    setLocBusy((b) => ({ ...b, [locationId]: true })); setError('')
    try {
      const res = await fetch(`/api/ai/locations/${locationId}/revise`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction, regenerate: true }) })
      const d = await res.json()
      if (!res.ok) { setError(d?.error ?? 'Failed to edit location'); return }
      if (d?.location) setRefLocs((prev) => prev.map((l) => (l.id === locationId ? { ...l, ...d.location, hasUndo: true } : l)))
      setLocEdit((t) => ({ ...t, [locationId]: '' }))
      if (d?.jobId) setRefSession(true) // poll only when a regeneration job actually started
    } catch { setError('Network error') } finally { setLocBusy((b) => { const n = { ...b }; delete n[locationId]; return n }) }
  }

  // Stage 60: one-step undo — restore the previous location version (text + reference images).
  const undoLocation = async (locationId: string) => {
    setLocBusy((b) => ({ ...b, [locationId]: true })); setError('')
    try {
      const res = await fetch(`/api/ai/locations/${locationId}/undo`, { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? 'Failed to undo change'); return }
      if (d?.location) setRefLocs((prev) => prev.map((l) => (l.id === locationId ? { ...l, ...d.location, hasUndo: false } : l)))
    } catch { setError('Network error') } finally { setLocBusy((b) => { const n = { ...b }; delete n[locationId]; return n }) }
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
    setRevising(true); setError(null); setReviseNotice(null)
    try {
      const res = await fetch(`/api/ai/episodes/${episode.id}/revise`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction, force }) })
      const data = await res.json()
      if (res.status === 409 && data?.needsForce) { if (confirm(`${data.error}\n\nContinue?`)) return reviseEpisode(true); setRevising(false); return }
      if (!res.ok) throw new Error(data?.error ?? 'Failed to rewrite episode')
      // Stage 77: the route returns a background job — keep `revising` until the poll finishes
      // (revisePoll.onFinish reloads the episode and clears the instruction on success).
      if (data?.jobId) { revisePoll.start(data.jobId); return }
      // No jobId (unexpected) — fall back to the old immediate reload.
      setReviseText(''); await reloadEpisode(); setRevising(false)
    } catch (e: any) { setError(e?.message ?? 'Error'); setRevising(false) }
  }

  // Stage 83 — entry point for the sticky «"Rewrite" bar. Rewriting the episode plot/synopsis/
  // script re-plans and RESETS every scene (and any generated clips). If scenes already exist, ask
  // first; on confirm we run with force=true so the reset (incl. clips) goes through in one step.
  // No scenes yet → nothing to lose → run immediately, exactly like before.
  const askReviseEpisode = () => {
    if (!reviseText.trim() || revising) return
    if (needsSceneResetConfirm(scenes.length)) { setResetAsk(true); return }
    void reviseEpisode()
  }
  const confirmReviseReset = () => { setResetAsk(false); void reviseEpisode(true) }

  // Stage 77 — resume the rewrite placeholder after a page reload: the latest season job from
  // GET /api/ai/season carries `resultData.revise.episodeIds`; if it is active and names THIS
  // episode, the script is being rewritten right now.
  const reviseResumedRef = useRef(false)
  useEffect(() => {
    if (reviseResumedRef.current) return
    reviseResumedRef.current = true
    ;(async () => {
      try {
        const r = await fetch(`/api/ai/season?projectId=${project.id}`, { cache: 'no-store' })
        if (!r.ok) return
        const d = await r.json()
        if (isEpisodeRevisePending(d?.job, episode.id)) {
          setRevising(true)
          revisePoll.start(d.job.id)
        }
      } catch { /* ignore */ }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, episode.id])

  const reviseScene = async (scene: Scene) => {
    const instruction = sceneEdit[scene.id]?.trim(); if (!instruction) return
    setSceneBusy((b) => ({ ...b, [scene.id]: true })); setError(null)
    try {
      const res = await fetch(`/api/ai/scenes/${scene.id}/revise`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction }) })
      const data = await res.json(); if (!res.ok) throw new Error(data?.error ?? 'Failed to edit scene')
      patchScene(scene.id, { ...data.scene, hasUndo: true }); setSceneEdit((t) => ({ ...t, [scene.id]: '' }))
      // Stage 79a: no confirmation — «"Edit" rewrites the scene AND re-renders the clip at once.
      await regenScene(scene.id)
    } catch (e: any) { setError(e?.message ?? 'Error') } finally { setSceneBusy((b) => { const n = { ...b }; delete n[scene.id]; return n }) }
  }

  // Stage 60: one-step undo — restore the previous scene version (text + previously rendered clip).
  const undoScene = async (scene: Scene) => {
    setSceneBusy((b) => ({ ...b, [scene.id]: true })); setError(null)
    try {
      const res = await fetch(`/api/ai/scenes/${scene.id}/undo`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? 'Failed to undo change')
      patchScene(scene.id, { ...data.scene, hasUndo: false })
    } catch (e: any) { setError(e?.message ?? 'Error') } finally { setSceneBusy((b) => { const n = { ...b }; delete n[scene.id]; return n }) }
  }

  // Single-scene background generation (POST /api/ai/generate-video → runVideoJob).
  // Stage 33: Seedance 2.5 is the only video model — no `provider` is sent; the route resolves it.
  const generateScene = async (sceneId: string, _withModel: boolean) => {
    setActiveGen((p) => ({ ...p, [sceneId]: true })); setError(null)
    setSceneError((prev) => { const n = { ...prev }; delete n[sceneId]; return n })
    setSceneErrorRefs((prev) => { const n = { ...prev }; delete n[sceneId]; return n })
    try {
      // Stage 89: send the top-panel Quality & speed (power tier) so this generation — and per-frame
      // Edit/Regenerate, which call this same route — use exactly what the user picked.
      const body: Record<string, unknown> = { projectId: project.id, sceneId, powerTier: powerTierRef.current }
      const res = await postJobStart('/api/ai/generate-video', body)
      const data = await res.json(); if (!res.ok) throw new Error(data?.error ?? 'Failed to start generation')
      patchScene(sceneId, { status: 'generating' }); pollVideoJob(sceneId, data.jobId); void refreshCredits()
    } catch (e: any) { clearGen(sceneId); setError(e?.message ?? 'Error') }
  }
  const regenScene = (sceneId: string) => generateScene(sceneId, false)

  // «Cancel generation (confirmed): flag the running video job; the worker cancels the provider
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
      if (!res.ok) throw new Error(data?.error ?? 'Failed to cancel generation')
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
      setError(e?.message ?? 'Error')
    }
  }

  // Stage 39 — «Generate all scenes": POST /api/ai/episodes/[id]/generate-all starts EVERY pending /
  // failed scene at once (server-side fan-out); the client polls all returned jobs simultaneously so each
  // card shows its own progress / error. `genAllAsk` holds the cost estimate for the confirmation box.
  const [genAllAsk, setGenAllAsk] = useState<{ pendingCount: number; total: number; costPerScene: number; credits: number } | null>(null)
  const [genAllStarting, setGenAllStarting] = useState(false)
  const generatingCount = Object.values(activeGen).filter(Boolean).length
  // Stage 72 — the «"In sequence" switch is back (see chainMode below); the server-side chain run is reported here.
  const [chainRunActive, setChainRunActive] = useState<boolean>(!!initial.chainRunActive)
  const [chainRunNote, setChainRunNote] = useState<string | null>(initial.chainRunNote ?? null)
  // Stage 100 — parallel mode was removed entirely: generation is ALWAYS sequential (chain). There is
  // no mode toggle anymore, and every confirmation/hint wording is fixed to the sequential flow.
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
      if (!res.ok) throw new Error(d?.error ?? 'Failed to get cost estimate')
      if (!d.pendingCount) { setError('All scenes are already ready or generating'); return }
      setGenAllAsk({ pendingCount: d.pendingCount, total: d.total ?? 0, costPerScene: d.costPerScene ?? 0, credits: d.credits ?? credits })
    } catch (e: any) { setError(e?.message ?? 'Error') }
    finally { setGenAllStarting(false) }
  }
  const generateAllScenes = async () => {
    setGenAllAsk(null); setGenAllStarting(true); setError(null)
    try {
      const res = await postJobStart(`/api/ai/episodes/${episode.id}/generate-all`, { powerTier: powerTierRef.current })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !Array.isArray(d?.jobs)) throw new Error(d?.error ?? 'Failed to start generation')
      if (d.chain) { setChainRunActive(true); setChainRunNote(null) }
      for (const j of d.jobs as Array<{ sceneId: string; jobId: string }>) {
        setActiveGen((p) => ({ ...p, [j.sceneId]: true }))
        setSceneError((prev) => { const n = { ...prev }; delete n[j.sceneId]; return n })
        setSceneErrorRefs((prev) => { const n = { ...prev }; delete n[j.sceneId]; return n })
        patchScene(j.sceneId, { status: 'generating' })
        pollVideoJob(j.sceneId, j.jobId)
      }
      // Scenes the balance could not cover are reported per card as «Not enough credits.
      for (const u of (d.insufficient ?? []) as Array<{ sceneId: string; error?: string }>) {
        setSceneError((prev) => ({ ...prev, [u.sceneId]: u.error ?? 'Not enough credits' }))
      }
      if (typeof d?.creditsRemaining === 'number') setCredits(d.creditsRemaining); else void refreshCredits()
    } catch (e: any) { setError(e?.message ?? 'Error') }
    finally { setGenAllStarting(false) }
  }

  // Stage 31 — open the "View prompt" modal and load the scene's FINAL prompt (override if set,
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
      if (!res.ok) throw new Error(data?.error || 'Failed to load prompt')
      setPromptText(String(data.prompt ?? ''))
      setPromptHasOverride(!!data.hasOverride)
      setPromptRefKind(typeof data.referenceKind === 'string' ? data.referenceKind : null)
    } catch (e: any) {
      setPromptErr(e?.message ?? 'Failed to load prompt')
    } finally {
      setPromptLoading(false)
    }
  }

  // Copy the current textarea contents (so a hand-edited prompt is copied as shown) and flash «Copied.
  const copyPromptModal = async () => {
    try {
      await navigator.clipboard.writeText(promptText)
      setPromptCopied(true)
      setTimeout(() => setPromptCopied(false), 2000)
    } catch { setPromptErr("Couldn't copy") }
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
      if (!res.ok) throw new Error(data?.error || "Couldn't save")
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
      setPromptErr(e?.message ?? "Couldn't save")
    } finally {
      setPromptSaving(false)
    }
  }

  const allReady = scenes.length > 0 && scenes.every((s) => validUrl(s.videoUrl) && !activeGen[s.id])

  // «"Assemble" — pure concatenation of the ready scene clips into a single episode video.
  // No audit, no polish, no re-generation: just stitches the existing clips together and
  // stores the result on the episode. The button is enabled only when every scene is ready.
  // Stage 46B: the POST returns a jobId; progress comes from GET /api/jobs/[id].
  const stitch = async () => {
    setAssembleDialogOpen(false)
    setStitching(true); setError(null); setAssembleNote(null)
    try {
      const res = await fetch('/api/ai/assemble-episode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ episodeId: episode.id, quality: assembleQuality, fps: assembleFps }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? "Couldn't assemble the episode")
      if (!data?.jobId) throw new Error('Assembly did not start')
      stitchJob.start(data.jobId)
    } catch (e: any) { setError(e?.message ?? 'Error'); setStitching(false) }
  }

  const isAssembled = episode.status === 'assembled' || validUrl(episode.videoUrl)
  const nextEpisode = siblings.filter((s) => s.number > episode.number).sort((a, b) => a.number - b.number)[0] ?? null

  return (
    <div className="min-h-screen bg-background">
      {/* Stage 76: project name in the sticky header (project comes from episode.season.project on the server). */}
      <Header projectName={project?.name} projectId={project?.id} />
      <main className={`mx-auto max-w-[1200px] px-4 py-6 ${phase === 'script' ? 'pb-44' : ''}`} data-testid="episode-page">
        {/* Stage 14 (C): episode nav — right-aligned «Episodes" dropdown grid (10/row desktop), any order. */}
        <div className="flex flex-wrap items-center gap-4">
          <Link href={`/project/${project.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> To season story</Link>
          <EpisodeNavGrid projectId={project.id} episodes={siblings} currentId={episode.id} />
        </div>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase text-muted-foreground">Episode {episode.number}{episode.arcRole ? ` · ${episode.arcRole}` : ''}</div>
            <h1 className="font-display text-2xl font-bold tracking-tight">{episode.title}</h1>
            {episode.logline && <p className="mt-1 text-sm text-muted-foreground">{episode.logline}</p>}
          </div>
          <div className="text-sm text-muted-foreground">Credits: <span className="font-semibold text-foreground" data-testid="credits">{credits}</span></div>
        </div>

        {/* Stage 14 (D): guided steps — script → references → scenes */}
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs" data-testid="phase-steps">
          {(([['script', '1 · Script'], ['references', '2 · References'], ['scenes', '3 · Scenes']]) as [EpisodePhase, string][]).map(([key, label]) => {
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
            <h2 className="mb-3 font-display text-xl font-bold">Episode script</h2>
            {/* Stage 77: while the rewrite job runs the OLD script is hidden behind a placeholder. */}
            {rewriteViewState(revising, revisePoll.job?.status) === 'placeholder' ? (
              <RewritePlaceholder job={revisePoll.job} expectedTotalSec={EPISODE_REVISE_EXPECTED_SEC} label="Rewriting episode script…" testId="episode-revise-progress" />
            ) : (
              <BookScript text={episode.script} scenes={scenes} />
            )}
            {reviseNotice && <p className="mt-3 text-sm text-primary" data-testid="episode-revise-notice">{reviseNotice}</p>}
            {/* Stage 59 navigation — Script is step 1: single forward button to references. */}
            <div className="mt-5 flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4">
              <button onClick={() => goPhase('references')} disabled={revising} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:brightness-110 disabled:opacity-50" data-testid="script-to-references">
                To references <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {/* Step 2 — Stage 12: references of THIS episode + single "generate all" */}
        {phase === 'references' && (
        <section className="mt-4 rounded-xl border border-border bg-card p-4" data-testid="episode-references">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="inline-flex items-center gap-2 font-display text-xl font-bold"><Images className="h-5 w-5 text-primary" /> Episode references</h2>
            {refSession ? (
              <span className="inline-flex items-center gap-2 text-xs text-muted-foreground" data-testid="refs-progress">
                <Loader2 className="h-4 w-4 animate-spin text-primary" /> {refScope === 'locations' ? <>Generating location: {refsLocsDone}/{refLocs.length}</> : <>Generating characters: {refsCharsDone}/{refChars.length}</>}
                <CancelButton onCancel={cancelRefs} testId="refs-cancel" label="Cancel" pendingLabel="Stopping…" />
              </span>
            ) : (
              <span className="inline-flex flex-wrap items-center gap-2">
                {refsReady && <span className="text-xs font-medium text-emerald-500" data-testid="refs-status">All references are ready</span>}
                {!refsCharsReady && (
                  <button onClick={() => setRefModalOpen(true)} disabled={refStarting} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="generate-all-refs" title="Generate photos of all episode characters (locations — separately, on the location card)">
                    {refStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Generate characters
                  </button>
                )}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Characters (multiple angles) are generated with the "Generate characters" button. Locations are separate: one master frame using the button on the card, additional angles with "+". All images are tagged with C2PA. Click any frame to open it full screen.</p>

          {/* Stage 91/93: Locations FIRST on the per-episode references screen.
              IMPORTANT: this is the screen the user actually sees (episode-view.tsx, phase === 'references').
              Ordering here is guaranteed by DOM/source order (Locations block is rendered before
              Characters), NOT by a Tailwind order-* class (those get purged from the compiled CSS).
              Stage 93: the location card now MATCHES the character card exactly in size and layout —
              same heading style, same grid (sm:grid-cols-2 lg:grid-cols-3), same 9:16 object-contain
              photos and the same button rows — with NO oversized/highlighted wrapper and no "base
              scene layer" badge, while keeping every location-specific control (generate/regenerate
              master frame, "+ Angle", cancel-generation + confirm dialog). Locations stay FIRST. */}
          <h3 className="mt-4 flex items-center gap-2 text-sm font-semibold" data-testid="episode-location-block"><MapPin className="h-4 w-4" /> Locations ({refLocs.length})</h3>
          <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {refLocs.map((l) => {
              const detail = locationDetailLevel(l)
              const base = [{ url: l.imageUrl, label: 'Wide shot', slot: 'master' }, { url: l.imageReverse, label: 'Reverse angle', slot: 'reverse' }, { url: l.imageDetail, label: 'Medium shot', slot: 'detail' }].filter((a) => validUrl(a.url))
              const extras = parseExtra(l.imageExtra)
              // This location has a running master-frame / extra-angle job (server truth; before the first tick — the job we just started).
              const locGen = refSession && !locCanceled.current.has(l.id) && (locActive.has(l.id) || (!tickSeen && (!!refJobs.current.loc[l.id] || !!refJobs.current.extra[l.id])))
              const cancelling = !!locCancelling[l.id]
              const busy = !!locBusy[l.id] || locGen || cancelling
              return (
                <div key={l.id} className="rounded-lg border border-border/60 p-3" data-testid="ref-location">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 truncate text-sm font-medium">{l.name} <span className="font-normal text-muted-foreground">· {locationFrames(l)} {locationFrames(l) === 1 ? 'frame' : 'frames'}</span></div>
                    <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-[10px] text-muted-foreground" title="The recommended number of frames depends on the required location detail; add angles with '+' as needed" data-testid="location-detail-badge">detail: {locationDetailLabel(detail)} · recommended {desiredTotalFrames(l)}</span>
                  </div>
                  <div className="mt-2">
                    {(() => { const all = [...base.map((a) => ({ url: a.url as string, label: a.label, slot: a.slot, idx: undefined as number | undefined })), ...extras.map((u, i) => ({ url: u, label: `${i + 1}. ${locationExtraLabel(i)}`, slot: 'extra', idx: i }))]; const urls = all.map((a) => a.url); return all.length > 0 ? (
                      <div className={all.length > 1 ? 'grid grid-cols-2 gap-2' : ''}>
                        {all.map((a, i) => (
                          <button key={a.url + i} type="button" onClick={() => openLightbox(urls, i, `${l.name} — ${a.label}`)} className={`group relative aspect-[9/16] overflow-hidden rounded bg-muted ${all.length === 1 ? 'mx-auto w-full max-w-[13rem]' : ''}`} title={a.label} data-testid="ref-image">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={a.url} alt={`${l.name} — ${a.label}`} className="h-full w-full object-contain" />
                            <span className="absolute right-1 top-1 rounded bg-black/50 p-0.5 opacity-0 transition group-hover:opacity-100"><Maximize2 className="h-3 w-3 text-white" /></span>
                            <FrameToolbar
                              regen={{ testId: `regen-shot-${a.slot}${a.idx !== undefined ? `-${a.idx}` : ''}`, busy, spinning: shotIsBusy(l.id, a.slot, a.idx), onClick: () => regenShot('location', l.id, a.slot, a.idx) }}
                              download={{ url: a.url, name: referenceFileName('location', l.name, a.slot, a.url, a.idx) }}
                              del={{ testId: `delete-shot-${a.slot}${a.idx !== undefined ? `-${a.idx}` : ''}`, onClick: () => deleteFrame(l.id, a.slot, a.idx), disabled: busy || all.length <= 1, disabledTitle: all.length <= 1 ? 'At least one frame' : 'Wait for generation to finish' }}
                            />
                          </button>
                        ))}
                      </div>
                    ) : busy ? (
                      <div className="mx-auto flex aspect-[9/16] w-full max-w-[13rem] items-center justify-center rounded bg-muted"><Loader2 className="h-4 w-4 animate-spin text-primary" /></div>
                    ) : (
                      <div className="mx-auto flex aspect-[9/16] w-full max-w-[13rem] items-center justify-center rounded bg-muted"><ImageOff className="h-4 w-4 text-muted-foreground/40" /></div>
                    ) })()}
                  </div>
                  {/* Stage 46E: prompt tools + download all */}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="location-prompt-tools">
                    <button type="button" onClick={() => setPromptFor({ kind: 'location', id: l.id, name: l.name })} className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs" data-testid="location-prompt" title="View, copy, or edit the location visual prompt">
                      <FileText className="h-3.5 w-3.5" /> Prompt
                    </button>
                    <button
                      type="button"
                      disabled={busy || !!locResetting[l.id]}
                      onClick={async () => { setLocResetting((m) => ({ ...m, [l.id]: true })); try { await resetLocationPrompt(l.id) } finally { setLocResetting((m) => { const n = { ...m }; delete n[l.id]; return n }) } }}
                      className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50"
                      data-testid="location-prompt-reset"
                      title="Restore the original AI-written location prompt"
                    >
                      {locResetting[l.id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Reset prompt to auto
                    </button>
                    <DownloadAllButton kind="location" id={l.id} count={locationFrames(l)} />
                    {locHasPromptOverride(l) && <span className="rounded bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary" data-testid="location-prompt-override">Prompt changed manually</span>}
                  </div>
                      {locGen || cancelling ? (
                        /* While THIS location is generating the button becomes «Cancel generation (confirmed below),
                           mirroring the scene-video cancel. */
                        <button
                          onClick={() => setLocCancelAsk(l.id)}
                          disabled={cancelling || locCancelAsk === l.id}
                          className="mt-2 inline-flex w-full items-center justify-center gap-1 rounded-lg border border-destructive/50 px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                          data-testid="ref-location-cancel"
                          title="Stop generation for this location"
                        >
                          {cancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                          {cancelling ? 'Stopping...' : 'Cancel generation'}
                        </button>
                      ) : (
                        /* Stage 46A: «Generate" makes exactly ONE master frame of THIS location; "+ Angle" adds one angle. */
                        <div className="mt-2 flex gap-1.5">
                          <button
                            onClick={() => generateLocationRefs(l.id)}
                            disabled={busy || refStarting}
                            className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
                            data-testid="ref-location-generate"
                            title={locBaseReady(l) ? 'Create a new location master frame (old angles will be reset)' : 'Generate one master frame for this location'}
                          >
                            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : locBaseReady(l) ? <RefreshCw className="h-3.5 w-3.5" /> : <Wand2 className="h-3.5 w-3.5" />}
                            {busy ? 'Generating...' : `${locBaseReady(l) ? 'Regenerate' : 'Generate'} master frame (${CHARACTER_REFERENCE_COST} cr.)`}
                          </button>
                          {locBaseReady(l) && (
                            <button
                              onClick={() => addLocationAngle(l.id)}
                              disabled={busy || refStarting}
                              className="inline-flex items-center justify-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium disabled:opacity-50"
                              data-testid="ref-location-add-angle"
                              title={`Add another angle of this location (${CHARACTER_REFERENCE_COST} cr.)`}
                            >
                              <Plus className="h-3.5 w-3.5" /> Angle
                            </button>
                          )}
                        </div>
                      )}
                      {locCancelAsk === l.id && locGen && (
                        <div className="mt-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs" data-testid="ref-location-cancel-confirm">
                          Stop generating this location? Credits for unfinished frames will be refunded.
                          <div className="mt-1.5 flex gap-1.5">
                            <button onClick={() => cancelLocationGen(l.id)} className="inline-flex items-center gap-1 rounded-lg bg-destructive px-2 py-1 text-destructive-foreground" data-testid="ref-location-cancel-ok"><X className="h-3.5 w-3.5" /> Yes, cancel</button>
                            <button onClick={() => setLocCancelAsk(null)} className="rounded-lg border border-border px-2 py-1" data-testid="ref-location-cancel-keep">Continue generation</button>
                          </div>
                        </div>
                      )}
                      <div className="mt-2 flex flex-col gap-1.5 sm:flex-row">
                        <input value={locEdit[l.id] ?? ''} onChange={(e) => setLocEdit((t) => ({ ...t, [l.id]: e.target.value }))} placeholder="Edit location by prompt…" className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-xs" data-testid="ref-location-input" disabled={busy} />
                        <button onClick={() => reviseLocation(l.id)} disabled={busy || !(locEdit[l.id] ?? '').trim()} className="inline-flex items-center justify-center gap-1 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50" data-testid="ref-location-submit" title="Edit by prompt">
                          {locBusy[l.id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                        </button>
                        {l.hasUndo && (
                          <button onClick={() => undoLocation(l.id)} disabled={busy} className="inline-flex items-center justify-center gap-1 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50" data-testid="location-undo" title="Undo last change">
                            <Undo2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                </div>
              )
            })}
            {refLocs.length === 0 && <p className="text-sm text-muted-foreground">No locations are linked to this episode.</p>}
          </div>

          {/* Characters — rendered BELOW the location block (locations stay first; both cards are the same size). */}
          <h3 className="mt-6 flex items-center gap-2 text-sm font-semibold"><Users className="h-4 w-4" /> Characters ({refChars.length})</h3>
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
                  <div className="mt-2 truncate text-sm font-medium">{c.name} <span className="font-normal text-muted-foreground">· {photos.length} photo</span></div>
                  {c.role && <div className="truncate text-xs text-muted-foreground">{c.role}</div>}
                      {/* Stage 46E: prompt view/edit + download all */}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <button type="button" onClick={() => setPromptFor({ kind: 'character', id: c.id, name: c.name })} className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs" data-testid="character-prompt" title="View, copy, or edit the character prompt">
                          <FileText className="h-3.5 w-3.5" /> Prompt
                        </button>
                        <DownloadAllButton kind="character" id={c.id} count={photos.length} />
                        <button type="button" disabled={busy || !!charResetting[c.id]} onClick={() => resetCharacterPrompt(c.id)} className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50" data-testid="char-prompt-reset" title="Remove manual prompt and restore automatic">
                            {charResetting[c.id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Reset prompt to auto
                          </button>
                        {!!(c.promptOverride && String(c.promptOverride).trim()) && <span className="rounded bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary" data-testid="character-prompt-override">Prompt changed manually</span>}
                      </div>
                      <div className="mt-2 flex flex-col gap-1.5 sm:flex-row">
                        <input value={charEdit[c.id] ?? ''} onChange={(e) => setCharEdit((t) => ({ ...t, [c.id]: e.target.value }))} placeholder="Edit by prompt…" className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-xs" data-testid="ref-character-input" disabled={busy} />
                        <button onClick={() => reviseCharacter(c.id)} disabled={busy || !(charEdit[c.id] ?? '').trim()} className="inline-flex items-center justify-center gap-1 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50" data-testid="ref-character-submit" title="Edit by prompt">
                          {charBusy[c.id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                        </button>
                        {c.hasUndo && (
                          <button onClick={() => undoCharacter(c.id)} disabled={busy} className="inline-flex items-center justify-center gap-1 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50" data-testid="character-undo" title="Undo last change">
                            <Undo2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                </div>
              )
            })}
            {refChars.length === 0 && <p className="text-sm text-muted-foreground">No characters are linked to this episode.</p>}
          </div>

          {/* Stage 59 navigation — References is step 2: back to script · forward to scenes.
              The forward button is enabled once all references (characters + locations) are ready. */}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <button onClick={() => goPhase('script')} className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted" data-testid="refs-to-script">
              <ArrowLeft className="h-4 w-4" /> Script
            </button>
            <button onClick={() => goPhase('scenes')} disabled={!refsReady} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="refs-to-scenes" title={refsReady ? '' : 'Generate all episode references first'}>
              To scenes <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </section>
        )}

        {/* Step 3 — scenes: per-scene generation + «Generate all scenes" (parallel, Stage 39) + assemble */}
        {phase === 'scenes' && (
        <>
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
          {/* Stage 59 navigation — Scenes is step 3: back to references. */}
          <button onClick={() => goPhase('references')} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted" data-testid="back-to-references">
            <ArrowLeft className="h-4 w-4" /> References
          </button>
          {/* Stage 100 — «Generate all scenes": every pending / failed scene is generated one after another (sequential chain). */}
          {!allReady && (
            <button onClick={openGenerateAll} disabled={genAllStarting || genAllAsk !== null || chainRunActive} className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="generate-all-scenes" title="Start generating all unfinished scenes one by one">
              {genAllStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Generate all scenes
            </button>
          )}
          <button onClick={() => setAssembleDialogOpen(true)} disabled={!allReady || stitching} className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50" data-testid="assemble" title={allReady ? 'Join completed scenes into one episode' : 'Available when all scenes are ready'}>
            {stitching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />} Assemble
          </button>
          <span className="text-xs text-muted-foreground" data-testid="batch-status">{scenes.filter((s) => validUrl(s.videoUrl)).length} of {scenes.length} scenes ready{generatingCount > 0 ? ` · generating: ${generatingCount}` : ''}{isAssembled ? ' · episode assembled' : ''}</span>
          {/* Stage 89 — «Quality & speed» (power tier) chosen right here, before generating. One selector
              reflects BOTH quality (resolution) and speed/cost; the value is applied to scene generation,
              «Generate all» and per-frame Edit/Regenerate. NO model selector (Seedance 2.5 / Seedream 5.0 fixed). */}
          <div className="inline-flex items-center gap-2" data-testid="power-tier-picker">
            <span className="text-xs text-muted-foreground">Quality &amp; speed:</span>
            <div className="inline-flex overflow-hidden rounded-lg border border-border text-xs" role="group" aria-label="Quality and speed">
              {POWER_TIERS.map((t) => {
                const active = powerTier === t
                return (
                  <button key={t} type="button" onClick={() => setPowerTier(t)} aria-pressed={active}
                    className={`px-3 py-1.5 font-medium transition ${active ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'}`}
                    data-testid={`power-tier-${t}`}
                    title={QUALITY_SPEED[t].hint}>
                    {QUALITY_SPEED[t].label}
                  </button>
                )
              })}
            </div>
          </div>
          {/* Stage 100: parallel mode removed — generation is always sequential (chain), so there is no
              mode selector anymore. Scenes always start one after another, each from the previous scene's final frame. */}
          {chainRunActive && <span className="inline-flex items-center gap-1 text-xs text-primary" data-testid="chain-run-active"><Loader2 className="h-3 w-3 animate-spin" /> The chain continues: scenes are generated in sequence</span>}
          <p className="w-full text-xs text-muted-foreground" data-testid="scenes-hint">
            Scenes are generated in sequence: the final frame of the previous scene is passed to the next one, and the camera changes position. <b>Generate all scenes:</b> starts all scenes that are not ready yet one by one (credits are charged for each scene).{' '}
            <b>Assemble:</b> stitches the finished videos from all scenes into one episode without regenerating — available when all scenes are ready. Episode quality (480p/720p/1080p, 30/60 frames/s) and background music are selected during assembly.
          </p>
          {stitching && stitchJob.job && <div className="w-full" data-testid="assemble-progress"><JobProgressBar job={stitchJob.job} expectedTotalSec={180} /></div>}
          {assembleNote && <p className="w-full text-sm text-amber-400" data-testid="assemble-note">{assembleNote}</p>}
          {chainRunNote && !chainRunActive && <p className="w-full text-sm text-destructive" data-testid="chain-run-note">{chainRunNote}</p>}
          {error && <p className="w-full text-sm text-destructive" data-testid="error">{error}</p>}
        </div>

        {/* Assembled episode + go to next */}
        {validUrl(episode.videoUrl) && (
          <div className="mt-4 rounded-xl border border-border bg-card p-4" data-testid="episode-video">
            <h2 className="mb-2 inline-flex items-center gap-1 font-semibold"><Film className="h-4 w-4" /> Assembled episode{episode.assembleQuality ? <span className="ml-1 text-xs font-normal text-muted-foreground" data-testid="assembled-settings">· {episode.assembleQuality}{episode.assembleFps ? ` · ${episode.assembleFps} fps` : ''}</span> : null}</h2>
            <video src={episode.videoUrl} controls playsInline className="mx-auto max-h-[70vh] w-full max-w-sm rounded-lg bg-black" />
            <div className="mt-2 flex flex-wrap items-center gap-4">
              <a href={episode.videoUrl} download className="inline-flex items-center gap-1 text-sm text-primary"><Download className="h-4 w-4" /> Download mp4</a>
              {nextEpisode && (
                <Link href={`/project/${project.id}/episode/${nextEpisode.id}`} className="inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" data-testid="go-to-next-episode">
                  Go to episode {nextEpisode.number} <ArrowRight className="h-4 w-4" />
                </Link>
              )}
            </div>
          </div>
        )}

        {/* Scenes */}
        {/* Stage 45/103 — running-time budget: the whole episode is EPISODE_TOTAL_LABEL (1:00). */}
        {(() => {
          const total = episodeTotalSeconds(scenes)
          const over = total > EPISODE_MAX_TOTAL_SECONDS
          const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
          return (
            <div className="mt-8 flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <h2 className="font-display text-xl font-bold">Scenes ({scenes.length})</h2>
              <span className={`text-sm ${over ? 'font-semibold text-destructive' : 'text-muted-foreground'}`} title={over ? `Episode is longer than ${EPISODE_TOTAL_LABEL} — shorten the scenes` : `Episode length — ${EPISODE_TOTAL_LABEL}`}>
                Total duration: {mmss(total)} / {mmss(EPISODE_MAX_TOTAL_SECONDS)}{over ? ` — longer than ${EPISODE_TOTAL_LABEL}, shorten the scenes` : ''}
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
                    <div className="font-semibold">Scene {scene.number}
                      {scene.sceneKind === 'narration' && <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary align-middle" data-testid="narration-badge">Voiceover</span>}
                      {scene.sceneKind === 'action' && <span className="ml-2 rounded bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-600 align-middle" data-testid="scene-kind-action">Action</span>}
                      <span className="text-xs font-normal text-muted-foreground"> · ~{scene.durationSec ?? 15}s</span>
                      {(validUrl(scene.videoUrl) || gen) && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground align-middle" data-testid="scene-provider-badge">{VIDEO_MODEL_LABEL}</span>}
                    </div>
                    {scene.lookStale && validUrl(scene.videoUrl) && (
                      <div className="mt-1 inline-flex items-center rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-700" data-testid="scene-look-stale">Character appearance changed — regenerate</div>
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
                      <div className="text-xs text-muted-foreground">{job?.message ?? 'In queue…'}</div>
                      {job && <SmoothProgress job={job} expectedTotalSec={VIDEO_EXPECTED_SEC} className="w-full" />}
                    </div>
                  ) : validUrl(scene.videoUrl) ? (
                    <SceneVideoPlayer videoUrl={scene.videoUrl as string} poster={scene.lastFrameUrl} className="h-full w-full object-contain" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">The video has not been generated yet</div>
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

                {/* Stage 104 — KEYFRAME: the Seedream opening still that seeds the image-to-video clip (frame 1;
                    the next scene's keyframe is this clip's final frame). Regenerating it never deletes the video. */}
                <div className="mt-3 flex items-center gap-3 rounded-lg border border-border/60 bg-muted/30 p-2" data-testid="scene-keyframe">
                  <div className="aspect-[9/16] h-24 shrink-0 overflow-hidden rounded bg-black/70">
                    {validUrl(scene.keyframeUrl) ? (
                      <img src={scene.keyframeUrl as string} alt={`Keyframe of scene ${scene.number}`} className="h-full w-full object-cover" data-testid="scene-keyframe-thumb" />
                    ) : (
                      <div className="flex h-full items-center justify-center text-[10px] text-muted-foreground">{kfBusy[scene.id] || scene.keyframeStatus === 'running' || scene.keyframeStatus === 'pending' ? <Loader2 className="h-4 w-4 animate-spin" /> : 'No keyframe'}</div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">Keyframe</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${scene.keyframeStatus === 'done' ? 'bg-emerald-500/15 text-emerald-700' : scene.keyframeStatus === 'error' ? 'bg-destructive/15 text-destructive' : scene.keyframeStatus ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'}`} data-testid="scene-keyframe-badge">
                        {scene.keyframeStatus ?? 'none'}
                      </span>
                    </div>
                    {scene.keyframeError && <p className="mt-1 line-clamp-3 text-[11px] text-destructive" data-testid="scene-keyframe-error">{scene.keyframeError}</p>}
                    {!scene.keyframeError && <p className="mt-1 text-[11px] text-muted-foreground">Opening still of the shot — frame 1 of the video; the next scene's keyframe is its final frame.</p>}
                  </div>
                  <button
                    onClick={() => generateKeyframe(scene.id)}
                    disabled={gen || !!kfBusy[scene.id] || scene.keyframeStatus === 'running' || scene.keyframeStatus === 'pending' || !scene.videoPrompt}
                    className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                    data-testid="scene-keyframe-generate"
                    title={validUrl(scene.keyframeUrl) ? 'Render the opening still again (the video is kept)' : 'Render the opening still of this shot'}
                  >
                    {kfBusy[scene.id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Images className="h-3.5 w-3.5" />}
                    {validUrl(scene.keyframeUrl) ? 'Regenerate keyframe' : 'Generate keyframe'}
                  </button>
                </div>

                <div className="mt-3 space-y-2">
                  {/* Stage 35 — one row, two half-width buttons under the preview: the primary action
                      (generate / regenerate — Stage 39: no sequential gate) and «View prompt. */}
                  <div className="grid grid-cols-2 gap-2">
                    {gen ? (
                      /* While THIS scene is generating the primary button becomes «Cancel generation
                         (confirmed in the box below). */
                      <button
                        onClick={() => setCancelAsk(scene.id)}
                        disabled={cancelAsk === scene.id || !!cancelling[scene.id]}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-destructive/50 px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                        data-testid="scene-cancel-gen"
                        title="Stop generating this scene"
                      >
                        {cancelling[scene.id] ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />} {cancelling[scene.id] ? 'Stopping...' : 'Cancel generation'}
                      </button>
                    ) : !ready ? (
                      <div className="flex w-full flex-col gap-1">
                        <button
                          onClick={() => generateScene(scene.id, true)}
                          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                          data-testid="scene-generate"
                          title="Generate this scene"
                        >
                          <Wand2 className="h-4 w-4" /> Generate scene
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => regenScene(scene.id)}
                        disabled={gen}
                        title="Regenerate the video immediately, without confirmation"
                        className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
                        data-testid="scene-regenerate"
                      >
                        <RefreshCw className="h-4 w-4" /> Regenerate
                      </button>
                    )}
                    <button
                      onClick={() => openPromptModal(scene)}
                      disabled={!scene.videoPrompt}
                      className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
                      data-testid="scene-view-prompt"
                      title="View, copy, or edit the full prompt"
                    >
                      <FileText className="h-4 w-4 shrink-0" />
                      View prompt
                      {scene.promptOverride ? <span className="ml-1 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary" data-testid="scene-override-badge">modified</span> : null}
                    </button>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input value={sceneEdit[scene.id] ?? ''} onChange={(e) => setSceneEdit((t) => ({ ...t, [scene.id]: e.target.value }))} placeholder="Edit scene: what to adjust…" className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm" data-testid="scene-revise-input" disabled={gen} />
                    <button onClick={() => reviseScene(scene)} disabled={gen || !!sceneBusy[scene.id] || !(sceneEdit[scene.id] ?? '').trim()} className="inline-flex items-center justify-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50" data-testid="scene-revise-submit">
                      {sceneBusy[scene.id] ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Edit
                    </button>
                    {scene.hasUndo && (
                      <button onClick={() => undoScene(scene)} disabled={gen || !!sceneBusy[scene.id]} className="inline-flex items-center justify-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50" data-testid="scene-undo" title="Undo last change">
                        <Undo2 className="h-4 w-4" /> Cancel
                      </button>
                    )}
                  </div>
                  {cancelAsk === scene.id && gen && (
                    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm" data-testid="cancel-confirm">
                      Stop generating this scene? Charged credits will be refunded.
                      <div className="mt-2 flex gap-2">
                        <button onClick={() => cancelSceneGen(scene.id)} className="inline-flex items-center gap-1 rounded-lg bg-destructive px-3 py-1.5 text-destructive-foreground" data-testid="cancel-ok"><X className="h-4 w-4" /> Yes, cancel</button>
                        <button onClick={() => setCancelAsk(null)} className="rounded-lg border border-border px-3 py-1.5" data-testid="cancel-keep">Continue generation</button>
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

      {/* Stage 83: confirm the destructive scene reset before an episode-wide rewrite (only when scenes exist). */}
      {phase === 'script' && resetAsk && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" data-testid="scene-reset-confirm" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-xl border border-border bg-background p-5 shadow-lg">
            <p className="text-sm leading-relaxed">{SCENE_RESET_CONFIRM_MESSAGE}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setResetAsk(false)} className="rounded-lg border border-border px-4 py-2 text-sm" data-testid="scene-reset-cancel">Cancel</button>
              <button onClick={confirmReviseReset} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" data-testid="scene-reset-yes">Yes</button>
            </div>
          </div>
        </div>
      )}
      {/* Stage 14 (D3): episode-level revise-by-prompt as a sticky bottom bar (whole episode or a named scene) */}
      {phase === 'script' && (
        <StickyReviseBar
          value={reviseText}
          onChange={setReviseText}
          onSubmit={askReviseEpisode}
          busy={revising}
          testId="episode-revise"
          label="Edit the episode script by prompt (the whole episode or a specific scene)"
          placeholder="For example: remove the kitchen scene, heighten the conflict in scene 3…"
          submitLabel="Rewrite"
          hint="Edits apply to the entire script and rebuild the scenes from scratch (current scenes and their prompts are reset). You can specify a scene by number. Ctrl/⌘+Enter — send."
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
            <h3 className="font-display text-lg font-bold">Generate all scenes</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Will be started <b>{genAllAsk.pendingCount}</b> scenes in sequence — one after another, each next one starts after the previous one is published — approximately <b>{genAllAsk.total}</b> cr. ({genAllAsk.costPerScene} cr. per scene). Balance: {genAllAsk.credits} cr.
              {genAllAsk.credits < genAllAsk.total && <span className="mt-1 block text-destructive">There aren’t enough credits for all scenes: only the ones you can pay for will start, and the rest will be marked “Not enough credits.”</span>}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setGenAllAsk(null)} className="rounded-lg border border-border px-3 py-1.5 text-sm">Cancel</button>
              <button onClick={generateAllScenes} className="inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50" data-testid="generate-all-ok">
                <Wand2 className="h-4 w-4" /> Start
              </button>
            </div>
          </div>
        </div>
      )}

      {/* EDIT 1 — AI image model picker shown before generating all references. */}
      {refModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid="ref-model-modal">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5">
            <h3 className="font-display text-lg font-bold">Select an AI model</h3>
            <p className="mt-1 text-sm text-muted-foreground">The model that will generate all character and location references for the episode.</p>
            <label className="mt-4 block text-sm font-medium" htmlFor="image-model-select">AI model (images)</label>
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
              <button onClick={() => setRefModalOpen(false)} className="rounded-lg border border-border px-3 py-1.5 text-sm">Cancel</button>
              <button onClick={generateCharacterRefs} className="inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50" data-testid="ref-model-ok">
                <Wand2 className="h-4 w-4" /> Generate
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stage 46B — «"Assemble" dialog: production quality / fps of the final episode file. */}
      {assembleDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" data-testid="assemble-dialog">
          <div className="w-full max-w-md rounded-xl border border-border bg-card p-5">
            <h3 className="font-display text-lg font-bold">Assemble episode</h3>
            <p className="mt-1 text-sm text-muted-foreground">Scenes are rendered in 480p. Select the finished episode quality here: only the assembled file is upscaled. 480p / 30 — no transcoding, fastest.</p>
            <label className="mt-4 block text-sm font-medium" htmlFor="assemble-quality">Production episode quality</label>
            <select id="assemble-quality" data-testid="assemble-quality" value={assembleQuality} onChange={(e) => setAssembleQuality(e.target.value as AssembleQuality)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
              {ASSEMBLE_QUALITIES.map((q) => (<option key={q} value={q}>{q}</option>))}
            </select>
            <label className="mt-3 block text-sm font-medium" htmlFor="assemble-fps">Frame rate</label>
            <select id="assemble-fps" data-testid="assemble-fps" value={assembleFps} onChange={(e) => setAssembleFps(Number(e.target.value) as AssembleFps)} className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">
              {ASSEMBLE_FPS.map((f) => (<option key={f} value={f}>{f} fps</option>))}
            </select>
            <p className="mt-3 text-xs text-muted-foreground" data-testid="assemble-music-status">
              {assembleMusic?.musicError
                ? `Music unavailable: ${assembleMusic.musicError}`
                : assembleMusic?.musicApplied && assembleMusic.musicSummary
                  ? `Music: ${assembleMusic.musicSummary}`
                  : 'Music is selected automatically for moments in the episode; if it’s unavailable, the episode is assembled without it.'}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setAssembleDialogOpen(false)} className="rounded-lg border border-border px-3 py-1.5 text-sm" data-testid="assemble-cancel">Cancel</button>
              <button onClick={stitch} className="inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-1.5 text-sm text-primary-foreground" data-testid="assemble-ok">
                <Film className="h-4 w-4" /> Assemble
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stage 46E — character / location prompt modal (shared component). */}
      {promptFor && (
        <PromptModal
          title={promptFor.kind === 'character' ? `Character prompt · ${promptFor.name}` : `Location prompt · ${promptFor.name}`}
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

      {/* Stage 31 — "View prompt" modal: view / copy / manually override the scene's final prompt. */}
      {promptModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" data-testid="scene-prompt-modal">
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-card shadow-xl">
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div>
                <h3 className="flex items-center gap-2 font-display text-lg font-bold"><FileText className="h-5 w-5" /> Full prompt · Scene {promptModal.number}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  This is the exact text sent to the model. References are shown as <code className="rounded bg-muted px-1">[Image1]…[ImageN]</code>. You can copy it, edit it with your AI, and save it — the saved text will be used the next time the scene is generated (frame stitching is preserved).
                </p>
                {promptHasOverride && (
                  <p className="mt-2 inline-flex items-center gap-1 rounded bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary" data-testid="scene-prompt-override-indicator">Prompt changed manually</p>
                )}
              </div>
              <button onClick={() => setPromptModal(null)} className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close" data-testid="scene-prompt-close"><X className="h-5 w-5" /></button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {promptLoading ? (
                <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Loading prompt…</div>
              ) : (
                <>
                  {promptErr && <p className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="scene-prompt-error">{promptErr}</p>}
                  <textarea
                    value={promptText}
                    onChange={(e) => setPromptText(e.target.value)}
                    spellCheck={false}
                    className="h-[45vh] w-full resize-none whitespace-pre-wrap rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs leading-relaxed"
                    data-testid="scene-prompt-text"
                    placeholder="Scene prompt…"
                  />
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4">
              <button
                onClick={() => savePromptOverride(true)}
                disabled={promptSaving || promptLoading}
                className="mr-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
                data-testid="scene-reset-prompt"
                title="Rewrite the prompt from scratch based on the current rules and script"
              >
                {promptSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Reset to auto
              </button>
              <button
                onClick={copyPromptModal}
                disabled={promptLoading || !promptText}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
                data-testid="scene-copy-prompt"
              >
                {promptCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {promptCopied ? 'Copied' : 'Copy'}
              </button>
              <button
                onClick={() => savePromptOverride(false)}
                disabled={promptSaving || promptLoading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
                data-testid="scene-save-prompt"
              >
                {promptSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : promptSaved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />} {promptSaved ? 'Saved' : 'Save'}
              </button>
              <button onClick={() => setPromptModal(null)} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted">Close</button>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
