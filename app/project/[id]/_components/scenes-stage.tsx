'use client'

import { useState, useEffect, useRef } from 'react'
import { Loader2, Play, Check, RefreshCw, Edit2, Film, ChevronDown, ChevronRight, Zap } from 'lucide-react'
import { JobProgressBar, type JobInfo, type JobPollResponse, JOB_POLL_INTERVAL_MS } from './use-job-polling'

const VIDEO_EXPECTED_SEC = 600 // ~10 min: Seedance renders a 15 s clip with native audio + upload

/**
 * Scene player: Seedance video with native audio (speech + ambience baked into the clip).
 * The audioUrl prop is kept for backward-compatibility with older scenes but is no longer generated.
 */
function SceneVideoPlayer({
  videoUrl,
  audioUrl,
  poster,
  className,
}: {
  videoUrl: string
  audioUrl?: string | null
  poster?: string | null
  className?: string
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  const syncTime = () => {
    const v = videoRef.current
    const a = audioRef.current
    if (!v || !a) return
    if (Math.abs(a.currentTime - v.currentTime) > 0.25) a.currentTime = v.currentTime
  }

  const handlePlay = () => {
    const a = audioRef.current
    if (!a) return
    syncTime()
    a.play().catch(() => {})
  }
  const handlePause = () => audioRef.current?.pause()
  const handleRateChange = () => {
    const v = videoRef.current
    const a = audioRef.current
    if (v && a) a.playbackRate = v.playbackRate
  }
  const handleVolumeChange = () => {
    const v = videoRef.current
    const a = audioRef.current
    if (v && a) {
      a.volume = v.volume
      a.muted = v.muted
    }
  }
  const handleEnded = () => {
    const a = audioRef.current
    if (a) {
      a.pause()
      a.currentTime = 0
    }
  }

  // Stop the voiceover if the component unmounts mid-playback
  useEffect(() => () => audioRef.current?.pause(), [])

  return (
    <>
      <video
        ref={videoRef}
        src={videoUrl}
        controls
        playsInline
        preload="auto"
        poster={poster ?? undefined}
        className={className}
        onPlay={handlePlay}
        onPause={handlePause}
        onSeeked={syncTime}
        onSeeking={handlePause}
        onRateChange={handleRateChange}
        onVolumeChange={handleVolumeChange}
        onEnded={handleEnded}
      />
      {audioUrl && <audio ref={audioRef} src={audioUrl} preload="auto" className="hidden" />}
    </>
  )
}

export function ScenesStage({ project, onRefresh }: { project: any; onRefresh: () => void }) {
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null)
  /** episodeId -> its scenes. Kept per-episode so switching episodes is instant and
   *  never wipes/reflows the panel (no flashing), and lets several episodes render at once. */
  const [scenesByEp, setScenesByEp] = useState<Record<string, any[]>>({})
  /** episodeId -> true while its scenes are being (re)generated (independent per episode). */
  const [generatingEps, setGeneratingEps] = useState<Record<string, boolean>>({})
  /** episodeId -> true while it is being assembled. */
  const [assemblingEps, setAssemblingEps] = useState<Record<string, boolean>>({})
  /** episodeId -> freshly assembled video URL (optimistic, before project refetch lands). */
  const [episodeVideo, setEpisodeVideo] = useState<Record<string, string>>({})
  /** sceneId -> job being polled (or just finished, kept briefly for the 100% state) */
  const [videoJobs, setVideoJobs] = useState<Record<string, JobInfo>>({})
  const [startingVideo, setStartingVideo] = useState<string | null>(null)
  /** episodeId -> true while the "Generate all scenes" batch request is being dispatched. */
  const [startingBatch, setStartingBatch] = useState<Record<string, boolean>>({})
  // Per-scene spoken language for native audio ("en" default, or "ru"). Local override
  // of whatever is stored on the scene; applied when the scene's video is generated.
  const [sceneLang, setSceneLang] = useState<Record<string, string>>({})
  const langOf = (scene: any): string => sceneLang[scene?.id] ?? scene?.language ?? 'en'
  /** Spoken language for the "Generate all scenes" batch (EN default, RU optional). */
  const [batchLang, setBatchLang] = useState<'en' | 'ru'>('en')
  const pollTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const [error, setError] = useState('')
  const [expandedSeason, setExpandedSeason] = useState<string | null>(null)

  const allSeasons = project?.seasons ?? []
  const allEpisodes: any[] = allSeasons.flatMap((s: any) => s?.episodes ?? [])
  const findEpisode = (epId: string | null) =>
    epId ? allEpisodes.find((e: any) => e?.id === epId) ?? null : null

  // Derived view for the currently-open episode (no stale local copy → no flash on refresh).
  const selectedEpisodeRaw = findEpisode(selectedEpisodeId)
  const selectedEpisode = selectedEpisodeRaw
    ? { ...selectedEpisodeRaw, videoUrl: episodeVideo[selectedEpisodeId!] ?? selectedEpisodeRaw.videoUrl }
    : null
  const scenes: any[] = selectedEpisodeId
    ? scenesByEp[selectedEpisodeId] ?? selectedEpisodeRaw?.scenes ?? []
    : []
  const generating = selectedEpisodeId ? !!generatingEps[selectedEpisodeId] : false
  const assembling = selectedEpisodeId ? !!assemblingEps[selectedEpisodeId] : false

  /** Replace/patch the scene list of a specific episode. */
  const setEpScenes = (epId: string, next: any[]) =>
    setScenesByEp((prev) => ({ ...prev, [epId]: next }))

  /** Patch a single scene wherever it lives (works across episodes rendering concurrently). */
  const patchScene = (sceneId: string, patch: any) =>
    setScenesByEp((prev) => {
      const next = { ...prev }
      for (const epId of Object.keys(next)) {
        const arr = next[epId]
        if (arr?.some((s: any) => s?.id === sceneId)) {
          next[epId] = arr.map((s: any) =>
            s?.id === sceneId ? { ...s, ...(typeof patch === 'function' ? patch(s) : patch) } : s
          )
        }
      }
      return next
    })

  const selectEpisode = (episode: any) => {
    const epId = episode?.id
    if (!epId) return
    setSelectedEpisodeId(epId)
    // Seed this episode's scenes once (from what the server already sent) — instant, no wipe.
    const existing = scenesByEp[epId] ?? episode?.scenes ?? []
    if (!scenesByEp[epId]) setScenesByEp((prev) => ({ ...prev, [epId]: existing }))
    if (existing.length === 0 && !generatingEps[epId]) generateScenes(epId)
  }

  const generateScenes = async (episodeId: string) => {
    if (!episodeId || generatingEps[episodeId]) return
    setGeneratingEps((prev) => ({ ...prev, [episodeId]: true }))
    setError('')
    try {
      const res = await fetch('/api/ai/scenes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project?.id, episodeId }),
      })
      const data = await res.json()
      if (data?.scenes) setEpScenes(episodeId, data.scenes)
      else setError(data?.error ?? 'Generation failed')
    } catch { setError('Network error') }
    finally { setGeneratingEps((prev) => ({ ...prev, [episodeId]: false })) }
  }

  const stopPolling = (sceneId: string) => {
    const t = pollTimers.current[sceneId]
    if (t) clearTimeout(t)
    delete pollTimers.current[sceneId]
  }

  /** Poll GET /api/jobs/[id] every 3 s for one scene's video job. */
  const pollVideoJob = (sceneId: string, jobId: string) => {
    stopPolling(sceneId)
    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' })
        if (res.status === 404) { stopPolling(sceneId); return }
        const data: JobPollResponse = await res.json()
        if (data?.job) {
          setVideoJobs((prev) => ({ ...prev, [sceneId]: data.job }))
          if (data.job.status === 'completed' || data.job.status === 'failed') {
            stopPolling(sceneId)
            if (data.job.status === 'failed') setError(data.job.error ?? 'Video generation failed')
            const updatedScene = data.scene ?? data.job.result?.scene
            if (updatedScene) {
              patchScene(sceneId, updatedScene)
            }
            // Keep the 100% / failed bar visible briefly, then hide it
            setTimeout(() => {
              setVideoJobs((prev) => {
                const next = { ...prev }
                if (next[sceneId]?.id === jobId) delete next[sceneId]
                return next
              })
            }, 2500)
            return
          }
        }
      } catch {
        // transient network error — keep polling
      }
      pollTimers.current[sceneId] = setTimeout(tick, JOB_POLL_INTERVAL_MS)
    }
    tick()
  }

  // Stop all pollers on unmount
  useEffect(() => () => { Object.values(pollTimers.current).forEach(clearTimeout) }, [])

  // Resume polling for EVERY active video job across the project (any episode),
  // so multiple episodes can render at once and survive a refresh without flicker.
  useEffect(() => {
    if (!project?.id) return
    // Map sceneId -> episodeId from the server data, so we can seed the right episode.
    const sceneToEp: Record<string, string> = {}
    for (const ep of allEpisodes) {
      for (const sc of ep?.scenes ?? []) if (sc?.id) sceneToEp[sc.id] = ep.id
    }
    let cancelled = false
    fetch(`/api/jobs?projectId=${project.id}&type=video&active=1`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return
        for (const j of data?.jobs ?? []) {
          if (j?.sceneId && !pollTimers.current[j.sceneId]) {
            // Make sure the owning episode's scenes are loaded so patchScene can update them.
            const epId = sceneToEp[j.sceneId]
            if (epId) {
              setScenesByEp((prev) =>
                prev[epId] ? prev : { ...prev, [epId]: findEpisode(epId)?.scenes ?? [] }
              )
            }
            setVideoJobs((prev) => ({ ...prev, [j.sceneId]: j }))
            pollVideoJob(j.sceneId, j.id)
          }
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])

  const generateVideo = async (sceneId: string, language?: string) => {
    setStartingVideo(sceneId)
    setError('')
    try {
      const res = await fetch('/api/ai/generate-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project?.id, sceneId, language }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.jobId) {
        setError(data?.error ?? 'Video generation failed')
        return
      }
      patchScene(sceneId, { status: 'generating' })
      pollVideoJob(sceneId, data.jobId)
    } catch { setError('Network error') }
    finally { setStartingVideo(null) }
  }

  /**
   * Generate video for EVERY scene of the episode at once — they render in PARALLEL.
   * Each returned job is polled independently. Scenes with an already-running job are
   * resumed (never double-charged). If you dislike a scene, tweak its prompt and hit
   * the per-scene Regenerate button — only that scene reruns.
   */
  const generateEpisodeVideos = async (episodeId?: string, language?: string) => {
    const epId = episodeId ?? selectedEpisodeId
    if (!epId || startingBatch[epId]) return
    setStartingBatch((prev) => ({ ...prev, [epId]: true }))
    setError('')
    try {
      const res = await fetch('/api/ai/generate-episode-videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project?.id, episodeId: epId, language }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !Array.isArray(data?.jobs)) {
        setError(data?.error ?? 'Batch generation failed')
        return
      }
      for (const j of data.jobs as Array<{ sceneId: string; jobId: string }>) {
        patchScene(j.sceneId, { status: 'generating' })
        pollVideoJob(j.sceneId, j.jobId)
      }
      if (data.jobs.length === 0) {
        setError(data?.skipped ? 'All scenes already running or out of credits' : 'No scenes to generate')
      }
    } catch { setError('Network error') }
    finally { setStartingBatch((prev) => ({ ...prev, [epId]: false })) }
  }

  const acceptScene = async (sceneId: string) => {
    try {
      const res = await fetch('/api/ai/accept-scene', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sceneId }),
      })
      const data = await res.json()
      if (data?.scene) {
        patchScene(sceneId, data.scene)
      }
    } catch {}
  }

  const assembleEpisode = async (episodeId?: string) => {
    const epId = episodeId ?? selectedEpisodeId
    if (!epId) return
    setAssemblingEps((prev) => ({ ...prev, [epId]: true }))
    setError('')
    try {
      const res = await fetch('/api/ai/assemble-episode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodeId: epId }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.videoUrl) {
        setEpisodeVideo((prev) => ({ ...prev, [epId]: data.videoUrl }))
        onRefresh()
      } else {
        setError(data?.error || 'Assembly failed')
      }
    } catch { setError('Assembly failed') }
    finally { setAssemblingEps((prev) => ({ ...prev, [epId]: false })) }
  }

  const isSceneBusy = (sceneId: string) => {
    if (startingVideo === sceneId) return true
    const j = videoJobs[sceneId]
    return !!j && (j.status === 'processing' || j.status === 'pending')
  }

  /**
   * Is ANY work running for this episode — scene-list generation, a scene video
   * rendering, or assembly? Used to keep an activity spinner in the episode tree so
   * it never disappears when you switch to another episode to start it too.
   */
  const isEpisodeBusy = (ep: any): boolean => {
    const epId = ep?.id
    if (!epId) return false
    if (generatingEps[epId] || assemblingEps[epId]) return true
    const scs = scenesByEp[epId] ?? ep?.scenes ?? []
    return scs.some((s: any) => isSceneBusy(s?.id))
  }

  const allAccepted = (scenes ?? []).length > 0 && (scenes ?? []).every((s: any) => s?.status === 'accepted')

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
        <h2 className="font-display text-xl font-bold">Stage 4 — Scenes & Video</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Select an episode, generate scenes, then generate video for each scene.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        {/* Episode Tree */}
        <div className="space-y-2">
          {(allSeasons ?? []).map((season: any) => (
            <div key={season?.id} className="rounded-xl border border-border bg-card overflow-hidden">
              <button
                onClick={() =>
                  setExpandedSeason(expandedSeason === season?.id ? null : season?.id)
                }
                className="flex w-full items-center justify-between p-3 text-left text-sm font-medium hover:bg-muted/30 transition"
              >
                Season {season?.number ?? '?'}
                {expandedSeason === season?.id ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </button>
              {expandedSeason === season?.id && (
                <div className="border-t border-border">
                  {(season?.episodes ?? []).map((ep: any) => (
                    <button
                      key={ep?.id}
                      onClick={() => selectEpisode(ep)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition hover:bg-muted/30 ${
                        selectedEpisode?.id === ep?.id ? 'bg-primary/10 text-primary' : 'text-muted-foreground'
                      }`}
                    >
                      <Film className="h-3 w-3 flex-shrink-0" />
                      <span className="truncate">Ep. {ep?.number}: {ep?.title ?? 'Untitled'}</span>
                      {isEpisodeBusy(ep) ? (
                        <Loader2 className="ml-auto h-3 w-3 flex-shrink-0 animate-spin text-primary" />
                      ) : (
                        ep?.videoUrl && <Check className="ml-auto h-3 w-3 text-green-400" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Scenes Panel */}
        <div>
          {!selectedEpisode ? (
            <div className="flex h-60 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted-foreground">
              Select an episode from the left
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold">
                  Ep. {selectedEpisode?.number}: {selectedEpisode?.title ?? ''}
                </h3>
                {selectedEpisode?.videoUrl && (
                  <span className="rounded-full bg-green-500/10 px-3 py-1 text-xs font-medium text-green-400">
                    ✅ Assembled
                  </span>
                )}
              </div>

              {/* Generate ALL scenes of the episode at once — they render in parallel.
                  Dislike one? Tweak its prompt and hit that scene's Regenerate button. */}
              {(scenes ?? []).length > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3" style={{ boxShadow: 'var(--shadow-sm)' }}>
                  <div className="flex items-center overflow-hidden rounded-lg border border-border text-xs">
                    {(['en', 'ru'] as const).map((lng) => (
                      <button
                        key={lng}
                        type="button"
                        onClick={() => setBatchLang(lng)}
                        disabled={!!startingBatch[selectedEpisodeId!]}
                        className={`px-2.5 py-1.5 font-medium transition disabled:opacity-50 ${
                          batchLang === lng
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-card text-muted-foreground hover:bg-muted/40'
                        }`}
                      >
                        {lng === 'en' ? 'EN' : 'RU'}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => generateEpisodeVideos(selectedEpisodeId!, batchLang)}
                    disabled={!!startingBatch[selectedEpisodeId!]}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
                  >
                    {startingBatch[selectedEpisodeId!] ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Zap className="h-4 w-4" />
                    )}
                    Generate all scenes
                  </button>
                </div>
              )}

              {/* Non-destructive loading banner: the panel stays mounted so nothing
                  flashes away and back while scenes are (re)generated. */}
              {generating && (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  {(scenes ?? []).length ? 'Regenerating scenes…' : 'Generating scenes…'}
                </div>
              )}

              {/* Skeleton placeholders keep the layout height stable on first generation */}
              {generating && (scenes ?? []).length === 0 && (
                <div className="space-y-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-28 animate-pulse rounded-xl border border-border bg-card" />
                  ))}
                </div>
              )}

              {selectedEpisode?.videoUrl && (
                <div className="overflow-hidden rounded-xl border border-border bg-card p-4" style={{ boxShadow: 'var(--shadow-sm)' }}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-muted-foreground">Assembled Episode</p>
                    {allAccepted && (
                      <button
                        onClick={() => assembleEpisode()}
                        disabled={assembling}
                        title="Re-run assembly of all accepted scenes (replaces the current video)"
                        className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium transition hover:bg-muted disabled:opacity-50"
                      >
                        {assembling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                        {assembling ? 'Reassembling…' : 'Reassemble Episode'}
                      </button>
                    )}
                  </div>
                  {assembling && (
                    <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
                    </div>
                  )}
                  <div className={`aspect-[9/16] max-h-[500px] overflow-hidden rounded-lg bg-muted ${assembling ? 'opacity-60' : ''}`}>
                    <video
                      key={selectedEpisode.videoUrl}
                      src={selectedEpisode.videoUrl}
                      controls
                      playsInline
                      preload="auto"
                      poster={selectedEpisode?.posterUrl ?? undefined}
                      className="h-full w-full object-contain"
                    />
                  </div>
                </div>
              )}

              {error && <div className="rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}

              {(scenes ?? []).map((scene: any) => (
                <div
                  key={scene?.id}
                  className="rounded-xl border border-border bg-card p-4"
                  style={{ boxShadow: 'var(--shadow-sm)' }}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium">Scene {scene?.number ?? '?'}</span>
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${
                        scene?.status === 'accepted'
                          ? 'bg-green-500/10 text-green-400'
                          : scene?.status === 'generated'
                          ? 'bg-yellow-500/10 text-yellow-400'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {scene?.status ?? 'pending'}
                    </span>
                  </div>

                  <div className="mb-3 space-y-1 text-xs text-muted-foreground">
                    {scene?.dialogue && <p><span className="font-medium text-foreground">Dialogue:</span> {scene.dialogue}</p>}
                    {scene?.locationDesc && <p><span className="font-medium text-foreground">Location:</span> {scene.locationDesc}</p>}
                    {scene?.videoPrompt && <p><span className="font-medium text-foreground">Prompt:</span> {scene.videoPrompt}</p>}
                  </div>

                  {scene?.videoUrl && (
                    <div className="mb-3 aspect-[9/16] max-h-[400px] overflow-hidden rounded-lg bg-muted">
                      <SceneVideoPlayer
                        videoUrl={scene.videoUrl}
                        audioUrl={scene?.audioUrl}
                        poster={scene?.posterUrl}
                        className="h-full w-full object-contain"
                      />
                    </div>
                  )}

                  {startingVideo === scene?.id && !videoJobs[scene?.id] && (
                    <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin text-primary" /> Starting video generation...
                    </div>
                  )}
                  {videoJobs[scene?.id] && (
                    <JobProgressBar job={videoJobs[scene?.id]} expectedTotalSec={VIDEO_EXPECTED_SEC} className="mb-3" />
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    {scene?.status !== 'accepted' && (
                      <>
                        {/* Per-scene spoken language for the native voices (EN default, RU optional) */}
                        <div className="flex items-center overflow-hidden rounded-lg border border-border text-xs">
                          {(['en', 'ru'] as const).map((lng) => (
                            <button
                              key={lng}
                              type="button"
                              onClick={() => setSceneLang((prev) => ({ ...prev, [scene?.id]: lng }))}
                              disabled={isSceneBusy(scene?.id)}
                              className={`px-2.5 py-1.5 font-medium transition disabled:opacity-50 ${
                                langOf(scene) === lng
                                  ? 'bg-primary text-primary-foreground'
                                  : 'bg-card text-muted-foreground hover:bg-muted/40'
                              }`}
                            >
                              {lng === 'en' ? 'EN' : 'RU'}
                            </button>
                          ))}
                        </div>
                        <button
                          onClick={() => generateVideo(scene?.id ?? '', langOf(scene))}
                          disabled={isSceneBusy(scene?.id)}
                          className="flex items-center gap-1 rounded-lg bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground transition hover:brightness-110 disabled:opacity-50"
                        >
                          {isSceneBusy(scene?.id) ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Play className="h-3 w-3" />
                          )}
                          {scene?.videoUrl ? 'Regenerate' : 'Generate Video'}
                        </button>
                        {scene?.videoUrl && (
                          <button
                            onClick={() => acceptScene(scene?.id ?? '')}
                            className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:brightness-110"
                          >
                            <Check className="h-3 w-3" /> Accept
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}

              {allAccepted && !selectedEpisode?.videoUrl && (
                <button
                  onClick={() => assembleEpisode()}
                  disabled={assembling}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-3 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
                >
                  {assembling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Film className="h-4 w-4" />}
                  Assemble Episode
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
