'use client'

import { useState } from 'react'
import { Wand2, Loader2, Check, PenLine } from 'lucide-react'

export function SynopsisStage({ project, onRefresh }: { project: any; onRefresh: () => void }) {
  const [prompt, setPrompt] = useState('')
  const [synopsis, setSynopsis] = useState(project?.synopsis ?? '')
  const [correctionPrompt, setCorrectionPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState('')

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
      if (data?.synopsis) {
        setSynopsis(data.synopsis)
        setCorrectionPrompt('')
      } else {
        setError(data?.error ?? 'Generation failed')
      }
    } catch { setError('Network error') }
    finally { setGenerating(false) }
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

  // Stage 59 (step 2 «Синопсис»): in the new 4-step flow the synopsis already exists (written at the
  // idea step). This screen shows ONLY the synopsis — no "your idea" panel, no cast/locations — with an
  // optional correction and an «Одобрить синопсис» button that advances to the season-story step.
  const isNew = Boolean(project?.newFlow)

  if (isNew) {
    return (
      <div className="space-y-6">
        <div className="rounded-xl border border-border bg-card p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
          <h2 className="mb-2 font-display text-xl font-bold">Шаг 2 — Синопсис</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Проверьте синопсис сезона. Можно отредактировать его прямо в тексте или попросить ИИ переписать с замечанием. Когда всё устроит — нажмите «Одобрить синопсис», и мы перейдём к сюжету сезона (персонажи, локации и сценарий).
          </p>

          {error && <div className="mb-4 rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>}

          <textarea
            rows={12}
            value={synopsis}
            onChange={(e) => setSynopsis(e.target.value)}
            placeholder="Синопсис сезона..."
            className="mb-4 w-full rounded-lg border border-input bg-background p-3 text-sm leading-relaxed outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
            data-testid="synopsis-text"
          />

          <div className="mb-4">
            <label className="mb-1 block text-sm font-medium">Замечание для переписывания (необязательно)</label>
            <textarea
              rows={2}
              placeholder="Сделать драматичнее, убрать счастливый финал, добавить семейную линию..."
              value={correctionPrompt}
              onChange={(e) => setCorrectionPrompt(e.target.value)}
              className="w-full rounded-lg border border-input bg-background p-3 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
              data-testid="synopsis-correction"
            />
            {correctionPrompt.trim() && (
              <button
                onClick={generate}
                disabled={generating}
                className="mt-2 flex items-center gap-2 rounded-lg bg-secondary px-4 py-2 text-sm font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50"
                data-testid="synopsis-regenerate"
              >
                {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                Переписать синопсис
              </button>
            )}
          </div>

          <button
            onClick={approve}
            disabled={approving || generating || !synopsis.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50 sm:w-auto"
            data-testid="synopsis-approve"
          >
            {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Одобрить синопсис
          </button>
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
