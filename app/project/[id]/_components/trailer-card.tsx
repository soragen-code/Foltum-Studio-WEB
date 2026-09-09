'use client'

/**
 * Test mode: one-minute mini-trailer (3 scenes ≈ 30+20+30 s) that demonstrates dialogues,
 * an emotional turn, a location change and locked lighting — without generating a season.
 * The script is written here; the clips are generated from the regular episode page, which
 * shows the exact cost before spending credits.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Loader2, FlaskConical, ArrowRight, Check } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { JOB_POLL_INTERVAL_MS } from './use-job-polling'
import { CancelButton } from './cancel-button'
import { sceneClipPlan } from '@/lib/season'
import type { PowerTier } from '@/lib/power-tier'

type TrailerEpisode = { id: string; title: string; videoUrl: string | null; status: string; scenes: { durationSec: number | null; status: string; videoUrl: string | null }[] }
type TrailerJob = { id: string; status: string; progress: number; message: string | null; error: string | null }

export function TrailerCard({ project }: { project: { id: string; powerTier?: string | null } }) {
  const [episode, setEpisode] = useState<TrailerEpisode | null>(null)
  const [job, setJob] = useState<TrailerJob | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [shown, setShown] = useState(0) // displayed %, smoothed between 3-s polls
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/ai/trailer?projectId=${project.id}`, { cache: 'no-store' })
      if (!res.ok) return
      const data = await res.json()
      setEpisode(data.episode ?? null); setJob(data.job ?? null)
    } catch { /* keep the previous state */ }
  }, [project.id])
  useEffect(() => { void load() }, [load])

  const active = !!job && (job.status === 'pending' || job.status === 'processing')
  useEffect(() => {
    if (!active) return
    timer.current = setTimeout(() => void load(), JOB_POLL_INTERVAL_MS)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [active, job?.progress, job?.message, load])

  // Elapsed-time counter + smooth progress: creep +1 %/s toward (server progress + 12), never above 95 %.
  useEffect(() => {
    if (!active) { setElapsed(0); setShown(0); return }
    const t0 = Date.now()
    const id = setInterval(() => {
      setElapsed(Math.round((Date.now() - t0) / 1000))
      setShown((v) => Math.max(v, Math.min(95, Math.max(job?.progress ?? 0, Math.min(v + 1, (job?.progress ?? 0) + 12)))))
    }, 1000)
    return () => clearInterval(id)
  }, [active, job?.progress])

  const start = async () => {
    if (episode && !confirm('Переписать мини-трейлер? Старый сценарий трейлера и его клипы будут заменены.')) return
    setStarting(true); setError(null)
    try {
      const res = await fetch('/api/ai/trailer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id }) })
      const data = await res.json()
      if (!res.ok) throw new Error(data?.error ?? 'Не удалось запустить трейлер')
      setJob({ id: data.jobId, status: 'processing', progress: 1, message: 'Запуск...', error: null })
    } catch (e: any) { setError(e?.message ?? 'Ошибка') }
    finally { setStarting(false) }
  }

  // Stage 11: cancel the trailer-script job. The worker stops at its next checkpoint and marks canceled.
  const cancel = async () => {
    if (!job?.id) return
    const res = await fetch(`/api/ai/jobs/${job.id}/cancel`, { method: 'POST' })
    if (res.ok) { setJob((j) => (j ? { ...j, status: 'canceled', message: 'Останавливаю генерацию…' } : j)); setTimeout(() => void load(), 1500) }
  }

  const tier = ((project.powerTier as PowerTier) || 'MEDIUM') as PowerTier
  const plan = sceneClipPlan(tier, episode?.scenes.length ? episode.scenes : 3)
  const generated = episode?.scenes.filter((s) => s.videoUrl).length ?? 0

  return (
    <div className="rounded-xl border border-dashed border-primary/40 bg-card p-4 sm:p-6" data-testid="trailer-card">
      <div className="flex items-start gap-3">
        <FlaskConical className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-bold">Тестовый режим: мини-трейлер (~1 мин)</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Быстрая проверка без генерации сезона: 3 сцены (≈30+20+30 с) с диалогами по 5–7 предложений, эмоциональным поворотом, сменой ракурса внутри локации и переходом во вторую локацию. Клипы генерируются на странице эпизода — там видна точная стоимость ({plan.total} кр. за {episode?.scenes.length || 3} сцены на тарифе {tier}).
          </p>
          {episode && !active && (
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm" data-testid="trailer-ready">
              <span className="inline-flex items-center gap-1 text-primary"><Check className="h-4 w-4" /> «{episode.title}» · {episode.scenes.length} сцен · клипов готово {generated}/{episode.scenes.length}{episode.videoUrl ? ' · собран' : ''}</span>
              <Link href={`/project/${project.id}/episode/${episode.id}`} className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-primary-foreground" data-testid="trailer-open">
                Открыть трейлер <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          )}
          {(active || starting) && (
            <div className="mt-3 space-y-2 text-sm" data-testid="trailer-progress">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" /><span className="min-w-0 flex-1">{job?.message ?? 'Запуск...'}</span>
                <span className="tabular-nums font-medium" data-testid="trailer-progress-pct">{Math.max(shown, job?.progress ?? 0)}%</span>
                {job?.id && !starting && <CancelButton onCancel={cancel} testId="trailer-cancel" className="shrink-0" />}
              </div>
              <Progress value={Math.max(shown, job?.progress ?? 0)} className="h-2" aria-label="Прогресс сценария трейлера" />
              <p className="text-xs text-muted-foreground">Прошло {elapsed} с · обычно сценарий готов за 20–40 с (одно обращение к нейросети)</p>
            </div>
          )}
          {job?.status === 'canceled' && !active && <p className="mt-2 text-sm text-amber-500" data-testid="trailer-canceled">{job.message ?? 'Генерация отменена'}</p>}
          {job?.status === 'failed' && !active && <p className="mt-2 text-sm text-destructive">Ошибка: {job.error ?? 'генерация прервана'}</p>}
          {!active && (
            <button onClick={start} disabled={starting} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-primary/50 px-3 py-1.5 text-sm text-primary disabled:opacity-50" data-testid="trailer-generate">
              {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
              {episode ? 'Переписать мини-трейлер' : 'Написать сценарий мини-трейлера'}
            </button>
          )}
          {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  )
}
