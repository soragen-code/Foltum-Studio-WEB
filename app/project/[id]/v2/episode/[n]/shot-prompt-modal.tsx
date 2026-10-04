'use client'

import { useEffect, useState } from 'react'
import { Loader2, Eye, Copy, Check, X, Info, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslation } from '@/lib/i18n/context'

/**
 * Поток v2 · модалка промпта запроса разбивки на кадры (по образцу ref-prompt-modal.tsx).
 * Открывается только по кнопке «Промпт». Редактируется ТОЛЬКО системное поле (сверху), есть сброс к авто.
 * Сообщение user (сценарий серии) показывается ниже как read-only (аккордеон, свёрнут).
 * «Сохранить» → поднимает отредактированный system наверх (localStorage-черновик); «Закрыть» — без сохранения.
 */
export function ShotPromptModal({ autoSystem, systemDraft, scriptText, onSave, onClose }: {
  autoSystem: string; systemDraft: string; scriptText: string
  onSave: (system: string) => void; onClose: () => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(systemDraft.trim() ? systemDraft : autoSystem)
  // Если авто-промпт подъехал позже открытия модалки, а поле ещё пустое — подставляем его (не считаем правкой).
  useEffect(() => {
    if (!draft.trim() && autoSystem.trim()) setDraft(systemDraft.trim() ? systemDraft : autoSystem)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSystem, systemDraft])
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)
  const [userOpen, setUserOpen] = useState(false)
  const edited = !!autoSystem.trim() && draft.trim() !== autoSystem.trim()
  const dirty = draft !== (systemDraft.trim() ? systemDraft : autoSystem)

  const btnBase = 'inline-flex items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-xs font-medium transition'
  const btnIdle = 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
  const btnActive = 'border-primary bg-primary/10 text-primary'

  const copy = async () => {
    try { await navigator.clipboard.writeText(draft); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* буфер недоступен */ }
  }
  const resetAuto = () => setDraft(autoSystem)
  const save = () => {
    if (!draft.trim()) return
    onSave(draft)
    setSaved(true); setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose} data-testid="episode-v2-shot-prompt-modal">
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3.5">
          <h3 className="flex min-w-0 items-center gap-2 font-display text-lg font-semibold">
            <Eye className="h-5 w-5 flex-shrink-0 text-primary" />
            <span className="truncate">{t('ideaV2.shotsPromptTitle')}</span>
          </h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground" aria-label={t('common.close')} data-testid="episode-v2-shot-prompt-x">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {/* Системное поле — единственное редактируемое, закреплено сверху */}
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('ideaV2.shotsPromptSystemLabel')}{edited && <span className="ml-2 normal-case text-amber-500">· {t('ideaV2.refsEdited')}</span>}
            </span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => void copy()} className={`${btnBase} ${copied ? btnActive : btnIdle}`} data-testid="episode-v2-shot-copy">
                {copied ? <><Check className="h-3.5 w-3.5 text-primary" /> {t('ideaV2.refsCopied')}</> : <><Copy className="h-3.5 w-3.5" /> {t('ideaV2.refsCopy')}</>}
              </button>
              <button type="button" onClick={resetAuto} disabled={!edited} className={`${btnBase} ${btnIdle} disabled:opacity-40`} title={t('ideaV2.shotsPromptResetHint')} data-testid="episode-v2-shot-reset">
                <RotateCcw className="h-3.5 w-3.5" /> {t('ideaV2.shotsPromptReset')}
              </button>
            </div>
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={Math.min(18, Math.max(8, draft.split('\n').length + 2))}
            className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-primary"
            data-testid="episode-v2-shot-prompt-system"
          />
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> {t('ideaV2.shotsPromptNote')}
          </p>

          {/* Сообщение user (сценарий) — read-only, свёрнуто */}
          <div className="rounded-lg border border-border">
            <button type="button" onClick={() => setUserOpen((v) => !v)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-foreground" data-testid="episode-v2-shot-user-toggle">
              <span className="flex items-center gap-1.5">
                {userOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                {t('ideaV2.shotsPromptUserLabel')}
              </span>
              <span className="normal-case text-[10px] text-muted-foreground/70">{t('ideaV2.shotsPromptReadonly')}</span>
            </button>
            {userOpen && (
              <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap border-t border-border bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/90" data-testid="episode-v2-shot-user-text">{scriptText || t('ideaV2.shotsNeedScript')}</pre>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
          <button onClick={onClose} className="flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-semibold transition hover:bg-muted" data-testid="episode-v2-shot-prompt-close">
            {t('common.close')}
          </button>
          <button onClick={save} disabled={!dirty || !draft.trim()} className={`flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-semibold transition hover:bg-muted disabled:opacity-50 ${saved ? 'text-primary' : ''}`} data-testid="episode-v2-shot-prompt-save">
            {saved ? <Check className="h-4 w-4" /> : <Check className="h-4 w-4" />} {saved ? t('ideaV2.saved') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
