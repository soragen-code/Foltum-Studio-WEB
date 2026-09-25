'use client'

import { useState, useEffect, useRef } from 'react'
import { Wand2, Loader2, Check, PenLine } from 'lucide-react'
import { useJobPolling, StreamingText } from './use-job-polling'
import { RewritePlaceholder } from './rewrite-placeholder'
import { rewriteViewState } from '@/lib/rewrite-view-state'

// Roughly how long the synopsis rewrite takes — drives the smooth 0→100 % client bar.
const SYNOPSIS_CORRECTION_EXPECTED_SEC = 30

export function SynopsisStage({ project, onRefresh }: { project: any; onRefresh: () => void }) {
  const [prompt, setPrompt] = useState('')
  const [synopsis, setSynopsis] = useState(project?.synopsis ?? '')
  const [correctionPrompt, setCorrectionPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState('')
  const resumedRef = useRef(false)

  // Stage 69: «"Rewrite synopsis" now runs as a background GenerationJob so the client no longer
  // holds an open fetch (which broke on navigation and showed no progress). We poll the job and show a
  // smooth 0→100 % bar; on finish the new synopsis is written into the textarea.
  const poll = useJobPolling({
    intervalMs: 800,
    onFinish: (res) => {
      const job = res.job
      if (job.status === 'completed') {
        const next = job.result?.synopsis
        if (typeof next === 'string' && next.trim()) {
          setSynopsis(next)
          setCorrectionPrompt('')
        }
      } else if (job.status === 'failed') {
        setError(job.error ?? 'Generation failed')
      }
      setGenerating(false)
    },
  })

  const generate = async () => {
    if (!prompt.trim() && !correctionPrompt.trim()) return
    setGenerating(true)
    setError('')
    try {
      const res = await fetch('/api/ai/synopsis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project?.id,
          prompt: prompt.trim(),
          correction: correctionPrompt.trim(),
          currentSynopsis: synopsis,
        }),
      })
      const data = await res.json()
      if (data?.jobId) {
        poll.start(data.jobId)
      } else {
        setError(data?.error ?? 'Generation failed')
        setGenerating(false)
      }
    } catch { setError('Network error'); setGenerating(false) }
  }

  // Resume the progress bar / pick up a finished synopsis if the page was reloaded mid-rewrite.
  useEffect(() => {
    if (resumedRef.current || !project?.id) return
    resumedRef.current = true
    ;(async () => {
      try {
        const res = await fetch(`/api/ai/synopsis?projectId=${project.id}`, { cache: 'no-store' })
        const data = await res.json()
        const job = data?.job
        if (!job) return
        if (job.status === 'pending' || job.status === 'processing') {
          setGenerating(true)
          poll.start(job.id)
        } else if (job.status === 'completed' && typeof job.result?.synopsis === 'string' && !synopsis.trim()) {
          setSynopsis(job.result.synopsis)
        }
      } catch { /* ignore */ }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id])

  // Step 2 «Регенерировать»: build a completely fresh synopsis from the approved logline/idea
  // (no correction, no current text) — mirrors the "Create a synopsis for this idea" path.
  const regenerate = async () => {
    const seed = (project?.logline ?? project?.idea ?? '').trim()
    if (!seed) { setError('Нет идеи для регенерации'); return }
    setGenerating(true)
    setError('')
    try {
      const res = await fetch('/api/ai/synopsis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project?.id, prompt: seed, correction: '', currentSynopsis: '' }),
      })
      const data = await res.json()
      if (data?.jobId) {
        poll.start(data.jobId)
      } else {
        setError(data?.error ?? 'Ошибка генерации')
        setGenerating(false)
      }
    } catch { setError('Ошибка сети'); setGenerating(false) }
  }

  const approve = async () => {
    if (!synopsis.trim()) return
    setApproving(true)
    try {
      await fetch(`/api/projects/${project?.id}/approve-synopsis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ synopsis }),
      })
      onRefresh()
    } catch { setError('Failed to approve') }
    finally { setApproving(false) }
  }

  // Stage 59 (step 2 «Synopsis"): in the new 4-step flow the synopsis already exists (written at the
  // idea step). This screen shows ONLY the synopsis — no "your idea" panel, no cast/locations — with an
  // optional correction and an «"Approve synopsis" button that advances to the season-story step.
  const isNew = Boolean(project?.newFlow)

  if (isNew) {
    return (
      <div className="space-y-6">
        <div className="rounded-xl border border-border bg-card p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
          <h2 className="mb-2 font-display text-xl font-bold">Шаг 2 — Синопсис</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Проверьте синопсис сезона. Его можно отредактировать прямо в тексте, сгенерировать заново на основе идеи или попросить ИИ переписать по вашему замечанию. Когда всё устраивает — нажмите «Аппрув / Далее», и мы перейдём к сюжету по сериям.
          </p>

          {error && <div className="mb-4 rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}

          {/* Stage 77: while the rewrite job runs the OLD synopsis is hidden behind a placeholder. */}
          {rewriteViewState(generating, poll.job?.status) === 'placeholder' ? (
            <div className="mb-4 space-y-3">
              <RewritePlaceholder job={poll.job} expectedTotalSec={SYNOPSIS_CORRECTION_EXPECTED_SEC} label="Генерация синопсиса…" testId="synopsis-revise-progress" />
              {/* Стриминг: новый синопсис появляется постепенно по мере генерации. */}
              <StreamingText text={poll.job?.streamedText} active={poll.job?.status === 'processing' || poll.job?.status === 'pending'} />
            </div>
          ) : (
            <textarea
              rows={12}
              value={synopsis}
              onChange={(e) => setSynopsis(e.target.value)}
              placeholder="Season synopsis..."
              className="mb-4 w-full rounded-lg border border-input bg-background p-3 text-sm leading-relaxed outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
              data-testid="synopsis-text"
            />
          )}

          <div className="mb-4">
            <label className="mb-1 block text-sm font-medium">Исправить промптом (необязательно)</label>
            <textarea
              rows={2}
              placeholder="Сделай драматичнее, убери счастливый финал, добавь семейную линию..."
              value={correctionPrompt}
              onChange={(e) => setCorrectionPrompt(e.target.value)}
              disabled={generating}
              className="w-full rounded-lg border border-input bg-background p-3 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-60"
              data-testid="synopsis-correction"
            />
            {correctionPrompt.trim() && (
              <button
                onClick={generate}
                disabled={generating}
                className="mt-2 flex items-center gap-2 rounded-lg bg-secondary px-4 py-2 text-sm font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50"
                data-testid="synopsis-fix"
              >
                {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <PenLine className="h-4 w-4" />}
                Исправить промптом
              </button>
            )}
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              onClick={regenerate}
              disabled={generating || approving}
              className="flex items-center justify-center gap-2 rounded-lg bg-secondary px-6 py-3 text-sm font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50"
              data-testid="synopsis-regenerate"
            >
              {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              Регенерировать
            </button>
            <button
              onClick={approve}
              disabled={approving || generating || !synopsis.trim()}
              className="flex items-center justify-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
              data-testid="synopsis-approve"
            >
              {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Аппрув / Далее
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
        <h2 className="mb-4 font-display text-xl font-bold">Stage 1 — Synopsis</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Describe your film or series idea. AI will generate a short synopsis.
        </p>

        {error && <div className="mb-4 rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium">Your Idea</label>
            <textarea
              rows={4}
              placeholder="A dystopian thriller about a rogue AI that starts writing its own TV series..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full rounded-lg border border-input bg-background p-3 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </div>

          <button
            onClick={generate}
            disabled={generating || (!prompt.trim() && !correctionPrompt.trim())}
            className="flex items-center gap-2 rounded-lg bg-secondary px-5 py-2.5 text-sm font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50"
          >
            {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            Generate Synopsis
          </button>
        </div>
      </div>

      {synopsis && (
        <div className="rounded-xl border border-border bg-card p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-display text-lg font-semibold">Generated Synopsis</h3>
            <PenLine className="h-4 w-4 text-muted-foreground" />
          </div>
          <textarea
            rows={8}
            value={synopsis}
            onChange={(e) => setSynopsis(e.target.value)}
            className="mb-4 w-full rounded-lg border border-input bg-background p-3 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
          />

          <div className="mb-4">
            <label className="mb-1 block text-sm font-medium">Correction Prompt (optional)</label>
            <textarea
              rows={2}
              placeholder="Make it darker, add a love subplot..."
              value={correctionPrompt}
              onChange={(e) => setCorrectionPrompt(e.target.value)}
              className="w-full rounded-lg border border-input bg-background p-3 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
            />
            {correctionPrompt.trim() && (
              <button
                onClick={generate}
                disabled={generating}
                className="mt-2 flex items-center gap-2 rounded-lg bg-muted px-4 py-2 text-sm transition hover:bg-muted/80"
              >
                {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                Regenerate
              </button>
            )}
          </div>

          <button
            onClick={approve}
            disabled={approving || !synopsis.trim()}
            className="flex items-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
          >
            {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Approve Synopsis
          </button>
        </div>
      )}
    </div>
  )
}
