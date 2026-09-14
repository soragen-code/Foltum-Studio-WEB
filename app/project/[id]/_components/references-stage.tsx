'use client'


import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Wand2, ArrowRight, ImageOff, Users, RefreshCw, MapPin, Camera, FileText, RotateCcw } from 'lucide-react'
import { FrameToolbar, DownloadAllButton } from './frame-toolbar'
import { PromptModal, CHARACTER_PROMPT_DESCRIPTION, LOCATION_PROMPT_DESCRIPTION } from './prompt-modal'
import { referenceFileName } from '@/lib/download-name'
import { CharacterCard, type CharacterCardData } from './idea-stage'
import type { JobInfo } from './use-job-polling'
import { CancelButton } from './cancel-button'
import { CHARACTER_REFERENCE_COST } from '@/lib/power-tier'
import { TIER_LABELS, groupByTier, tierOf, type Tier, type LocationCardData, LocationCard, AddLocationForm } from './cast-and-locations'
import { locationExtraLabel } from '@/lib/visual-style'
import { ProviderPicker } from './provider-picker'
import { CharacterUserRefs } from './character-user-refs'

interface RefCharacter extends CharacterCardData {
  imageFront?: string | null
  imageProfile?: string | null
  imageFull?: string | null
  imageExtra?: string | null
  /** Stage 46E: manual character prompt (null = auto). */
  promptOverride?: string | null
  /** Stage 75: user-uploaded photo references (JSON array of URLs, max 4). */
  userRefs?: string | null
  refLocked?: boolean | null
}

const POLL_MS = 3000
// Stage 55: the full-body front shot (imageFull) is the ONLY auto-generated character reference, so the
// card shows a SINGLE full-body slot. The old front-portrait / profile placeholders were never auto-filled
// (only imageFull is generated) and are no longer rendered as separate empty slots. Legacy characters that
// only kept the old front portrait still show it in this one slot.
const FULL_BODY_LABEL = 'Full-body (reference)'
const LOCATION_JOB_TYPE = 'location_image'
const LOCATION_EXTRA_JOB_TYPE = 'location_extra_image'
const EXTRA_ANGLES_PER_REQUEST = 3

/** Parse the location's imageExtra JSON array into a clean list of URLs. */
function parseExtra(imageExtra?: string | null): string[] {
  if (!imageExtra) return []
  try {
    const arr = JSON.parse(imageExtra)
    return Array.isArray(arr) ? arr.filter((u): u is string => typeof u === 'string' && u.startsWith('http')) : []
  } catch { return [] }
}

/** Location id covered by an active location_extra_image job (resultData = JSON {locationId}). */
function jobExtraLocationId(j: JobInfo & { resultData?: string | null }): string | null {
  try {
    const rd = j.resultData ? JSON.parse(j.resultData) : (j as any).result
    return typeof rd?.locationId === 'string' ? rd.locationId : null
  } catch { return null }
}

function jobCharacterIds(j: JobInfo & { resultData?: string | null }): string[] | null {
  try {
    const rd = j.resultData ? JSON.parse(j.resultData) : j.result
    return Array.isArray(rd?.characterIds) ? rd.characterIds : null
  } catch { return null }
}

/** Location ids covered by an active location_image job (resultData = JSON {locationIds}). */
function jobLocationIds(j: JobInfo & { resultData?: string | null }): string[] {
  try {
    const rd = j.resultData ? JSON.parse(j.resultData) : j.result
    return Array.isArray(rd?.locationIds) ? rd.locationIds : []
  } catch { return [] }
}

function validUrl(u?: string | null) {
  return typeof u === 'string' && u.startsWith('http') && u.length > 10
}
// Stage 53: a character reference is a single photo — the full-body front shot (imageFull). A character
// is "ready" once it has that anchor; legacy characters that only kept the old front portrait count too.
function hasAllImages(c: RefCharacter) {
  return validUrl(c.imageFull) || validUrl(c.imageFront)
}
function hasAnyImage(c: RefCharacter) {
  return validUrl(c.imageFront) || validUrl(c.imageProfile) || validUrl(c.imageFull)
}

/**
 * Step "Characters (references)": Seedream references per character, a stable
 * per-character spinner (activeGen map), prompt-based appearance edits that
 * regenerate that character's references, and "Continue to script".
 */
/**
 * `optional` (stage 5): the screen is opened as the «"References" tab from the season script — no
 * mandatory «"Continue to script" button; the trailer card lives here too.
 */
export function ReferencesStage({ project, onRefresh, optional = false }: { project: any; onRefresh: () => void; optional?: boolean }) {
  const [characters, setCharacters] = useState<RefCharacter[]>(project?.characters ?? [])
  const [locations, setLocations] = useState<LocationCardData[]>(project?.locations ?? [])
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [locJobs, setLocJobs] = useState<JobInfo[]>([])
  const [locExtraJobs, setLocExtraJobs] = useState<JobInfo[]>([])
  const [bulk, setBulk] = useState<string>('') // which bulk button is sending
  // locationId → jobId started locally (until the server lists the job)
  const [localLoc, setLocalLoc] = useState<Record<string, string>>({})
  const [localExtra, setLocalExtra] = useState<Record<string, string>>({})
  // Until the first poll answers we don't know whether a job is running — show spinners
  // for characters without references instead of an empty "no image" state.
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [continuing, setContinuing] = useState(false)
  const [starting, setStarting] = useState(false)
  // characterId → jobId of a regeneration we started locally (kept until the server confirms the job)
  const [localGen, setLocalGen] = useState<Record<string, string>>({})
  const mounted = useRef(true)

  /** One tick: active character jobs + fresh character rows. */
  const tick = useCallback(async () => {
    try {
      const [jobsRes, projRes, locJobsRes, locExtraJobsRes] = await Promise.all([
        fetch(`/api/jobs?projectId=${project.id}&type=characters&active=1`, { cache: 'no-store' }),
        fetch(`/api/projects/${project.id}`, { cache: 'no-store' }),
        fetch(`/api/jobs?projectId=${project.id}&type=${LOCATION_JOB_TYPE}&active=1`, { cache: 'no-store' }),
        fetch(`/api/jobs?projectId=${project.id}&type=${LOCATION_EXTRA_JOB_TYPE}&active=1`, { cache: 'no-store' }),
      ])
      if (!mounted.current) return
      if (locJobsRes.ok) {
        const data = await locJobsRes.json()
        const list: JobInfo[] = Array.isArray(data?.jobs) ? data.jobs : []
        setLocJobs(list)
        setLocalLoc((prev) => {
          const next: Record<string, string> = {}
          for (const [lid, jid] of Object.entries(prev)) if (list.some((j) => j.id === jid)) next[lid] = jid
          return Object.keys(next).length === Object.keys(prev).length ? prev : next
        })
      }
      if (locExtraJobsRes.ok) {
        const data = await locExtraJobsRes.json()
        const list: JobInfo[] = Array.isArray(data?.jobs) ? data.jobs : []
        setLocExtraJobs(list)
        setLocalExtra((prev) => {
          const next: Record<string, string> = {}
          for (const [lid, jid] of Object.entries(prev)) if (list.some((j) => j.id === jid)) next[lid] = jid
          return Object.keys(next).length === Object.keys(prev).length ? prev : next
        })
      }
      if (jobsRes.ok) {
        const data = await jobsRes.json()
        const list: JobInfo[] = Array.isArray(data?.jobs) ? data.jobs : []
        setJobs(list)
        setLoaded(true)
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
        if (Array.isArray(data?.project?.locations)) setLocations(data.project.locations)
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
  // A project-wide job spins only its own characters when it lists them (resultData.characterIds);
  // older jobs without the list — every character still missing images.
  const projectJobIds = projectJob ? jobCharacterIds(projectJob as any) : null
  if (projectJob || !loaded)
    for (const c of characters)
      if (!hasAllImages(c) && !activeGen[c.id] && (projectJobIds ? projectJobIds.includes(c.id) : projectJob ? true : tierOf(c) === 'MAIN'))
        activeGen[c.id] = projectJob ?? 'local'

  const anyActive = !loaded || jobs.length > 0 || Object.keys(localGen).length > 0
  const readyCount = characters.filter(hasAnyImage).length
  const missing = characters.filter((c) => !hasAllImages(c))
  const missingByTier = (tiers: Tier[]) => missing.filter((c) => tiers.includes(tierOf(c)))
  const groups = groupByTier(characters)

  // Location reference generation state
  const activeLoc: Record<string, JobInfo | 'local'> = {}
  for (const j of locJobs) for (const lid of jobLocationIds(j as any)) activeLoc[lid] = j
  for (const lid of Object.keys(localLoc)) if (!activeLoc[lid]) activeLoc[lid] = 'local'
  const locReady = locations.filter((l) => validUrl(l.imageUrl)).length
  // Extra-angle job state (one location at a time)
  const activeExtra: Record<string, JobInfo | 'local'> = {}
  for (const j of locExtraJobs) { const lid = jobExtraLocationId(j as any); if (lid) activeExtra[lid] = j }
  for (const lid of Object.keys(localExtra)) if (!activeExtra[lid]) activeExtra[lid] = 'local'

  /** Bulk: generate references for the characters (without images) of the given tiers. */
  const startBulk = async (key: string, tiers?: Tier[]) => {
    setError(''); setBulk(key)
    try {
      const res = await fetch('/api/ai/characters/references', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, ...(tiers ? { tiers } : {}) }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data?.error ?? 'Failed to start generation'); return }
      if (data?.jobId) {
        const targets = tiers ? missingByTier(tiers) : missing
        setLocalGen((prev) => { const n = { ...prev }; for (const c of targets) n[c.id] = data.jobId; return n })
      }
      await tick()
    } catch { setError('Network error') }
    finally { setBulk('') }
  }

  // ---- Stage 46B-2: per-photo «Regenerate (one frame = CHARACTER_REFERENCE_COST), polled until done ----
  const [shotBusy, setShotBusy] = useState<Record<string, boolean>>({}) // key `${entityId}:${slot}`
  const shotKey = (entityId: string, slot: string, index?: number) => `${entityId}:${slot}${index !== undefined ? `-${index}` : ''}`
  const regenShot = async (kind: 'character' | 'location', entityId: string, slot: string, index?: number) => {
    const key = shotKey(entityId, slot, index)
    if (shotBusy[key]) return
    setError(''); setShotBusy((b) => ({ ...b, [key]: true }))
    try {
      const body = kind === 'character' ? { shot: slot, index } : { slot, index }
      const res = await fetch(`/api/ai/${kind === 'character' ? 'characters' : 'locations'}/${entityId}/shot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data?.error ?? 'Failed to regenerate photo'); return }
      for (let i = 0; i < 400 && data?.jobId && mounted.current; i++) {
        await new Promise((r) => setTimeout(r, 3000))
        const jr = await fetch(`/api/jobs/${data.jobId}`, { cache: 'no-store' }).catch(() => null)
        if (!jr || !jr.ok) continue
        const jd = await jr.json().catch(() => ({}))
        const st = jd?.job?.status
        if (st === 'completed') break
        if (st === 'failed' || st === 'canceled') { setError(jd?.job?.error ?? 'Photo regeneration failed'); break }
      }
      await tick()
    } catch { setError('Network error') } finally { setShotBusy((b) => { const n = { ...b }; delete n[key]; return n }) }
  }

  // ---- Stage 46E: prompt modal (characters + locations), delete frame, reset location prompt, downloads ----
  const [promptFor, setPromptFor] = useState<{ kind: 'character' | 'location'; id: string; name: string } | null>(null)
  const deleteFrame = async (locationId: string, slot: string, index?: number) => {
    setError('')
    const res = await fetch(`/api/ai/locations/${locationId}/frame`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot, index }) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data?.error ?? "Couldn't delete the shot"); return }
    if (data?.location) setLocations((prev) => prev.map((l) => (l.id === locationId ? { ...l, ...data.location } : l)))
  }
  const resetLocationPrompt = async (locationId: string) => {
    setError('')
    const res = await fetch(`/api/ai/locations/${locationId}/prompt`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reset: true }) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data?.error ?? "Couldn't reset the prompt"); return }
    setLocations((prev) => prev.map((l) => (l.id === locationId ? { ...l, visualPrompt: data.prompt, visualPromptAuto: data.autoPrompt } : l)))
  }
  // Stage 46E-1: reset character prompt override straight from the card (no modal)
  const [charResetting, setCharResetting] = useState<Record<string, boolean>>({})
  const resetCharacterPrompt = async (characterId: string) => {
    setError('')
    setCharResetting((prev) => ({ ...prev, [characterId]: true }))
    try {
      const res = await fetch(`/api/ai/characters/${characterId}/prompt`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: '' }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data?.error ?? "Couldn't reset the prompt"); return }
      setCharacters((prev) => prev.map((c) => (c.id === characterId ? { ...c, promptOverride: null } : c)))
    } finally {
      setCharResetting((prev) => ({ ...prev, [characterId]: false }))
    }
  }
  const locationFrameCount = (loc: LocationCardData) => [loc.imageUrl, loc.imageReverse, loc.imageDetail].filter(validUrl).length + parseExtra(loc.imageExtra).length
  const characterFrameCount = (c: RefCharacter) => [c.imageFront, c.imageProfile, c.imageFull].filter(validUrl).length + parseExtra(c.imageExtra).length

  const generateLocation = async (locationId: string) => {
    setError('')
    const res = await fetch(`/api/ai/locations/${locationId}/image`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) { setError(data?.error ?? 'Failed to start location generation'); return }
    if (data?.jobId) setLocalLoc((prev) => ({ ...prev, [locationId]: data.jobId }))
    await tick()
  }

  const generateExtraLocation = async (locationId: string) => {
    setError('')
    const res = await fetch(`/api/ai/locations/${locationId}/extra-images`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: EXTRA_ANGLES_PER_REQUEST }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data?.error ?? 'Failed to start generating additional angles'); return }
    if (data?.jobId) setLocalExtra((prev) => ({ ...prev, [locationId]: data.jobId }))
    await tick()
  }

  const reviseLocation = async (locationId: string, instruction: string) => {
    setError('')
    const res = await fetch(`/api/ai/locations/${locationId}/revise`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction, regenerate: true }),
    })
    const data = await res.json()
    if (!res.ok) { setError(data?.error ?? 'Failed to edit location'); return }
    if (data?.location) setLocations((prev) => prev.map((l) => (l.id === locationId ? { ...l, ...data.location, hasUndo: true } : l)))
    if (data?.jobId) setLocalLoc((prev) => ({ ...prev, [locationId]: data.jobId }))
    await tick()
  }

  // Stage 60: one-step undo — restore the previous location version (text + reference images).
  const undoLocation = async (locationId: string) => {
    setError('')
    const res = await fetch(`/api/ai/locations/${locationId}/undo`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data?.error ?? 'Failed to undo change'); return }
    if (data?.location) setLocations((prev) => prev.map((l) => (l.id === locationId ? { ...l, ...data.location, hasUndo: false } : l)))
    await tick()
  }

  /** (Re)start the project-wide reference job — idempotent on the server. */
  const startReferences = async () => {
    setError(''); setStarting(true)
    try {
      const res = await fetch(`/api/projects/${project.id}/approve-idea`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) { setError(data?.error ?? 'Failed to start generation'); return }
      await tick()
    } catch { setError('Network error') }
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
    if (!res.ok) { setError(data?.error ?? 'Failed to change appearance'); return }
    if (data?.character) setCharacters((prev) => prev.map((c) => (c.id === characterId ? { ...c, ...data.character, hasUndo: true } : c)))
    if (data?.jobId) setLocalGen((prev) => ({ ...prev, [characterId]: data.jobId }))
    await tick()
  }

  // Stage 60: one-step undo — restore the previous character version (appearance + reference images).
  const undoCharacter = async (characterId: string) => {
    setError('')
    const res = await fetch(`/api/ai/characters/${characterId}/undo`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data?.error ?? 'Failed to undo change'); return }
    if (data?.character) setCharacters((prev) => prev.map((c) => (c.id === characterId ? { ...c, ...data.character, hasUndo: false } : c)))
    await tick()
  }

  // Stage 11: cancel a running reference/location job (character batch, location, extra angles).
  // Sets cancelRequested server-side; the worker stops at its next checkpoint and keeps images already made.
  const cancelJob = async (jobId: string) => {
    try { await fetch(`/api/ai/jobs/${jobId}/cancel`, { method: 'POST' }) } catch {}
    await tick()
  }

  const continueToScript = async () => {
    setError(''); setContinuing(true)
    try {
      const res = await fetch(`/api/projects/${project.id}/continue-to-script`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) { setError(data?.error ?? "Couldn't continue"); return }
      onRefresh()
    } catch { setError('Network error') }
    finally { setContinuing(false) }
  }

  return (
    // Stage 85/86: location references render FIRST as a distinct highlighted block at the top
    // (order-first, larger cards) — it is the base layer of the scene; character reference blocks
    // follow below. The order is enforced by TYPE (the location section carries `order-first`, and
    // it is rendered from the dedicated `locations` relation — never mixed into the character groups),
    // so it holds for OLD projects too, regardless of the order records were created / returned by the
    // DB. Layout/render-order only; no generation logic changed.
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-border bg-card p-4 sm:p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="flex items-center gap-2 font-display text-xl font-bold">
            <Users className="h-5 w-5 text-primary" /> {optional ? 'References' : 'Step 2 — Characters (references)'}
          </h2>
          {/* Stage 74: reference-image provider (transport only; model fixed to Seedream 5.0 Pro). Always visible. */}
          <ProviderPicker kind="image" projectId={project.id} value={project?.imageProvider} compact onChange={onRefresh} />
        </div>
        {optional && (
          <p className="mt-1 text-sm text-muted-foreground">
            References are not required for the script — they are needed to generate scene videos: characters and locations will look consistent across all shots.
          </p>
        )}
        <p className="mt-1 text-sm text-muted-foreground">
          Photorealistic references are generated from each character's appearance description. Done: {readyCount} of {characters.length}.
          References are created automatically for main characters; supporting, episodic, and crowd/extras can be generated
          using the buttons below ({CHARACTER_REFERENCE_COST} cr. per character or group).
        </p>
        {error && <div className="mt-4 rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}
        {projectJob && (
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="references-progress">
            <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-primary" />
            <span className="min-w-0 flex-1 truncate">{projectJob.message ?? 'Generating references...'}</span>
            <span className="flex-shrink-0 tabular-nums">{Math.round(projectJob.progress)}%</span>
            <CancelButton onCancel={() => cancelJob(projectJob.id)} testId="references-cancel" />
          </div>
        )}
        {!anyActive && missing.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2" data-testid="references-bulk">
            {missingByTier(['MAIN']).length > 0 && (
              <button
                onClick={startReferences}
                disabled={starting || !!bulk}
                className="flex items-center gap-2 rounded-lg bg-secondary px-4 py-2 text-xs font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50"
                data-testid="references-start"
              >
                {starting ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Generate main characters ({missingByTier(['MAIN']).length} × {CHARACTER_REFERENCE_COST} cr.)
              </button>
            )}
            {missingByTier(['SUPPORTING']).length > 0 && (
              <button
                onClick={() => startBulk('supporting', ['SUPPORTING'])}
                disabled={starting || !!bulk}
                className="flex items-center gap-2 rounded-lg bg-secondary px-4 py-2 text-xs font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50"
                data-testid="references-start-supporting"
              >
                {bulk === 'supporting' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Users className="h-3 w-3" />}
                Generate supporting characters ({missingByTier(['SUPPORTING']).length} × {CHARACTER_REFERENCE_COST} cr.)
              </button>
            )}
            {missingByTier(['MINOR', 'CROWD']).length > 0 && (
              <button
                onClick={() => startBulk('minor', ['MINOR', 'CROWD'])}
                disabled={starting || !!bulk}
                className="flex items-center gap-2 rounded-lg bg-secondary px-4 py-2 text-xs font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50"
                data-testid="references-start-minor"
              >
                {bulk === 'minor' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Users className="h-3 w-3" />}
                Episodic characters and extras ({missingByTier(['MINOR', 'CROWD']).length} × {CHARACTER_REFERENCE_COST} cr.)
              </button>
            )}
            {missing.length > 1 && (
              <button
                onClick={() => startBulk('all')}
                disabled={starting || !!bulk}
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
                data-testid="references-start-all"
              >
                {bulk === 'all' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
                Generate all ({missing.length} × {CHARACTER_REFERENCE_COST} = {missing.length * CHARACTER_REFERENCE_COST} cr.)
              </button>
            )}
          </div>
        )}
      </div>

      {groups.map((g) => (
        <section key={g.tier} className="space-y-3" data-testid={`ref-group-${g.tier}`}>
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {TIER_LABELS[g.tier]} <span className="text-xs font-normal text-muted-foreground">· {g.items.filter(hasAnyImage).length} of {g.items.length} with references</span>
          </h3>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {g.items.map((c) => {
              const gen = activeGen[c.id]
              return (
                <CharacterCard
                  key={c.id}
                  char={c}
                  busy={!!gen}
                  onUndo={undoCharacter}
                  extra={
                    <>
                      <ReferenceImages char={c} generating={!!gen} message={gen && gen !== 'local' ? gen.message : null} onRegen={(shot) => regenShot('character', c.id, shot)} shotBusy={(shot) => !!shotBusy[shotKey(c.id, shot)]} />
                      {/* Stage 75: user-uploaded photo references (fed as image_input to every reference shot) */}
                      <CharacterUserRefs characterId={c.id} userRefs={c.userRefs} disabled={!!c.refLocked} />
                      {/* Stage 46E: prompt view/edit + download all */}
                      <div className="mb-3 flex flex-wrap items-center gap-1.5">
                        <button type="button" onClick={() => setPromptFor({ kind: 'character', id: c.id, name: c.name })} className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs" data-testid="character-prompt" title="View, copy, or edit the character prompt">
                          <FileText className="h-3.5 w-3.5" /> Prompt
                        </button>
                        <DownloadAllButton kind="character" id={c.id} count={characterFrameCount(c)} />
                        <button type="button" disabled={!!gen || !!charResetting[c.id]} onClick={() => resetCharacterPrompt(c.id)} className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50" data-testid="char-prompt-reset" title="Remove manual prompt and restore automatic">
                            {charResetting[c.id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Reset prompt to auto
                          </button>
                        {!!(c.promptOverride && c.promptOverride.trim()) && <span className="rounded bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary" data-testid="character-prompt-override">Prompt changed manually</span>}
                      </div>
                    </>
                  }
                  footer={<AppearanceEditor characterId={c.id} disabled={!!gen} onSubmit={changeAppearance} />}
                />
              )
            })}
          </div>
        </section>
      ))}

      {/* Stage 85: highlighted, order-first block — the location is the base layer of the scene. */}
      <section className="order-first rounded-xl border-2 border-primary/40 bg-primary/5 p-4 sm:p-6" style={{ boxShadow: 'var(--shadow-md)' }} data-testid="location-references">
        <h2 className="flex flex-wrap items-center gap-2 font-display text-xl font-bold">
          <MapPin className="h-5 w-5 text-primary" /> Location references
          <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">Base scene layer — created first</span>
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A photorealistic shot of each location without people (9:16). It is passed to the video model along with the characters so the setting
          looked the same in all scenes. Done: {locReady} of {locations.length}. Cost — {CHARACTER_REFERENCE_COST} cr. per location.
        </p>
        <div className="mt-4">
          <AddLocationForm projectId={project.id} onAdded={(loc) => setLocations((prev) => [...prev, loc])} onError={setError} />
        </div>
        {/* Stage 85: fewer columns than the character grid (lg:grid-cols-3) → location cards render slightly larger. */}
        {locations.length > 0 && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-2">
            {locations.map((loc) => {
              const gen = activeLoc[loc.id]
              const has = validUrl(loc.imageUrl)
              return (
                <LocationCard
                  key={loc.id}
                  loc={loc}
                  busy={!!gen}
                  onRevise={reviseLocation}
                  onUndo={undoLocation}
                  hasPromptOverride={loc.visualPromptAuto != null && (loc.visualPrompt ?? '').trim() !== (loc.visualPromptAuto ?? '').trim()}
                  onOpenPrompt={() => setPromptFor({ kind: 'location', id: loc.id, name: loc.name })}
                  onResetPrompt={() => resetLocationPrompt(loc.id)}
                  media={
                    <div className="group relative mb-3 aspect-[9/16] max-h-80 w-full overflow-hidden rounded-lg bg-muted">
                      {has ? (
                        <>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={loc.imageUrl as string} alt={loc.name} className="h-full w-full object-cover" data-testid="location-image" />
                          <FrameToolbar
                            regen={{ testId: 'regen-shot-master', busy: !!gen || !!activeExtra[loc.id], spinning: !!shotBusy[shotKey(loc.id, 'master')], onClick: () => regenShot('location', loc.id, 'master') }}
                            download={{ url: loc.imageUrl as string, name: referenceFileName('location', loc.name, 'master', loc.imageUrl as string) }}
                            del={{ testId: 'delete-shot-master', onClick: () => deleteFrame(loc.id, 'master'), disabled: !!gen || !!activeExtra[loc.id] || locationFrameCount(loc) <= 1, disabledTitle: locationFrameCount(loc) <= 1 ? 'At least one frame' : 'Wait for generation to finish' }}
                          />
                        </>
                      ) : gen ? (
                        <div className="flex h-full w-full items-center justify-center" data-testid="location-spinner">
                          <Loader2 className="h-5 w-5 animate-spin text-primary" />
                        </div>
                      ) : (
                        <div className="flex h-full w-full items-center justify-center bg-muted/50"><ImageOff className="h-5 w-5 text-muted-foreground/40" /></div>
                      )}
                      {gen && has && (
                        <div className="absolute inset-0 flex items-center justify-center bg-background/60"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
                      )}
                    </div>
                  }
                  footer={
                    <div className="mt-3 border-t border-border pt-3">
                      {has && (validUrl(loc.imageReverse) || validUrl(loc.imageDetail)) && (
                        /* Stage 46E: angle frames as full tiles with an always-visible toolbar (regen / download / delete). */
                        <div className="mb-3 flex flex-wrap gap-2" data-testid="location-angles">
                          {[{ url: loc.imageReverse, label: 'Reverse angle', slot: 'reverse' }, { url: loc.imageDetail, label: 'Medium shot', slot: 'detail' }].filter((a) => validUrl(a.url)).map((a) => (
                            <span key={a.label} className="relative block h-40 w-24 overflow-hidden rounded bg-muted" title={a.label}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={a.url as string} alt={`${loc.name} — ${a.label}`} className="h-full w-full object-cover" />
                              <FrameToolbar
                                regen={{ testId: `regen-shot-${a.slot}`, busy: !!gen || !!activeExtra[loc.id], spinning: !!shotBusy[shotKey(loc.id, a.slot)], onClick: () => regenShot('location', loc.id, a.slot) }}
                                download={{ url: a.url as string, name: referenceFileName('location', loc.name, a.slot, a.url as string) }}
                                del={{ testId: `delete-shot-${a.slot}`, onClick: () => deleteFrame(loc.id, a.slot), disabled: !!gen || !!activeExtra[loc.id] || locationFrameCount(loc) <= 1, disabledTitle: locationFrameCount(loc) <= 1 ? 'At least one frame' : 'Wait for generation to finish' }}
                              />
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        <DownloadAllButton kind="location" id={loc.id} count={locationFrameCount(loc)} />
                        <button
                          type="button"
                          onClick={() => generateLocation(loc.id)}
                          disabled={!!gen}
                          className="flex items-center gap-1 rounded-lg bg-muted px-3 py-1.5 text-xs transition hover:bg-muted/80 disabled:opacity-50"
                          data-testid="location-generate"
                        >
                          {gen ? <Loader2 className="h-3 w-3 animate-spin" /> : <Camera className="h-3 w-3" />}
                          {gen ? 'Generating…' : has ? `Regenerate (${CHARACTER_REFERENCE_COST} cr.)` : `Generate reference (${CHARACTER_REFERENCE_COST} cr.)`}
                        </button>
                        {gen && gen !== 'local' && <CancelButton onCancel={() => cancelJob((gen as JobInfo).id)} testId="location-cancel" />}
                      </div>
                      <p className="mt-2 text-[11px] text-muted-foreground">3 angles of the same place (wide, reverse, medium), same lighting — all go to Seedance as references.</p>
                      {has && (() => {
                        const extras = parseExtra(loc.imageExtra)
                        const extraJob = activeExtra[loc.id]
                        const busyExtra = !!extraJob
                        return (
                          <div className="mt-3 border-t border-border/60 pt-3" data-testid="location-extra">
                            {extras.length > 0 && (
                              <div className="mb-2 flex flex-wrap gap-2" data-testid="location-extra-thumbs">
                                {extras.map((url, i) => (
                                  <span key={url} className="relative block h-40 w-24 overflow-hidden rounded bg-muted" title={`${i + 1}. ${locationExtraLabel(i)}`}>
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={url} alt={`${loc.name} — ${locationExtraLabel(i)}`} className="h-full w-full object-cover" />
                                    <FrameToolbar
                                      regen={{ testId: `regen-shot-extra-${i}`, busy: !!gen || busyExtra, spinning: !!shotBusy[shotKey(loc.id, 'extra', i)], onClick: () => regenShot('location', loc.id, 'extra', i) }}
                                      download={{ url, name: referenceFileName('location', loc.name, 'extra', url, i) }}
                                      del={{ testId: `delete-shot-extra-${i}`, onClick: () => deleteFrame(loc.id, 'extra', i), disabled: !!gen || busyExtra || locationFrameCount(loc) <= 1, disabledTitle: locationFrameCount(loc) <= 1 ? 'At least one frame' : 'Wait for generation to finish' }}
                                    />
                                  </span>
                                ))}
                              </div>
                            )}
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => generateExtraLocation(loc.id)}
                                disabled={busyExtra}
                                className="flex items-center gap-1 rounded-lg bg-muted px-3 py-1.5 text-xs transition hover:bg-muted/80 disabled:opacity-50"
                                data-testid="location-extra-generate"
                              >
                                {busyExtra ? <Loader2 className="h-3 w-3 animate-spin" /> : <Camera className="h-3 w-3" />}
                                {busyExtra ? 'Generating…' : `Add more angles/shots (${EXTRA_ANGLES_PER_REQUEST} × ${CHARACTER_REFERENCE_COST} = ${EXTRA_ANGLES_PER_REQUEST * CHARACTER_REFERENCE_COST} cr.)`}
                              </button>
                              {extraJob && extraJob !== 'local' && <CancelButton onCancel={() => cancelJob((extraJob as JobInfo).id)} testId="location-extra-cancel" />}
                            </div>
                            <p className="mt-1.5 text-[11px] text-muted-foreground">More angles and location details — same lighting, no people. Helps add variety to scene shots.</p>
                          </div>
                        )
                      })()}
                    </div>
                  }
                />
              )
            })}
          </div>
        )}
      </section>

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
            if (promptFor.kind === 'character') setCharacters((prev) => prev.map((c) => (c.id === promptFor.id ? { ...c, promptOverride: hasOverride ? prompt : null } : c)))
            else setLocations((prev) => prev.map((l) => (l.id === promptFor.id ? { ...l, visualPrompt: prompt, visualPromptAuto: hasOverride ? l.visualPromptAuto ?? null : prompt } : l)))
          }}
        />
      )}

      {!optional && <button
        onClick={continueToScript}
        disabled={continuing || readyCount === 0}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-3 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
        data-testid="continue-to-script"
      >
        {continuing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
        Continue to script
      </button>}
      {!optional && readyCount === 0 && (
        <p className="-mt-3 text-center text-xs text-muted-foreground">
          The button will become available once at least one reference is ready.
        </p>
      )}
    </div>
  )
}

function ReferenceImages({ char, generating, message, onRegen, shotBusy }: { char: RefCharacter; generating: boolean; message?: string | null; onRegen: (shot: string) => void; shotBusy?: (shot: string) => boolean }) {
  // Stage 55: one standard reference per character — the full-body front (imageFull). It is displayed at
  // its native vertical 9:16 aspect (not cropped into a 3:4 box, which used to cut off the head and feet and
  // made the figure look short/cropped). Legacy characters that only kept the old front portrait fall back
  // to it; the regenerate / download actions always target the full-body shot.
  const img = validUrl(char.imageFull) ? char.imageFull : char.imageFront
  return (
    <div className="mb-3">
      <div className="group relative mx-auto aspect-[9/16] w-full max-w-[13rem] overflow-hidden rounded-lg bg-muted" title={FULL_BODY_LABEL}>
        {validUrl(img) ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img as string} alt={`${char.name} — ${FULL_BODY_LABEL}`} className="h-full w-full object-contain" data-testid="reference-image" />
            <FrameToolbar
              regen={{ testId: 'regen-shot-full', busy: generating, spinning: !!shotBusy?.('full'), onClick: () => onRegen('full') }}
              download={{ url: img as string, name: referenceFileName('character', char.name, 'full', img as string) }}
            />
          </>
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
      {generating && (
        <p className="mt-1.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground" data-testid="reference-status">
          <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin text-primary" />
          <span className="truncate">{message || 'Generating references...'}</span>
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
      <label className="block text-xs font-medium">Edit appearance</label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        disabled={disabled || sending}
        placeholder="For example: short gray haircut, thin-rimmed glasses"
        className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-xs outline-none focus:border-primary"
        data-testid="appearance-input"
      />
      <button
        type="button"
        onClick={submit}
        disabled={disabled || sending || !text.trim()}
        className="flex items-center gap-1 rounded-lg bg-muted px-3 py-1.5 text-xs transition hover:bg-muted/80 disabled:opacity-50"
        data-testid="appearance-submit"
        title="Updates the appearance description and regenerates references (1 credit)"
      >
        {sending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
        Update and regenerate (1 credit)
      </button>
    </div>
  )
}
