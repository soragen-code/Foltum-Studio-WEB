'use client'

import { useState } from 'react'
import { Loader2, Eye, Copy, Check, X, Info, RotateCcw } from 'lucide-react'
import { useTranslation } from '@/lib/i18n/context'

/**
 * Поток v2 · модалка промпта сборки листа-сториборда (по образцу shot-prompt-modal.tsx).
 * Открывается только по кнопке «Промпт». Редактируется поле промпта (сверху), есть сброс к авто.
 * Ниже — read-only превью референсов серии, которые уйдут в генерацию вместе с промптом.
 * «Сохранить» → поднимает отредактированный промпт наверх (localStorage-черновик); «Закрыть» — без сохранения.
 */
export type StoryboardPromptRef = { id: string; label: string; kind: 'character' | 'location' | 'prop'; imageUrl?: string | null }

export function StoryboardPromptModal({ autoPrompt, promptDraft, refs, onSave, onClose }: {
  autoPrompt: string; promptDraft: string; refs: StoryboardPromptRef[]
  onSave: (prompt: string) => void; onClose: () => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(promptDraft || autoPrompt)
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)
  // «РУ» — перевод текущего EN-промпта только для просмотра (/api/ai/translate); кэш по исходному тексту.
  const [ruOn, setRuOn] = useState(false)
  const [ruLoading, setRuLoading] = useState(false)
  const [ruText, setRuText] = useState<{ src: string; text: string } | null>(null)
  const edited = draft.trim() !== autoPrompt.trim()
  const dirty = draft !== (promptDraft || autoPrompt)

  const btnBase = 'inline-flex items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-xs font-medium transition'
  const btnIdle = 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
  const btnActive = 'border-primary bg-primary/10 text-primary'

  const copy = async () => {
    try { await navigator.clipboard.writeText(draft); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* буфер недоступен */ }
  }
  const resetAuto = () => setDraft(autoPrompt)
  const toggleRu = async () => {
    const next = !ruOn
    setRuOn(next)
    if (!next || ruText?.src === draft) return
    setRuLoading(true)
    try {
      const res = await fetch('/api/ai/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: draft }) })
      const d = await res.json().catch(() => ({}))
      setRuText({ src: draft, text: res.ok && typeof d?.text === 'string' && d.text.trim() ? d.text : draft })
    } catch { setRuText({ src: draft, text: draft }) }
    finally { setRuLoading(false) }
  }
  const save = () => {
    if (!draft.trim()) return
    onSave(draft)
    setSaved(true); setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose} data-testid="episode-v2-storyboard-prompt-modal">
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3.5">
          <h3 className="flex min-w-0 items-center gap-2 font-display text-lg font-semibold">
            <Eye className="h-5 w-5 flex-shrink-0 text-primary" />
            <span className="truncate">{t('ideaV2.storyboardPromptTitle')}</span>
          </h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground" aria-label={t('common.close')} data-testid="episode-v2-storyboard-prompt-x">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {/* Поле промпта — редактируемое, закреплено сверху */}
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('ideaV2.storyboardPromptLabel')}{edited && <span className="ml-2 normal-case text-amber-500">· {t('ideaV2.refsEdited')}</span>}
            </span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => void toggleRu()} className={`${btnBase} ${ruOn ? btnActive : btnIdle}`} title={t('ideaV2.refsRuHint')} aria-pressed={ruOn} data-testid="episode-v2-storyboard-ru-toggle">
                {ruLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : t('ideaV2.ruToggle')}
              </button>
              <button type="button" onClick={() => void copy()} className={`${btnBase} ${copied ? btnActive : btnIdle}`} data-testid="episode-v2-storyboard-copy">
                {copied ? <><Check className="h-3.5 w-3.5 text-primary" /> {t('ideaV2.refsCopied')}</> : <><Copy className="h-3.5 w-3.5" /> {t('ideaV2.refsCopy')}</>}
              </button>
              <button type="button" onClick={resetAuto} disabled={!edited || ruOn} className={`${btnBase} ${btnIdle} disabled:opacity-40`} title={t('ideaV2.shotsPromptResetHint')} data-testid="episode-v2-storyboard-reset">
                <RotateCcw className="h-3.5 w-3.5" /> {t('ideaV2.shotsPromptReset')}
              </button>
            </div>
          </div>
          <textarea
            value={ruOn ? (ruLoading ? '' : ruText?.text ?? draft) : draft}
            onChange={(e) => { if (!ruOn) setDraft(e.target.value) }}
            readOnly={ruOn}
            placeholder={ruOn && ruLoading ? '…' : undefined}
            rows={Math.min(18, Math.max(8, draft.split('\n').length + 2))}
            className={`w-full resize-y rounded-lg border px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-primary ${ruOn ? 'border-border bg-muted/40 text-foreground/90' : 'border-input bg-background'}`}
            data-testid="episode-v2-storyboard-prompt-text"
          />
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> {ruOn ? t('ideaV2.refsRuNote') : t('ideaV2.storyboardPromptNote')}
          </p>

          {/* Референсы серии — read-only превью (уходят в генерацию вместе с промптом) */}
          <div className="rounded-lg border border-border">
            <div className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('ideaV2.storyboardPromptRefsLabel')}</span>
              {refs.length > 0 && <span className="text-[10px] text-muted-foreground/70">{refs.length}</span>}
            </div>
            {refs.length === 0 ? (
              <p className="border-t border-border px-3 py-3 text-[11px] text-muted-foreground" data-testid="episode-v2-storyboard-refs-empty">{t('ideaV2.storyboardPromptNoRefs')}</p>
            ) : (
              <div className="grid grid-cols-3 gap-2 border-t border-border p-3 sm:grid-cols-4" data-testid="episode-v2-storyboard-refs">
                {refs.map((r) => (
                  <div key={r.id} className="overflow-hidden rounded-md border border-border bg-muted/20">
                    <div className="aspect-square w-full bg-muted/30">
                      {r.imageUrl
                        /* eslint-disable-next-line @next/next/no-img-element */
                        ? <img src={r.imageUrl} alt={r.label} className="h-full w-full object-cover" />
                        : <div className="flex h-full w-full items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>}
                    </div>
                    <p className="truncate px-1.5 py-1 text-[10px] text-muted-foreground" title={r.label}>{r.label}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
          <button onClick={onClose} className="flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-semibold transition hover:bg-muted" data-testid="episode-v2-storyboard-prompt-close">
            {t('common.close')}
          </button>
          <button onClick={save} disabled={!dirty || !draft.trim()} className={`flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-semibold transition hover:bg-muted disabled:opacity-50 ${saved ? 'text-primary' : ''}`} data-testid="episode-v2-storyboard-prompt-save">
            <Check className="h-4 w-4" /> {saved ? t('ideaV2.saved') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
