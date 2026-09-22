'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Header } from '@/components/header'
import { Loader2, Wand2, ArrowRight, ArrowLeft, FileText, BookOpen } from 'lucide-react'

type Sibling = { id: string; number: number; title: string; hasPlot: boolean; hasScript: boolean }
type EpisodeInfo = { id: string; number: number; title: string; plot: string | null; plotStatus: string | null; hasScript: boolean }

/**
 * Stage 173 (task 2) — the episode PLOT (сюжет) workspace. Shows the plot of ONE episode; from here the
 * producer goes to that episode's SCRIPT, or generates the plot of the NEXT episode (sequential). Plots are
 * generated one at a time — the "generate next plot" action is only enabled once THIS episode has a plot.
 */
export function PlotView({
  projectId,
  projectName,
  episode,
  siblings,
}: {
  projectId: string
  projectName: string
  episode: EpisodeInfo
  siblings: Sibling[]
}) {
  const router = useRouter()
  const [plot, setPlot] = useState<string | null>(episode.plot)
  const [busy, setBusy] = useState(false)
  const [nextBusy, setNextBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ordered = [...siblings].sort((a, b) => a.number - b.number)
  const nextEp = ordered.find((s) => s.number === episode.number + 1) ?? null
  const prevEp = ordered.find((s) => s.number === episode.number - 1) ?? null
  const hasPlot = !!plot?.trim()

  const scriptHref = `/project/${projectId}/episode/${episode.id}/script`

  // Generate (or regenerate) THIS episode's plot.
  const generate = async () => {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`/api/ai/episodes/${episode.id}/plot`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Не удалось сгенерировать сюжет')
      setPlot(data.plot ?? '')
      router.refresh()
    } catch (e: any) {
      setError(e?.message ?? 'Ошибка')
    } finally { setBusy(false) }
  }

  // Generate the NEXT episode's plot, then open its plot page.
  const generateNext = async () => {
    if (!nextEp) return
    setNextBusy(true); setError(null)
    try {
      const res = await fetch(`/api/ai/episodes/${nextEp.id}/plot`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Не удалось сгенерировать сюжет следующей серии')
      router.push(`/project/${projectId}/plot/${nextEp.id}`)
    } catch (e: any) {
      setError(e?.message ?? 'Ошибка'); setNextBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <Header projectName={projectName} projectId={projectId} />
      <main className="mx-auto max-w-[900px] px-4 py-6">
        <div className="mb-4 flex items-center justify-between gap-2">
          <Link href={`/project/${projectId}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" data-testid="plot-back">
            <ArrowLeft className="h-4 w-4" /> К сюжету сезона
          </Link>
          {prevEp && (
            <Link href={`/project/${projectId}/plot/${prevEp.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" data-testid="plot-prev">
              <ArrowLeft className="h-4 w-4" /> Сюжет серии {prevEp.number}
            </Link>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card p-4 sm:p-6" data-testid="plot-stage">
          <div className="flex flex-wrap items-center gap-2">
            <BookOpen className="h-5 w-5 text-primary" />
            <h1 className="font-display text-xl font-bold">Сюжет серии {episode.number}{episode.title ? ` — ${episode.title}` : ''}</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Это сюжет (что происходит: события, персонажи, локации и подлокации, порядок сцен) — на его основе затем создаётся скрипт эпизода. Сюжеты создаются последовательно: сначала сюжет этой серии, затем сюжет следующей.
          </p>

          {error && <p className="mt-3 text-sm text-destructive" data-testid="plot-error">{error}</p>}

          {!hasPlot ? (
            <div className="mt-5" data-testid="plot-empty">
              <button
                onClick={generate}
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
                data-testid="plot-generate"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                Сгенерировать сюжет серии {episode.number}
              </button>
            </div>
          ) : (
            <>
              <div className="mt-4 space-y-2 whitespace-pre-wrap text-sm leading-relaxed" data-testid="plot-text">
                {plot!.split(/\n{2,}/).map((para, i) => (
                  <p key={i}>{para}</p>
                ))}
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                {/* (a) go to / generate this episode's script — built FROM this plot (task 3). */}
                <Link
                  href={scriptHref}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110"
                  data-testid="plot-go-script"
                >
                  <FileText className="h-4 w-4" /> Перейти к скрипту серии {episode.number} <ArrowRight className="h-4 w-4" />
                </Link>

                {/* (b) generate the NEXT episode's plot (analogous page). */}
                {nextEp && (
                  <button
                    onClick={generateNext}
                    disabled={nextBusy}
                    className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm font-semibold transition hover:border-primary/60 disabled:opacity-50"
                    data-testid="plot-generate-next"
                  >
                    {nextBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                    Сгенерировать сюжет следующей серии ({nextEp.number})
                  </button>
                )}
              </div>

              <div className="mt-4">
                <button
                  onClick={generate}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                  data-testid="plot-regenerate"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                  Перегенерировать сюжет этой серии
                </button>
              </div>
            </>
          )}
        </div>

        {/* Quick navigation to every episode's plot page (generated ones open directly; ungenerated ones open
            their empty plot page where they can be generated in order). */}
        {ordered.length > 1 && (
          <div className="mt-5 rounded-xl border border-border bg-card p-4" data-testid="plot-nav">
            <div className="text-xs font-medium text-muted-foreground">Серии сезона</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {ordered.map((s) => (
                <Link
                  key={s.id}
                  href={`/project/${projectId}/plot/${s.id}`}
                  className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs transition ${
                    s.id === episode.id
                      ? 'bg-primary text-primary-foreground'
                      : s.hasPlot
                      ? 'bg-primary/10 text-primary hover:bg-primary/20'
                      : 'bg-muted text-muted-foreground hover:bg-muted/70'
                  }`}
                  data-testid={`plot-nav-${s.number}`}
                >
                  {s.number}{s.hasPlot ? ' ✓' : ''}
                </Link>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
