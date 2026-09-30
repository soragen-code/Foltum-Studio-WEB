'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Wand2, Sparkles, Lightbulb, Eye, Pencil, ArrowLeft, ArrowRight, Tags, Info, BookOpen, RotateCcw, Copy, Check, X, Quote } from 'lucide-react'
import { GENRES } from '@/lib/idea'
import { FABLE_MODEL_LABEL, SYNOPSIS_V2_STAGE, LOGLINE_V2_STAGE, LOGLINE_V2_FORMULA_RU, LOGLINE_V2_EXAMPLE_RU } from '@/lib/idea-v2'
import { CancelButton } from './cancel-button'
import { useJobPolling, SmoothProgress, StreamingText } from './use-job-polling'

/** Примерная длительность генераций v2 — управляет плавным прогресс-баром. */
const SYNOPSIS_V2_EXPECTED_SEC = 50

type Screen = 'choose' | 'input'
type Field = 'system' | 'user' | 'assistant'
type Kind = 'logline' | 'synopsis'
type StepKey = 'idea' | Kind
type Prompt = { system: string; user: string; assistant: string }

const EMPTY_PROMPT: Prompt = { system: '', user: '', assistant: '' }
const FIELD_FLAGS = { system: false, user: false, assistant: false }
const FIELD_TEXTS = { system: '', user: '', assistant: '' }

const API: Record<Kind, { generate: string; preview: string }> = {
  logline: { generate: '/api/ai/v2/logline', preview: '/api/ai/v2/logline/preview' },
  synopsis: { generate: '/api/ai/v2/synopsis', preview: '/api/ai/v2/synopsis/preview' },
}
const KIND_LABEL: Record<Kind, string> = { logline: 'логлайна', synopsis: 'синопсиса' }

/**
 * Поток «Новый проект v2.0» — три шага: Идея → Логлайн → Синопсис.
 *   idea     — выбор режима (своя идея / жанры [+ пожелания]) и ввод → «Сохранить и продолжить»
 *              (строит промпт логлайна и открывает шаг 2, НЕ генерируя).
 *   logline  — «Просмотреть промпт» / «Сгенерировать»; стрим логлайна побуквенно; готовый текст можно
 *              поправить → «Сохранить и продолжить» (утверждает логлайн и запускает синопсис).
 *   synopsis — синопсис, развернутый из утверждённого логлайна.
 *
 * На экранах логлайна и синопсиса кнопки действий стоят в правом верхнем углу блока, над текстом. Модалка промпта общая для обоих шагов
 * (per-field: Копировать / Сбросить / Редактировать / РУ; в подвале — только «Сохранить»).
 * Перевод РУ — только для отображения; в API всегда уходит оригинал.
 */
export function IdeaStageV2({ project, onRefresh }: { project: any; onRefresh: () => void }) {
  const [mode, setMode] = useState<'idea' | 'genres'>('idea')
  const [idea, setIdea] = useState<string>(project?.idea && !String(project.idea).startsWith('[v2 · genres]') ? project.idea : '')
  const [genres, setGenres] = useState<string[]>([])
  const [screen, setScreen] = useState<Screen>('choose')
  // Пожелания продюсера (только режим жанров). В БД не хранятся — уходят в preview/generate через inputBody.
  const [wishes, setWishes] = useState('')
  // Модалка-предупреждение о сбросе последующих шагов (при «Сохранить и продолжить» с изменённым вводом).
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  // Пользователь подтвердил сброс → уже сохранённые логлайн/синопсис скрываются до новой генерации логлайна.
  const [downstreamReset, setDownstreamReset] = useState(false)
  // Ввод шага 1 сохранён («Сохранить и продолжить») → экран логлайна доступен ещё до генерации.
  // Также удерживает экран логлайна в «дыре» между завершением job и onRefresh (нет мигания на шаг 1).
  const [inputSaved, setInputSaved] = useState(false)
  const [savingInput, setSavingInput] = useState(false)

  // ─── Данные проекта
  const stage = project?.stage
  const savedLogline = String(project?.logline ?? '').trim()
  const hasLogline = (stage === LOGLINE_V2_STAGE || stage === SYNOPSIS_V2_STAGE) && !!savedLogline && !downstreamReset
  const hasSynopsis = stage === SYNOPSIS_V2_STAGE && !!String(project?.synopsis ?? '').trim() && !downstreamReset
  const autoView: StepKey = hasSynopsis ? 'synopsis' : hasLogline ? 'logline' : 'idea'
  const [view, setView] = useState<StepKey | null>(null) // null → autoView
  const currentView: StepKey = view ?? autoView

  // Черновик логлайна (редактируется на экране логлайна перед аппрувом).
  const [loglineDraft, setLoglineDraft] = useState(savedLogline)
  useEffect(() => { setLoglineDraft(savedLogline) }, [savedLogline])
  const loglineDirty = loglineDraft.trim() !== savedLogline

  // Правка логлайна: «что изменить» — уходит в preview/generate вместе с текущим логлайном,
  // чтобы модель дорабатывала его с сохранением контекста, а не писала с нуля.
  const [refineText, setRefineText] = useState('')

  // Ввод менялся после последнего «Сохранить и продолжить» → шаги «Логлайн»/«Синопсис» недоступны,
  // но их данные НЕ сбрасываются, пока пользователь не подтвердит сброс в модалке.
  const [inputDirty, setInputDirty] = useState(false)

  // ─── Промпты (по шагам): редактируемые + «пристин» для «Сбросить»
  const [promptKind, setPromptKind] = useState<Kind>('logline')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState<Kind | null>(null)
  const [ready, setReady] = useState<Record<Kind, boolean>>({ logline: false, synopsis: false })
  const [edit, setEdit] = useState<Record<Kind, Prompt>>({ logline: EMPTY_PROMPT, synopsis: EMPTY_PROMPT })
  const [orig, setOrig] = useState<Record<Kind, Prompt>>({ logline: EMPTY_PROMPT, synopsis: EMPTY_PROMPT })
  const [note, setNote] = useState<Record<Kind, string>>({ logline: '', synopsis: '' })
  const [copied, setCopied] = useState<Field | null>(null)
  const [editable, setEditable] = useState<Record<Field, boolean>>(FIELD_FLAGS)
  const [ruOn, setRuOn] = useState<Record<Field, boolean>>(FIELD_FLAGS)
  const [ruText, setRuText] = useState<Record<Field, string>>(FIELD_TEXTS)
  const [ruLoading, setRuLoading] = useState<Record<Field, boolean>>(FIELD_FLAGS)

  const isEdited = (k: Kind) =>
    ready[k] && (edit[k].system !== orig[k].system || edit[k].user !== orig[k].user || edit[k].assistant !== orig[k].assistant)
  const resetPrompt = (k: Kind) => setReady((p) => ({ ...p, [k]: false }))

  // Сброс последующих шагов — вызывается ТОЛЬКО после подтверждения в модалке.
  const invalidateDownstream = () => {
    resetPrompt('logline'); resetPrompt('synopsis'); setPreviewOpen(false)
    setDownstreamReset(true); setLoglineDraft('')
  }
  // Редактирование ввода лишь помечает его изменённым — ничего не сбрасывает.
  const markInputDirty = () => setInputDirty(true)

  // ─── Генерация (две фоновые задачи)
  const [starting, setStarting] = useState<Kind | null>(null)
  const [error, setError] = useState('')
  const [canceled, setCanceled] = useState<Kind | null>(null)
  const activeJobIdRef = useRef<string | null>(null)

  const finish = (k: Kind) => (res: any) => {
    activeJobIdRef.current = null
    if (res.job.status === 'completed') {
      setError(''); setCanceled(null); setPreviewOpen(false)
      if (k === 'logline') {
        setInputDirty(false); setInputSaved(true); setDownstreamReset(false); resetPrompt('synopsis'); setRefineText('')
        // Сразу показываем готовый текст (до onRefresh), чтобы поле не пустело.
        const fresh = String(res.job.result?.logline ?? res.job.streamedText ?? '').trim()
        if (fresh) setLoglineDraft(fresh)
      }
      setView(k)
      onRefresh()
    } else if (res.job.status === 'canceled') {
      setCanceled(k)
    } else {
      setError(res.job.error ?? `Не удалось сгенерировать ${k === 'logline' ? 'логлайн' : 'синопсис'}`)
    }
  }
  const loglineJob = useJobPolling({ intervalMs: 400, onFinish: finish('logline') })
  const synopsisJob = useJobPolling({ intervalMs: 800, onFinish: finish('synopsis') })
  const jobs: Record<Kind, typeof loglineJob> = { logline: loglineJob, synopsis: synopsisJob }
  const isActive = (j: any) => !!j && (j.status === 'pending' || j.status === 'processing')
  const activeKind: Kind | null = starting ?? (isActive(loglineJob.job) ? 'logline' : isActive(synopsisJob.job) ? 'synopsis' : null)
  const generating = !!activeKind

  // Возобновление: подхватываем уже крутящуюся задачу логлайна или синопсиса.
  useEffect(() => {
    let ignore = false
    ;(async () => {
      for (const k of ['logline', 'synopsis'] as Kind[]) {
        try {
          const res = await fetch(`${API[k].generate}?projectId=${project.id}`, { cache: 'no-store' })
          if (!res.ok) continue
          const j = (await res.json().catch(() => null))?.job
          if (ignore) return
          if (j && isActive(j)) { activeJobIdRef.current = j.id; jobs[k].start(j.id); return }
        } catch { /* транзиентно */ }
      }
    })()
    return () => { ignore = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  // Проект создан из жанров ("[v2 · genres] …") → восстанавливаем режим и жанры.
  useEffect(() => {
    const raw = String(project?.idea ?? '')
    if (raw.startsWith('[v2 · genres]')) {
      setMode('genres')
      const enList = raw.replace('[v2 · genres]', '').split(',').map((s) => s.trim()).filter(Boolean)
      const byEn = Object.fromEntries(GENRES.map((g) => [g.en, g.id]))
      const ids = enList.map((en) => byEn[en] ?? en)
      if (ids.length) setGenres(ids)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleGenre = (id: string) => {
    setGenres((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]))
    markInputDirty()
  }
  const onIdeaChange = (v: string) => { setIdea(v); markInputDirty() }
  const canProceed = mode === 'idea' ? idea.trim().length >= 10 : genres.length > 0
  const onWishesChange = (v: string) => { setWishes(v); markInputDirty() }
  const inputBody = () => (mode === 'idea' ? { idea: idea.trim() } : { genres, wishes: wishes.trim() || undefined })
  // Аргументы уточнения логлайна: добавляются только для шага логлайна, когда есть непустая правка и текущий логлайн.
  const refineArgs = (k: Kind) =>
    k === 'logline' && refineText.trim() && savedLogline ? { logline: savedLogline, refine: refineText.trim() } : {}
  const onRefineChange = (v: string) => { setRefineText(v); resetPrompt('logline') }

  const chooseMode = (m: 'idea' | 'genres') => {
    if (m !== mode) markInputDirty()
    setMode(m); setError(''); setCanceled(null); setScreen('input')
  }

  // Собрать промпт шага k для текущего ввода (+ пристин-копии).
  const buildPrompt = async (k: Kind): Promise<boolean> => {
    try {
      const res = await fetch(API[k].preview, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, ...inputBody(), ...refineArgs(k) }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? 'Не удалось собрать промпт'); return false }
      const p: Prompt = { system: d.system ?? '', user: d.user ?? '', assistant: d.assistant ?? '' }
      setEdit((s) => ({ ...s, [k]: p })); setOrig((s) => ({ ...s, [k]: p }))
      setNote((s) => ({ ...s, [k]: d.contextNote ?? '' }))
      setReady((s) => ({ ...s, [k]: true }))
      return true
    } catch { setError('Ошибка сети'); return false }
  }

  const openPreview = async (k: Kind) => {
    setError('')
    setEditable(FIELD_FLAGS); setRuOn(FIELD_FLAGS); setRuText(FIELD_TEXTS); setRuLoading(FIELD_FLAGS)
    setPromptKind(k)
    if (ready[k]) { setPreviewOpen(true); return }
    setPreviewLoading(k)
    const ok = await buildPrompt(k)
    setPreviewLoading(null)
    if (ok) setPreviewOpen(true)
  }

  const generate = async (k: Kind) => {
    setError(''); setCanceled(null); jobs[k].clear(); setStarting(k)
    try {
      const body: any = { projectId: project.id, ...inputBody(), ...refineArgs(k) }
      if (isEdited(k)) { body.overrideSystem = edit[k].system; body.overrideUser = edit[k].user; body.overrideAssistant = edit[k].assistant }
      const res = await fetch(API[k].generate, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? `Не удалось сгенерировать ${k === 'logline' ? 'логлайн' : 'синопсис'}`); return }
      if (d?.jobId) { activeJobIdRef.current = d.jobId; jobs[k].start(d.jobId) }
      else onRefresh()
    } catch { setError('Ошибка сети') }
    finally { setStarting(null) }
  }

  // Сохранить ввод (идея/жанры/пожелания) и перейти на экран логлайна. Промпт логлайна
  // перестраивается, если ввод менялся (актуальные пожелания попадают в промпт). Генерацию НЕ запускаем.
  const proceedToLogline = async (reset: boolean) => {
    setError(''); setCanceled(null); setResetConfirmOpen(false)
    if (reset) invalidateDownstream()
    const rebuild = reset || inputDirty || !ready.logline
    if (rebuild) {
      resetPrompt('logline')
      setSavingInput(true)
      const ok = await buildPrompt('logline')
      setSavingInput(false)
      if (!ok) return
    }
    setInputDirty(false)
    setInputSaved(true)
    setView('logline')
  }

  // Шаг 1 → «Сохранить и продолжить». Если ввод изменён и уже есть логлайн/синопсис —
  // сначала модалка-предупреждение о сбросе; иначе обычный переход без сброса.
  const saveInputAndContinue = () => {
    if (!canProceed) {
      setError(mode === 'idea' ? 'Опишите идею хотя бы одним–двумя предложениями' : 'Выберите хотя бы один жанр')
      return
    }
    if (inputDirty && (hasLogline || hasSynopsis)) { setResetConfirmOpen(true); return }
    void proceedToLogline(false)
  }

  // Утвердить (возможно отредактированный) логлайн и перейти на экран синопсиса (без автогенерации).
  const [approving, setApproving] = useState(false)
  const approveLoglineAndContinue = async () => {
    const text = loglineDraft.trim()
    if (text.length < 10) { setError('Логлайн слишком короткий'); return }
    setError(''); setApproving(true)
    try {
      const needApprove = loglineDirty || !project?.loglineApproved
      if (needApprove) {
        const res = await fetch('/api/ai/v2/logline/approve', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id, logline: text }),
        })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { setError(d?.error ?? 'Не удалось утвердить логлайн'); return }
        // Логлайн изменился → собранный промпт синопсиса устарел (если его не правили вручную).
        if (!isEdited('synopsis')) resetPrompt('synopsis')
      }
    } catch { setError('Ошибка сети'); return }
    finally { setApproving(false) }
    // Переходим на экран синопсиса БЕЗ автогенерации — пользователь сам смотрит промпт и жмёт «Сгенерировать».
    setView('synopsis'); onRefresh()
  }

  const cancel = async () => {
    const id = activeJobIdRef.current
    if (!id) return
    try { await fetch(`/api/ai/jobs/${id}/cancel`, { method: 'POST' }) } catch { /* поллинг повторит */ }
  }

  // ─── Пер-поле действия модалки промпта (для текущего promptKind)
  const fieldValue = edit[promptKind]
  const setField = (key: Field, v: string) => setEdit((s) => ({ ...s, [promptKind]: { ...s[promptKind], [key]: v } }))

  const copyPrompt = async (which: Field, text: string) => {
    try {
      await navigator.clipboard.writeText(text ?? '')
      setCopied(which)
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500)
    } catch { /* буфер обмена недоступен */ }
  }
  const toggleEdit = (key: Field) => { setEditable((p) => ({ ...p, [key]: !p[key] })); setRuOn((p) => ({ ...p, [key]: false })) }
  const resetField = (key: Field) => {
    setField(key, orig[promptKind][key])
    setRuOn((p) => ({ ...p, [key]: false })); setRuText((p) => ({ ...p, [key]: '' }))
  }
  const translateField = async (key: Field) => {
    setRuLoading((p) => ({ ...p, [key]: true }))
    try {
      const res = await fetch('/api/ai/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: fieldValue[key] }) })
      const d = await res.json().catch(() => ({}))
      setRuText((p) => ({ ...p, [key]: res.ok ? (d.text ?? '') : '(не удалось перевести)' }))
    } catch {
      setRuText((p) => ({ ...p, [key]: '(ошибка сети при переводе)' }))
    } finally {
      setRuLoading((p) => ({ ...p, [key]: false }))
    }
  }
  const toggleRu = (key: Field) => {
    const next = !ruOn[key]
    setRuOn((p) => ({ ...p, [key]: next }))
    if (next && !ruText[key]) translateField(key)
  }
  const onFieldChange = (key: Field, v: string) => { setField(key, v); setRuText((p) => (p[key] ? { ...p, [key]: '' } : p)) }

  // ─── Степпер: Идея → Логлайн → Синопсис
  const currentStepKey: StepKey = activeKind ?? currentView
  const loglineApproved = !!project?.loglineApproved
  const stepClickable: Record<StepKey, boolean> = {
    idea: !generating,
    logline: (hasLogline || inputSaved) && !inputDirty && !generating,
    synopsis: (hasSynopsis || (loglineApproved && hasLogline)) && !inputDirty && !loglineDirty && !generating,
  }
  const goStep = (key: StepKey) => {
    if (key === currentStepKey || !stepClickable[key]) return
    setError(''); setPreviewOpen(false)
    if (key === 'idea') setScreen('input')
    setView(key)
  }
  const V2_STEPS: { key: StepKey; label: string }[] = [
    { key: 'idea', label: 'Идея' },
    { key: 'logline', label: 'Логлайн' },
    { key: 'synopsis', label: 'Синопсис' },
  ]
  const stepsBar = (() => {
    const curIdx = V2_STEPS.findIndex((s) => s.key === currentStepKey)
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="idea-v2-steps">
        {V2_STEPS.map((s, i) => {
          const active = s.key === currentStepKey
          const reached = i <= curIdx
          const canClick = stepClickable[s.key] && !active
          return (
            <div key={s.key} className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={!canClick}
                onClick={() => goStep(s.key)}
                data-testid={`idea-v2-step-${s.key}`}
                data-active={active ? 'true' : undefined}
                aria-current={active ? 'step' : undefined}
                className={`rounded-full border px-3 py-1 font-medium transition ${
                  active
                    ? 'border-primary bg-primary text-primary-foreground'
                    : reached || canClick
                      ? 'border-border hover:border-primary/60'
                      : 'border-border/50 text-muted-foreground/50'
                } ${canClick ? 'cursor-pointer' : 'cursor-default'} disabled:cursor-not-allowed`}
              >
                {`${i + 1} · ${s.label}`}
              </button>
              {i < V2_STEPS.length - 1 && <span className="text-muted-foreground/40">→</span>}
            </div>
          )
        })}
      </div>
    )
  })()

  // ─── Кнопки действий результата (правый верхний угол блока, над текстом)
  const btnGhost = 'flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold transition hover:bg-muted disabled:opacity-50'
  const btnMain = 'flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-1.5 text-xs font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50'
  const resultActions = (k: Kind, onRegenerate: () => void) => (
    <div className="flex flex-wrap items-center justify-end gap-2" data-testid={`idea-v2-${k}-actions`}>
      <button onClick={() => openPreview(k)} disabled={previewLoading === k || approving} className={btnGhost} data-testid={`idea-v2-${k}-preview`}>
        {previewLoading === k ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Собираем промпт…</> : <><Eye className="h-3.5 w-3.5" /> Просмотреть промпт</>}
      </button>
      <button onClick={onRegenerate} disabled={approving} className={btnMain} data-testid={`idea-v2-${k}-regenerate`}>
        <Wand2 className="h-3.5 w-3.5" /> Перегенерировать
      </button>
    </div>
  )

  // ─── Модалка просмотра / редактирования промпта (общая для логлайна и синопсиса)
  const renderPromptModal = () => {
    if (!previewOpen || generating) return null
    const btnBase = 'inline-flex items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-xs font-medium transition'
    const btnIdle = 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
    const btnActive = 'border-primary bg-primary/10 text-primary'

    const renderField = (key: Field, label: string, rows: number, placeholder?: string) => {
      const isRu = ruOn[key]
      const loading = ruLoading[key]
      const canEdit = editable[key] && !isRu
      const shown = isRu ? (loading ? '' : ruText[key]) : fieldValue[key]
      return (
        <div>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</label>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => copyPrompt(key, shown)} className={`${btnBase} ${btnIdle}`} title="Скопировать" data-testid={`idea-v2-copy-${key}`}>
                {copied === key ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <button type="button" onClick={() => resetField(key)} className={`${btnBase} ${btnIdle}`} title="Сбросить" data-testid={`idea-v2-reset-${key}`}>
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => toggleEdit(key)}
                className={`${btnBase} ${editable[key] ? btnActive : btnIdle}`}
                title={editable[key] ? 'Редактирование включено' : 'Редактировать'}
                aria-pressed={editable[key]}
                data-testid={`idea-v2-edit-${key}`}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => toggleRu(key)}
                className={`${btnBase} ${isRu ? btnActive : btnIdle}`}
                title="Показать перевод на русский (только просмотр; в API уходит оригинал)"
                aria-pressed={isRu}
                data-testid={`idea-v2-ru-${key}`}
              >
                РУ
              </button>
            </div>
          </div>
          <div className="relative">
            <textarea
              value={shown}
              onChange={(e) => onFieldChange(key, e.target.value)}
              readOnly={!canEdit}
              rows={rows}
              placeholder={placeholder}
              className={`w-full resize-y rounded-lg border px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-primary ${canEdit ? 'border-input bg-background' : 'border-border bg-muted/40 text-foreground/90'}`}
              data-testid={`idea-v2-preview-${key}`}
            />
            {loading && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-background/60">
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> Переводим…</span>
              </div>
            )}
          </div>
          {isRu && !loading && (
            <p className="mt-1 text-[11px] text-muted-foreground">Показан перевод на русский — только для просмотра. В генерацию уходит оригинал.</p>
          )}
        </div>
      )
    }

    const close = () => setPreviewOpen(false)
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={close} data-testid="idea-v2-preview-modal" data-kind={promptKind}>
        <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3.5">
            <h3 className="flex items-center gap-2 font-display text-lg font-semibold">
              <Eye className="h-5 w-5 text-primary" /> Промпт {KIND_LABEL[promptKind]}
            </h3>
            <button onClick={close} className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground" aria-label="Закрыть" data-testid="idea-v2-preview-close">
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
            {note[promptKind] && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="idea-v2-context-note">
                <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> {note[promptKind]}
              </p>
            )}
            {renderField('system', 'System (правила)', 10)}
            {renderField('user', 'User (запрос)', 7)}
            {renderField('assistant', 'Assistant (зачин ответа)', 5, 'Необязательно: задайте зачин ответа модели — она продолжит с него. Оставьте пустым, чтобы модель писала с чистого листа.')}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
            <button onClick={close} className="flex items-center gap-2 rounded-lg bg-secondary px-5 py-2.5 text-sm font-semibold text-secondary-foreground transition hover:brightness-110" data-testid="idea-v2-preview-save">
              <Check className="h-4 w-4" /> Сохранить
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Модалка-предупреждение: изменённый ввод сбросит уже сгенерированные логлайн/синопсис.
  const renderResetConfirmModal = () => {
    if (!resetConfirmOpen) return null
    const close = () => setResetConfirmOpen(false)
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={close} data-testid="idea-v2-reset-confirm-modal">
        <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3.5">
            <h3 className="flex items-center gap-2 font-display text-lg font-semibold">
              <Info className="h-5 w-5 text-amber-500" /> Изменения затронут следующие шаги
            </h3>
            <button onClick={close} className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground" aria-label="Закрыть">
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="px-5 py-4 text-sm text-muted-foreground">
            Вы изменили {mode === 'idea' ? 'идею' : 'жанры или пожелания'}. Если продолжить, ранее сгенерированные логлайн{hasSynopsis ? ' и синопсис' : ''} будут сброшены и потребуют повторной генерации.
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
            <button onClick={close} className="rounded-lg border border-border bg-background px-5 py-2.5 text-sm font-semibold text-foreground transition hover:bg-muted" data-testid="idea-v2-reset-cancel">
              Отмена
            </button>
            <button onClick={() => void proceedToLogline(true)} className="flex items-center gap-2 rounded-lg bg-secondary px-5 py-2.5 text-sm font-semibold text-secondary-foreground transition hover:brightness-110" data-testid="idea-v2-reset-confirm">
              <RotateCcw className="h-4 w-4" /> Продолжить и сбросить
            </button>
          </div>
        </div>
      </div>
    )
  }

  const errorBox = error && (
    <div className="rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive" data-testid="idea-v2-error">{error}</div>
  )
  const cardCls = 'rounded-xl border border-border bg-card p-4 sm:p-6'
  const cardStyle = { boxShadow: 'var(--shadow-md)' }

  // ═══════════════════════ Генерация синопсиса: прогресс ═══════════════════════
  // (логлайн генерируется прямо на своём экране — см. ниже, стрим под кнопками)
  if (activeKind === 'synopsis') {
    const j = synopsisJob.job
    return (
      <div className="space-y-6" data-testid="idea-stage-v2">
        {stepsBar}
        {errorBox}
        <div className={cardCls} style={cardStyle} data-testid="idea-v2-generating" data-kind="synopsis">
          <h2 className="flex items-center gap-2 font-display text-xl font-bold">
            <Wand2 className="h-5 w-5 text-primary" /> Генерация {KIND_LABEL.synopsis}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Отправляется в: <span className="font-semibold text-foreground" data-testid="idea-v2-model">{FABLE_MODEL_LABEL}</span>.
          </p>
          <div className="mt-4 space-y-2" data-testid="idea-v2-progress">
            {j ? (
              <SmoothProgress job={j} expectedTotalSec={SYNOPSIS_V2_EXPECTED_SEC} />
            ) : (
              <p className="inline-flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin text-primary" /> Запуск генерации…</p>
            )}
            <StreamingText text={j?.streamedText} active={isActive(j)} />
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 text-xs text-muted-foreground">
                Разворачиваем утверждённый логлайн в синопсис сезона. Вкладку можно закрыть — прогресс и текст сохранятся.
              </p>
              <CancelButton onCancel={cancel} testId="idea-v2-cancel" className="flex-shrink-0" />
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ═══════════════════════ Шаг 2: логлайн ═══════════════════════
  // Экран доступен сразу после «Сохранить и продолжить» (inputSaved) — ещё до генерации; inputSaved же
  // удерживает его между завершением job и onRefresh, чтобы не было отката на шаг 1.
  const loglineGenerating = activeKind === 'logline'
  if ((currentView === 'logline' && (hasLogline || inputSaved)) || loglineGenerating) {
    const j = loglineJob.job
    const streamed = String(j?.streamedText ?? '')
    const loglineStale = hasLogline && inputDirty && !loglineGenerating // ввод изменён после генерации
    const haveText = !!loglineDraft.trim()
    return (
      <div className="space-y-6" data-testid="idea-stage-v2">
        {stepsBar}
        <div className={cardCls} style={cardStyle} data-testid="idea-v2-logline">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 font-display text-xl font-bold">
                <Quote className="h-5 w-5 text-primary" /> Шаг 2: логлайн
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Модель: <span className="font-semibold text-foreground">{FABLE_MODEL_LABEL}</span>
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2" data-testid="idea-v2-logline-actions">
              <button onClick={() => openPreview('logline')} disabled={previewLoading === 'logline' || approving || loglineGenerating} className={btnGhost} data-testid="idea-v2-logline-preview">
                {previewLoading === 'logline' ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Собираем промпт…</> : <><Eye className="h-3.5 w-3.5" /> Просмотреть промпт</>}
              </button>
              {!haveText && !loglineGenerating && (
                <button onClick={() => generate('logline')} disabled={approving} className={btnMain} data-testid="idea-v2-logline-generate">
                  <Wand2 className="h-3.5 w-3.5" /> Сгенерировать
                </button>
              )}
            </div>
          </div>

          {loglineGenerating ? (
            <div className="mt-4 space-y-2" data-testid="idea-v2-logline-stream">
              {streamed.trim() ? (
                <StreamingText text={streamed} active={isActive(j)} className="text-base" maxHeight={200} />
              ) : (
                <p className="inline-flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" /> Пишем логлайн…
                </p>
              )}
              <div className="flex items-center justify-between gap-2">
                <p className="min-w-0 text-xs text-muted-foreground">Логлайн появляется по мере генерации. Вкладку можно закрыть — прогресс сохранится.</p>
                <CancelButton onCancel={cancel} testId="idea-v2-cancel" className="flex-shrink-0" />
              </div>
            </div>
          ) : haveText ? (
            <>
              <textarea
                value={loglineDraft}
                onChange={(e) => setLoglineDraft(e.target.value)}
                rows={3}
                className="mt-4 w-full resize-y rounded-lg border border-input bg-background px-4 py-3 text-base leading-relaxed outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
                data-testid="idea-v2-logline-text"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Формула: <span className="italic">{LOGLINE_V2_FORMULA_RU}</span> Текст можно поправить перед сохранением.
                {loglineDirty && !loglineStale && <span className="ml-1 text-amber-500">Логлайн изменён — синопсис будет построен по новой версии.</span>}
              </p>
              {loglineStale && (
                <p className="mt-1 text-xs text-amber-500" data-testid="idea-v2-logline-stale">Идея или жанры изменились — перегенерируйте логлайн.</p>
              )}
              {!loglineStale && (
                <div className="mt-5 rounded-lg border border-border/70 bg-muted/30 px-4 py-3" data-testid="idea-v2-logline-refine">
                  <label className="text-xs font-semibold text-foreground">Что изменить в логлайне?</label>
                  <textarea
                    value={refineText}
                    onChange={(e) => onRefineChange(e.target.value)}
                    placeholder="Например: сделай ставки выше, добавь романтическую линию, перенеси действие в 90-е…"
                    rows={2}
                    disabled={approving}
                    className="mt-2 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
                    data-testid="idea-v2-logline-refine-input"
                  />
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="min-w-0 text-[11px] text-muted-foreground">Правка сохраняет контекст: модель дорабатывает текущий логлайн, а не пишет с нуля. Отправляемый промпт можно посмотреть кнопкой «Просмотреть промпт».</p>
                    <button
                      onClick={() => generate('logline')}
                      disabled={approving || !refineText.trim()}
                      className={`${btnMain} flex-shrink-0`}
                      data-testid="idea-v2-logline-refine-apply"
                    >
                      <Wand2 className="h-3.5 w-3.5" /> Обновить логлайн
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground" data-testid="idea-v2-logline-empty">
              Логлайн ещё не сгенерирован. Посмотрите промпт при желании и нажмите «Сгенерировать».
              <p className="mt-2 text-xs">Формула: <span className="italic">{LOGLINE_V2_FORMULA_RU}</span></p>
            </div>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground/80">Пример: {LOGLINE_V2_EXAMPLE_RU}</p>

          {error && <div className="mt-4">{errorBox}</div>}
          {canceled === 'logline' && <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-canceled">Генерация логлайна отменена.</p>}
          {canceled === 'synopsis' && <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-canceled">Генерация синопсиса отменена.</p>}

          <div className="mt-6 flex flex-wrap items-center justify-end gap-3 border-t border-border pt-4" data-testid="idea-v2-logline-footer">
              {hasSynopsis && !loglineDirty && !inputDirty && !loglineGenerating && (
                <button onClick={() => goStep('synopsis')} className="flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground" data-testid="idea-v2-to-synopsis">
                  К готовому синопсису <ArrowRight className="h-4 w-4" />
                </button>
              )}
              <button
                onClick={approveLoglineAndContinue}
                disabled={approving || loglineGenerating || !haveText || loglineStale || loglineDraft.trim().length < 10}
                className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
                data-testid="idea-v2-logline-approve"
              >
                {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Сохранить и продолжить
              </button>
          </div>
        </div>
        {renderPromptModal()}
      </div>
    )
  }

  // ═══════════════════════ Шаг 3: синопсис — до генерации ═══════════════════════
  // Переход сюда по «Сохранить и продолжить» на логлайне. Синопсис НЕ генерируется автоматически:
  // пользователь сам смотрит промпт и жмёт «Сгенерировать».
  if (currentView === 'synopsis' && !hasSynopsis) {
    return (
      <div className="space-y-6" data-testid="idea-stage-v2">
        {stepsBar}
        <div className={cardCls} style={cardStyle} data-testid="idea-v2-synopsis-pregen">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 font-display text-xl font-bold">
                <BookOpen className="h-5 w-5 text-primary" /> Шаг 3: синопсис
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Модель: <span className="font-semibold text-foreground" data-testid="idea-v2-model">{FABLE_MODEL_LABEL}</span>
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2" data-testid="idea-v2-synopsis-actions">
              <button onClick={() => openPreview('synopsis')} disabled={previewLoading === 'synopsis'} className={btnGhost} data-testid="idea-v2-synopsis-preview">
                {previewLoading === 'synopsis' ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Собираем промпт…</> : <><Eye className="h-3.5 w-3.5" /> Просмотреть промпт</>}
              </button>
              <button onClick={() => generate('synopsis')} className={btnMain} data-testid="idea-v2-synopsis-generate">
                <Wand2 className="h-3.5 w-3.5" /> Сгенерировать
              </button>
            </div>
          </div>

          {savedLogline && (
            <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm italic" data-testid="idea-v2-synopsis-logline">
              <span className="mr-1 not-italic font-semibold text-primary">Логлайн:</span>{savedLogline}
            </div>
          )}
          <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground" data-testid="idea-v2-synopsis-empty">
            Синопсис ещё не сгенерирован. Посмотрите промпт при желании и нажмите «Сгенерировать» — логлайн развернётся в синопсис на 7–10 предложений.
          </div>
          {error && <div className="mt-4">{errorBox}</div>}
          {canceled === 'synopsis' && <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-canceled">Генерация синопсиса отменена.</p>}

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <button onClick={() => goStep('logline')} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground" data-testid="idea-v2-synopsis-back">
              <ArrowLeft className="h-4 w-4" /> К логлайну
            </button>
          </div>
        </div>
        {renderPromptModal()}
      </div>
    )
  }

  // ═══════════════════════ Шаг 3: синопсис ═══════════════════════
  if (currentView === 'synopsis' && hasSynopsis) {
    return (
      <div className="space-y-6" data-testid="idea-stage-v2">
        {stepsBar}
        <div className={cardCls} style={cardStyle} data-testid="idea-v2-result">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 font-display text-xl font-bold">
                <BookOpen className="h-5 w-5 text-primary" /> Шаг 3: синопсис готов
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Модель: <span className="font-semibold text-foreground" data-testid="idea-v2-result-model">{FABLE_MODEL_LABEL}</span>
              </p>
            </div>
            {resultActions('synopsis', () => generate('synopsis'))}
          </div>

          {savedLogline && (
            <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm italic" data-testid="idea-v2-result-logline">
              <span className="mr-1 not-italic font-semibold text-primary">Логлайн:</span>{savedLogline}
            </div>
          )}
          <div className="mt-4 whitespace-pre-line rounded-lg border border-border bg-background px-4 py-3 text-sm leading-relaxed" data-testid="idea-v2-result-text">
            {String(project.synopsis).trim()}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Синопсис сохранён в проекте. Следующие шаги потока v2.0 появятся позже.</p>
          {error && <div className="mt-4">{errorBox}</div>}
          {canceled === 'synopsis' && <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-canceled">Генерация отменена.</p>}
        </div>
        {renderPromptModal()}
      </div>
    )
  }

  // ═══════════════════════ Шаг 1: идея ═══════════════════════
  return (
    <div className="space-y-6" data-testid="idea-stage-v2">
      {stepsBar}

      {hasLogline && !inputDirty && (
        <button onClick={() => goStep('logline')} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground" data-testid="idea-v2-back-to-logline">
          <ArrowLeft className="h-4 w-4" /> К готовому логлайну
        </button>
      )}

      {errorBox}

      {screen === 'choose' && (
        <div className="mx-auto max-w-2xl text-center" data-testid="idea-v2-choose">
          <h2 className="flex items-center justify-center gap-2 font-display text-2xl font-bold">
            <Sparkles className="h-6 w-6 text-primary" /> Новый проект v2.0 — Шаг 1: идея
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
            Выберите, с чего начать. Опишите свою идею словами или соберите набор жанров — и ИИ придумает историю.
          </p>
          <div className="mt-8 grid gap-4 text-left sm:grid-cols-2">
            <button type="button" onClick={() => chooseMode('idea')} className="group flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 text-left transition hover:border-primary/60" data-testid="idea-v2-choose-idea">
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary"><Lightbulb className="h-6 w-6" /></div>
              <div className="font-display text-lg font-semibold">Своя идея</div>
              <p className="text-sm text-muted-foreground">Опишите замысел своими словами — от одной фразы до нескольких предложений. ИИ сначала сформулирует логлайн, затем развернёт его в синопсис.</p>
              <span className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-primary">Описать идею <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" /></span>
            </button>
            <button type="button" onClick={() => chooseMode('genres')} className="group flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 text-left transition hover:border-primary/60" data-testid="idea-v2-choose-genres">
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary"><Tags className="h-6 w-6" /></div>
              <div className="font-display text-lg font-semibold">Собрать из жанров</div>
              <p className="text-sm text-muted-foreground">Нет готовой идеи? Выберите один или несколько жанров — ИИ придумает оригинальный сюжет на их основе.</p>
              <span className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-primary">Выбрать жанры <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" /></span>
            </button>
          </div>
        </div>
      )}

      {screen === 'input' && (
        <div className={cardCls} style={cardStyle} data-testid="idea-v2-input-screen">
          <button onClick={() => { setScreen('choose'); setError('') }} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground" data-testid="idea-v2-back-to-choose">
            <ArrowLeft className="h-4 w-4" /> Назад к выбору
          </button>
          <h2 className="mt-3 flex items-center gap-2 font-display text-xl font-bold">
            {mode === 'idea' ? <><Lightbulb className="h-5 w-5 text-primary" /> Своя идея</> : <><Tags className="h-5 w-5 text-primary" /> Собрать из жанров</>}
          </h2>

          {mode === 'idea' ? (
            <textarea
              value={idea}
              onChange={(e) => onIdeaChange(e.target.value)}
              placeholder="Например: молодая смотрительница маяка на северном острове находит дневник своей пропавшей предшественницы…"
              rows={5}
              className="mt-4 w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
              data-testid="idea-v2-input"
            />
          ) : (
            <div className="mt-4">
              <p className="mb-2 text-xs font-medium text-muted-foreground">Выберите один или несколько жанров:</p>
              <div className="flex flex-wrap gap-2" data-testid="idea-v2-genres">
                {GENRES.map((g) => {
                  const on = genres.includes(g.id)
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => toggleGenre(g.id)}
                      aria-pressed={on}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${on ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-foreground hover:border-primary/60'}`}
                      data-testid={`idea-v2-genre-${g.id}`}
                    >
                      {g.label}
                    </button>
                  )
                })}
              </div>
              <p className="mb-2 mt-5 text-xs font-medium text-muted-foreground">Пожелания (необязательно):</p>
              <textarea
                value={wishes}
                onChange={(e) => onWishesChange(e.target.value)}
                placeholder="Опишите пожелания к сюжету, тону, героям… (необязательно)"
                rows={3}
                maxLength={2000}
                className="w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
                data-testid="idea-v2-wishes"
              />
            </div>
          )}

          <p className="mt-4 text-sm text-muted-foreground">
            Отправляется в: <span className="font-semibold text-foreground" data-testid="idea-v2-model">{FABLE_MODEL_LABEL}</span>.
            На следующем шаге можно просмотреть промпт и сгенерировать логлайн — одно предложение по формуле «{LOGLINE_V2_FORMULA_RU}». После утверждения он развернётся в синопсис на 7–10 предложений.
          </p>

          {canceled === 'logline' && (
            <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-canceled">Генерация отменена. Её можно запустить снова на шаге логлайна.</p>
          )}

          <div className="mt-6 flex items-center justify-end border-t border-border pt-4" data-testid="idea-v2-input-footer">
            <button
              onClick={saveInputAndContinue}
              disabled={!canProceed || savingInput}
              className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
              data-testid="idea-v2-generate"
            >
              {savingInput ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />} Сохранить и продолжить
            </button>
          </div>
        </div>
      )}

      {renderPromptModal()}
      {renderResetConfirmModal()}
    </div>
  )
}
