'use client'

import { parseEpisodeFootage } from '@/lib/season'

/** Stage 105 — shown next to every story / structure / episode-script rewrite control (visible, not hover). */
export const REWRITE_NOTE = 'Rewriting clears the generated scenes and videos of the affected episodes.'

export function RewriteNote({ className = '', testId = 'rewrite-note' }: { className?: string; testId?: string }) {
  return (
    <p className={`text-[11px] leading-snug text-muted-foreground ${className}`} data-testid={testId}>
      {REWRITE_NOTE}
    </p>
  )
}

/**
 * Stage 105 — renders the 60-second footage description as three labelled rows
 * (Shot 1 / Shot 2 / Cliffhanger). Falls back to a plain paragraph for legacy descriptions.
 */
export function EpisodeFootage({ description, className = '' }: { description?: string | null; className?: string }) {
  const text = (description ?? '').trim()
  if (!text) return null
  const parsed = parseEpisodeFootage(text)
  if (!parsed) {
    return <p className={`text-xs text-muted-foreground ${className}`} data-testid="episode-footage-plain">{text}</p>
  }
  const rows: [string, string, string | undefined][] = [
    ['Shot 1 (30 s)', parsed.shot1, parsed.opensOn],
    ['Shot 2 (30 s)', parsed.shot2, undefined],
    ['Cliffhanger', parsed.cliffhanger, undefined],
  ]
  return (
    <div className={`space-y-1 text-xs text-muted-foreground ${className}`} data-testid="episode-footage">
      {rows.map(([label, body, opensOn]) => (
        <p key={label}>
          <span className="font-semibold text-foreground">{label}:</span>{' '}
          {opensOn && (
            <span className="rounded bg-primary/10 px-1 font-medium text-primary" data-testid="episode-footage-opens-on">
              Opens on: {opensOn}
            </span>
          )}
          {opensOn ? ' ' : ''}
          {body}
        </p>
      ))}
    </div>
  )
}
