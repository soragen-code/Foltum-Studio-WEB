'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Wand2, Eye, Pencil, Check, X, Clapperboard } from 'lucide-react'
import { FABLE_MODEL_LABEL, episodeShotsV2SystemPrompt, shotFrameText, synopsisLanguageFromCode, type EpisodeShotV2 } from '@/lib/idea-v2'
import { useTranslation } from '@/lib/i18n/context'
import { CancelButton } from '../../../_components/cancel-button'
import { useJobPolling, SmoothProgress } from '../../../_components/use-job-polling'
import { ShotPromptModal } from './shot-prompt-modal'

/**
 * Поток v2 · вкладка «Шот-лист» серии n.
 * «Разбить на кадры» → воркер episode_shots_v2 (FABLE_MODEL) делит сценарий на упорядоченные кадры/клипы (4–6 сек,
 * 1 кадр = 1 клип) с описанием действия на языке синопсиса. «Промпт» (Eye) → модалка: редактируемый system (со
 * сбросом к авто) + read-only сценарий (user). Отредактированный system хранится в localStorage-черновике и
 * передаётся при разбивке как override. Карточки кадров можно править вручную (№, длительность, описание) — PATCH,
 * повторная разбивка такие кадры не перезатирает. Задача возобновляется при повторном открытии страницы.
 */
const API = '/api/ai/v2/shots'
const EXTRACT_EXPECTED_SEC = 210 // реальные прогоны: 1,5–3,5 мин (перевод + длинный JSON с 3 полями на кадр)
const isActive = (j: any) => !!j && (j.status === 'pending' || j.status === 'processing')
const draftKey = (pid: string, n: number) => `foltum:v2:shots-prompt:${pid}:${n}`

export function ShotlistTab({ projectId, n, hasScript, scriptText, initialShots }: {
  projectId: string; n: number; hasScript: boolean; scriptText: string; initialShots: EpisodeShotV2[]
}) {
  const { t } = useTranslation()
  const [items, setItems] = useState<EpisodeShotV2[]>(initialShots)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [starting, setStarting] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  // Авто-system считаем сразу на клиенте (шаблон не зависит от языка проекта), сервер лишь уточняет его в GET —
  // иначе модалка, открытая до ответа GET, оставалась с пустым полем.
  const [autoSystem, setAutoSystem] = useState(() => episodeShotsV2SystemPrompt(synopsisLanguageFromCode(null)))
  const [systemDraft, setSystemDraft] = useState('')
  const [script, setScript] = useState(scriptText)
  const extractIdRef = useRef<string | null>(null)

  // Черновик системного промпта из localStorage (per-episode).
  useEffect(() => {
    try {
      const v = localStorage.getItem(draftKey(projectId, n))
      if (v && v.trim()) setSystemDraft(v)
      else if (v !== null) localStorage.removeItem(draftKey(projectId, n))
    } catch { /* недоступно */ }
  }, [projectId, n])

  // Блокировка вертикального скролла при открытой модалке.
  useEffect(() => {
    if (!promptOpen) return
    const body = document.body
    const scrollY = window.scrollY
    const prev = { position: body.style.position, top: body.style.top, left: body.style.left, right: body.style.right, width: body.style.width, overflow: body.style.overflow }
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.left = '0'
    body.style.right = '0'
    body.style.width = '100%'
    body.style.overflow = 'hidden'
    return () => {
      body.style.position = prev.position
      body.style.top = prev.top
      body.style.left = prev.left
      body.style.right = prev.right
      body.style.width = prev.width
      body.style.overflow = prev.overflow
      window.scrollTo(0, scrollY)
    }
  }, [promptOpen])

  const refresh = async () => {
    try {
      const res = await fetch(`${API}?projectId=${projectId}&episode=${n}`, { cache: 'no-store' })
      if (!res.ok) return
      const d = await res.json().catch(() => null)
      if (Array.isArray(d?.items)) setItems(d.items)
    } catch { /* транзиентно */ }
  }

  const extract = useJobPolling({
    intervalMs: 1000,
    onFinish: (res: any) => {
      extractIdRef.current = null
      if (res.job.status === 'completed') { setError(''); void refresh() }
      else if (res.job.status === 'canceled') setNotice(t('ideaV2.shotsCanceled'))
      else setError(res.job.error ?? t('ideaV2.shotsExtractFailed'))
    },
  })
  const extracting = starting || isActive(extract.job)

  // Возобновление идущей задачи + наполнение данных модалки (autoSystem, сценарий).
  useEffect(() => {
    let ignore = false
    ;(async () => {
      try {
        const d = await fetch(`${API}?projectId=${projectId}&episode=${n}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
        if (ignore || !d) return
        if (Array.isArray(d.items)) setItems(d.items)
        if (typeof d.autoSystem === 'string' && d.autoSystem.trim()) setAutoSystem(d.autoSystem)
        if (typeof d.scriptText === 'string' && d.scriptText) setScript(d.scriptText)
        if (isActive(d.job)) { extractIdRef.current = d.job.id; extract.start(d.job.id) }
      } catch { /* транзиентно */ }
    })()
    return () => { ignore = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, n])

  const runExtract = async () => {
    setError(''); setNotice(''); extract.clear(); setStarting(true)
    const override = systemDraft.trim() && systemDraft.trim() !== autoSystem.trim() ? systemDraft : undefined
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, episode: n, ...(override ? { system: override } : {}) }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? t('ideaV2.shotsExtractFailed')); return }
      if (d?.jobId) { extractIdRef.current = d.jobId; extract.start(d.jobId) }
    } catch { setError(t('ideaV2.shotsNetworkError')) }
    finally { setStarting(false) }
  }

  const cancelJob = async () => {
    const id = extractIdRef.current
    if (!id) return
    try { await fetch(`/api/ai/jobs/${id}/cancel`, { method: 'POST' }) } catch { /* поллинг повторит */ }
  }

  // «Пересобрать промпт»: свежий системный промпт с сервера (актуальные правила + язык проекта), сохранённая правка сбрасывается.
  const rebuildSystemPrompt = async (): Promise<string> => {
    const d = await fetch(`${API}?projectId=${projectId}&episode=${n}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    const fresh = typeof d?.autoSystem === 'string' && d.autoSystem.trim() ? d.autoSystem : ''
    if (!fresh) return ''
    setAutoSystem(fresh)
    setSystemDraft('')
    try { localStorage.removeItem(draftKey(projectId, n)) } catch { /* недоступно */ }
    return fresh
  }

  const saveSystemDraft = (system: string) => {
    setSystemDraft(system)
    try {
      if (system.trim() && system.trim() !== autoSystem.trim()) localStorage.setItem(draftKey(projectId, n), system)
      else localStorage.removeItem(draftKey(projectId, n))
    } catch { /* недоступно */ }
    setPromptOpen(false)
  }

  const totalSec = useMemo(() => items.reduce((s, x) => s + (Number(x.durationSec) || 0), 0), [items])

  const btnBar = 'inline-flex items-center justify-center gap-2 rounded-none border border-border bg-muted px-4 py-2 text-sm font-semibold transition hover:bg-muted/80 disabled:opacity-50'

  if (!hasScript && !items.length) {
    return <p className="text-sm text-muted-foreground" data-testid="episode-v2-shots-need-script">{t('ideaV2.shotsNeedScript')}</p>
  }

  const ej = extract.job

  return (
    <div data-testid="episode-v2-shots">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('ideaV2.shotsIntro')} <span className="font-semibold text-foreground">{FABLE_MODEL_LABEL}</span></p>
        <div className="flex flex-wrap items-stretch gap-2">
          <button onClick={() => setPromptOpen(true)} disabled={extracting} className={`${btnBar} min-w-[140px]`} data-testid="episode-v2-shots-view-prompt">
            <Eye className="h-4 w-4" /> {t('ideaV2.shotsViewPrompt')}
            {systemDraft.trim() && autoSystem && systemDraft.trim() !== autoSystem.trim() && (
              <span className="rounded-sm bg-primary px-1 text-[9px] font-bold uppercase leading-tight text-primary-foreground">{t('ideaV2.refsEdited')}</span>
            )}
          </button>
          {hasScript && (
            <button onClick={() => void runExtract()} disabled={extracting} className={`${btnBar} min-w-[180px]`} data-testid="episode-v2-shots-extract">
              {extracting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              {items.length ? t('ideaV2.shotsReextract') : t('ideaV2.shotsExtract')}
            </button>
          )}
        </div>
      </div>
      {!hasScript && <p className="mt-2 text-xs text-amber-500">{t('ideaV2.shotsNeedScript')}</p>}
      {items.length > 0 && hasScript && <p className="mt-2 text-[11px] text-muted-foreground">{t('ideaV2.shotsReextractHint')}</p>}

      {extracting && (
        <div className="mt-4 space-y-2" data-testid="episode-v2-shots-extracting">
          {ej ? <SmoothProgress job={ej} expectedTotalSec={EXTRACT_EXPECTED_SEC} /> : (
            <p className="inline-flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin text-primary" /> {t('ideaV2.shotsExtracting')}</p>
          )}
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 text-xs text-muted-foreground">{t('ideaV2.shotsExtracting')} {t('ideaV2.shotsExtractEta')} {t('ideaV2.shotsCanClose')}</p>
            <CancelButton onCancel={cancelJob} testId="episode-v2-shots-extract-cancel" className="flex-shrink-0" />
          </div>
        </div>
      )}
      {notice && <p className="mt-3 text-xs text-amber-500">{notice}</p>}
      {error && <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="episode-v2-shots-error">{error}</div>}

      {!items.length && hasScript && !extracting && <p className="mt-4 text-sm text-muted-foreground">{t('ideaV2.shotsEmpty')}</p>}

      {items.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="episode-v2-shots-summary">
          <span>{t('ideaV2.shotsCount', { count: items.length })}</span>
          <span>·</span>
          <span>{t('ideaV2.shotsTotalDuration', { sec: totalSec })}</span>
        </div>
      )}

      <div className="mt-3 space-y-2">
        {items.map((shot) => (
          <ShotCard
            key={shot.id}
            projectId={projectId}
            n={n}
            shot={shot}
            disabled={extracting}
            onSaved={(patch) => setItems((list) => list.map((x) => (x.id === shot.id ? { ...x, ...patch, edited: true } : x)))}
          />
        ))}
      </div>

      {promptOpen && (
        <ShotPromptModal
          autoSystem={autoSystem}
          systemDraft={systemDraft}
          scriptText={script}
          onSave={saveSystemDraft}
          onRebuild={rebuildSystemPrompt}
          onClose={() => setPromptOpen(false)}
        />
      )}
    </div>
  )
}

/** Три абзаца кадра для отображения/правки: «Фрейм» (статичное описание), «Действие» (обязательное), «Концовка». */
type ShotFieldKey = 'frame' | 'action' | 'ending'

const SHOT_FIELDS: Array<{ key: ShotFieldKey; labelKey: string; multiline: boolean }> = [
  { key: 'frame', labelKey: 'ideaV2.shotField.frame', multiline: true },
  { key: 'action', labelKey: 'ideaV2.shotField.action', multiline: true },
  { key: 'ending', labelKey: 'ideaV2.shotField.ending', multiline: true },
]

type ShotPatch = Partial<Pick<EpisodeShotV2, 'frame' | 'action' | 'ending' | 'durationSec'>>

/** Текст поля кадра: для старых шотов без frame — синтез из legacy-полей. */
const shotFieldValue = (shot: EpisodeShotV2, key: ShotFieldKey): string =>
  key === 'frame' ? shotFrameText(shot) : String((shot as any)[key] ?? '')

/**
 * Карточка одного кадра: № · длительность · три абзаца (Фрейм / Действие / Концовка). Правка вручную + длительность
 * 4–6 сек → PATCH /api/ai/v2/shots (edited=true). Повторная разбивка такие кадры сохраняет.
 */
function ShotCard({ projectId, n, shot, disabled, onSaved }: {
  projectId: string; n: number; shot: EpisodeShotV2; disabled: boolean; onSaved: (patch: ShotPatch) => void
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})
  const [dur, setDur] = useState(shot.durationSec)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const startEdit = () => {
    const f: Record<string, string> = {}
    for (const { key } of SHOT_FIELDS) f[key] = shotFieldValue(shot, key)
    setForm(f); setDur(shot.durationSec); setError(''); setEditing(true)
  }
  const cancel = () => setEditing(false)
  const setField = (key: string, v: string) => setForm((p) => ({ ...p, [key]: v }))

  const save = async () => {
    const a = (form.action ?? '').trim()
    const d = Math.min(6, Math.max(4, Math.round(Number(dur) || 5)))
    if (!a) { setError(t('ideaV2.shotsActionRequired')); return }
    const fr = (form.frame ?? '').trim()
    const en = (form.ending ?? '').trim()
    const patch: ShotPatch = { frame: fr, action: a, ending: en, durationSec: d }
    setSaving(true); setError('')
    try {
      const res = await fetch(API, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, episode: n, id: shot.id, ...patch }),
      })
      if (!res.ok) { const j = await res.json().catch(() => ({})); setError(j?.error ?? t('ideaV2.shotsSaveFailed')); return }
      // Пустые строки на клиенте показываем как «нет значения».
      onSaved({ frame: fr, action: a, ending: en, durationSec: d })
      setEditing(false)
    } catch { setError(t('ideaV2.shotsNetworkError')) }
    finally { setSaving(false) }
  }

  const present = SHOT_FIELDS.map((f) => ({ ...f, value: shotFieldValue(shot, f.key).trim() })).filter((f) => f.value)

  return (
    <div className="flex gap-3 rounded-lg border border-border/70 bg-muted/20 p-3 sm:p-4" data-testid={`episode-v2-shot-${shot.id}`}>
      <div className="flex flex-shrink-0 flex-col items-center gap-1">
        <span className="flex h-9 w-9 items-center justify-center rounded-md bg-secondary text-sm font-bold text-secondary-foreground" data-testid="episode-v2-shot-index">{shot.index}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground" data-testid="episode-v2-shot-duration">{t('ideaV2.shotsSec', { sec: editing ? dur : shot.durationSec })}</span>
      </div>
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="space-y-2">
            {SHOT_FIELDS.map(({ key, labelKey, multiline }) => (
              <label key={key} className="block">
                <span className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t(labelKey)}{key === 'action' ? ' *' : ''}</span>
                {multiline ? (
                  <textarea
                    value={form[key] ?? ''}
                    onChange={(e) => setField(key, e.target.value)}
                    rows={Math.min(6, Math.max(2, (form[key] ?? '').split('\n').length + 1))}
                    className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary"
                    data-testid={`episode-v2-shot-field-${key}`}
                  />
                ) : (
                  <input
                    type="text"
                    value={form[key] ?? ''}
                    onChange={(e) => setField(key, e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary"
                    data-testid={`episode-v2-shot-field-${key}`}
                  />
                )}
              </label>
            ))}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {t('ideaV2.shotsDurationLabel')}
                <input
                  type="number" min={4} max={6} step={1} value={dur}
                  onChange={(e) => setDur(Math.min(6, Math.max(4, Math.round(Number(e.target.value) || 5))))}
                  className="w-16 rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
                  data-testid="episode-v2-shot-duration-input"
                />
              </label>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={cancel} disabled={saving} className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-semibold transition hover:bg-muted disabled:opacity-50" data-testid="episode-v2-shot-cancel">
                  <X className="h-3.5 w-3.5" /> {t('common.cancel')}
                </button>
                <button onClick={() => void save()} disabled={saving || !(form.action ?? '').trim()} className="inline-flex items-center gap-1 rounded-md bg-secondary px-2.5 py-1.5 text-xs font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50" data-testid="episode-v2-shot-save">
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} {t('common.save')}
                </button>
              </div>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1" data-testid="episode-v2-shot-action">
              <div className="space-y-2 text-sm leading-relaxed">
                {present.map(({ key, labelKey, value }) => (
                  <div key={key} data-testid={`episode-v2-shot-view-${key}`}>
                    <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t(labelKey)}</div>
                    <p className="whitespace-pre-wrap text-foreground">{value}</p>
                  </div>
                ))}
              </div>
              {shot.edited && <span className="mt-1 inline-block text-[10px] text-muted-foreground">· {t('ideaV2.refsEdited')}</span>}
            </div>
            <button onClick={startEdit} disabled={disabled} className="flex-shrink-0 rounded-md border border-border bg-transparent p-1.5 text-muted-foreground transition hover:bg-muted/60 hover:text-foreground disabled:opacity-50" title={t('common.edit')} data-testid="episode-v2-shot-edit">
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
