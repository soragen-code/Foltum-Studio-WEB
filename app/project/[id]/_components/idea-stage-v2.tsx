'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Wand2, Sparkles, Lightbulb, Eye, Pencil, ArrowLeft, ArrowRight, Tags, Info, BookOpen, RotateCcw, Copy, Check, X } from 'lucide-react'
import { GENRES } from '@/lib/idea'
import { FABLE_MODEL_LABEL, SYNOPSIS_V2_STAGE } from '@/lib/idea-v2'
import { CancelButton } from './cancel-button'
import { useJobPolling, SmoothProgress, StreamingText } from './use-job-polling'

/** Примерная длительность генерации синопсиса v2 — управляет плавным прогресс-баром. */
const SYNOPSIS_V2_EXPECTED_SEC = 50

type Screen = 'choose' | 'input'
type Field = 'system' | 'user' | 'assistant'

/**
 * Поток «Новый проект v2.0» — два шага: Идея → Синопсис.
 *   choose — выбор режима: «Своя идея» или «Собрать из жанров».
 *   input  — ввод идеи / выбор жанров + кнопка «Генерировать синопсис».
 *
 * Отдельного шага «Промпт» в степпере нет. Промпт можно посмотреть и отредактировать
 * на странице готового синопсиса (кнопка «Просмотреть промпт» → модалка). Правки промпта
 * применяются при «Перегенерировать». Перевод полей на русский (кнопка «РУ») — только для
 * отображения на стороне клиента; в API всегда уходит английский оригинал.
 */
export function IdeaStageV2({ project, onRefresh }: { project: any; onRefresh: () => void }) {
  const [mode, setMode] = useState<'idea' | 'genres'>('idea')
  const [idea, setIdea] = useState<string>(project?.idea && !String(project.idea).startsWith('[v2 · genres]') ? project.idea : '')
  const [genres, setGenres] = useState<string[]>([])
  const [screen, setScreen] = useState<Screen>('choose')

  // Просмотр / редактирование промпта (модалка на странице синопсиса).
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false) // спиннер сборки промпта на экране результата
  const [promptReady, setPromptReady] = useState(false) // промпт собран для ТЕКУЩЕГО ввода
  const [inputDirty, setInputDirty] = useState(false)   // ввод менялся после последней генерации → шаг «Синопсис» недоступен

  // Редактируемые значения промпта + «пристин»-копии для кнопки «Сбросить».
  const [editSystem, setEditSystem] = useState('')
  const [editUser, setEditUser] = useState('')
  const [editAssistant, setEditAssistant] = useState('')
  const [origSystem, setOrigSystem] = useState('')
  const [origUser, setOrigUser] = useState('')
  const [origAssistant, setOrigAssistant] = useState('')
  const [contextNote, setContextNote] = useState('')
  const [copied, setCopied] = useState<Field | null>(null)

  // Пер-поле: режим редактирования (карандашик), показ русского перевода (РУ), сам перевод и его загрузка.
  const [editable, setEditable] = useState<Record<Field, boolean>>({ system: false, user: false, assistant: false })
  const [ruOn, setRuOn] = useState<Record<Field, boolean>>({ system: false, user: false, assistant: false })
  const [ruText, setRuText] = useState<Record<Field, string>>({ system: '', user: '', assistant: '' })
  const [ruLoading, setRuLoading] = useState<Record<Field, boolean>>({ system: false, user: false, assistant: false })

  // Любое изменение идеи/жанров/режима «сбрасывает» промпт и синопсис: следующий шаг обнуляется
  // и становится недоступным, пока текущий шаг не будет пройден заново.
  const invalidateDownstream = () => { setPromptReady(false); setInputDirty(true); setPreviewOpen(false) }

  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [canceled, setCanceled] = useState(false)
  const activeJobIdRef = useRef<string | null>(null)
  // Результат v2 уже сохранён в проекте — показываем его; «Начать заново» возвращает к форме.
  const hasResult = project?.stage === SYNOPSIS_V2_STAGE && !!String(project?.synopsis ?? '').trim()
  const [showForm, setShowForm] = useState(false)

  const { job, start: startPolling, clear: clearJob } = useJobPolling({
    intervalMs: 800,
    onFinish: (res) => {
      activeJobIdRef.current = null
      if (res.job.status === 'completed') {
        setError(''); setCanceled(false); setShowForm(false); setPreviewOpen(false); setInputDirty(false)
        onRefresh() // синопсис сохранён (stage="synopsis_v2") — этот экран покажет результат
      } else if (res.job.status === 'canceled') {
        setCanceled(true)
      } else {
        setError(res.job.error ?? 'Не удалось сгенерировать синопсис')
      }
    },
  })
  const jobActive = !!job && (job.status === 'pending' || job.status === 'processing')
  const generating = starting || jobActive

  // Промпт отредактирован пользователем относительно собранного оригинала → при перегенерации уйдёт override.
  const promptEdited = promptReady && (editSystem !== origSystem || editUser !== origUser || editAssistant !== origAssistant)

  // Возобновление: если для проекта уже крутится v2-задача (пользователь ушёл и вернулся) — подхватываем её.
  useEffect(() => {
    let ignore = false
    ;(async () => {
      try {
        const res = await fetch(`/api/ai/v2/synopsis?projectId=${project.id}`, { cache: 'no-store' })
        if (!res.ok) return
        const d = await res.json().catch(() => null)
        const j = d?.job
        if (!j || ignore) return
        if (j.status === 'pending' || j.status === 'processing') {
          setShowForm(true); setScreen('input')
          activeJobIdRef.current = j.id
          startPolling(j.id)
        }
      } catch { /* транзиентно — кнопки всё равно позволят запустить заново */ }
    })()
    return () => { ignore = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  // При первом рендере, если проект был создан из жанров ("[v2 · genres] …"), восстанавливаем режим и
  // выбранные жанры — чтобы «Перегенерировать»/«Просмотреть промпт» на экране результата работали корректно.
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
    invalidateDownstream()
  }

  const onIdeaChange = (v: string) => { setIdea(v); invalidateDownstream() }

  const canProceed = mode === 'idea' ? idea.trim().length >= 10 : genres.length > 0

  const chooseMode = (m: 'idea' | 'genres') => {
    setMode(m); setError(''); setCanceled(false); invalidateDownstream(); setScreen('input')
  }

  // Собрать промпт (system/user/assistant) для текущего ввода и сохранить в state (+ пристин-копии).
  // Используется кнопкой «Просмотреть промпт» на экране результата. Возвращает true при успехе.
  const buildPrompt = async (): Promise<boolean> => {
    try {
      const res = await fetch('/api/ai/v2/synopsis/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, ...(mode === 'idea' ? { idea: idea.trim() } : { genres }) }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? 'Не удалось собрать промпт'); return false }
      const sys = d.system ?? '', usr = d.user ?? '', ast = d.assistant ?? ''
      setEditSystem(sys); setEditUser(usr); setEditAssistant(ast)
      setOrigSystem(sys); setOrigUser(usr); setOrigAssistant(ast)
      setContextNote(d.contextNote ?? '')
      setEditable({ system: false, user: false, assistant: false })
      setRuOn({ system: false, user: false, assistant: false })
      setRuText({ system: '', user: '', assistant: '' })
      setRuLoading({ system: false, user: false, assistant: false })
      setPromptReady(true)
      return true
    } catch { setError('Ошибка сети'); return false }
  }

  // Экран результата: собрать промпт при необходимости (со спиннером) и открыть модалку просмотра.
  const previewFromResult = async () => {
    setError('')
    if (promptReady) { setPreviewOpen(true); return }
    setPreviewLoading(true)
    const ok = await buildPrompt()
    setPreviewLoading(false)
    if (ok) setPreviewOpen(true)
  }

  const generate = async (withOverride: boolean) => {
    setError(''); setCanceled(false); clearJob(); setStarting(true)
    try {
      const body: any = { projectId: project.id, ...(mode === 'idea' ? { idea: idea.trim() } : { genres }) }
      if (withOverride) { body.overrideSystem = editSystem; body.overrideUser = editUser; body.overrideAssistant = editAssistant }
      const res = await fetch('/api/ai/v2/synopsis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? 'Не удалось сгенерировать синопсис'); return }
      if (d?.jobId) { activeJobIdRef.current = d.jobId; startPolling(d.jobId) }
      else onRefresh()
    } catch { setError('Ошибка сети') }
    finally { setStarting(false) }
  }

  // Запуск генерации с экрана ввода. Если промпт был отредактирован в модалке — уходит override.
  const startGenerate = () => {
    if (!canProceed) {
      setError(mode === 'idea' ? 'Опишите идею хотя бы одним–двумя предложениями' : 'Выберите хотя бы один жанр')
      return
    }
    setCanceled(false); generate(promptEdited)
  }

  // Перегенерация с экрана результата: запустить заново (с override, если промпт правили и сохранили).
  const regenerateFromResult = () => {
    setShowForm(true); setCanceled(false); generate(promptEdited)
  }

  const cancel = async () => {
    const id = activeJobIdRef.current
    if (!id) return
    try { await fetch(`/api/ai/jobs/${id}/cancel`, { method: 'POST' }) } catch { /* поллинг повторит */ }
  }

  const copyPrompt = async (which: Field, text: string) => {
    try {
      await navigator.clipboard.writeText(text ?? '')
      setCopied(which)
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500)
    } catch { /* буфер обмена недоступен — молча игнорируем */ }
  }

  const closePreview = () => setPreviewOpen(false)

  // ─────────────── Пер-поле действия модалки промпта
  const fieldValue: Record<Field, string> = { system: editSystem, user: editUser, assistant: editAssistant }
  const fieldSetter: Record<Field, (v: string) => void> = { system: setEditSystem, user: setEditUser, assistant: setEditAssistant }
  const fieldOrig: Record<Field, string> = { system: origSystem, user: origUser, assistant: origAssistant }

  // Карандашик: сделать поле редактируемым/только для просмотра. При включении правки убираем показ перевода.
  const toggleEdit = (key: Field) => {
    setEditable((p) => ({ ...p, [key]: !p[key] }))
    setRuOn((p) => ({ ...p, [key]: false }))
  }

  // Сбросить поле к собранному оригиналу и убрать перевод.
  const resetField = (key: Field) => {
    fieldSetter[key](fieldOrig[key])
    setRuOn((p) => ({ ...p, [key]: false }))
    setRuText((p) => ({ ...p, [key]: '' }))
  }

  // Перевести текущее значение поля на русский (только для отображения).
  const translateField = async (key: Field) => {
    setRuLoading((p) => ({ ...p, [key]: true }))
    try {
      const res = await fetch('/api/ai/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: fieldValue[key] }),
      })
      const d = await res.json().catch(() => ({}))
      setRuText((p) => ({ ...p, [key]: res.ok ? (d.text ?? '') : '(не удалось перевести)' }))
    } catch {
      setRuText((p) => ({ ...p, [key]: '(ошибка сети при переводе)' }))
    } finally {
      setRuLoading((p) => ({ ...p, [key]: false }))
    }
  }

  // РУ: показать/скрыть перевод. При включении, если перевода ещё нет — запросить.
  const toggleRu = (key: Field) => {
    const next = !ruOn[key]
    setRuOn((p) => ({ ...p, [key]: next }))
    if (next && !ruText[key]) translateField(key)
  }

  // Правка значения поля из textarea: чистим перевод (устарел) и обновляем значение.
  const onFieldChange = (key: Field, v: string) => {
    fieldSetter[key](v)
    setRuText((p) => (p[key] ? { ...p, [key]: '' } : p))
  }

  // ─────────────── Степпер потока v2: Идея → Синопсис (шага «Промпт» нет)
  const currentStepKey: 'idea' | 'synopsis' =
    ((hasResult && !showForm && !generating) || generating) ? 'synopsis' : 'idea'
  const stepClickable = {
    idea: !generating,
    synopsis: hasResult && !inputDirty && !generating,
  }
  const goStep = (key: 'idea' | 'synopsis') => {
    if (key === currentStepKey || generating) return
    setError(''); setPreviewOpen(false)
    if (key === 'idea') {
      if (!stepClickable.idea) return
      setShowForm(true); setScreen('input')
    } else {
      if (!stepClickable.synopsis) return
      setShowForm(false)
    }
  }

  const V2_STEPS: { key: 'idea' | 'synopsis'; label: string }[] = [
    { key: 'idea', label: 'Идея' },
    { key: 'synopsis', label: 'Синопсис' },
  ]
  const StepsBar = () => {
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
                    : reached
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
  }

  // ─────────────── Модалка просмотра / редактирования промпта (на странице синопсиса)
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
              <button
                type="button"
                onClick={() => copyPrompt(key, shown)}
                className={`${btnBase} ${btnIdle}`}
                title="Скопировать"
                data-testid={`idea-v2-copy-${key}`}
              >
                {copied === key ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => resetField(key)}
                className={`${btnBase} ${btnIdle}`}
                title="Сбросить"
                data-testid={`idea-v2-reset-${key}`}
              >
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

    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        onClick={closePreview}
        data-testid="idea-v2-preview-modal"
      >
        <div
          className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Шапка */}
          <div className="flex items-center justify-between gap-2 border-b border-border px-5 py-3.5">
            <h3 className="flex items-center gap-2 font-display text-lg font-semibold">
              <Eye className="h-5 w-5 text-primary" /> Промпт синопсиса
            </h3>
            <button
              onClick={closePreview}
              className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
              aria-label="Закрыть"
              data-testid="idea-v2-preview-close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Тело — прокручиваемое */}
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
            {contextNote && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="idea-v2-context-note">
                <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> {contextNote}
              </p>
            )}
            {renderField('system', 'System (правила)', 10)}
            {renderField('user', 'User (запрос)', 7)}
            {renderField('assistant', 'Assistant (зачин ответа)', 5, 'Необязательно: задайте зачин ответа модели — она продолжит с него. Оставьте пустым, чтобы модель писала синопсис с чистого листа.')}
          </div>

          {/* Подвал — только «Сохранить» */}
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
            <button
              onClick={closePreview}
              className="flex items-center gap-2 rounded-lg bg-secondary px-5 py-2.5 text-sm font-semibold text-secondary-foreground transition hover:brightness-110"
              data-testid="idea-v2-preview-save"
            >
              <Check className="h-4 w-4" /> Сохранить
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────── Результат готов
  if (hasResult && !showForm && !generating) {
    return (
      <div className="space-y-6" data-testid="idea-stage-v2">
        <StepsBar />
        <div className="rounded-xl border border-border bg-card p-4 sm:p-6" style={{ boxShadow: 'var(--shadow-md)' }} data-testid="idea-v2-result">
          <h2 className="flex items-center gap-2 font-display text-xl font-bold">
            <BookOpen className="h-5 w-5 text-primary" /> Новый проект v2.0 — синопсис готов
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Модель: <span className="font-semibold text-foreground" data-testid="idea-v2-result-model">{FABLE_MODEL_LABEL}</span>
          </p>
          <div className="mt-4 whitespace-pre-line rounded-lg border border-border bg-background px-4 py-3 text-sm leading-relaxed" data-testid="idea-v2-result-text">
            {String(project.synopsis).trim()}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Синопсис сохранён в проекте. Следующие шаги потока v2.0 появятся позже.
          </p>

          {error && (
            <div className="mt-4 rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive" data-testid="idea-v2-result-error">{error}</div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={previewFromResult}
              disabled={previewLoading}
              className="flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-semibold transition hover:bg-muted disabled:opacity-50"
              data-testid="idea-v2-result-preview"
            >
              {previewLoading
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Собираем промпт…</>
                : <><Eye className="h-4 w-4" /> Просмотреть промпт</>}
            </button>
            <button
              onClick={regenerateFromResult}
              className="flex items-center gap-2 rounded-lg bg-secondary px-5 py-2.5 text-sm font-semibold text-secondary-foreground transition hover:brightness-110"
              data-testid="idea-v2-result-regenerate"
            >
              <Wand2 className="h-4 w-4" /> Перегенерировать
            </button>
            <button
              onClick={() => { setShowForm(true); setScreen('choose'); setError(''); setCanceled(false); invalidateDownstream() }}
              className="flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-semibold transition hover:bg-muted"
              data-testid="idea-v2-regenerate"
            >
              <RotateCcw className="h-4 w-4" /> Начать заново
            </button>
          </div>
        </div>

        {renderPromptModal()}
      </div>
    )
  }

  return (
    <div className="space-y-6" data-testid="idea-stage-v2">
      <StepsBar />

      {hasResult && !generating && (
        <button
          onClick={() => setShowForm(false)}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
          data-testid="idea-v2-back-to-result"
        >
          <ArrowLeft className="h-4 w-4" /> К готовому синопсису
        </button>
      )}

      {error && (
        <div className="rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive" data-testid="idea-v2-error">{error}</div>
      )}

      {/* ═══════════════════════ Генерация: прогресс ═══════════════════════ */}
      {generating && (
        <div className="rounded-xl border border-border bg-card p-4 sm:p-6" style={{ boxShadow: 'var(--shadow-md)' }} data-testid="idea-v2-step2">
          <h2 className="flex items-center gap-2 font-display text-xl font-bold">
            <Wand2 className="h-5 w-5 text-primary" /> Генерация синопсиса
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Отправляется в: <span className="font-semibold text-foreground" data-testid="idea-v2-model">{FABLE_MODEL_LABEL}</span>.
          </p>
          <div className="mt-4 space-y-2" data-testid="idea-v2-progress">
            {job ? (
              <SmoothProgress job={job} expectedTotalSec={SYNOPSIS_V2_EXPECTED_SEC} />
            ) : (
              <p className="inline-flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin text-primary" /> Запуск генерации…</p>
            )}
            <StreamingText text={job?.streamedText} active={jobActive} />
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 text-xs text-muted-foreground">Генерируем синопсис сезона. Текст появляется постепенно; вкладку можно закрыть — прогресс и текст сохранятся.</p>
              <CancelButton onCancel={cancel} testId="idea-v2-cancel" className="flex-shrink-0" />
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════ Экран 1: выбор режима ═══════════════════════ */}
      {!generating && screen === 'choose' && (
        <div className="mx-auto max-w-2xl text-center" data-testid="idea-v2-choose">
          <h2 className="flex items-center justify-center gap-2 font-display text-2xl font-bold">
            <Sparkles className="h-6 w-6 text-primary" /> Новый проект v2.0 — Шаг 1: идея
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
            Выберите, с чего начать. Опишите свою идею словами или соберите набор жанров — и ИИ придумает историю.
          </p>

          <div className="mt-8 grid gap-4 text-left sm:grid-cols-2">
            {/* (а) Своя идея */}
            <button
              type="button"
              onClick={() => chooseMode('idea')}
              className="group flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 text-left transition hover:border-primary/60"
              data-testid="idea-v2-choose-idea"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Lightbulb className="h-6 w-6" />
              </div>
              <div className="font-display text-lg font-semibold">Своя идея</div>
              <p className="text-sm text-muted-foreground">
                Опишите замысел своими словами — от одной фразы до нескольких предложений. ИИ развернёт его в синопсис сезона.
              </p>
              <span className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-primary">
                Описать идею <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
              </span>
            </button>

            {/* (б) Собрать из жанров */}
            <button
              type="button"
              onClick={() => chooseMode('genres')}
              className="group flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 text-left transition hover:border-primary/60"
              data-testid="idea-v2-choose-genres"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Tags className="h-6 w-6" />
              </div>
              <div className="font-display text-lg font-semibold">Собрать из жанров</div>
              <p className="text-sm text-muted-foreground">
                Нет готовой идеи? Выберите один или несколько жанров — ИИ придумает оригинальный сюжет на их основе.
              </p>
              <span className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-primary">
                Выбрать жанры <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
              </span>
            </button>
          </div>
        </div>
      )}

      {/* ═══════════════════════ Экран 2: ввод идеи / жанров + генерация ═══════════════════════ */}
      {!generating && screen === 'input' && (
        <div className="rounded-xl border border-border bg-card p-4 sm:p-6" style={{ boxShadow: 'var(--shadow-md)' }} data-testid="idea-v2-input-screen">
          <button
            onClick={() => { setScreen('choose'); setError('') }}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
            data-testid="idea-v2-back-to-choose"
          >
            <ArrowLeft className="h-4 w-4" /> Назад к выбору
          </button>

          <h2 className="mt-3 flex items-center gap-2 font-display text-xl font-bold">
            {mode === 'idea'
              ? <><Lightbulb className="h-5 w-5 text-primary" /> Своя идея</>
              : <><Tags className="h-5 w-5 text-primary" /> Собрать из жанров</>}
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
            </div>
          )}

          <p className="mt-4 text-sm text-muted-foreground">
            Отправляется в: <span className="font-semibold text-foreground" data-testid="idea-v2-model">{FABLE_MODEL_LABEL}</span>.
            Будет сгенерирован синопсис на 7–10 предложений: предыстория, основной хук (главный клиффхэнгер ближе к концу сезона) и концовка.
          </p>

          <button
            onClick={startGenerate}
            disabled={!canProceed}
            className="mt-5 flex items-center gap-2 rounded-lg bg-secondary px-5 py-2.5 text-sm font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50"
            data-testid="idea-v2-generate"
          >
            <Wand2 className="h-4 w-4" /> {hasResult ? 'Перегенерировать синопсис' : 'Генерировать синопсис'}
          </button>

          {canceled && (
            <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-canceled">Генерация отменена. Нажмите кнопку выше, чтобы запустить снова.</p>
          )}
        </div>
      )}

      {renderPromptModal()}
    </div>
  )
}
