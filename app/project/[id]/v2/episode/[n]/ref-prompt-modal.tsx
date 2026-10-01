'use client'

import { useState } from 'react'
import { Loader2, Eye, Copy, Check, X, Info } from 'lucide-react'
import { stripRefKindPrefixV2, type EpisodeRefV2 } from '@/lib/idea-v2'
import { useTranslation } from '@/lib/i18n/context'

/**
 * Поток v2 · модалка промпта одного рефа серии (визуально по образцу v2-prompt-modal.tsx). Открывается только по кнопке
 * «Промпт» в блоке рефа. EN-промпт редактируется; «RU» — перевод только для показа (/api/ai/translate), хранится EN;
 * «Копировать» — текущий текст поля; «Сохранить» → PATCH /api/ai/v2/refs (edited=true); «Закрыть» — без сохранения.
 */
export function RefPromptModal({ projectId, n, refItem, onSaved, onClose }: {
  projectId: string; n: number; refItem: EpisodeRefV2; onSaved: (prompt: string) => void; onClose: () => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(refItem.prompt)
  const [ruOn, setRuOn] = useState(false)
  const [ru, setRu] = useState<{ src: string; text: string } | null>(null)
  const [ruLoading, setRuLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const dirty = draft !== refItem.prompt

  const btnBase = 'inline-flex items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-xs font-medium transition'
  const btnIdle = 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
  const btnActive = 'border-primary bg-primary/10 text-primary'

  const toggleRu = async () => {
    const next = !ruOn
    setRuOn(next)
    if (!next || ru?.src === draft) return
    setRuLoading(true)
    try {
      const res = await fetch('/api/ai/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: draft }) })
      const d = await res.json().catch(() => ({}))
      setRu({ src: draft, text: res.ok && typeof d?.text === 'string' && d.text.trim() ? d.text : draft })
    } catch { setRu({ src: draft, text: draft }) }
    finally { setRuLoading(false) }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(draft); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* буфер недоступен */ }
  }
  const save = async () => {
    if (!draft.trim()) return
    setSaving(true); setError('')
    try {
      const res = await fetch('/api/ai/v2/refs', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId, episode: n, id: refItem.id, prompt: draft }) })
      if (!res.ok) { const d = await res.json().catch(() => ({})); setError(d?.error ?? t('ideaV2.refsSaveFailed')); return }
      onSaved(draft)
      setSaved(true); setTimeout(() => setSaved(false), 1500)
    } catch { setError(t('ideaV2.refsNetworkError')) }
    finally { setSaving(false) }
  }

  const text = ruOn && ru ? ru.text : draft
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose} data-testid="episode-v2-ref-prompt-modal" data-ref={refItem.id}>
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3.5">
          <h3 className="flex min-w-0 items-center gap-2 font-display text-lg font-semibold">
            <Eye className="h-5 w-5 flex-shrink-0 text-primary" />
            <span className="truncate">{t('ideaV2.refsPromptTitle')} · {stripRefKindPrefixV2(refItem.label)}</span>
          </h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground" aria-label={t('common.close')} data-testid="episode-v2-ref-prompt-x">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('ideaV2.refsPromptLabel')}{refItem.edited && <span className="ml-2 normal-case text-amber-500">· {t('ideaV2.refsEdited')}</span>}
            </span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => void copy()} className={`${btnBase} ${copied ? btnActive : btnIdle}`} data-testid="episode-v2-ref-copy">
                {copied ? <><Check className="h-3.5 w-3.5 text-primary" /> {t('ideaV2.refsCopied')}</> : <><Copy className="h-3.5 w-3.5" /> {t('ideaV2.refsCopy')}</>}
              </button>
              <button type="button" onClick={() => void toggleRu()} className={`${btnBase} ${ruOn ? btnActive : btnIdle}`} title={t('ideaV2.refsRuHint')} aria-pressed={ruOn} data-testid="episode-v2-ref-ru-toggle">
                {ruLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'RU'}
              </button>
            </div>
          </div>
          <div className="relative">
            <textarea
              value={ruOn && ruLoading ? '' : text}
              onChange={(e) => setDraft(e.target.value)}
              readOnly={ruOn}
              rows={Math.min(16, Math.max(6, text.split('\n').length + 2))}
              className={`w-full resize-y rounded-lg border px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-primary ${ruOn ? 'border-border bg-muted/40 text-foreground/90' : 'border-input bg-background'}`}
              data-testid="episode-v2-ref-prompt"
            />
            {ruOn && ruLoading && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-background/60">
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> {t('ideaV2.refsTranslating')}</span>
              </div>
            )}
          </div>
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> {ruOn ? t('ideaV2.refsRuNote') : t('ideaV2.refsPromptNote')}
          </p>
          {error && <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
          <button onClick={onClose} className="flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-semibold transition hover:bg-muted" data-testid="episode-v2-ref-prompt-close">
            {t('common.close')}
          </button>
          <button onClick={() => void save()} disabled={saving || !dirty || !draft.trim()} className={`flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-semibold transition hover:bg-muted disabled:opacity-50 ${saved ? 'text-primary' : ''}`} data-testid="episode-v2-ref-prompt-save">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {saved ? t('ideaV2.saved') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
