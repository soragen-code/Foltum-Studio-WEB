'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Eye, Copy, Check, X, Info, RotateCcw, Maximize2, RefreshCw } from 'lucide-react'
import { useTranslation } from '@/lib/i18n/context'
import { syncStoryboardV2RefsBlock } from '@/lib/idea-v2'

/**
 * Поток v2 · модалка промпта сборки листа-сториборда (по образцу shot-prompt-modal.tsx).
 * Открывается только по кнопке «Промпт». Редактируется поле промпта (сверху), есть сброс к авто.
 * Ниже — read-only превью референсов серии, которые уйдут в генерацию вместе с промптом.
 * «Сохранить» → поднимает отредактированный промпт наверх (localStorage-черновик); «Закрыть» — без сохранения.
 */
export type StoryboardPromptRef = { id: string; label: string; kind: 'character' | 'location' | 'prop'; imageUrl?: string | null }

export function StoryboardPromptModal({ autoPrompt, promptDraft, refs, loading = false, loadError = '', onRetry, onRebuild, onSave, onClose }: {
  autoPrompt: string; promptDraft: string; refs: StoryboardPromptRef[]
  /** Авто-промпт ещё строится на сервере (перевод фреймов/меток) — вместо поля показывается лоадер. */
  loading?: boolean
  loadError?: string
  onRetry?: () => void
  /** «Пересобрать» — принудительно построить авто-промпт заново (актуальные шоты/рефы), сбросив правки. */
  onRebuild?: () => void
  onSave: (prompt: string) => void; onClose: () => void
}) {
  const { t } = useTranslation()
  // Сохранённая правка показывается с АКТУАЛЬНЫМ блоком «References:» (рефы со страницы «Референсы»).
  const [draft, setDraft] = useState(promptDraft ? syncStoryboardV2RefsBlock(promptDraft, autoPrompt) : autoPrompt)
  // Авто-промпт обновился с сервера (рефы/шоты изменились), а пользователь его не правил → подменяем на лету.
  const prevAutoRef = useRef(autoPrompt)
  const rebuiltRef = useRef(false)
  useEffect(() => {
    const prev = prevAutoRef.current
    prevAutoRef.current = autoPrompt
    if (autoPrompt && autoPrompt !== prev) setDraft((d) => (rebuiltRef.current || !d.trim() || d.trim() === prev.trim() ? autoPrompt : syncStoryboardV2RefsBlock(d, autoPrompt)))
    rebuiltRef.current = false
  }, [autoPrompt])
  // Сразу сбрасываем правки к текущему авто (если сервер вернёт тот же текст — поле уже актуально), затем — свежий авто.
  const rebuild = () => { if (!onRebuild || loading) return; rebuiltRef.current = true; setRuOn(false); setDraft(autoPrompt); onRebuild() }
  // Полноэкранный просмотр референса (клик по карточке; Esc / клик по фону — закрыть).
  const [lightbox, setLightbox] = useState<{ url: string; alt: string } | null>(null)
  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setLightbox(null) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])
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
              {onRebuild && (
                <button type="button" onClick={rebuild} disabled={loading} className={`${btnBase} ${btnIdle} disabled:opacity-40`} title={t('ideaV2.storyboardPromptRebuildHint')} data-testid="episode-v2-storyboard-prompt-rebuild">
                  {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} {t('ideaV2.storyboardPromptRebuild')}
                </button>
              )}
            </div>
          </div>
          {loading || (!autoPrompt && !draft) ? (
            <div className="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground" data-testid="episode-v2-storyboard-prompt-loading">
              {loading ? (
                <><Loader2 className="h-5 w-5 animate-spin text-primary" /> {t('ideaV2.storyboardPromptBuilding')}</>
              ) : (
                <>
                  <span className="text-destructive">{loadError || t('ideaV2.storyboardError')}</span>
                  {onRetry && <button type="button" onClick={onRetry} className={`${btnBase} ${btnIdle}`} data-testid="episode-v2-storyboard-prompt-retry"><RotateCcw className="h-3.5 w-3.5" /> {t('common.retry')}</button>}
                </>
              )}
            </div>
          ) : (
          <textarea
            value={ruOn ? (ruLoading ? '' : ruText?.text ?? draft) : draft}
            onChange={(e) => { if (!ruOn) setDraft(e.target.value) }}
            readOnly={ruOn}
            placeholder={ruOn && ruLoading ? '…' : undefined}
            rows={Math.min(18, Math.max(8, draft.split('\n').length + 2))}
            className={`w-full resize-y rounded-lg border px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-primary ${ruOn ? 'border-border bg-muted/40 text-foreground/90' : 'border-input bg-background'}`}
            data-testid="episode-v2-storyboard-prompt-text"
          />
          )}
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
                    <div className="group relative aspect-square w-full bg-muted/30">
                      {r.imageUrl ? (
                        <button type="button" onClick={() => setLightbox({ url: r.imageUrl!, alt: r.label })} className="block h-full w-full cursor-zoom-in" aria-label={r.label} data-testid="episode-v2-storyboard-ref-open">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={r.imageUrl} alt={r.label} className="h-full w-full object-cover" />
                          <span className="pointer-events-none absolute right-1 top-1 rounded bg-black/50 p-1 text-white opacity-0 transition group-hover:opacity-100"><Maximize2 className="h-3 w-3" /></span>
                        </button>
                      ) : <div className="flex h-full w-full items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>}
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
      {lightbox && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4" onClick={(e) => { e.stopPropagation(); setLightbox(null) }} data-testid="episode-v2-storyboard-ref-lightbox">
          <button type="button" onClick={(e) => { e.stopPropagation(); setLightbox(null) }} className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20" aria-label={t('common.close')} data-testid="episode-v2-storyboard-ref-lightbox-close">
            <X className="h-5 w-5" />
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox.url} alt={lightbox.alt} className="max-h-full max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
          <p className="pointer-events-none absolute bottom-4 left-1/2 max-w-[90vw] -translate-x-1/2 truncate rounded bg-black/50 px-3 py-1 text-xs text-white">{lightbox.alt}</p>
        </div>
      )}
    </div>
  )
}
