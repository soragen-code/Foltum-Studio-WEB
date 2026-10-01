'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Wand2, Sparkles, Lightbulb, Eye, Pencil, ArrowLeft, ArrowRight, Tags, Info, BookOpen, RotateCcw, Copy, Check, X, Quote } from 'lucide-react'
import { GENRES } from '@/lib/idea'
import { FABLE_MODEL_LABEL, SYNOPSIS_V2_STAGE, LOGLINE_V2_STAGE, LOGLINE_V2_FORMULA_RU } from '@/lib/idea-v2'
import { useTranslation } from '@/lib/i18n/context'
import { CancelButton } from './cancel-button'
import { useJobPolling, SmoothProgress } from './use-job-polling'

/** Примерная длительность генераций v2 — управляет плавным прогресс-баром. */
const SYNOPSIS_V2_EXPECTED_SEC = 50

/** Единый стиль текста логлайна — и в стриме, и в готовом (редактируемом) виде: один шрифт, размер, межстрочник, отступы, фон. */
const LOGLINE_TEXT_CLS = 'mt-4 w-full whitespace-pre-wrap break-words rounded-lg border border-input bg-background px-4 py-3 text-base leading-relaxed text-foreground'
/** Единый стиль текста синопсиса — стрим и готовый вид. Без ограничений по высоте и внутреннего скролла. */
const SYNOPSIS_TEXT_CLS = 'whitespace-pre-wrap break-words rounded-lg border border-border bg-background px-4 py-3 text-sm leading-relaxed text-foreground'

/** Стрим текста: бокс растёт под содержимое, ничего не обрезается (без maxHeight/скролла). */
function GrowingStream({ text, active, className, testId }: { text: string; active: boolean; className: string; testId?: string }) {
  return (
    <div className={className} data-testid={testId}>
      {text}
      {active && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-primary align-middle" aria-hidden />}
    </div>
  )
}

/** Textarea с авто-высотой по содержимому: без ползунка resize и фиксированного rows, без внутреннего скролла. */
function AutoGrowTextarea({ value, onChange, className, testId, disabled }: {
  value: string; onChange: (v: string) => void; className: string; testId?: string; disabled?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={1}
      disabled={disabled}
      className={`${className} resize-none overflow-hidden outline-none transition focus:border-primary focus:ring-1 focus:ring-primary`}
      data-testid={testId}
    />
  )
}

type Screen = 'choose' | 'input'
type Kind = 'logline' | 'synopsis'
type StepKey = 'idea' | Kind
/** Сообщение диалога с моделью (то, что уходит в API как messages). Роли system нет: правила — в первом user. */
type Msg = { role: 'user' | 'assistant'; content: string }

/** Индекс крайнего (самого нового) user-сообщения — единственного редактируемого. */
const lastUserIdx = (m: Msg[]) => { for (let i = m.length - 1; i >= 0; i--) if (m[i].role === 'user') return i; return -1 }
/** Диалог с учётом правки крайнего user — ровно то, что уйдёт в API при ручном редактировании. */
const withLastUser = (m: Msg[], text: string): Msg[] => {
  const i = lastUserIdx(m)
  return i < 0 ? m : m.map((x, j) => (j === i ? { ...x, content: text } : x))
}
/** Хронологический текст истории для буфера обмена: «USER:» / «ASSISTANT:», через пустую строку. */
const historyText = (m: Msg[]) => m.map((x) => `${x.role.toUpperCase()}:\n${x.content}`).join('\n\n')

/**
 * Черновик промпта («Сохранить» в модалке): отредактированный крайний user БЕЗ вызова ИИ. В проекте нет поля
 * под черновик промпта и миграции не делаем → localStorage по ключу projectId+kind. Храним и оригинал (orig):
 * черновик применяется только если собранный заново крайний user совпал с orig (иначе он устарел и отбрасывается).
 */
type PromptDraft = { orig: string; edit: string }
const draftKey = (projectId: string, k: Kind) => `foltum:v2:prompt-draft:${projectId}:${k}`
const loadDraft = (projectId: string, k: Kind): PromptDraft | null => {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(draftKey(projectId, k)) : null
    if (!raw) return null
    const d = JSON.parse(raw)
    return d && typeof d.orig === 'string' && typeof d.edit === 'string' ? d : null
  } catch { return null }
}
const storeDraft = (projectId: string, k: Kind, orig: string, edit: string) => {
  try {
    if (edit === orig) window.localStorage.removeItem(draftKey(projectId, k))
    else window.localStorage.setItem(draftKey(projectId, k), JSON.stringify({ orig, edit } satisfies PromptDraft))
  } catch { /* localStorage недоступен */ }
}

const API: Record<Kind, { generate: string; preview: string }> = {
  logline: { generate: '/api/ai/v2/logline', preview: '/api/ai/v2/logline/preview' },
  synopsis: { generate: '/api/ai/v2/synopsis', preview: '/api/ai/v2/synopsis/preview' },
}
const KIND_LABEL: Record<Kind, string> = { logline: 'логлайна', synopsis: 'синопсиса' }

/**
 * Поток «Новый проект v2.0» — три шага: Идея → Логлайн → Синопсис.
 *   idea     — выбор режима (своя идея / жанры [+ пожелания]) и ввод → «Продолжить»
 *              (строит промпт логлайна и открывает модалку, оставаясь на шаге 1; «Отправить» в модалке →
 *              переход на шаг 2 + генерация; «Закрыть» → остаёмся на шаге 1).
 *   logline  — стрим логлайна побуквенно; поле правки → «Изменить» (модалка промпта → «Отправить»: правка уходит
 *              диалогом messages с прежними логлайнами); готовый текст можно поправить → «Продолжить».
 *   synopsis — синопсис, развернутый из утверждённого логлайна.
 *
 * Основная кнопка перехода («Продолжить» / «Сгенерировать») на всех шагах стоит ВНЕ карточки, под ней. Модалка промпта общая
 * для обоих шагов: диалог messages без system (правила в первом user), новые сверху, редактируется только крайний user;
 * кнопки «Скопировать историю» и «RU». Перевод RU — только для отображения; в API всегда уходит английский оригинал.
 */
export function IdeaStageV2({ project, onRefresh }: { project: any; onRefresh: () => void }) {
  const [mode, setMode] = useState<'idea' | 'genres'>('idea')
  const [idea, setIdea] = useState<string>(project?.idea && !String(project.idea).startsWith('[v2 · genres]') ? project.idea : '')
  const [genres, setGenres] = useState<string[]>([])
  const [screen, setScreen] = useState<Screen>('choose')
  // Пожелания продюсера (только режим жанров). В БД не хранятся — уходят в preview/generate через inputBody.
  const [wishes, setWishes] = useState('')
  // Английский перевод пожеланий, полученный из preview (промпт в модалке показан с ним).
  // Уходит в generate как wishesEn, чтобы в модель попал ровно показанный текст. Сбрасывается при правке поля.
  const [wishesEn, setWishesEn] = useState('')
  // Модалка-предупреждение о сбросе последующих шагов — показывается ТОЛЬКО после «Отправить» в модалке промпта, если ввод менялся.
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  // Пользователь подтвердил сброс → уже сохранённые логлайн/синопсис скрываются до новой генерации логлайна.
  const [downstreamReset, setDownstreamReset] = useState(false)
  // Ввод шага 1 зафиксирован («Отправить» в модалке промпта) → экран логлайна доступен.
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
  // Английский перевод правки из preview (показан в модалке) — уходит в generate как есть и сохраняется в loglineTurns.
  const [refineEn, setRefineEn] = useState('')
  // Реальный диалог с моделью (живёт в сессии): базовый логлайн L0 + применённые пары «правка → логлайн».
  // Уходит в API как loglineBase/loglineTurns → бэкенд собирает messages system→user→assistant→user→…,
  // поэтому прежние правки («не про воду» → «не про шахты») не отменяются моделью.
  const [loglineBase, setLoglineBase] = useState('')
  const [loglineTurns, setLoglineTurns] = useState<{ refine: string; logline: string }[]>([])
  // Правка, с которой стартовала текущая генерация — фиксируем в момент запуска (без stale-замыкания).
  const lastRefineRef = useRef<string>('')

  // Ввод менялся после последнего «Продолжить» → шаги «Логлайн»/«Синопсис» недоступны,
  // но их данные НЕ сбрасываются, пока пользователь не подтвердит сброс в модалке.
  const [inputDirty, setInputDirty] = useState(false)

  // ─── Промпты (по шагам): диалог messages из preview (без system) + правка крайнего user
  const { t } = useTranslation()
  const [promptKind, setPromptKind] = useState<Kind>('logline')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState<Kind | null>(null)
  const [ready, setReady] = useState<Record<Kind, boolean>>({ logline: false, synopsis: false })
  // Оригинальный диалог из preview: первый user (правила + задание) → assistant → user (правка) → … → крайний user.
  const [msgs, setMsgs] = useState<Record<Kind, Msg[]>>({ logline: [], synopsis: [] })
  // Редактируемый текст крайнего user (единственное редактируемое сообщение).
  const [lastEdit, setLastEdit] = useState<Record<Kind, string>>({ logline: '', synopsis: '' })
  const [note, setNote] = useState<Record<Kind, string>>({ logline: '', synopsis: '' })
  const [copied, setCopied] = useState(false)
  // РУ-перевод транскрипта (только отображение; в API уходит английский оригинал).
  const [msgsRuOn, setMsgsRuOn] = useState(false)
  const [msgsRu, setMsgsRu] = useState<string[] | null>(null)
  const [msgsRuLoading, setMsgsRuLoading] = useState(false)

  const lastUserOrig = (k: Kind) => { const i = lastUserIdx(msgs[k]); return i < 0 ? '' : msgs[k][i].content }
  const isEdited = (k: Kind) => ready[k] && lastEdit[k] !== lastUserOrig(k)
  /** Диалог, который уйдёт в API (история хронологически + отредактированный крайний user). */
  const sendMessages = (k: Kind) => withLastUser(msgs[k], lastEdit[k])
  const resetPrompt = (k: Kind) => setReady((p) => ({ ...p, [k]: false }))

  // Сброс последующих шагов — вызывается ТОЛЬКО после подтверждения в модалке-предупреждении.
  // Промпт логлайна НЕ сбрасываем: он уже собран и (возможно) отредактирован в модалке — уходит в генерацию.
  const invalidateDownstream = () => {
    resetPrompt('synopsis'); setPreviewOpen(false)
    setDownstreamReset(true); setLoglineDraft('')
    setRefineText(''); setRefineEn(''); setLoglineBase(''); setLoglineTurns([]); lastRefineRef.current = ''
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
        const fresh = String(res.job.result?.logline ?? res.job.streamedText ?? '').trim()
        // Ход диалога: правка → результат становится парой в транскрипте; генерация с нуля → результат = база L0.
        if (lastRefineRef.current) {
          const applied = lastRefineRef.current; lastRefineRef.current = ''
          if (fresh) setLoglineTurns((t) => [...t, { refine: applied, logline: fresh }])
        } else { setLoglineBase(fresh); setLoglineTurns([]) }
        setInputDirty(false); setInputSaved(true); setDownstreamReset(false); resetPrompt('synopsis'); setRefineText('')
        // Сразу показываем готовый текст (до onRefresh), чтобы поле не пустело.
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
  const onWishesChange = (v: string) => { setWishes(v); setWishesEn(''); markInputDirty() }
  const inputBody = () => (mode === 'idea'
    ? { idea: idea.trim() }
    : { genres, wishes: wishes.trim() || undefined, wishesEn: wishes.trim() && wishesEn ? wishesEn : undefined })
  // Аргументы уточнения логлайна: добавляются только для шага логлайна, когда есть непустая правка и текущий логлайн.
  // noRefine — принудительно «с нуля» (шаг 1 → модалка, кнопка «Сгенерировать»), даже если поле правки заполнено.
  const refineArgs = (k: Kind, noRefine = false) =>
    k === 'logline' && !noRefine && refineText.trim() && savedLogline
      ? { logline: savedLogline, refine: refineText.trim(), ...(refineEn ? { refineEn } : {}), ...(loglineBase ? { loglineBase, loglineTurns } : {}) }
      : {}
  const onRefineChange = (v: string) => { setRefineText(v); setRefineEn(''); resetPrompt('logline') }

  const chooseMode = (m: 'idea' | 'genres') => {
    if (m !== mode) markInputDirty()
    setMode(m); setError(''); setCanceled(null); setScreen('input')
  }

  // Собрать промпт шага k для текущего ввода. Возвращает собранный диалог и крайний user с учётом сохранённого
  // черновика (localStorage), либо null при ошибке.
  const buildPrompt = async (k: Kind, noRefine = false): Promise<{ list: Msg[]; last: string; refineEn: string } | null> => {
    try {
      const args = refineArgs(k, noRefine)
      const res = await fetch(API[k].preview, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, ...inputBody(), ...args }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? 'Не удалось собрать промпт'); return null }
      if (k === 'logline' && typeof d.wishesEn === 'string') setWishesEn(d.wishesEn)
      const refineEnNow = k === 'logline' && typeof d.refineEn === 'string' ? d.refineEn : ''
      if (k === 'logline') setRefineEn(refineEnNow)
      // messages без system (правила в первом user). Старый ответ с system/user — маппим в один user на лету.
      let list: Msg[] = Array.isArray(d.messages)
        ? d.messages.filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').map((m: any) => ({ role: m.role, content: m.content }))
        : []
      if (!list.length) {
        const merged = [String(d.system ?? '').trim(), String(d.user ?? '').trim()].filter(Boolean).join('\n\n')
        list = [{ role: 'user', content: merged }]
        if (String(d.assistant ?? '').trim()) list.push({ role: 'assistant', content: String(d.assistant).trim() })
      }
      setMsgs((s) => ({ ...s, [k]: list }))
      const li = lastUserIdx(list)
      const orig = li < 0 ? '' : list[li].content
      // Сохранённый черновик («Сохранить» в модалке) подхватывается, если собранный крайний user не изменился.
      const draft = loadDraft(project.id, k)
      const last = draft && draft.orig === orig ? draft.edit : orig
      setLastEdit((s) => ({ ...s, [k]: last }))
      setMsgsRu(null); setMsgsRuOn(false)
      const dialogNote = list.length > 1
        ? ` Запрос уйдёт диалогом из ${list.length} сообщений (показан ниже, новые сверху): модель видит свои прежние ответы и все ранние правки. Редактировать можно только текущий (крайний) запрос.`
        : ' Правила и задание уходят одним сообщением (без системного промпта); его можно отредактировать перед отправкой.'
      setNote((s) => ({ ...s, [k]: `${d.contextNote ?? ''}${dialogNote}` }))
      setReady((s) => ({ ...s, [k]: true }))
      return { list, last, refineEn: refineEnNow }
    } catch { setError('Ошибка сети'); return null }
  }

  const resetModalFlags = (k: Kind) => {
    setMsgsRuOn(false); setCopied(false)
    setPromptKind(k)
  }
  // Открыть модалку промпта (шаг 2 → «Изменить»): собирает промпт правки и показывает его; отправка — из модалки.
  const openPreview = async (k: Kind) => {
    setError('')
    resetModalFlags(k)
    if (ready[k]) { setPreviewOpen(true); return }
    setPreviewLoading(k)
    const ok = await buildPrompt(k)
    setPreviewLoading(null)
    if (ok) setPreviewOpen(true)
  }

  const generate = async (k: Kind, noRefine = false) => {
    setError(''); setCanceled(null); jobs[k].clear(); setStarting(k); setPreviewOpen(false)
    try {
      // Ручная правка крайнего user → уходит ВЕСЬ диалог (история + правка), без system.
      let override: Msg[] | null = isEdited(k) ? sendMessages(k) : null
      let refineEnNow = refineEn
      // Промпт не собирался (генерация без модалки), но есть сохранённый черновик → собираем и подхватываем его.
      if (!override && !ready[k] && loadDraft(project.id, k)) {
        const b = await buildPrompt(k, noRefine)
        if (b) {
          const li = lastUserIdx(b.list)
          if (li >= 0 && b.last !== b.list[li].content) override = withLastUser(b.list, b.last)
          if (b.refineEn) refineEnNow = b.refineEn
        }
      }
      if (k === 'logline') {
        // Активная правка → запомним её (АНГЛИЙСКИЙ вариант из preview, чтобы вся история была английской):
        // по завершении она станет ходом диалога. Иначе (генерация «с нуля») результат станет новой базой L0.
        if (!noRefine && refineText.trim() && savedLogline) lastRefineRef.current = refineEnNow.trim() || refineText.trim()
        else { lastRefineRef.current = ''; if (noRefine) setRefineText('') }
      }
      const body: any = { projectId: project.id, ...inputBody(), ...refineArgs(k, noRefine), ...(k === 'logline' && refineEnNow ? { refineEn: refineEnNow } : {}) }
      if (override) body.overrideMessages = override
      const res = await fetch(API[k].generate, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? `Не удалось сгенерировать ${k === 'logline' ? 'логлайн' : 'синопсис'}`); return }
      if (d?.jobId) { activeJobIdRef.current = d.jobId; jobs[k].start(d.jobId) }
      else onRefresh()
    } catch { setError('Ошибка сети') }
    finally { setStarting(null) }
  }

  // «Продолжить» на шаге 1: собрать промпт логлайна «с нуля» и ОТКРЫТЬ модалку. Остаёмся на шаге 1,
  // ничего не сбрасываем и не генерируем. Дальше — только из модалки: «Отправить» (→ при изменённом вводе
  // сначала предупреждение о сбросе) или «Закрыть» (остаёмся на шаге 1, всё как было).
  const continueFromIdea = async () => {
    if (!canProceed) {
      setError(mode === 'idea' ? 'Опишите идею хотя бы одним–двумя предложениями' : 'Выберите хотя бы один жанр')
      return
    }
    setError(''); setCanceled(null)
    resetPrompt('logline'); setRefineText(''); setRefineEn('')
    setSavingInput(true)
    const ok = await buildPrompt('logline', true)
    setSavingInput(false)
    if (!ok) return
    resetModalFlags('logline')
    setPreviewOpen(true)
  }

  // Финал «Отправить» для логлайна с шага 1: фиксируем ввод, открываем шаг 2, запускаем генерацию с нуля.
  const commitLoglineFromIdea = () => {
    setInputDirty(false); setInputSaved(true); setView('logline')
    void generate('logline', true)
  }

  // Подтверждение в предупреждении «Изменения затронут следующие шаги» (после «Отправить»):
  // реально стираем логлайн/синопсис в БД (иначе вернутся после перезагрузки), затем шаг 2 + генерация.
  const confirmResetAndSend = async () => {
    setResetConfirmOpen(false); setError('')
    setSavingInput(true)
    try {
      const res = await fetch('/api/ai/v2/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setSavingInput(false); setError(d?.error ?? 'Не удалось сбросить последующие шаги'); return
      }
    } catch { setSavingInput(false); setError('Ошибка сети'); return }
    setSavingInput(false)
    invalidateDownstream()
    onRefresh()
    commitLoglineFromIdea()
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
    // Логлайн утверждён → диалог правок больше не нужен (следующие правки будут к новому логлайну).
    setLoglineBase(''); setLoglineTurns([]); lastRefineRef.current = ''
    // Переходим на экран синопсиса БЕЗ автогенерации — пользователь сам смотрит промпт и жмёт «Сгенерировать».
    setView('synopsis'); onRefresh()
  }

  const cancel = async () => {
    const id = activeJobIdRef.current
    if (!id) return
    try { await fetch(`/api/ai/jobs/${id}/cancel`, { method: 'POST' }) } catch { /* поллинг повторит */ }
  }

  // ─── Действия модалки промпта (для текущего promptKind)
  const curMsgs = msgs[promptKind]
  const curLastIdx = lastUserIdx(curMsgs)

  /** «Скопировать историю»: весь диалог хронологически (USER:/ASSISTANT:), английский оригинал, крайний user — с правкой. */
  const copyHistory = async () => {
    try {
      await navigator.clipboard.writeText(historyText(sendMessages(promptKind)))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* буфер обмена недоступен */ }
  }
  const resetLast = () => { setLastEdit((p) => ({ ...p, [promptKind]: lastUserOrig(promptKind) })); setMsgsRu(null) }
  const onLastChange = (v: string) => { setLastEdit((p) => ({ ...p, [promptKind]: v })); setMsgsRu(null) }
  // РУ для транскрипта: переводим каждое сообщение (параллельно), только для отображения. Крайний user — с учётом правки.
  const toggleMsgsRu = async () => {
    const next = !msgsRuOn
    setMsgsRuOn(next)
    if (!next || msgsRu) return
    setMsgsRuLoading(true)
    try {
      const out = await Promise.all(sendMessages(promptKind).map(async (m) => {
        try {
          const res = await fetch('/api/ai/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: m.content }) })
          const d = await res.json().catch(() => ({}))
          return res.ok && typeof d?.text === 'string' && d.text.trim() ? d.text : m.content
        } catch { return m.content }
      }))
      setMsgsRu(out)
    } finally { setMsgsRuLoading(false) }
  }

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
  const btnMain = 'flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-1.5 text-xs font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50'
  const resultActions = (k: Kind, onRegenerate: () => void) => (
    <div className="flex flex-wrap items-center justify-end gap-2" data-testid={`idea-v2-${k}-actions`}>
      <button onClick={onRegenerate} disabled={approving} className={btnMain} data-testid={`idea-v2-${k}-regenerate`}>
        <Wand2 className="h-3.5 w-3.5" /> Перегенерировать
      </button>
    </div>
  )

  // ─── Модалка просмотра / редактирования промпта (общая для логлайна и синопсиса)
  // Показывает диалог messages (без system) ОТ НОВЫХ К СТАРЫМ; редактируется только крайний user.
  const renderPromptModal = () => {
    if (!previewOpen || generating) return null
    const btnBase = 'inline-flex items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-xs font-medium transition'
    const btnIdle = 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
    const btnActive = 'border-primary bg-primary/10 text-primary'
    const total = curMsgs.length
    const edited = isEdited(promptKind)

    const label = (m: Msg, i: number) => {
      if (m.role === 'assistant') return i === 1 ? 'Assistant · ответ L0' : `Assistant · ответ ${Math.floor(i / 2)}`
      if (i === 0) return total === 1 ? 'User · правила + задание (уходит сейчас)' : 'User · правила + задание'
      return i === curLastIdx ? 'User · текущая правка (уходит сейчас)' : `User · правка ${Math.floor(i / 2)}`
    }

    const close = () => setPreviewOpen(false)
    // «Сохранить» = запомнить отредактированный крайний user (localStorage) БЕЗ вызова ИИ и закрыть. Reset-предупреждение не трогаем.
    const saveDraft = () => {
      storeDraft(project.id, promptKind, lastUserOrig(promptKind), lastEdit[promptKind])
      setPreviewOpen(false)
    }
    // «Отправить» = закрыть модалку, перейти на шаг и запустить генерацию (история + отредактированный крайний user).
    // Сохранённое состояние обновляется тем же содержимым.
    const send = () => {
      storeDraft(project.id, promptKind, lastUserOrig(promptKind), lastEdit[promptKind])
      setPreviewOpen(false)
      if (promptKind === 'logline' && currentView === 'idea') {
        // С шага 1: если ввод менялся при уже готовом логлайне/синопсисе — сначала предупреждение о сбросе.
        if (inputDirty && (hasLogline || hasSynopsis)) { setResetConfirmOpen(true); return }
        commitLoglineFromIdea(); return
      }
      setView(promptKind)
      void generate(promptKind)
    }
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
          <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {note[promptKind] && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="idea-v2-context-note">
                <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> {note[promptKind]}
              </p>
            )}
            <div data-testid="idea-v2-dialog">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Отправляемый диалог · {total} {total === 1 ? 'сообщение' : total < 5 ? 'сообщения' : 'сообщений'} · новые сверху
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void copyHistory()}
                    className={`${btnBase} ${copied ? btnActive : btnIdle}`}
                    title={t('ideaV2.copyHistoryHint')}
                    data-testid="idea-v2-copy-history"
                  >
                    {copied ? <><Check className="h-3.5 w-3.5 text-primary" /> {t('ideaV2.copied')}</> : <><Copy className="h-3.5 w-3.5" /> {t('ideaV2.copyHistory')}</>}
                  </button>
                  <button
                    type="button"
                    onClick={() => void toggleMsgsRu()}
                    className={`${btnBase} ${msgsRuOn ? btnActive : btnIdle}`}
                    title="Показать перевод на русский (только для просмотра; в API уходит оригинал)"
                    aria-pressed={msgsRuOn}
                    data-testid="idea-v2-dialog-ru"
                  >
                    {msgsRuLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'RU'}
                  </button>
                </div>
              </div>
              <ol className="space-y-2">
                {curMsgs.map((m, i) => ({ m, i })).reverse().map(({ m, i }) => {
                  const isLastUser = i === curLastIdx
                  const ruShown = msgsRuOn && !msgsRuLoading && !!msgsRu
                  const text = ruShown ? msgsRu![i] : isLastUser ? lastEdit[promptKind] : m.content
                  const canEdit = isLastUser && !msgsRuOn
                  return (
                    <li
                      key={i}
                      className={`rounded-lg border px-3 py-2 ${m.role === 'assistant' ? 'border-primary/30 bg-primary/5' : isLastUser ? 'border-amber-500/40 bg-amber-500/5' : 'border-border/60 bg-muted/30'}`}
                      data-testid="idea-v2-dialog-msg"
                      data-role={m.role}
                      data-editable={isLastUser ? 'true' : undefined}
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold text-muted-foreground">{i + 1}. {label(m, i)}</span>
                        {isLastUser && (
                          <div className="flex items-center gap-1">
                            {edited && <span className="text-[11px] text-amber-500">изменено</span>}
                            <button type="button" onClick={resetLast} disabled={!edited} className={`${btnBase} ${btnIdle} disabled:opacity-40`} title="Вернуть исходный текст" data-testid="idea-v2-reset-last">
                              <RotateCcw className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                      {isLastUser ? (
                        <div className="relative">
                          <textarea
                            value={msgsRuOn && msgsRuLoading ? '' : text}
                            onChange={(e) => onLastChange(e.target.value)}
                            readOnly={!canEdit}
                            rows={Math.min(18, Math.max(4, (text ?? '').split('\n').length + 1))}
                            className={`w-full resize-y rounded-lg border px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-primary ${canEdit ? 'border-input bg-background' : 'border-border bg-muted/40 text-foreground/90'}`}
                            data-testid="idea-v2-preview-user"
                          />
                          {msgsRuOn && msgsRuLoading && (
                            <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-background/60">
                              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> Переводим…</span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-foreground/90">
                          {msgsRuOn && msgsRuLoading ? <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> Переводим…</span> : text}
                        </pre>
                      )}
                    </li>
                  )
                })}
              </ol>
              {msgsRuOn && !msgsRuLoading && (
                <p className="mt-1 text-[11px] text-muted-foreground">Показан перевод на русский — только для просмотра. В генерацию уходит оригинал; редактирование доступно при выключенном RU.</p>
              )}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
            <button onClick={close} className="flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-semibold transition hover:bg-muted" data-testid="idea-v2-preview-cancel">
              Закрыть
            </button>
            <button onClick={saveDraft} disabled={generating} className="flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-semibold transition hover:bg-muted" data-testid="idea-v2-preview-save">
              <Check className="h-4 w-4" /> {t('common.save')}
            </button>
            <button onClick={send} disabled={generating || !lastEdit[promptKind].trim()} className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50" data-testid="idea-v2-preview-send">
              <Wand2 className="h-4 w-4" /> Отправить
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
            <button onClick={() => void confirmResetAndSend()} className="flex items-center gap-2 rounded-lg bg-secondary px-5 py-2.5 text-sm font-semibold text-secondary-foreground transition hover:brightness-110" data-testid="idea-v2-reset-confirm">
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
  // Единая основная кнопка перехода и подвал шага — ВНЕ карточки, под ней (одинаково на всех трёх шагах).
  const btnPrimary = 'flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50'
  const stepFooter = (testId: string, right: React.ReactNode, left?: React.ReactNode) => (
    <div className="flex flex-wrap items-center justify-between gap-3" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-3">{left}</div>
      <div className="flex flex-wrap items-center justify-end gap-3">{right}</div>
    </div>
  )

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
            {String(j?.streamedText ?? '').trim() && (
              <GrowingStream text={String(j?.streamedText ?? '')} active={isActive(j)} className={SYNOPSIS_TEXT_CLS} testId="idea-v2-synopsis-streaming" />
            )}
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
  // Экран доступен сразу после «Отправить» в модалке промпта (inputSaved); inputSaved же
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
          </div>

          {loglineGenerating ? (
            <div className="mt-4 space-y-2" data-testid="idea-v2-logline-stream">
              {streamed.trim() ? (
                <GrowingStream text={streamed} active={isActive(j)} className={LOGLINE_TEXT_CLS} testId="idea-v2-logline-streaming" />
              ) : (
                <p className={`${LOGLINE_TEXT_CLS} flex items-center gap-2 text-muted-foreground`}>
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
              <AutoGrowTextarea value={loglineDraft} onChange={setLoglineDraft} className={LOGLINE_TEXT_CLS} testId="idea-v2-logline-text" />
              <p className="mt-2 text-xs text-muted-foreground">
                Текст можно поправить перед сохранением.
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
                  <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                    <button
                      onClick={() => openPreview('logline')}
                      disabled={approving || !refineText.trim() || previewLoading === 'logline'}
                      className={`${btnMain} flex-shrink-0`}
                      data-testid="idea-v2-logline-refine-edit"
                    >
                      {previewLoading === 'logline' ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Собираем промпт…</> : <><Pencil className="h-3.5 w-3.5" /> Изменить</>}
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground" data-testid="idea-v2-logline-empty">
              Логлайн ещё не сгенерирован. Вернитесь на шаг 1 и нажмите «Продолжить» → «Отправить».
            </div>
          )}

          {error && <div className="mt-4">{errorBox}</div>}
          {canceled === 'logline' && <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-canceled">Генерация логлайна отменена.</p>}
          {canceled === 'synopsis' && <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-canceled">Генерация синопсиса отменена.</p>}

        </div>
        {stepFooter(
          'idea-v2-logline-footer',
          <>
            {hasSynopsis && !loglineDirty && !inputDirty && !loglineGenerating && (
              <button onClick={() => goStep('synopsis')} className="flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground" data-testid="idea-v2-to-synopsis">
                К готовому синопсису <ArrowRight className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={approveLoglineAndContinue}
              disabled={approving || loglineGenerating || !haveText || loglineStale || loglineDraft.trim().length < 10}
              className={btnPrimary}
              data-testid="idea-v2-logline-approve"
            >
              {approving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Продолжить
            </button>
          </>,
          <button onClick={() => goStep('idea')} disabled={!stepClickable.idea} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground disabled:opacity-50" data-testid="idea-v2-logline-back">
            <ArrowLeft className="h-4 w-4" /> К идее
          </button>,
        )}
        {renderPromptModal()}
      </div>
    )
  }

  // ═══════════════════════ Шаг 3: синопсис — до генерации ═══════════════════════
  // Переход сюда по «Продолжить» на логлайне. Синопсис НЕ генерируется автоматически:
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
          </div>

          {savedLogline && (
            <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm italic" data-testid="idea-v2-synopsis-logline">
              <span className="mr-1 not-italic font-semibold text-primary">Логлайн:</span>{savedLogline}
            </div>
          )}
          <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground" data-testid="idea-v2-synopsis-empty">
            Синопсис ещё не сгенерирован. Нажмите «Сгенерировать» — логлайн развернётся в синопсис на 7–10 предложений.
          </div>
          {error && <div className="mt-4">{errorBox}</div>}
          {canceled === 'synopsis' && <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-canceled">Генерация синопсиса отменена.</p>}
        </div>
        {stepFooter(
          'idea-v2-synopsis-footer',
          <button onClick={() => generate('synopsis')} className={btnPrimary} data-testid="idea-v2-synopsis-generate">
            <Wand2 className="h-4 w-4" /> Сгенерировать
          </button>,
          <button onClick={() => goStep('logline')} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground" data-testid="idea-v2-synopsis-back">
            <ArrowLeft className="h-4 w-4" /> К логлайну
          </button>,
        )}
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
          <div className={`mt-4 ${SYNOPSIS_TEXT_CLS}`} data-testid="idea-v2-result-text">
            {String(project.synopsis).trim()}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Синопсис сохранён в проекте. Следующие шаги потока v2.0 появятся позже.</p>
          {error && <div className="mt-4">{errorBox}</div>}
          {canceled === 'synopsis' && <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-canceled">Генерация отменена.</p>}
        </div>
        {stepFooter(
          'idea-v2-result-footer',
          null,
          <button onClick={() => goStep('logline')} disabled={!stepClickable.logline} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground disabled:opacity-50" data-testid="idea-v2-result-back">
            <ArrowLeft className="h-4 w-4" /> К логлайну
          </button>,
        )}
        {renderPromptModal()}
      </div>
    )
  }

  // ═══════════════════════ Шаг 1: идея ═══════════════════════
  return (
    <div className="space-y-6" data-testid="idea-stage-v2">
      {stepsBar}

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
          <h2 className="flex items-center gap-2 font-display text-xl font-bold">
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
        </div>
      )}
      {screen === 'input' && stepFooter(
        'idea-v2-input-footer',
        <button
          onClick={() => void continueFromIdea()}
          disabled={!canProceed || savingInput}
          className={btnPrimary}
          data-testid="idea-v2-generate"
        >
          {savingInput ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />} Продолжить
        </button>,
        hasLogline && !inputDirty ? (
          <button onClick={() => goStep('logline')} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground" data-testid="idea-v2-input-to-logline">
            К готовому логлайну <ArrowRight className="h-4 w-4" />
          </button>
        ) : null,
      )}

      {renderPromptModal()}
      {renderResetConfirmModal()}
    </div>
  )
}
