'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, Check, Loader2 } from 'lucide-react'

export type NavEpisode = { id: string; number: number; title: string; status?: string | null; videoUrl?: string | null }

function validUrl(u?: string | null) {
  return !!u && /^https?:\/\//.test(u)
}

/** Short status label + colour for an episode cell. */
function statusOf(s: NavEpisode): { label: string; done: boolean } {
  if (s.status === 'assembled' || validUrl(s.videoUrl)) return { label: 'собран', done: true }
  if (s.status === 'scenes_ready') return { label: 'сцены', done: false }
  if (s.status === 'approved') return { label: 'рефы', done: false }
  if (s.status === 'script_ready') return { label: 'сюжет', done: false }
  return { label: '—', done: false }
}

/**
 * Stage 14 (C) — episode navigation as a right-aligned «Эпизоды» dropdown that opens a GRID
 * (up to 10 cells per row on desktop; fewer per row on smaller screens — never a horizontal
 * scroll). Each cell shows the episode number + its status and links to that episode; episodes
 * can be opened in any order. Replaces the old flat tab row.
 */
export function EpisodeNavGrid({ projectId, episodes, currentId }: { projectId: string; episodes: NavEpisode[]; currentId: string }) {
  const [open, setOpen] = useState(false)
  const [openingId, setOpeningId] = useState<string | null>(null) // episodeId being navigated to
  const ref = useRef<HTMLDivElement | null>(null)
  const sorted = [...episodes].sort((a, b) => a.number - b.number)
  const current = sorted.find((e) => e.id === currentId)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  if (sorted.length === 0) return null

  return (
    <div className="relative ml-auto" ref={ref} data-testid="episode-nav">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted"
        data-testid="episode-nav-trigger"
        aria-expanded={open}
        aria-haspopup="true"
      >
        Эпизоды
        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{current ? current.number : '—'}/{sorted.length}</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          className="absolute right-0 z-40 mt-2 w-[min(92vw,640px)] rounded-xl border border-border bg-card p-3 shadow-xl"
          data-testid="episode-nav-panel"
          role="menu"
        >
          <p className="mb-2 px-0.5 text-xs text-muted-foreground">Откройте любой эпизод — в любом порядке.</p>
          <div className="grid grid-cols-5 gap-2 sm:grid-cols-8 md:grid-cols-10" data-testid="episode-nav-grid">
            {sorted.map((s) => {
              const active = s.id === currentId
              const st = statusOf(s)
              return (
                <Link
                  key={s.id}
                  href={`/project/${projectId}/episode/${s.id}`}
                  onClick={() => { if (active) { setOpen(false); return } setOpeningId(s.id) }}
                  aria-disabled={openingId === s.id}
                  data-testid="episode-nav-item"
                  data-active={active}
                  title={`Эпизод ${s.number}: ${s.title} — ${st.label}`}
                  className={`flex aspect-square flex-col items-center justify-center gap-0.5 rounded-lg border p-1 text-center transition ${active ? 'border-primary bg-primary/10 font-semibold text-foreground' : 'border-border text-muted-foreground hover:border-primary/60 hover:text-foreground'} ${openingId === s.id ? 'pointer-events-none opacity-70' : ''}`}
                >
                  {openingId === s.id ? (
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  ) : (
                    <>
                      <span className="text-sm font-bold leading-none">{s.number}</span>
                      <span className="flex items-center gap-0.5 text-[9px] leading-none">
                        {st.done && <Check className="h-2.5 w-2.5 text-primary" />}
                        {st.label}
                      </span>
                    </>
                  )}
                </Link>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
