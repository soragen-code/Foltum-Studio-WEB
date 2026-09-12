'use client'

import { useState } from 'react'
import { Loader2, RefreshCw, Download, Trash2 } from 'lucide-react'

/**
 * Stage 46E — compact, ALWAYS-visible toolbar at the bottom of a reference photo / frame:
 * «Перегенерировать» · «Скачать» · «Удалить» (optional, locations only). Every control has a text label
 * (touch-screen users get no hover). Rendered with spans (role=button) so it can live inside a clickable
 * photo `<button>` without invalid nesting; clicks never bubble to the photo (lightbox).
 */
export interface FrameToolbarProps {
  regen: { testId: string; busy: boolean; spinning: boolean; onClick: () => void }
  /** Download through the owner-checked proxy (`/api/files/download?url=…&name=…`). */
  download?: { url: string; name: string }
  /** Delete immediately (no confirm step, Stage 46E-1) with a spinner while pending. `disabledTitle` is shown when the frame cannot be removed (min 1 / generating). */
  del?: { onClick: () => Promise<void> | void; disabled?: boolean; disabledTitle?: string; testId: string }
}

export function downloadUrl(url: string, name: string): string {
  return `/api/files/download?url=${encodeURIComponent(url)}&name=${encodeURIComponent(name)}`
}

/** Same-origin attachment URL → the browser saves the file (no navigation away from the page). */
export function triggerDownload(href: string, name?: string) {
  const a = document.createElement('a')
  a.href = href
  if (name) a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

const ROW = 'inline-flex w-full cursor-pointer items-center justify-center gap-1 rounded bg-black/60 px-1 py-0.5 text-[10px] font-medium leading-none text-white transition hover:bg-black/80'

export function FrameToolbar({ regen, download, del }: FrameToolbarProps) {
  const [deleting, setDeleting] = useState(false)
  const stop = (e: React.SyntheticEvent) => { e.stopPropagation(); e.preventDefault() }
  const regenOff = regen.busy || regen.spinning
  const delOff = !!del?.disabled || deleting || regen.spinning

  return (
    <span className="absolute inset-x-1 bottom-1 flex flex-col gap-0.5" onClick={stop} data-testid="frame-toolbar">
      <span
        role="button"
        aria-label="Перегенерировать"
        title="Перегенерировать (1 кредит)"
        aria-disabled={regenOff}
        data-testid={regen.testId}
        onClick={(e) => { stop(e); if (!regenOff) regen.onClick() }}
        className={`${ROW} ${regen.busy && !regen.spinning ? 'pointer-events-none opacity-40' : ''}`}
      >
        {regen.spinning ? <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" /> : <RefreshCw className="h-3 w-3 flex-shrink-0" />}
        <span className="truncate">Перегенерировать</span>
      </span>
      {download && (
        <span
          role="button"
          aria-label="Скачать"
          title={`Скачать ${download.name}`}
          data-testid="download-frame"
          onClick={(e) => { stop(e); triggerDownload(downloadUrl(download.url, download.name), download.name) }}
          className={ROW}
        >
          <Download className="h-3 w-3 flex-shrink-0" /> <span className="truncate">Скачать</span>
        </span>
      )}
      {del && (
        <span
          role="button"
          aria-label="Удалить"
          title={delOff ? (del.disabledTitle ?? 'Сейчас нельзя удалить') : 'Удалить кадр'}
          aria-disabled={delOff}
          data-testid={del.testId}
          onClick={async (e) => { stop(e); if (delOff) return; setDeleting(true); try { await del.onClick() } finally { setDeleting(false) } }}
          className={`${ROW} ${delOff ? 'pointer-events-none opacity-40' : 'hover:bg-red-700/80'}`}
        >
          {deleting ? <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" /> : <Trash2 className="h-3 w-3 flex-shrink-0" />} <span className="truncate">Удалить</span>
        </span>
      )}
    </span>
  )
}

/** «Скачать все» — one zip of every frame of a character / location. */
export function DownloadAllButton({ kind, id, count, className = '' }: { kind: 'character' | 'location'; id: string; count: number; className?: string }) {
  return (
    <button
      type="button"
      disabled={count === 0}
      onClick={() => triggerDownload(`/api/files/download-zip?${kind}=${encodeURIComponent(id)}`)}
      className={`inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs disabled:opacity-50 ${className}`}
      data-testid="download-all"
      title={count === 0 ? 'Нет кадров для скачивания' : `Скачать все кадры (${count}) одним zip-архивом`}
    >
      <Download className="h-3.5 w-3.5" /> Скачать все{count > 0 ? ` (${count})` : ''}
    </button>
  )
}
