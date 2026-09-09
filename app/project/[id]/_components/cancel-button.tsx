'use client'

import { useState } from 'react'
import { Loader2, X } from 'lucide-react'

/**
 * Stage 11 — «Отменить генерацию» button shown next to a running progress indicator.
 * On click it calls `onCancel` (which hits the relevant cancel endpoint). While the
 * request is in flight the button shows a spinner; afterwards the parent switches the
 * job/UI to its "Отменено" state. Idempotent: repeated clicks are safe (button disables
 * itself while pending). Dark-theme, compact, mobile-safe.
 */
export function CancelButton({
  onCancel,
  label = 'Отменить',
  pendingLabel = 'Останавливаю…',
  className = '',
  testId,
}: {
  onCancel: () => Promise<void>
  label?: string
  pendingLabel?: string
  className?: string
  testId?: string
}) {
  const [pending, setPending] = useState(false)

  const handle = async () => {
    if (pending) return
    setPending(true)
    try {
      await onCancel()
    } catch {
      // parent surfaces errors; keep the button usable for a retry
    } finally {
      setPending(false)
    }
  }

  return (
    <button
      type="button"
      onClick={handle}
      disabled={pending}
      data-testid={testId}
      className={`inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive hover:border-destructive/40 disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
    >
      {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
      {pending ? pendingLabel : label}
    </button>
  )
}
