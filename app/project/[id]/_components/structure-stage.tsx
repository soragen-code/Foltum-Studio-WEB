'use client'

import { useState } from 'react'
import { Loader2, Wand2, Check, ChevronDown, ChevronRight, Edit2 } from 'lucide-react'

export function StructureStage({ project, onRefresh }: { project: any; onRefresh: () => void }) {
  const [seasons, setSeasons] = useState<any[]>(project?.seasons ?? [])
  const [generating, setGenerating] = useState(false)
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState('')
  const [expandedSeason, setExpandedSeason] = useState<string | null>(null)
  const [editingEp, setEditingEp] = useState<string | null>(null)
  const [totalDuration, setTotalDuration] = useState<number>(30)
  const isApproved = project?.structureApproved ?? false

  const durationOptions = [
    { value: 10, label: '~10 мин' },
    { value: 15, label: '~15 мин' },
    { value: 30, label: '~30 мин' },
    { value: 45, label: '~45 мин' },
    { value: 60, label: '~1 час' },
    { value: 90, label: '~1.5 часа' },
    { value: 120, label: '~2 часа' },
  ]

  const generateStructure = async () => {
    setGenerating(true)
    setError('')
    try {
      const res = await fetch('/api/ai/structure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project?.id, synopsis: project?.synopsis, totalDurationMinutes: totalDuration }),
      })
      const data = await res.json()
      if (data?.seasons) {
        setSeasons(data.seasons)
      } else {
        setError(data?.error ?? 'Generation failed')
      }
    } catch { setError('Network error') }
    finally { setGenerating(false) }
  }

  const approve = async () => {
    setApproving(true)
    try {
      await fetch(`/api/projects/${project?.id}/approve-structure`, { method: 'POST' })
      onRefresh()
    } catch { setError('Failed to approve') }
    finally { setApproving(false) }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
        <h2 className="font-display text-xl font-bold">Stage 3 — Structure</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          AI breaks your synopsis into seasons and episodes with cliffhangers.
        </p>

        {error && <div className="mt-4 rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}

        {!isApproved && (seasons?.length ?? 0) === 0 && (
          <div className="mt-4 space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">
                Хронометраж сериала
              </label>
              <div className="flex flex-wrap gap-2">
                {durationOptions.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setTotalDuration(opt.value)}
                    className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                      totalDuration === opt.value
                        ? 'border-primary bg-primary/10 text-primary font-semibold'
                        : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/60'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                AI подберёт количество сезонов, эпизодов и длительность каждого эпизода
              </p>
            </div>
            <button
              onClick={generateStructure}
              disabled={generating}
              className="flex items-center gap-2 rounded-lg bg-secondary px-5 py-2.5 text-sm font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50"
            >
              {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              Generate Structure
            </button>
          </div>
        )}
      </div>

      {(seasons?.length ?? 0) > 0 && (
        <>
          <div className="space-y-3">
            {(seasons ?? []).map((season: any) => (
              <div
                key={season?.id ?? season?.number}
                className="rounded-xl border border-border bg-card overflow-hidden"
                style={{ boxShadow: 'var(--shadow-sm)' }}
              >
                <button
                  onClick={() =>
                    setExpandedSeason(
                      expandedSeason === (season?.id ?? '') ? null : (season?.id ?? '')
                    )
                  }
                  className="flex w-full items-center justify-between p-4 text-left hover:bg-muted/30 transition"
                >
                  <h3 className="font-semibold">
                    Season {season?.number ?? '?'}{season?.title ? `: ${season.title}` : ''}
                  </h3>
                  {expandedSeason === (season?.id ?? '') ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>

                {expandedSeason === (season?.id ?? '') && (
                  <div className="border-t border-border px-4 pb-4">
                    {(season?.episodes ?? []).map((ep: any) => (
                      <div
                        key={ep?.id ?? ep?.number}
                        className="mt-3 rounded-lg bg-muted/30 p-3"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">
                            Ep. {ep?.number ?? '?'}: {ep?.title ?? 'Untitled'}
                          </span>
                          {!isApproved && (
                            <button
                              onClick={() =>
                                setEditingEp(editingEp === (ep?.id ?? '') ? null : (ep?.id ?? ''))
                              }
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <Edit2 className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {ep?.description ?? ''}
                        </p>
                        {ep?.cliffhanger && (
                          <p className="mt-1 text-xs italic text-primary">
                            🚨 {ep.cliffhanger}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {!isApproved && (
            <div className="flex gap-3">
              <button
                onClick={generateStructure}
                disabled={generating}
                className="flex items-center gap-2 rounded-lg bg-muted px-4 py-2.5 text-sm transition hover:bg-muted/80"
              >
                Regenerate
              </button>
              <button
                onClick={approve}
                disabled={approving}
                className="flex items-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
              >
                {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Approve Structure
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
