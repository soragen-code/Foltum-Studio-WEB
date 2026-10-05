'use client'

import { Loader2, Eye, RotateCcw, Copy, Check, X, ChevronDown, ChevronRight, Info } from 'lucide-react'
import { useTranslation } from '@/lib/i18n/context'

/**
 * Единая модалка просмотра / редактирования промпта потока v2 (вынесена из idea-stage-v2.tsx БЕЗ изменения поведения;
 * используется там и на странице эпизода v2). Чисто презентационная: всё состояние — у вызывающего.
 * system закреплён сверху (единственное редактируемое, «Сбросить к авто»); ниже история ОТ НОВЫХ К СТАРЫМ —
 * read-only, свёрнута по умолчанию в аккордеон «История». Кнопки: только «Сохранить» и «Закрыть» (+ RU, «Скопировать историю»).
 */
export type PromptMsg = { role: 'system' | 'user' | 'assistant'; content: string }

export interface PromptModalProps {
  kind: string
  title: string
  /** Метка первого ответа модели ('S0' / 'P0' / ...). */
  firstAnswerTag: string
  messages: PromptMsg[]
  sysEdit: string
  sysEdited: boolean
  note: string
  onSysChange: (v: string) => void
  onResetSys: () => void
  copied: boolean
  onCopy: () => void
  ruOn: boolean
  ruLoading: boolean
  ru: string[] | null
  onToggleRu: () => void
  historyOpen: boolean
  onToggleHistory: () => void
  saved: boolean
  saveDisabled: boolean
  onSave: () => void
  onClose: () => void
  /** Режим просмотра (сюжет утверждён): System read-only, без «Сбросить к авто» и «Сохранить». */
  readOnly?: boolean
}

export function PromptModal({
  kind, title, firstAnswerTag, messages, sysEdit, sysEdited, note, onSysChange, onResetSys, copied, onCopy,
  ruOn, ruLoading, ru, onToggleRu, historyOpen, onToggleHistory, saved, saveDisabled, onSave, onClose, readOnly = false,
}: PromptModalProps) {
  const { t } = useTranslation()
  const btnBase = 'inline-flex items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-xs font-medium transition'
  const btnIdle = 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
  const btnActive = 'border-primary bg-primary/10 text-primary'
  const hasSys = messages[0]?.role === 'system'
  const off = hasSys ? 1 : 0 // индекс первого user в messages
  const total = messages.length - off // сообщений истории (без system)
  let lastIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') { lastIdx = i; break }

  const label = (m: PromptMsg, i: number) => {
    const j = i - off // позиция в истории: 0 — первый user, 1 — ответ 0, 2 — правка 1, 3 — ответ 1, ...
    if (m.role === 'assistant') return t('promptModal.assistantAnswer', { n: j === 1 ? firstAnswerTag : Math.floor(j / 2) })
    if (j === 0) return total === 1 ? t('promptModal.userTaskNow') : t('promptModal.userTask')
    return i === lastIdx ? t('promptModal.userEditNow') : t('promptModal.userEdit', { n: Math.floor(j / 2) })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose} data-testid="idea-v2-preview-modal" data-kind={kind}>
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3.5">
          <h3 className="flex items-center gap-2 font-display text-lg font-semibold">
            <Eye className="h-5 w-5 text-primary" /> {title}
          </h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground" aria-label={t('common.close')} data-testid="idea-v2-preview-close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {note && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="idea-v2-context-note">
              <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> {note}
            </p>
          )}
          <div data-testid="idea-v2-dialog">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('promptModal.dialogHeader', { n: total })}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => void onCopy()}
                  className={`${btnBase} ${copied ? btnActive : btnIdle}`}
                  title={t('ideaV2.copyHistoryHint')}
                  data-testid="idea-v2-copy-history"
                >
                  {copied ? <><Check className="h-3.5 w-3.5 text-primary" /> {t('ideaV2.copied')}</> : <><Copy className="h-3.5 w-3.5" /> {t('ideaV2.copyHistory')}</>}
                </button>
                <button
                  type="button"
                  onClick={() => void onToggleRu()}
                  className={`${btnBase} ${ruOn ? btnActive : btnIdle}`}
                  title={t('promptModal.ruTitle')}
                  aria-pressed={ruOn}
                  data-testid="idea-v2-dialog-ru"
                >
                  {ruLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'RU'}
                </button>
              </div>
            </div>
            {hasSys && (() => {
              const ruShown = ruOn && !ruLoading && !!ru
              const text = ruShown ? ru![0] : sysEdit
              const canEdit = !ruOn && !readOnly
              return (
                <div className="mb-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2" data-testid="idea-v2-dialog-system" data-editable={readOnly ? 'false' : 'true'}>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-muted-foreground" title={t('ideaV2.systemHint')}>System · {t('ideaV2.system')} {t('promptModal.rulesFirst')}</span>
                    <div className="flex items-center gap-1">
                      {sysEdited && <span className="text-[11px] text-amber-500">{t('promptModal.edited')}</span>}
                      {!readOnly && <button type="button" onClick={onResetSys} disabled={!sysEdited} className={`${btnBase} ${btnIdle} disabled:opacity-40`} title={t('board.resetPrompt')} data-testid="idea-v2-reset-system">
                        <RotateCcw className="h-3.5 w-3.5" /> {t('board.resetPrompt')}
                      </button>}
                    </div>
                  </div>
                  <div className="relative">
                    <textarea
                      value={ruOn && ruLoading ? '' : text}
                      onChange={(e) => onSysChange(e.target.value)}
                      readOnly={!canEdit}
                      rows={Math.min(14, Math.max(3, (text ?? '').split('\n').length + 1))}
                      className={`w-full resize-y rounded-lg border px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-primary ${canEdit ? 'border-input bg-background' : 'border-border bg-muted/40 text-foreground/90'}`}
                      data-testid="idea-v2-preview-system"
                    />
                    {ruOn && ruLoading && (
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-background/60">
                        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> {t('ideaV2.refsTranslating')}</span>
                      </div>
                    )}
                  </div>
                </div>
              )
            })()}
            <div className="rounded-lg border border-border/60" data-testid="idea-v2-history" data-open={historyOpen ? 'true' : 'false'}>
              <button
                type="button"
                onClick={() => onToggleHistory()}
                aria-expanded={historyOpen}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold text-muted-foreground transition hover:bg-muted/40 hover:text-foreground"
                data-testid="idea-v2-history-toggle"
              >
                <span className="inline-flex items-center gap-1.5">
                  {historyOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  {t('ideaV2.history')} · {t('promptModal.msgCount', { n: total })}
                </span>
                <span className="text-[11px] font-normal">{t('ideaV2.historyHint')}</span>
              </button>
              {historyOpen && (
                <ol className="space-y-2 border-t border-border/60 p-2">
                  {messages.map((m, i) => ({ m, i })).filter(({ m }) => m.role !== 'system').reverse().map(({ m, i }) => {
                    const isLastUser = i === lastIdx
                    const ruShown = ruOn && !ruLoading && !!ru
                    const text = ruShown ? ru![i] : m.content
                    return (
                      <li
                        key={i}
                        className={`rounded-lg border px-3 py-2 ${m.role === 'assistant' ? 'border-primary/30 bg-primary/5' : isLastUser ? 'border-amber-500/40 bg-amber-500/5' : 'border-border/60 bg-muted/30'}`}
                        data-testid="idea-v2-dialog-msg"
                        data-role={m.role}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="text-[11px] font-semibold text-muted-foreground">{i + 1 - off}. {label(m, i)}</span>
                        </div>
                        <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-foreground/90">
                          {ruOn && ruLoading ? <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> {t('ideaV2.refsTranslating')}</span> : text}
                        </pre>
                      </li>
                    )
                  })}
                </ol>
              )}
            </div>
            {ruOn && !ruLoading && (
              <p className="mt-1 text-[11px] text-muted-foreground">{t('promptModal.ruNote')}</p>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
          <button onClick={onClose} className="flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-semibold transition hover:bg-muted" data-testid="idea-v2-preview-cancel">
            {t('common.close')}
          </button>
          {!readOnly && <button onClick={onSave} disabled={saveDisabled || (hasSys && !sysEdit.trim())} className={`flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-semibold transition hover:bg-muted ${saved ? 'text-primary' : ''}`} data-testid="idea-v2-preview-save">
            <Check className="h-4 w-4" /> {saved ? t('ideaV2.saved') : t('common.save')}
          </button>}
        </div>
      </div>
    </div>
  )
}
