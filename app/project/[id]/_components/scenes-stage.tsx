'use client'

import { useState, useEffect, useRef } from 'react'
import { Loader2, Play, Check, RefreshCw, Edit2, Film, ChevronDown, ChevronRight } from 'lucide-react'
import { JobProgressBar, type JobInfo, type JobPollResponse, JOB_POLL_INTERVAL_MS } from './use-job-polling'

const VIDEO_EXPECTED_SEC = 200 // ~3 min Seedance + TTS + upload

/**
 * Scene player: silent Seedance video + ElevenLabs voiceover kept in sync.
 * The <audio> element is hidden and mirrors the video's play/pause/seek/rate.
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
  const [selectedEpisode, setSelectedEpisode] = useState<any>(null)
  const [scenes, setScenes] = useState<any[]>([])
  const [generating, setGenerating] = useState(false)
  /** sceneId -> job being polled (or just finished, kept briefly for the 100% state) */
  const [videoJobs, setVideoJobs] = useState<Record<string, JobInfo>>({})
  const [startingVideo, setStartingVideo] = useState<string | null>(null)
  const pollTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const [assembling, setAssembling] = useState(false)
  const [error, setError] = useState('')
  const [expandedSeason, setExpandedSeason] = useState<string | null>(null)

  const allSeasons = project?.seasons ?? []

  const selectEpisode = async (episode: any) => {
    setSelectedEpisode(episode)
    setScenes(episode?.scenes ?? [])
    if ((episode?.scenes?.length ?? 0) === 0) {
      await generateScenes(episode?.id)
    }
  }

  const generateScenes = async (episodeId: string) => {
    setGenerating(true)
    setError('')
    try {
      const res = await fetch('/api/ai/scenes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project?.id, episodeId }),
      })
      const data = await res.json()
      if (data?.scenes) setScenes(data.scenes)
      else setError(data?.error ?? 'Generation failed')
    } catch { setError('Network error') }
    finally { setGenerating(false) }
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
              setScenes((prev) => (prev ?? []).map((sc: any) => (sc?.id === sceneId ? { ...sc, ...updatedScene } : sc)))
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

  // On episode change: resume polling for any video jobs still running for its scenes
  useEffect(() => {
    if (!project?.id || !selectedEpisode?.id) return
    const sceneIds = new Set((selectedEpisode?.scenes ?? scenes ?? []).map((sc: any) => sc?.id))
    let cancelled = false
    fetch(`/api/jobs?projectId=${project.id}&type=video&active=1`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return
        for (const j of data?.jobs ?? []) {
          if (j?.sceneId && sceneIds.has(j.sceneId) && !pollTimers.current[j.sceneId]) {
            setVideoJobs((prev) => ({ ...prev, [j.sceneId]: j }))
            pollVideoJob(j.sceneId, j.id)
          }
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, selectedEpisode?.id])

  const generateVideo = async (sceneId: string) => {
    setStartingVideo(sceneId)
    setError('')
    try {
      const res = await fetch('/api/ai/generate-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project?.id, sceneId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.jobId) {
        setError(data?.error ?? 'Video generation failed')
        return
      }
      setScenes((prev) => (prev ?? []).map((sc: any) => (sc?.id === sceneId ? { ...sc, status: 'generating' } : sc)))
      pollVideoJob(sceneId, data.jobId)
    } catch { setError('Network error') }
    finally { setStartingVideo(null) }
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
        setScenes((prev) =>
          (prev ?? []).map((s: any) => (s?.id === sceneId ? data.scene : s))
        )
      }
    } catch {}
  }

  const assembleEpisode = async () => {
    if (!selectedEpisode?.id) return
    setAssembling(true)
    try {
      const res = await fetch('/api/ai/assemble-episode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodeId: selectedEpisode.id }),
      })
      const data = await res.json()
      if (data?.videoUrl) {
        setSelectedEpisode({ ...(selectedEpisode ?? {}), videoUrl: data.videoUrl })
        onRefresh()
      }
    } catch { setError('Assembly failed') }
    finally { setAssembling(false) }
  }

  const isSceneBusy = (sceneId: string) => {
    if (startingVideo === sceneId) return true
    const j = videoJobs[sceneId]
    return !!j && (j.status === 'processing' || j.status === 'pending')
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
                      {ep?.videoUrl && <Check className="ml-auto h-3 w-3 text-green-400" />}
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
                  <p className="mb-2 text-xs font-medium text-muted-foreground">Assembled Episode</p>
                  <div className="aspect-[9/16] max-h-[500px] overflow-hidden rounded-lg bg-muted">
                    <video
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
                    {scene?.videoUrl && scene?.audioUrl && (
                      <p className="text-[11px] text-primary/80">🎙 Voiceover (ElevenLabs) — plays in sync with the video</p>
                    )}
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

                  <div className="flex gap-2">
                    {scene?.status !== 'accepted' && (
                      <>
                        <button
                          onClick={() => generateVideo(scene?.id ?? '')}
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
                  onClick={assembleEpisode}
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
