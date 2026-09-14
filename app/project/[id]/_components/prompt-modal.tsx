'use client'

import { useEffect, useState } from 'react'
import { Loader2, X, Copy, Check, Save, RotateCcw, FileText } from 'lucide-react'

/**
 * Stage 46E — shared «"Prompt" modal for characters and locations (the scene modal in episode-view predates it).
 * GET `endpoint` → { prompt, hasOverride }; PUT `endpoint` { prompt } saves; PUT `resetBody` restores the auto prompt.
 */
export interface PromptModalProps {
  title: string
  description?: string
  endpoint: string
  /** Body of the «reset to auto» PUT (characters: { prompt: '' }, locations: { reset: true }). */
  resetBody?: Record<string, unknown>
  /** Show «Reset to auto" even when the server reports no override (locations: legacy rows can still be re-generated). */
  alwaysShowReset?: boolean
  testId?: string
  onClose: () => void
  /** Called after every successful save / reset with the server's view. */
  onChange?: (info: { prompt: string; hasOverride: boolean }) => void
}

export function PromptModal({ title, description, endpoint, resetBody = { prompt: '' }, alwaysShowReset = false, testId = 'prompt-modal', onClose, onChange }: PromptModalProps) {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [hasOverride, setHasOverride] = useState(false)
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true); setErr(null)
      try {
        const r = await fetch(endpoint, { cache: 'no-store' })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(d?.error || 'Failed to load prompt')
        if (!alive) return
        setText(String(d.prompt ?? '')); setHasOverride(!!d.hasOverride)
      } catch (e: any) { if (alive) setErr(e?.message ?? 'Failed to load prompt') }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [endpoint])

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }
    catch { setErr("Couldn't copy") }
  }

  const put = async (body: Record<string, unknown>, reset: boolean) => {
    setSaving(true); setErr(null); setSaved(false)
    try {
      const r = await fetch(endpoint, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d?.error || "Couldn't save")
      const prompt = String(d.prompt ?? '')
      setText(prompt); setHasOverride(!!d.hasOverride)
      onChange?.({ prompt, hasOverride: !!d.hasOverride })
      if (!reset) { setSaved(true); setTimeout(() => setSaved(false), 2000) }
    } catch (e: any) { setErr(e?.message ?? "Couldn't save") }
    finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" data-testid={testId}>
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h3 className="flex items-center gap-2 font-display text-lg font-bold"><FileText className="h-5 w-5" /> {title}</h3>
            {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
            {hasOverride && (
              <p className="mt-2 inline-flex items-center gap-1 rounded bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary" data-testid={`${testId}-override-indicator`}>Prompt changed manually</p>
            )}
          </div>
          <button onClick={onClose} className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close" data-testid={`${testId}-close`}><X className="h-5 w-5" /></button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Loading prompt...</div>
          ) : (
            <>
              {err && <p className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid={`${testId}-error`}>{err}</p>}
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                spellCheck={false}
                className="h-[45vh] w-full resize-none whitespace-pre-wrap rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs leading-relaxed"
                data-testid={`${testId}-text`}
                placeholder="Prompt..."
              />
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4">
          {(hasOverride || alwaysShowReset) && (
            <button onClick={() => put(resetBody, true)} disabled={saving || loading} className="mr-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50" data-testid={`${testId}-reset`}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Reset to auto
            </button>
          )}
          <button onClick={copy} disabled={loading || !text} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50" data-testid={`${testId}-copy`}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? 'Copied' : 'Copy'}
          </button>
          <button onClick={() => put({ prompt: text }, false)} disabled={saving || loading} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50" data-testid={`${testId}-save`}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />} {saved ? 'Saved' : 'Save'}
          </button>
          <button onClick={onClose} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted">Close</button>
        </div>
      </div>
    </div>
  )
}

/** Character-card texts (shared by both pages). */
export const CHARACTER_PROMPT_DESCRIPTION = `This is the character's base prompt (a full-body shot — the anchor for the entire set). You can copy, edit, and save it: the saved description will be used for ALL character shots during the next (re)generation. Empty text or "Reset to auto" restores the automatic prompt.`
export const LOCATION_PROMPT_DESCRIPTION = 'The location visual prompt (EN) used to generate its shots. You can edit and save it; "Reset to auto" restores the original AI-written text.'
