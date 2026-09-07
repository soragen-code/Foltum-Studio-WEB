'use client'

import { useState } from 'react'
import { Loader2, Play, Check, RefreshCw, Edit2, Film, ChevronDown, ChevronRight } from 'lucide-react'

export function ScenesStage({ project, onRefresh }: { project: any; onRefresh: () => void }) {
  const [selectedEpisode, setSelectedEpisode] = useState<any>(null)
  const [scenes, setScenes] = useState<any[]>([])
  const [generating, setGenerating] = useState(false)
  const [generatingVideo, setGeneratingVideo] = useState<string | null>(null)
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

  const generateVideo = async (sceneId: string) => {
    setGeneratingVideo(sceneId)
    try {
      const res = await fetch('/api/ai/generate-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project?.id, sceneId }),
      })
      const data = await res.json()
      if (data?.scene) {
        setScenes((prev) =>
          (prev ?? []).map((s: any) => (s?.id === sceneId ? data.scene : s))
        )
      }
    } catch {}
    finally { setGeneratingVideo(null) }
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

  const allAccepted = (scenes ?? []).length > 0 && (scenes ?? []).every((s: any) => s?.status === 'accepted')
  const placeholderVideo = 'https://placehold.co/640x360/1a1a2e/eab308?text=Scene+Video'

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
          ) : generating ? (
            <div className="flex h-60 items-center justify-center rounded-xl border border-border bg-card">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <span className="ml-2 text-sm">Generating scenes...</span>
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
                    <div className="mb-3 aspect-video overflow-hidden rounded-lg bg-muted">
                      <img
                        src={scene.videoUrl}
                        alt={`Scene ${scene?.number}`}
                        className="h-full w-full object-cover"
                        onError={(e: any) => { e.target.src = placeholderVideo }}
                      />
                    </div>
                  )}

                  <div className="flex gap-2">
                    {scene?.status !== 'accepted' && (
                      <>
                        <button
                          onClick={() => generateVideo(scene?.id ?? '')}
                          disabled={generatingVideo === scene?.id}
                          className="flex items-center gap-1 rounded-lg bg-secondary px-3 py-1.5 text-xs font-medium text-secondary-foreground transition hover:brightness-110 disabled:opacity-50"
                        >
                          {generatingVideo === scene?.id ? (
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
