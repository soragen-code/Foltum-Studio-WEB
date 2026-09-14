'use client'

import { useEffect, useState } from 'react'
import { Loader2, X, Copy, Check, ScrollText } from 'lucide-react'

/**
 * Stage 99 — read-only "Scene Script" modal.
 *
 * GETs `/api/ai/scenes/[id]/script` → { script } and shows the assembled, human-readable English
 * screenplay page for one scene (which OPENS where the previous scene ended). Read-only: Copy + Close
 * only, no editing / saving / regeneration.
 */
export interface SceneScriptModalProps {
  sceneId: string
  sceneNumber?: number
  onClose: () => void
}

export function SceneScriptModal({ sceneId, sceneNumber, onClose }: SceneScriptModalProps) {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true); setErr(null)
      try {
        const r = await fetch(`/api/ai/scenes/${sceneId}/script`, { cache: 'no-store' })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(d?.error || 'Failed to load the scene script')
        if (!alive) return
        setText(String(d.script ?? ''))
      } catch (e: any) { if (alive) setErr(e?.message ?? 'Failed to load the scene script') }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [sceneId])

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) }
    catch { setErr("Couldn't copy") }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" data-testid="scene-script-modal">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-card shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h3 className="flex items-center gap-2 font-display text-lg font-bold">
              <ScrollText className="h-5 w-5" /> Scene Script{typeof sceneNumber === 'number' ? ` — Scene ${sceneNumber}` : ''}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">A readable screenplay page for this scene. It opens exactly where the previous scene ended.</p>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close" data-testid="scene-script-modal-close"><X className="h-5 w-5" /></button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Loading scene script...</div>
          ) : err ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid="scene-script-modal-error">{err}</p>
          ) : (
            <pre className="w-full whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground" data-testid="scene-script-modal-text">{text}</pre>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4">
          <button onClick={copy} disabled={loading || !text} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50" data-testid="scene-script-modal-copy">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? 'Copied' : 'Copy'}
          </button>
          <button onClick={onClose} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted">Close</button>
        </div>
      </div>
    </div>
  )
}
