'use client'

import { Loader2 } from 'lucide-react'
import { SmoothProgress, type JobInfo } from './use-job-polling'
import { CancelButton } from './cancel-button'

/**
 * Stage 77 — "rewrite in progress" placeholder. Rendered INSTEAD of the old text block while a
 * text-rewrite job (episode script / season story / synopsis) is running, so the stale text is
 * never shown next to a progress bar. Same height class as a typical text block (min 200px),
 * centered spinner + label + the smooth 0→100 % bar with elapsed time / job.message.
 * While `job` is still null (POST in flight, jobId not yet known) only the spinner + label show.
 */
export function RewritePlaceholder({
  job,
  expectedTotalSec,
  label,
  onCancel,
  testId,
  className = '',
}: {
  job: JobInfo | null | undefined
  expectedTotalSec: number
  label: string
  onCancel?: () => Promise<void>
  testId?: string
  className?: string
}) {
  return (
    <div
      className={`flex min-h-[200px] flex-col items-center justify-center gap-4 rounded-lg border border-border/60 bg-muted/10 p-6 ${className}`}
      data-testid={testId}
      role="status"
      aria-live="polite"
    >
      <Loader2 className="h-8 w-8 animate-spin text-primary" />
      <p className="text-center text-sm font-medium">{label}</p>
      {job && <SmoothProgress job={job} expectedTotalSec={expectedTotalSec} className="w-full max-w-xl" />}
      {onCancel && job && (job.status === 'pending' || job.status === 'processing') && (
        <CancelButton onCancel={onCancel} testId={testId ? `${testId}-cancel` : undefined} />
      )}
    </div>
  )
}
