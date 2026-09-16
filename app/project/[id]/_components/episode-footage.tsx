'use client'

import { parseEpisodeFootage, parseEpisodeSynopsis } from '@/lib/season'

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
 * Stage 128 — renders an episode "description" as ONE detailed continuous synopsis paragraph followed by a
 * highlighted Cliffhanger line (no 30-second shot split). Legacy episodes still saved in the old footage format
 * (SHOT 1 / SHOT 2 / CLIFFHANGER) keep their three labelled rows for backward compatibility. Empty → nothing.
 */
export function EpisodeFootage({ description, className = '' }: { description?: string | null; className?: string }) {
  const text = (description ?? '').trim()
  if (!text) return null
  // Legacy 3-line footage descriptions → keep the old three-row layout (no auto-migration of saved episodes).
  const legacy = parseEpisodeFootage(text)
  if (legacy) {
    const rows: [string, string, string | undefined][] = [
      ['Shot 1', legacy.shot1, legacy.opensOn],
      ['Shot 2', legacy.shot2, undefined],
      ['Cliffhanger', legacy.cliffhanger, undefined],
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
  // New format: a continuous synopsis + a separate cliffhanger line.
  const { synopsis, cliffhanger } = parseEpisodeSynopsis(text)
  return (
    <div className={`space-y-1.5 text-xs text-muted-foreground ${className}`} data-testid="episode-synopsis">
      {synopsis && <p className="leading-relaxed" data-testid="episode-synopsis-body">{synopsis}</p>}
      {cliffhanger && (
        <p data-testid="episode-synopsis-cliffhanger">
          <span className="font-semibold text-foreground">Cliffhanger:</span>{' '}
          <span className="rounded bg-primary/10 px-1 font-medium text-primary">{cliffhanger}</span>
        </p>
      )}
    </div>
  )
}
