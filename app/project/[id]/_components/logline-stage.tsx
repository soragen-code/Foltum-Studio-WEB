'use client'

import { useState, useEffect, useRef } from 'react'
import { Wand2, Loader2, Check, RefreshCw, MessageSquareText, Lightbulb } from 'lucide-react'
import { useJobPolling, SmoothProgress } from './use-job-polling'

/** Roughly how long the synopsis job (kicked on approval) takes — drives the smooth 0→100 % bar. */
const SYNOPSIS_EXPECTED_SEC = 45

/**
 * STEP 1 of the 3-step approval flow — the story IDEA (logline).
 *
 * Shows the short logline produced at the idea step with three actions:
 *   • «Регенерировать»    — regenerate a fresh logline from the same source.
 *   • «Исправить промптом» — apply the producer's note VERBATIM (a re-gen instruction OR a direct edit).
 *   • «Аппрув / Далее»    — approve the (possibly edited) logline and kick off the synopsis generation.
 *
 * Nothing auto-progresses: the synopsis is generated only when the producer approves here. Regeneration
 * happens only on an explicit button click.
 */
export function LoglineStage({ project, onRefresh }: { project: any; onRefresh: () => void }) {
  const [logline, setLogline] = useState<string>(project?.logline ?? '')
  const [correctionPrompt, setCorrectionPrompt] = useState('')
  const [regenerating, setRegenerating] = useState(false)
  const [fixing, setFixing] = useState(false)
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState('')
  const resumedRef = useRef(false)

  // After approval the season SYNOPSIS is generated as a background job (type "synopsis"); we poll it and,
  // when it completes, the project has advanced to stage="synopsis" — onRefresh() renders step 2.
  const poll = useJobPolling({
    onFinish: (res) => {
      const job = res.job
      if (job.status === 'completed') {
        setError('')
        onRefresh()
      } else if (job.status === 'canceled') {
        setApproving(false)
      } else {
        setError(job.error ?? 'Не удалось сгенерировать синопсис')
        setApproving(false)
      }
    },
  })
  const jobActive = !!poll.job && (poll.job.status === 'pending' || poll.job.status === 'processing')
  const busy = regenerating || fixing || approving || jobActive

  // Resume: if the synopsis job is already running (the producer approved, then reloaded / came back),
  // pick it up and keep polling instead of losing the progress bar. If it finished while away, the
  // project is already on stage="synopsis" and this component won't even mount.
  useEffect(() => {
    if (resumedRef.current || !project?.id) return
    resumedRef.current = true
    ;(async () => {
      try {
        const res = await fetch(`/api/ai/idea?projectId=${project.id}`, { cache: 'no-store' })
        if (!res.ok) return
        const d = await res.json().catch(() => null)
        const j = d?.job
        if (!j) return
        if (j.status === 'pending' || j.status === 'processing') {
          setApproving(true)
          poll.start(j.id)
        }
      } catch { /* transient — the buttons still work */ }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])

  const regenerate = async () => {
    setError(''); setRegenerating(true)
    try {
      const res = await fetch('/api/ai/logline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data?.error ?? 'Не удалось сгенерировать'); return }
      if (typeof data?.logline === 'string') setLogline(data.logline)
    } catch { setError('Ошибка сети') }
    finally { setRegenerating(false) }
  }

  const applyFix = async () => {
    if (!correctionPrompt.trim()) return
    setError(''); setFixing(true)
    try {
      const res = await fetch('/api/ai/logline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, correction: correctionPrompt.trim(), currentLogline: logline }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data?.error ?? 'Не удалось применить правку'); return }
      if (typeof data?.logline === 'string') setLogline(data.logline)
      setCorrectionPrompt('')
    } catch { setError('Ошибка сети') }
    finally { setFixing(false) }
  }

  const approve = async () => {
    if (!logline.trim()) return
    setError(''); setApproving(true)
    try {
      const res = await fetch(`/api/projects/${project.id}/approve-logline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logline }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data?.error ?? 'Не удалось подтвердить идею'); setApproving(false); return }
      if (data?.jobId) {
        poll.start(data.jobId)
      } else {
        // No job returned — advance anyway.
        onRefresh()
      }
    } catch { setError('Ошибка сети'); setApproving(false) }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
        <h2 className="mb-2 flex items-center gap-2 font-display text-xl font-bold">
          <Lightbulb className="h-5 w-5 text-primary" /> Шаг 1 — Идея
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Это короткая идея сезона (логлайн) в 2–3 предложениях. Отредактируйте её прямо в тексте, попросите
          ИИ переписать по промпту или сгенерируйте заново. Когда идея вас устроит — нажмите «Аппрув / Далее»,
          и мы создадим по ней синопсис сезона.
        </p>

        {error && <div className="mb-4 rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive" data-testid="logline-error">{error}</div>}

        <textarea
          rows={5}
          value={logline}
          onChange={(e) => setLogline(e.target.value)}
          disabled={busy}
          placeholder="Короткая идея сезона…"
          className="mb-4 w-full rounded-lg border border-input bg-background p-3 text-sm leading-relaxed outline-none transition focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-60"
          data-testid="logline-text"
        />

        {/* «Исправить промптом» — the note is applied verbatim (re-gen instruction OR a direct rewrite). */}
        <div className="mb-4">
          <label className="mb-1 flex items-center gap-2 text-sm font-medium">
            <MessageSquareText className="h-4 w-4 text-primary" /> Правка промптом (необязательно)
          </label>
          <textarea
            rows={2}
            placeholder="Например: сделать мрачнее, добавить линию соперника, перенести действие в 90-е…"
            value={correctionPrompt}
            onChange={(e) => setCorrectionPrompt(e.target.value)}
            disabled={busy}
            className="w-full rounded-lg border border-input bg-background p-3 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-60"
            data-testid="logline-correction"
          />
        </div>

        <div className="flex flex-wrap gap-3">
          <button
            onClick={regenerate}
            disabled={busy}
            className="flex items-center gap-2 rounded-lg bg-muted px-4 py-2 text-sm font-semibold transition hover:bg-muted/80 disabled:opacity-50"
            data-testid="logline-regenerate"
          >
            {regenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Регенерировать
          </button>
          <button
            onClick={applyFix}
            disabled={busy || !correctionPrompt.trim()}
            className="flex items-center gap-2 rounded-lg bg-secondary px-4 py-2 text-sm font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50"
            data-testid="logline-fix"
          >
            {fixing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            Исправить промптом
          </button>
          <button
            onClick={approve}
            disabled={busy || !logline.trim()}
            className="flex items-center gap-2 rounded-lg bg-primary px-6 py-2 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
            data-testid="logline-approve"
          >
            {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Аппрув / Далее
          </button>
        </div>

        {jobActive && (
          <div className="mt-4 space-y-2" data-testid="logline-synopsis-progress">
            <SmoothProgress job={poll.job!} expectedTotalSec={SYNOPSIS_EXPECTED_SEC} />
            <p className="text-xs text-muted-foreground">
              Шаг 2 · создаём синопсис сезона по утверждённой идее. Можно закрыть страницу — генерация
              продолжится в фоне, а прогресс восстановится при возвращении.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
