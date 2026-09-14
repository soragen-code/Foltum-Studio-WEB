'use client'

import { Loader2, Wand2 } from 'lucide-react'
import { CancelButton } from './cancel-button'

/**
 * Stage 14 — a single reusable bottom-docked "edit by prompt" bar.
 * Used on the story screen (A5) and the episode screen (D3). It is fixed to the bottom of the
 * viewport, always visible, works on mobile 390px, and never overlaps content (the page adds
 * its own padding-bottom). Shows a spinner while busy and an optional cancel button.
 */
export function StickyReviseBar({
  value,
  onChange,
  onSubmit,
  busy,
  onCancel,
  placeholder,
  label,
  submitLabel = 'Edit',
  hint,
  disabled,
  testId = 'sticky-revise',
  minLength = 3,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  busy: boolean
  onCancel?: () => void
  placeholder?: string
  label?: string
  submitLabel?: string
  hint?: string
  disabled?: boolean
  testId?: string
  minLength?: number
}) {
  const canSubmit = !busy && !disabled && value.trim().length >= minLength
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
      data-testid={testId}
    >
      <div className="mx-auto max-w-[1200px] px-4 py-2.5">
        {label && <label className="mb-1 block text-xs font-semibold text-muted-foreground">{label}</label>}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canSubmit) onSubmit()
            }}
            rows={2}
            disabled={busy || disabled}
            placeholder={placeholder}
            className="min-h-[44px] flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm"
            data-testid={`${testId}-input`}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={onSubmit}
              disabled={!canSubmit}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:flex-none"
              data-testid={`${testId}-submit`}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} {submitLabel}
            </button>
            {busy && onCancel && <CancelButton onCancel={async () => onCancel()} testId={`${testId}-cancel`} />}
          </div>
        </div>
        {hint && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{hint}</p>}
      </div>
    </div>
  )
}
