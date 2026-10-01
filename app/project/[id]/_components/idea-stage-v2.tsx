'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Wand2, Sparkles, Lightbulb, Eye, Pencil, ArrowLeft, ArrowRight, Tags, Info, BookOpen, RotateCcw, Copy, Check, X, ChevronDown, ChevronRight } from 'lucide-react'
import { GENRES } from '@/lib/idea'
import { FABLE_MODEL_LABEL, SYNOPSIS_V2_STAGE, SYNOPSIS_LANGUAGES, SYNOPSIS_LANGUAGE_CODES, DEFAULT_SYNOPSIS_LANGUAGE, normalizeSynopsisLanguage, normalizeEpisodesCount, DEFAULT_EPISODES_COUNT, MIN_EPISODES_COUNT, MAX_EPISODES_COUNT, type SynopsisLanguage } from '@/lib/idea-v2'
import { useTranslation } from '@/lib/i18n/context'
import { CancelButton } from './cancel-button'
import { useJobPolling, SmoothProgress } from './use-job-polling'

/** Примерная длительность генерации синопсиса v2 — управляет плавным прогресс-баром. */
const SYNOPSIS_V2_EXPECTED_SEC = 50

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

type Screen = 'choose' | 'input'
/** Единственный генерируемый шаг v2 — синопсис (шаг логлайна из потока v2 убран; его бэкенд оставлен для v1/старых проектов). */
type Kind = 'synopsis'
type StepKey = 'idea' | Kind
/** Сообщение диалога с моделью (то, что уходит в API как messages). system — всегда первым (правила), затем user/assistant. */
type Msg = { role: 'system' | 'user' | 'assistant'; content: string }

/** Текст system (первое сообщение), либо '' если его нет. */
const systemOf = (m: Msg[]) => (m[0]?.role === 'system' ? m[0].content : '')
/** Диалог с заменённым system (если system есть первым). */
const withSystem = (m: Msg[], text: string): Msg[] => (m[0]?.role === 'system' ? [{ role: 'system', content: text }, ...m.slice(1)] : m)
/** Сообщения без system (история user/assistant). */
const nonSystem = (m: Msg[]) => m.filter((x) => x.role !== 'system')

/** Индекс крайнего (самого нового) user-сообщения — текущего (неотправленного) запроса. */
const lastUserIdx = (m: Msg[]) => { for (let i = m.length - 1; i >= 0; i--) if (m[i].role === 'user') return i; return -1 }
/** Хронологический текст истории для буфера обмена: «SYSTEM:» первым, далее «USER:» / «ASSISTANT:», через пустую строку. */
const historyText = (m: Msg[]) => m.map((x) => `${x.role.toUpperCase()}:\n${x.content}`).join('\n\n')

/**
 * Черновик промпта: отредактированный system БЕЗ вызова ИИ + кэш собранного промпта. В проекте нет
 * поля под черновик и миграции не делаем → localStorage по ключу projectId+kind. История (user/assistant)
 * не редактируется — всегда авто-собранная.
 *   sysOrig      — авто-system на момент сборки: правка sysEdit применяется, только если заново собранный
 *                  system совпал с ним (иначе правка устарела — берём авто; это и есть «Сбросить к авто»
 *                  с актуальным шаблоном/языком/количеством эпизодов).
 *   fp + list    — «отпечаток» вводных и собранный диалог: если отпечаток текущих вводных совпал — модалка
 *                  открывается из кэша без запроса preview (промпт персистентен между открытиями/перезагрузкой).
 */
type PromptDraft = {
  sysOrig?: string; sysEdit?: string
  fp?: string; list?: Msg[]; note?: string; refineEn?: string; wishesEn?: string; ideaEn?: string
}
const draftKey = (projectId: string, k: Kind) => `foltum:v2:prompt-draft:${projectId}:${k}`
const loadDraft = (projectId: string, k: Kind): PromptDraft | null => {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(draftKey(projectId, k)) : null
    if (!raw) return null
    const d = JSON.parse(raw)
    if (!d || typeof d !== 'object') return null
    if (d.list !== undefined && !(Array.isArray(d.list) && d.list.every((m: any) => m && (m.role === 'system' || m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'))) delete d.list
    return d
  } catch { return null }
}
const storeDraft = (projectId: string, k: Kind, d: PromptDraft) => {
  try { window.localStorage.setItem(draftKey(projectId, k), JSON.stringify(d)) } catch { /* localStorage недоступен */ }
}
/** Нормализация строки для отпечатка вводных. */
const normFp = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ')

/**
 * Диалог правок синопсиса (S0 + пары «правка → синопсис») живёт в сессии; чтобы история не терялась при
 * перезагрузке страницы — дублируем в localStorage по projectId (без миграции БД). Применяется только если
 * сохранённая база/крайний синопсис согласуются с сохранённым в проекте синопсисом.
 */
type SynopsisDialog = { base: string; turns: { refine: string; synopsis: string }[] }
const dialogKey = (projectId: string) => `foltum:v2:synopsis-dialog:${projectId}`
const loadDialog = (projectId: string): SynopsisDialog | null => {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(dialogKey(projectId)) : null
    const d = raw ? JSON.parse(raw) : null
    return d && typeof d.base === 'string' && Array.isArray(d.turns) ? d : null
  } catch { return null }
}
const storeDialog = (projectId: string, base: string, turns: SynopsisDialog['turns']) => {
  try {
    if (!base) window.localStorage.removeItem(dialogKey(projectId))
    else window.localStorage.setItem(dialogKey(projectId), JSON.stringify({ base, turns } satisfies SynopsisDialog))
  } catch { /* localStorage недоступен */ }
}

/**
 * Язык синопсиса — выбор пользователя на шаге 1. Хранится в localStorage по projectId (fallback — старый ключ языка
 * логлайна); уходит параметром synopsisLanguage, бэкенд пишет ISO-код в Project.language.
 */
const langKey = (projectId: string) => `foltum:v2:synopsis-lang:${projectId}`
const legacyLangKey = (projectId: string) => `foltum:v2:logline-lang:${projectId}`
const loadLang = (projectId: string): SynopsisLanguage | null => {
  try {
    const raw = window.localStorage.getItem(langKey(projectId)) ?? window.localStorage.getItem(legacyLangKey(projectId))
    return raw && (SYNOPSIS_LANGUAGES as readonly string[]).includes(raw) ? (raw as SynopsisLanguage) : null
  } catch { return null }
}
const storeLang = (projectId: string, lang: SynopsisLanguage) => {
  try { window.localStorage.setItem(langKey(projectId), lang) } catch { /* localStorage недоступен */ }
}
/** Подписи языков (нативные названия — одинаковы для RU/EN UI). */
const LANG_LABELS: Record<SynopsisLanguage, string> = { Russian: 'Русский', English: 'English', Spanish: 'Español', German: 'Deutsch', French: 'Français' }
/** Язык синопсиса по умолчанию — язык интерфейса (ru → Русский, иначе English). */
const langFromLocale = (locale: string): SynopsisLanguage => (locale === 'ru' ? 'Russian' : 'English')
/** Восстановление с другого устройства: ISO-код Project.language → язык синопсиса (только если синопсис уже сгенерирован). */
const langFromCode = (code: unknown): SynopsisLanguage | null => {
  const hit = (Object.keys(SYNOPSIS_LANGUAGE_CODES) as SynopsisLanguage[]).find((l) => SYNOPSIS_LANGUAGE_CODES[l] === code)
  return hit ?? null
}

/** Количество эпизодов — выбор на шаге 1: Project.episodeCount (пишет воркер синопсиса) → localStorage → 50. */
const episodesKey = (projectId: string) => `foltum:v2:episodes:${projectId}`
const loadEpisodes = (projectId: string): number | null => {
  try {
    const raw = window.localStorage.getItem(episodesKey(projectId))
    return raw ? normalizeEpisodesCount(raw) : null
  } catch { return null }
}
const storeEpisodes = (projectId: string, n: number) => {
  try { window.localStorage.setItem(episodesKey(projectId), String(n)) } catch { /* localStorage недоступен */ }
}

const API: Record<Kind, { generate: string; preview: string }> = {
  synopsis: { generate: '/api/ai/v2/synopsis', preview: '/api/ai/v2/synopsis/preview' },
}
const KIND_LABEL: Record<Kind, string> = { synopsis: 'синопсиса' }

/**
 * Поток «Новый проект v2.0» — два шага: Идея → Синопсис (шаг логлайна убран; синопсис строится прямо из идеи/жанров).
 *   idea     — выбор режима (своя идея / жанры [+ пожелания]), язык синопсиса и количество эпизодов → «Продолжить»
 *              (сразу запускает генерацию и переходит на шаг 2; при изменённом вводе и готовом синопсисе — сначала
 *              предупреждение о сбросе). Рядом «Превью»: модалка промпта только с «Сохранить»/«Закрыть».
 *   synopsis — стрим синопсиса; поле правки → «Изменить» (сразу отправляет; правка уходит диалогом messages
 *              с прежними синопсисами: system → user → assistant(S0) → user → assistant → ... → user); «Превью» рядом.
 *
 * Основная кнопка перехода на обоих шагах стоит ВНЕ карточки, под ней. Модалка промпта: system (правила + N эпизодов +
 * язык) закреплён сверху, ниже диалог user/assistant (первый user — буквально ввод пользователя: жанры / идея /
 * пожелания по-английски), новые сверху, редактируются только system и крайний user; кнопки «Скопировать историю»
 * и «RU». Перевод RU — только для отображения; в API всегда уходит английский оригинал.
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
  // Английский перевод идеи из preview — уходит в generate как ideaEn (паритет с модалкой). Сбрасывается при правке идеи.
  const [ideaEn, setIdeaEn] = useState('')
  // Язык синопсиса (п. «Язык синопсиса» на шаге 1): localStorage по projectId → Project.language (если синопсис уже есть) → язык UI.
  const [synopsisLang, setSynopsisLang] = useState<SynopsisLanguage>(DEFAULT_SYNOPSIS_LANGUAGE)
  // Количество эпизодов (10–100, дефолт 50): Project.episodeCount → localStorage → 50. Текстовое значение поля — отдельно,
  // чтобы можно было стереть/набрать число; нормализуется (clamp) при потере фокуса и перед отправкой.
  const [episodes, setEpisodes] = useState<number>(DEFAULT_EPISODES_COUNT)
  const [episodesText, setEpisodesText] = useState<string>(String(DEFAULT_EPISODES_COUNT))
  // Модалка-предупреждение о сбросе синопсиса — показывается ТОЛЬКО по «Продолжить» на шаге 1, если ввод менялся.
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  // Пользователь подтвердил сброс → уже сохранённый синопсис скрывается до новой генерации.
  const [downstreamReset, setDownstreamReset] = useState(false)
  // Ввод шага 1 зафиксирован («Продолжить») → экран синопсиса доступен.
  // Также удерживает экран синопсиса в «дыре» между завершением job и onRefresh (нет мигания на шаг 1).
  const [inputSaved, setInputSaved] = useState(false)
  const [savingInput, setSavingInput] = useState(false)

  // ─── Данные проекта
  const stage = project?.stage
  const savedSynopsis = String(project?.synopsis ?? '').trim()
  const hasSynopsis = stage === SYNOPSIS_V2_STAGE && !!savedSynopsis && !downstreamReset
  const autoView: StepKey = hasSynopsis ? 'synopsis' : 'idea'
  const [view, setView] = useState<StepKey | null>(null) // null → autoView
  const currentView: StepKey = view ?? autoView

  // Правка синопсиса: «что изменить» — уходит в preview/generate вместе с текущим синопсисом,
  // чтобы модель дорабатывала его с сохранением контекста, а не писала с нуля.
  const [refineText, setRefineText] = useState('')
  // Английский перевод правки из preview (показан в модалке) — уходит в generate как есть и сохраняется в synopsisTurns.
  const [refineEn, setRefineEn] = useState('')
  // Реальный диалог с моделью (живёт в сессии): базовый синопсис S0 + применённые пары «правка → синопсис».
  // Уходит в API как synopsisBase/synopsisTurns → бэкенд собирает messages system→user→assistant→user→…,
  // поэтому прежние правки не отменяются моделью.
  const [synopsisBase, setSynopsisBase] = useState('')
  const [synopsisTurns, setSynopsisTurns] = useState<{ refine: string; synopsis: string }[]>([])
  // Правка, с которой стартовала текущая генерация — фиксируем в момент запуска (без stale-замыкания).
  const lastRefineRef = useRef<string>('')
  // Восстановление диалога правок после перезагрузки: берём из localStorage, если он согласуется с сохранённым синопсисом.
  useEffect(() => {
    const d = loadDialog(project.id)
    if (!d || !savedSynopsis) return
    const lastKnown = d.turns.length ? d.turns[d.turns.length - 1].synopsis : d.base
    if (lastKnown.trim() === savedSynopsis) { setSynopsisBase(d.base); setSynopsisTurns(d.turns) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])
  useEffect(() => { storeDialog(project.id, synopsisBase, synopsisTurns) }, [project.id, synopsisBase, synopsisTurns])

  // Ввод менялся после последнего «Продолжить» → шаг «Синопсис» недоступен,
  // но его данные НЕ сбрасываются, пока пользователь не подтвердит сброс в модалке.
  const [inputDirty, setInputDirty] = useState(false)

  // ─── Промпты: диалог messages из preview (system первым) + правки system и крайнего user
  const { t, locale } = useTranslation()
  useEffect(() => {
    const saved = loadLang(project.id) ?? (savedSynopsis ? langFromCode(project?.language) : null)
    setSynopsisLang(saved ?? langFromLocale(locale))
    // Количество эпизодов: сохранённое в проекте (воркер синопсиса пишет Project.episodeCount) приоритетнее localStorage.
    const fromProject = typeof project?.episodeCount === 'number' ? normalizeEpisodesCount(project.episodeCount) : null
    const n = fromProject ?? loadEpisodes(project.id) ?? DEFAULT_EPISODES_COUNT
    setEpisodes(n); setEpisodesText(String(n))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])
  const [promptKind, setPromptKind] = useState<Kind>('synopsis')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState<Kind | null>(null)
  const [ready, setReady] = useState<Record<Kind, boolean>>({ synopsis: false })
  // Оригинальный диалог из preview: system (правила) → user (ввод) → assistant (S0) → user (правка) → … → крайний user.
  const [msgs, setMsgs] = useState<Record<Kind, Msg[]>>({ synopsis: [] })
  // Редактируемый текст system (первое сообщение; «Сбросить к авто» возвращает шаблон).
  const [sysEdit, setSysEdit] = useState<Record<Kind, string>>({ synopsis: '' })
  const [note, setNote] = useState<Record<Kind, string>>({ synopsis: '' })
  const [copied, setCopied] = useState(false)
  // Подтверждение «Сохранено» у кнопки «Сохранить» (~1.5 с), модалка остаётся открытой.
  const [saved, setSaved] = useState(false)
  // Аккордеон «История» в модалке промпта: свёрнут по умолчанию (read-only список, новые сверху).
  const [historyOpen, setHistoryOpen] = useState(false)
  // Отпечаток вводных, под который собран текущий промпт шага k (для кэша черновика).
  const fpRef = useRef<Record<Kind, string>>({ synopsis: '' })
  // РУ-перевод транскрипта (только отображение; в API уходит английский оригинал).
  const [msgsRuOn, setMsgsRuOn] = useState(false)
  const [msgsRu, setMsgsRu] = useState<string[] | null>(null)
  const [msgsRuLoading, setMsgsRuLoading] = useState(false)

  const sysOrig = (k: Kind) => systemOf(msgs[k])
  const isSysEdited = (k: Kind) => ready[k] && sysEdit[k] !== sysOrig(k)
  /** Диалог, который уйдёт в API: system [с правкой] + авто-собранная история хронологически (не редактируется). */
  const sendMessages = (k: Kind) => withSystem(msgs[k], sysEdit[k])
  /** Текущее состояние модалки шага k как черновик (правка system + кэш собранного промпта под его отпечаток). */
  const draftNow = (k: Kind): PromptDraft => ({
    sysOrig: sysOrig(k), sysEdit: sysEdit[k],
    fp: fpRef.current[k] || undefined, list: msgs[k], note: note[k],
    refineEn, wishesEn, ideaEn,
  })
  const resetPrompt = (k: Kind) => setReady((p) => ({ ...p, [k]: false }))

  // Сброс синопсиса — вызывается ТОЛЬКО после подтверждения в модалке-предупреждении.
  // Собранный промпт НЕ сбрасываем: он уже собран и (возможно) отредактирован в модалке — уходит в генерацию.
  const invalidateDownstream = () => {
    setPreviewOpen(false)
    setDownstreamReset(true)
    setRefineText(''); setRefineEn(''); setSynopsisBase(''); setSynopsisTurns([]); lastRefineRef.current = ''
  }
  // Редактирование ввода лишь помечает его изменённым — ничего не сбрасывает.
  const markInputDirty = () => setInputDirty(true)

  // ─── Генерация (фоновая задача)
  const [starting, setStarting] = useState<Kind | null>(null)
  const [error, setError] = useState('')
  const [canceled, setCanceled] = useState<Kind | null>(null)
  const activeJobIdRef = useRef<string | null>(null)

  const finish = (k: Kind) => (res: any) => {
    activeJobIdRef.current = null
    if (res.job.status === 'completed') {
      setError(''); setCanceled(null); setPreviewOpen(false)
      // История изменилась (новый ответ модели) → кэш собранного промпта устарел: следующее открытие модалки
      // пересоберёт диалог с актуальной историей; правки system/user сохраняются (применяются при совпадении авто-текста).
      { const prev = loadDraft(project.id, k); if (prev) storeDraft(project.id, k, { ...prev, fp: undefined, list: undefined, note: undefined }) }
      const fresh = String(res.job.result?.synopsis ?? res.job.streamedText ?? '').trim()
      // Ход диалога: правка → результат становится парой в транскрипте; генерация с нуля → результат = база S0.
      if (lastRefineRef.current) {
        const applied = lastRefineRef.current; lastRefineRef.current = ''
        if (fresh) setSynopsisTurns((t) => [...t, { refine: applied, synopsis: fresh }])
      } else { setSynopsisBase(fresh); setSynopsisTurns([]) }
      setInputDirty(false); setInputSaved(true); setDownstreamReset(false); setRefineText(''); setRefineEn('')
      setView(k)
      onRefresh()
    } else if (res.job.status === 'canceled') {
      setCanceled(k)
    } else {
      setError(res.job.error ?? 'Не удалось сгенерировать синопсис')
    }
  }
  const synopsisJob = useJobPolling({ intervalMs: 800, onFinish: finish('synopsis') })
  const jobs: Record<Kind, typeof synopsisJob> = { synopsis: synopsisJob }
  const isActive = (j: any) => !!j && (j.status === 'pending' || j.status === 'processing')
  const activeKind: Kind | null = starting ?? (isActive(synopsisJob.job) ? 'synopsis' : null)
  const generating = !!activeKind

  // Возобновление: подхватываем уже крутящуюся задачу синопсиса.
  useEffect(() => {
    let ignore = false
    ;(async () => {
      for (const k of ['synopsis'] as Kind[]) {
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
  const onIdeaChange = (v: string) => { setIdea(v); setIdeaEn(''); markInputDirty() }
  // Смена языка синопсиса: запоминаем по проекту, пересобираем промпт (system содержит строку OUTPUT LANGUAGE).
  const onLangChange = (v: string) => {
    const lang = normalizeSynopsisLanguage(v)
    setSynopsisLang(lang); storeLang(project.id, lang); resetPrompt('synopsis'); markInputDirty()
  }
  // Количество эпизодов: пока печатают — только текст; фиксируем (clamp 10–100) по blur/Enter и перед сборкой промпта.
  const commitEpisodes = (raw: string): number => {
    const n = normalizeEpisodesCount(raw)
    setEpisodesText(String(n))
    if (n !== episodes) { setEpisodes(n); storeEpisodes(project.id, n); resetPrompt('synopsis'); markInputDirty() }
    return n
  }
  const onEpisodesChange = (v: string) => {
    setEpisodesText(v)
    const n = Number(v)
    if (Number.isFinite(n) && n >= MIN_EPISODES_COUNT && n <= MAX_EPISODES_COUNT && Math.round(n) !== episodes) {
      setEpisodes(Math.round(n)); storeEpisodes(project.id, Math.round(n)); resetPrompt('synopsis'); markInputDirty()
    }
  }
  const canProceed = mode === 'idea' ? idea.trim().length >= 10 : genres.length > 0
  const onWishesChange = (v: string) => { setWishes(v); setWishesEn(''); markInputDirty() }
  const inputBody = () => ({
    synopsisLanguage: synopsisLang,
    episodesCount: episodes,
    ...(mode === 'idea'
      ? { idea: idea.trim(), ideaEn: ideaEn || undefined }
      : { genres, wishes: wishes.trim() || undefined, wishesEn: wishes.trim() && wishesEn ? wishesEn : undefined }),
  })
  // Аргументы уточнения синопсиса: добавляются, когда есть непустая правка и текущий синопсис.
  // noRefine — принудительно «с нуля» (шаг 1 → модалка, «Перегенерировать»), даже если поле правки заполнено.
  const refineArgs = (_k: Kind, noRefine = false) =>
    !noRefine && refineText.trim() && savedSynopsis
      ? { synopsis: savedSynopsis, refine: refineText.trim(), ...(refineEn ? { refineEn } : {}), ...(synopsisBase ? { synopsisBase, synopsisTurns } : {}) }
      : {}
  const onRefineChange = (v: string) => { setRefineText(v); setRefineEn(''); resetPrompt('synopsis') }

  const chooseMode = (m: 'idea' | 'genres') => {
    if (m !== mode) markInputDirty()
    setMode(m); setError(''); setCanceled(null); setScreen('input')
  }

  /**
   * Отпечаток вводных промпта: всё, от чего зависит собираемый preview (нормализовано) —
   * режим, идея / жанры (сортированы) + пожелания, язык синопсиса, количество эпизодов,
   * правка (текст + текущий синопсис + база S0 + ходы).
   */
  const fingerprint = (k: Kind, noRefine = false) => {
    const src = mode === 'idea'
      ? { mode, idea: normFp(idea) }
      : { mode, genres: [...genres].map((g) => normFp(g).toLowerCase()).sort(), wishes: normFp(wishes) }
    const refine = !noRefine && refineText.trim() && savedSynopsis
      ? { refine: normFp(refineText), synopsis: normFp(savedSynopsis), base: normFp(synopsisBase), turns: synopsisTurns.map((t) => [normFp(t.refine), normFp(t.synopsis)]) }
      : null
    return JSON.stringify({ k, ...src, lang: synopsisLang, episodes, refine })
  }

  // Собрать промпт для текущего ввода. Если отпечаток вводных совпал с кэшем черновика — берём промпт из кэша
  // (без запроса preview, с сохранённой правкой system); иначе запрашиваем preview и кладём результат в кэш.
  // Возвращает собранный диалог и system с учётом черновика, либо null при ошибке.
  const buildPrompt = async (k: Kind, noRefine = false): Promise<{ list: Msg[]; sysEdit: string; refineEn: string } | null> => {
    const fp = fingerprint(k, noRefine)
    const cached = loadDraft(project.id, k)
    if (cached && cached.fp === fp && cached.list && nonSystem(cached.list).length) {
      const list = cached.list
      const sysE = cached.sysEdit?.trim() ? cached.sysEdit : systemOf(list)
      const refineEnNow = cached.refineEn ?? ''
      fpRef.current[k] = fp
      setMsgs((s) => ({ ...s, [k]: list }))
      setSysEdit((s) => ({ ...s, [k]: sysE }))
      setNote((s) => ({ ...s, [k]: cached.note ?? '' }))
      setWishesEn(cached.wishesEn ?? ''); setIdeaEn(cached.ideaEn ?? ''); setRefineEn(refineEnNow)
      setMsgsRu(null); setMsgsRuOn(false)
      setReady((s) => ({ ...s, [k]: true }))
      return { list, sysEdit: sysE, refineEn: refineEnNow }
    }
    try {
      const args = refineArgs(k, noRefine)
      const res = await fetch(API[k].preview, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, ...inputBody(), ...args }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? 'Не удалось собрать промпт'); return null }
      if (typeof d.wishesEn === 'string') setWishesEn(d.wishesEn)
      if (typeof d.ideaEn === 'string') setIdeaEn(d.ideaEn)
      const refineEnNow = typeof d.refineEn === 'string' ? d.refineEn : ''
      setRefineEn(refineEnNow)
      let list: Msg[] = Array.isArray(d.messages)
        ? d.messages.filter((m: any) => m && (m.role === 'system' || m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').map((m: any) => ({ role: m.role, content: m.content }))
        : []
      if (!nonSystem(list).length) {
        list = [{ role: 'user', content: String(d.user ?? '').trim() }]
        if (String(d.assistant ?? '').trim()) list.push({ role: 'assistant', content: String(d.assistant).trim() })
      }
      // system — всегда первым: из messages либо из отдельного поля system ответа preview.
      if (list[0]?.role !== 'system') {
        const sys = String(d.system ?? '').trim()
        list = sys ? [{ role: 'system', content: sys }, ...nonSystem(list)] : nonSystem(list)
      }
      setMsgs((s) => ({ ...s, [k]: list }))
      const draft = loadDraft(project.id, k)
      const sysO = systemOf(list)
      // Черновик system: применяем, если авто-system не изменился (иначе шаблон/язык/N обновились — берём авто).
      const sysE = draft && typeof draft.sysEdit === 'string' && draft.sysEdit.trim() && (draft.sysOrig ?? '') === sysO ? draft.sysEdit : sysO
      setSysEdit((s) => ({ ...s, [k]: sysE }))
      setMsgsRu(null); setMsgsRuOn(false)
      const hist = nonSystem(list).length
      const dialogNote = hist > 1
        ? ` Запрос уйдёт диалогом: system (правила) + ${hist} сообщений истории (свёрнута ниже, новые сверху): модель видит свои прежние ответы и все ранние правки. Редактировать можно только system.`
        : ' Запрос уйдёт как system (правила) + user (ваш ввод). Редактировать можно только system.'
      const noteText = `${d.contextNote ?? ''}${dialogNote}`
      setNote((s) => ({ ...s, [k]: noteText }))
      setReady((s) => ({ ...s, [k]: true }))
      // Кэш: собранный промпт под отпечаток текущих вводных (+ применённые правки) — следующее открытие без preview.
      fpRef.current[k] = fp
      storeDraft(project.id, k, {
        sysOrig: sysO, sysEdit: sysE, fp, list, note: noteText,
        refineEn: refineEnNow, wishesEn: typeof d.wishesEn === 'string' ? d.wishesEn : '', ideaEn: typeof d.ideaEn === 'string' ? d.ideaEn : '',
      })
      return { list, sysEdit: sysE, refineEn: refineEnNow }
    } catch { setError('Ошибка сети'); return null }
  }

  const resetModalFlags = (k: Kind) => {
    setMsgsRuOn(false); setCopied(false); setSaved(false); setHistoryOpen(false)
    setPromptKind(k)
  }
  // «Превью» рядом с любой отправляющей кнопкой: собирает промпт (из кэша, если вводные не менялись) и показывает его.
  // В модалке — только «Сохранить» (правки system / крайнего user в localStorage) и «Закрыть»; генерацию модалка не запускает.
  const openPreview = async (k: Kind, noRefine = false) => {
    setError('')
    if (k === 'synopsis' && currentView === 'idea') commitEpisodes(episodesText)
    resetModalFlags(k)
    if (ready[k] && fpRef.current[k] === fingerprint(k, noRefine)) { setPreviewOpen(true); return }
    setPreviewLoading(k)
    const ok = await buildPrompt(k, noRefine)
    setPreviewLoading(null)
    if (ok) setPreviewOpen(true)
  }

  const generate = async (k: Kind, noRefine = false) => {
    setError(''); setCanceled(null); jobs[k].clear(); setStarting(k); setPreviewOpen(false)
    try {
      // Генерация НЕ открывает модалку: уходит последний сохранённый промпт («Сохранить» в превью), если он есть
      // и собран под текущие вводные. Правка system → уходит ВЕСЬ диалог (изменённый system + авто-история).
      const fpNow = fingerprint(k, noRefine)
      let override: Msg[] | null = ready[k] && fpRef.current[k] === fpNow && isSysEdited(k) ? sendMessages(k) : null
      let refineEnNow = ready[k] && fpRef.current[k] === fpNow ? refineEn : ''
      if (!override && !(ready[k] && fpRef.current[k] === fpNow) && loadDraft(project.id, k)) {
        const b = await buildPrompt(k, noRefine)
        if (b) {
          if (b.sysEdit !== systemOf(b.list)) override = withSystem(b.list, b.sysEdit)
          if (b.refineEn) refineEnNow = b.refineEn
        }
      }
      // Активная правка → запомним её (АНГЛИЙСКИЙ вариант из preview, чтобы вся история была английской):
      // по завершении она станет ходом диалога. Иначе (генерация «с нуля») результат станет новой базой S0.
      if (!noRefine && refineText.trim() && savedSynopsis) lastRefineRef.current = refineEnNow.trim() || refineText.trim()
      else { lastRefineRef.current = ''; if (noRefine) setRefineText('') }
      const body: any = { projectId: project.id, ...inputBody(), ...refineArgs(k, noRefine), ...(refineEnNow ? { refineEn: refineEnNow } : {}) }
      if (override) body.overrideMessages = override
      const res = await fetch(API[k].generate, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? 'Не удалось сгенерировать синопсис'); return }
      if (d?.jobId) { activeJobIdRef.current = d.jobId; jobs[k].start(d.jobId) }
      else onRefresh()
    } catch { setError('Ошибка сети') }
    finally { setStarting(null) }
  }

  // «Продолжить» на шаге 1: модалку НЕ открываем — сразу запускаем генерацию синопсиса «с нуля»
  // (уйдёт последний сохранённый промпт из «Превью», если он есть). При изменённом вводе и готовом синопсисе —
  // сначала предупреждение о сбросе.
  const continueFromIdea = () => {
    if (!canProceed) {
      setError(mode === 'idea' ? 'Опишите идею хотя бы одним–двумя предложениями' : 'Выберите хотя бы один жанр')
      return
    }
    commitEpisodes(episodesText)
    setError(''); setCanceled(null)
    setRefineText(''); setRefineEn('')
    if (inputDirty && hasSynopsis) { setResetConfirmOpen(true); return }
    commitSynopsisFromIdea()
  }

  // «Продолжить» с шага 1: фиксируем ввод, открываем шаг 2, запускаем генерацию с нуля.
  const commitSynopsisFromIdea = () => {
    setInputDirty(false); setInputSaved(true); setView('synopsis')
    void generate('synopsis', true)
  }

  // Подтверждение в предупреждении «Изменения затронут синопсис» (после «Продолжить»):
  // реально стираем синопсис в БД (иначе вернётся после перезагрузки), затем шаг 2 + генерация.
  const confirmResetAndSend = async () => {
    setResetConfirmOpen(false); setError('')
    setSavingInput(true)
    try {
      const res = await fetch('/api/ai/v2/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: project.id }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setSavingInput(false); setError(d?.error ?? 'Не удалось сбросить синопсис'); return
      }
    } catch { setSavingInput(false); setError('Ошибка сети'); return }
    setSavingInput(false)
    invalidateDownstream()
    onRefresh()
    commitSynopsisFromIdea()
  }

  const cancel = async () => {
    const id = activeJobIdRef.current
    if (!id) return
    try { await fetch(`/api/ai/jobs/${id}/cancel`, { method: 'POST' }) } catch { /* поллинг повторит */ }
  }

  // ─── Действия модалки промпта (для текущего promptKind)
  const curMsgs = msgs[promptKind]
  const curLastIdx = lastUserIdx(curMsgs)

  /** «Скопировать историю»: весь диалог хронологически (SYSTEM [с правкой] / USER / ASSISTANT), английский оригинал. */
  const copyHistory = async () => {
    try {
      await navigator.clipboard.writeText(historyText(sendMessages(promptKind)))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* буфер обмена недоступен */ }
  }
  const resetSys = () => { setSysEdit((p) => ({ ...p, [promptKind]: sysOrig(promptKind) })); setMsgsRu(null) }
  const onSysChange = (v: string) => { setSysEdit((p) => ({ ...p, [promptKind]: v })); setMsgsRu(null) }
  // РУ для транскрипта: переводим каждое сообщение (параллельно), только для отображения.
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

  // ─── Степпер: Идея → Синопсис
  const currentStepKey: StepKey = activeKind ?? currentView
  const stepClickable: Record<StepKey, boolean> = {
    idea: !generating,
    synopsis: (hasSynopsis || inputSaved) && !inputDirty && !generating,
  }
  const goStep = (key: StepKey) => {
    if (key === currentStepKey || !stepClickable[key]) return
    setError(''); setPreviewOpen(false)
    if (key === 'idea') setScreen('input')
    setView(key)
  }
  const V2_STEPS: { key: StepKey; label: string }[] = [
    { key: 'idea', label: 'Идея' },
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
  const previewBtn = (k: Kind, noRefine: boolean, testId: string, disabled = false) => (
    <button onClick={() => openPreview(k, noRefine)} disabled={disabled || previewLoading === k || generating} className={btnMain} data-testid={testId} title="Посмотреть/отредактировать промпт перед отправкой">
      {previewLoading === k ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Собираем промпт...</> : <><Eye className="h-3.5 w-3.5" /> Превью</>}
    </button>
  )

  // ─── Модалка просмотра / редактирования промпта синопсиса (только «Сохранить» и «Закрыть»; генерацию не запускает)
  // system закреплён сверху (единственное редактируемое, «Сбросить к авто»); ниже история ОТ НОВЫХ К СТАРЫМ —
  // read-only, свёрнута по умолчанию в аккордеон «История».
  const renderPromptModal = () => {
    if (!previewOpen || generating) return null
    const btnBase = 'inline-flex items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-xs font-medium transition'
    const btnIdle = 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
    const btnActive = 'border-primary bg-primary/10 text-primary'
    const hasSys = curMsgs[0]?.role === 'system'
    const off = hasSys ? 1 : 0 // индекс первого user в curMsgs
    const total = curMsgs.length - off // сообщений истории (без system)
    const sysEdited = isSysEdited(promptKind)

    const label = (m: Msg, i: number) => {
      const j = i - off // позиция в истории: 0 — первый user, 1 — S0, 2 — правка 1, 3 — синопсис 1, …
      if (m.role === 'assistant') return j === 1 ? 'Assistant · ответ S0' : `Assistant · ответ ${Math.floor(j / 2)}`
      if (j === 0) return total === 1 ? 'User · задание (уходит сейчас)' : 'User · задание'
      return i === curLastIdx ? 'User · текущая правка (уходит сейчас)' : `User · правка ${Math.floor(j / 2)}`
    }

    const close = () => setPreviewOpen(false)
    // «Сохранить» = запомнить правку system (localStorage) БЕЗ вызова ИИ; модалка остаётся открытой,
    // подпись кнопки на ~1.5 с меняется на «Сохранено». Reset-предупреждение не трогаем.
    const saveDraft = () => {
      storeDraft(project.id, promptKind, draftNow(promptKind))
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
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
                  Отправляемый диалог · system + {total} {total === 1 ? 'сообщение' : total < 5 ? 'сообщения' : 'сообщений'}
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
              {hasSys && (() => {
                const ruShown = msgsRuOn && !msgsRuLoading && !!msgsRu
                const text = ruShown ? msgsRu![0] : sysEdit[promptKind]
                const canEdit = !msgsRuOn
                return (
                  <div className="mb-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2" data-testid="idea-v2-dialog-system" data-editable="true">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold text-muted-foreground" title={t('ideaV2.systemHint')}>System · {t('ideaV2.system')} (правила, уходит первым)</span>
                      <div className="flex items-center gap-1">
                        {sysEdited && <span className="text-[11px] text-amber-500">изменено</span>}
                        <button type="button" onClick={resetSys} disabled={!sysEdited} className={`${btnBase} ${btnIdle} disabled:opacity-40`} title={t('board.resetPrompt')} data-testid="idea-v2-reset-system">
                          <RotateCcw className="h-3.5 w-3.5" /> {t('board.resetPrompt')}
                        </button>
                      </div>
                    </div>
                    <div className="relative">
                      <textarea
                        value={msgsRuOn && msgsRuLoading ? '' : text}
                        onChange={(e) => onSysChange(e.target.value)}
                        readOnly={!canEdit}
                        rows={Math.min(14, Math.max(3, (text ?? '').split('\n').length + 1))}
                        className={`w-full resize-y rounded-lg border px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-primary ${canEdit ? 'border-input bg-background' : 'border-border bg-muted/40 text-foreground/90'}`}
                        data-testid="idea-v2-preview-system"
                      />
                      {msgsRuOn && msgsRuLoading && (
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-background/60">
                          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> Переводим…</span>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })()}
              <div className="rounded-lg border border-border/60" data-testid="idea-v2-history" data-open={historyOpen ? 'true' : 'false'}>
                <button
                  type="button"
                  onClick={() => setHistoryOpen((v) => !v)}
                  aria-expanded={historyOpen}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold text-muted-foreground transition hover:bg-muted/40 hover:text-foreground"
                  data-testid="idea-v2-history-toggle"
                >
                  <span className="inline-flex items-center gap-1.5">
                    {historyOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                    {t('ideaV2.history')} · {total} {total === 1 ? 'сообщение' : total < 5 ? 'сообщения' : 'сообщений'}
                  </span>
                  <span className="text-[11px] font-normal">{t('ideaV2.historyHint')}</span>
                </button>
                {historyOpen && (
                  <ol className="space-y-2 border-t border-border/60 p-2">
                    {curMsgs.map((m, i) => ({ m, i })).filter(({ m }) => m.role !== 'system').reverse().map(({ m, i }) => {
                      const isLastUser = i === curLastIdx
                      const ruShown = msgsRuOn && !msgsRuLoading && !!msgsRu
                      const text = ruShown ? msgsRu![i] : m.content
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
                            {msgsRuOn && msgsRuLoading ? <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> Переводим...</span> : text}
                          </pre>
                        </li>
                      )
                    })}
                  </ol>
                )}
              </div>
              {msgsRuOn && !msgsRuLoading && (
                <p className="mt-1 text-[11px] text-muted-foreground">Показан перевод на русский — только для просмотра. В генерацию уходит оригинал; редактирование system доступно при выключенном RU.</p>
              )}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
            <button onClick={close} className="flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-semibold transition hover:bg-muted" data-testid="idea-v2-preview-cancel">
              Закрыть
            </button>
            <button onClick={saveDraft} disabled={generating || (hasSys && !sysEdit[promptKind].trim())} className={`flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-semibold transition hover:bg-muted ${saved ? 'text-primary' : ''}`} data-testid="idea-v2-preview-save">
              <Check className="h-4 w-4" /> {saved ? t('ideaV2.saved') : t('common.save')}
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
            Вы изменили {mode === 'idea' ? 'идею' : 'жанры или пожелания'}. Если продолжить, ранее сгенерированный синопсис будет сброшен и потребует повторной генерации.
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
                Пишем синопсис сезона по вашей идее/жанрам. Вкладку можно закрыть — прогресс и текст сохранятся.
              </p>
              <CancelButton onCancel={cancel} testId="idea-v2-cancel" className="flex-shrink-0" />
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ═══════════════════════ Шаг 2: синопсис — до генерации ═══════════════════════
  // Сюда попадаем, если генерация не стартовала/отменена. «Сгенерировать» сразу отправляет (последний сохранённый) промпт,
  // «Превью» — показывает его.
  if (currentView === 'synopsis' && !hasSynopsis) {
    return (
      <div className="space-y-6" data-testid="idea-stage-v2">
        {stepsBar}
        <div className={cardCls} style={cardStyle} data-testid="idea-v2-synopsis-pregen">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 font-display text-xl font-bold">
                <BookOpen className="h-5 w-5 text-primary" /> Шаг 2: синопсис
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Модель: <span className="font-semibold text-foreground" data-testid="idea-v2-model">{FABLE_MODEL_LABEL}</span>
              </p>
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground" data-testid="idea-v2-synopsis-empty">
            Синопсис ещё не сгенерирован. Нажмите «Сгенерировать» — идея/жанры развернутся в синопсис сезона на 7–10 предложений.
          </div>
          {error && <div className="mt-4">{errorBox}</div>}
          {canceled === 'synopsis' && <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-canceled">Генерация синопсиса отменена.</p>}
        </div>
        {stepFooter(
          'idea-v2-synopsis-footer',
          <div className="flex flex-wrap items-center gap-2">
            {previewBtn('synopsis', true, 'idea-v2-synopsis-generate-preview')}
            <button onClick={() => generate('synopsis', true)} disabled={generating} className={btnPrimary} data-testid="idea-v2-synopsis-generate">
              <Wand2 className="h-4 w-4" /> Сгенерировать
            </button>
          </div>,
          <button onClick={() => goStep('idea')} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground" data-testid="idea-v2-synopsis-back">
            <ArrowLeft className="h-4 w-4" /> К идее
          </button>,
        )}
        {renderPromptModal()}
      </div>
    )
  }

  // ═══════════════════════ Шаг 2: синопсис готов ═══════════════════════
  if (currentView === 'synopsis' && hasSynopsis) {
    return (
      <div className="space-y-6" data-testid="idea-stage-v2">
        {stepsBar}
        <div className={cardCls} style={cardStyle} data-testid="idea-v2-result">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 font-display text-xl font-bold">
                <BookOpen className="h-5 w-5 text-primary" /> Шаг 2: синопсис готов
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Модель: <span className="font-semibold text-foreground" data-testid="idea-v2-result-model">{FABLE_MODEL_LABEL}</span>
              </p>
            </div>
          </div>

          <div className={`mt-4 ${SYNOPSIS_TEXT_CLS}`} data-testid="idea-v2-result-text">
            {String(project.synopsis).trim()}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">Синопсис сохранён в проекте. Следующие шаги потока v2.0 появятся позже.</p>
          {inputDirty && (
            <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-result-stale">Идея, жанры, язык или число эпизодов изменились — вернитесь на шаг 1 и нажмите «Продолжить», чтобы перегенерировать синопсис.</p>
          )}
          {!inputDirty && (
            <div className="mt-5 rounded-lg border border-border/70 bg-muted/30 px-4 py-3" data-testid="idea-v2-synopsis-refine">
              <label htmlFor="idea-v2-synopsis-refine-input" className="text-xs font-semibold text-foreground">Что изменить в синопсисе?</label>
              <textarea
                id="idea-v2-synopsis-refine-input"
                value={refineText}
                onChange={(e) => onRefineChange(e.target.value)}
                placeholder="Например: сделай ставки выше, добавь романтическую линию, перенеси действие в 90-е..."
                rows={2}
                disabled={generating}
                className="mt-2 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
                data-testid="idea-v2-synopsis-refine-input"
              />
              <p className="mt-1.5 text-[11px] text-muted-foreground">Правка уйдёт диалогом: модель видит прежний синопсис и все ранние правки. «Превью» — посмотреть/сохранить промпт, «Изменить» — отправить.</p>
              <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                {previewBtn('synopsis', false, 'idea-v2-synopsis-refine-preview', !refineText.trim())}
                <button
                  onClick={() => generate('synopsis')}
                  disabled={generating || !refineText.trim()}
                  className={`${btnMain} flex-shrink-0`}
                  data-testid="idea-v2-synopsis-refine-edit"
                >
                  <Pencil className="h-3.5 w-3.5" /> Изменить
                </button>
              </div>
            </div>
          )}
          {error && <div className="mt-4">{errorBox}</div>}
          {canceled === 'synopsis' && <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-canceled">Генерация отменена.</p>}
        </div>
        {stepFooter(
          'idea-v2-result-footer',
          null,
          <button onClick={() => goStep('idea')} disabled={!stepClickable.idea} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground disabled:opacity-50" data-testid="idea-v2-result-back">
            <ArrowLeft className="h-4 w-4" /> К идее
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
              <p className="text-sm text-muted-foreground">Опишите замысел своими словами — от одной фразы до нескольких предложений. ИИ развернёт её в синопсис сезона.</p>
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

          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3" data-testid="idea-v2-synopsis-language">
            <div className="flex items-center gap-2">
              <label htmlFor="idea-v2-synopsis-lang" className="text-xs font-medium text-muted-foreground">{t('ideaV2.synopsisLanguage')}:</label>
              <select
                id="idea-v2-synopsis-lang"
                value={synopsisLang}
                onChange={(e) => onLangChange(e.target.value)}
                className="rounded-lg border border-input bg-background px-3 py-1.5 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
                data-testid="idea-v2-synopsis-lang"
              >
                {SYNOPSIS_LANGUAGES.map((l) => <option key={l} value={l}>{LANG_LABELS[l]}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor="idea-v2-episodes" className="text-xs font-medium text-muted-foreground">{t('ideaV2.episodesCount')}:</label>
              <input
                id="idea-v2-episodes"
                type="number"
                inputMode="numeric"
                min={MIN_EPISODES_COUNT}
                max={MAX_EPISODES_COUNT}
                step={1}
                value={episodesText}
                onChange={(e) => onEpisodesChange(e.target.value)}
                onBlur={(e) => commitEpisodes(e.target.value)}
                className="w-24 rounded-lg border border-input bg-background px-3 py-1.5 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
                data-testid="idea-v2-episodes-count"
              />
              <span className="text-[11px] text-muted-foreground">{MIN_EPISODES_COUNT}–{MAX_EPISODES_COUNT}</span>
            </div>
          </div>

          <p className="mt-4 text-sm text-muted-foreground">
            Отправляется в: <span className="font-semibold text-foreground" data-testid="idea-v2-model">{FABLE_MODEL_LABEL}</span>.
            «Продолжить» сразу запустит генерацию синопсиса сезона на 7–10 предложений (предыстория, герой, главный хук и концовка) — под выбранный язык и количество эпизодов.
            «Превью» — посмотреть и при необходимости отредактировать/сохранить промпт перед отправкой.
          </p>

          {canceled === 'synopsis' && (
            <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-canceled">Генерация отменена. Её можно запустить снова на шаге синопсиса.</p>
          )}
        </div>
      )}
      {screen === 'input' && stepFooter(
        'idea-v2-input-footer',
        <div className="flex flex-wrap items-center gap-2">
          {previewBtn('synopsis', true, 'idea-v2-generate-preview', !canProceed || savingInput)}
          <button
            onClick={continueFromIdea}
            disabled={!canProceed || savingInput || generating}
            className={btnPrimary}
            data-testid="idea-v2-generate"
          >
            {savingInput ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />} Продолжить
          </button>
        </div>,
        hasSynopsis && !inputDirty ? (
          <button onClick={() => goStep('synopsis')} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground" data-testid="idea-v2-input-to-synopsis">
            К готовому синопсису <ArrowRight className="h-4 w-4" />
          </button>
        ) : null,
      )}

      {renderPromptModal()}
      {renderResetConfirmModal()}
    </div>
  )
}
