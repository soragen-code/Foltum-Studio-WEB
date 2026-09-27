'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X, Copy, Check, Terminal, RefreshCw } from 'lucide-react'

/**
 * «Промпт» — small icon button that opens a modal with the LAST prompts actually sent to the LLM / WaveSpeed
 * for this project (GET /api/projects/[id]/prompt-logs; rows are written by lib/prompt-log.ts).
 * `kinds` narrows the list to the current stage (e.g. ["idea"], ["script","shot_list",...]).
 */
export interface PromptLogButtonProps {
  projectId: string
  kinds?: string[]
  episodeId?: string | null
  sceneId?: string | null
  /** Button label (default «Промпт»). */
  label?: string
  className?: string
  testId?: string
  /** Marks the button with data-keep so read-only stage wrappers ([&_button:not([data-keep])]:hidden) keep it visible. */
  keep?: boolean
}

interface PromptLogEntry {
  id: string
  kind: string
  model: string
  createdAt: string
  provider: string | null
  endpoint: string | null
  system: string | null
  user: string
  extra: Record<string, unknown> | null
  episodeId: string | null
  sceneId: string | null
}

const KIND_LABELS: Record<string, string> = {
  idea: 'Идея', logline: 'Логлайн', synopsis: 'Синопсис', story: 'Сюжет', script: 'Сценарий', plot: 'Сюжет серии',
  shot_list: 'Шот-лист', characters: 'Персонажи', character: 'Персонаж (изображение)', locations: 'Локации',
  location: 'Локация (изображение)', storyboard: 'Сториборд', scenes: 'Сцены', video: 'Видео', keyframe: 'Кадр',
  artifact: 'Артефакты', llm: 'LLM',
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function PromptLogButton({ projectId, kinds, episodeId, sceneId, label = 'Промпт', className, testId = 'prompt-log', keep }: PromptLogButtonProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Показать промпты, отправленные в модель"
        className={className ?? 'inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground'}
        data-testid={`${testId}-button`}
        data-keep={keep || undefined}
      >
        <Terminal className="h-3.5 w-3.5" /> {label}
      </button>
      {/* Portal: the modal must not inherit read-only stage wrappers that hide descendant buttons. */}
      {open && typeof document !== 'undefined' && createPortal(<PromptLogModal projectId={projectId} kinds={kinds} episodeId={episodeId} sceneId={sceneId} testId={testId} onClose={() => setOpen(false)} />, document.body)}
    </>
  )
}

function PromptLogModal({ projectId, kinds, episodeId, sceneId, testId, onClose }: PromptLogButtonProps & { onClose: () => void }) {
  const [logs, setLogs] = useState<PromptLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const kindsKey = (kinds ?? []).join(',')

  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true); setErr(null)
      try {
        const q = new URLSearchParams()
        if (kindsKey) q.set('kind', kindsKey)
        if (episodeId) q.set('episodeId', episodeId)
        if (sceneId) q.set('sceneId', sceneId)
        q.set('limit', '20')
        const r = await fetch(`/api/projects/${projectId}/prompt-logs?${q.toString()}`, { cache: 'no-store' })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(d?.error || 'Не удалось загрузить промпты')
        if (!alive) return
        setLogs(Array.isArray(d.logs) ? d.logs : [])
      } catch (e: any) { if (alive) setErr(e?.message ?? 'Не удалось загрузить промпты') }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [projectId, kindsKey, episodeId, sceneId, tick])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" data-testid={`${testId}-modal`} onClick={onClose}>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl border border-border bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h3 className="flex items-center gap-2 font-display text-lg font-bold"><Terminal className="h-5 w-5" /> Отправленные промпты</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Последние запросы к модели для этого {episodeId ? 'эпизода' : 'проекта'}{kinds?.length ? ` · ${kinds.map((k) => KIND_LABELS[k] ?? k).join(', ')}` : ''}. Новые — сверху.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button onClick={() => setTick((t) => t + 1)} disabled={loading} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50" aria-label="Обновить" title="Обновить" data-testid={`${testId}-refresh`}>
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Закрыть" data-testid={`${testId}-close`}><X className="h-5 w-5" /></button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading && logs.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Загружаем промпты...</div>
          ) : err ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" data-testid={`${testId}-error`}>{err}</p>
          ) : logs.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground" data-testid={`${testId}-empty`}>Промптов пока нет — они появятся после первой генерации на этом шаге.</p>
          ) : (
            <ul className="space-y-4" data-testid={`${testId}-list`}>
              {logs.map((l, i) => <PromptLogItem key={l.id} entry={l} defaultOpen={i === 0} />)}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button onClick={onClose} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted">Закрыть</button>
        </div>
      </div>
    </div>
  )
}

function PromptLogItem({ entry, defaultOpen }: { entry: PromptLogEntry; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <li className="rounded-lg border border-border bg-background/60" data-testid="prompt-log-item">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-xs">
        <span className="font-medium text-foreground">{fmtTime(entry.createdAt)}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{KIND_LABELS[entry.kind] ?? entry.kind}</span>
        <span className="text-muted-foreground">
          Отправлено в: <span className="text-foreground">{entry.model}</span>
          {entry.provider ? <> · {entry.provider}</> : null}
          {entry.endpoint ? <> · <span className="break-all font-mono text-[11px]">{entry.endpoint}</span></> : null}
        </span>
        <span className="ml-auto text-muted-foreground">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-border px-3 py-3">
          {entry.system ? <PromptBlock title="System" text={entry.system} /> : null}
          <PromptBlock title="User" text={entry.user} />
          {entry.extra && Object.keys(entry.extra).length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Параметры запроса</summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed">{JSON.stringify(entry.extra, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
    </li>
  )
}

function PromptBlock({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* ignore */ }
  }
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title} <span className="font-normal normal-case">· {text.length.toLocaleString('ru-RU')} симв.</span></span>
        <button type="button" onClick={copy} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} {copied ? 'Скопировано' : 'Копировать'}
        </button>
      </div>
      <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed">{text}</pre>
    </div>
  )
}
