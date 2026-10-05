'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Loader2, Wand2, Sparkles, Lightbulb, Eye, Pencil, ArrowLeft, ArrowRight, Tags, Info, BookOpen, RotateCcw, Copy, Check, X, ChevronDown, ChevronRight, ListOrdered, Lock } from 'lucide-react'
import { GENRES } from '@/lib/idea'
import { FABLE_MODEL_LABEL, SYNOPSIS_V2_STAGE, SEASON_PLOT_V2_STAGE, parseSeasonPlotV2, SYNOPSIS_LANGUAGES, SYNOPSIS_LANGUAGE_CODES, DEFAULT_SYNOPSIS_LANGUAGE, normalizeSynopsisLanguage, normalizeEpisodesCount, DEFAULT_EPISODES_COUNT, MIN_EPISODES_COUNT, MAX_EPISODES_COUNT, type SynopsisLanguage } from '@/lib/idea-v2'
import { useTranslation } from '@/lib/i18n/context'
import { CancelButton } from './cancel-button'
import { useJobPolling, SmoothProgress } from './use-job-polling'
import { PromptModal } from './v2-prompt-modal'
import { V2_COSTS } from '@/lib/v2-costs'
import { useEntitlements, useLockHint, GatedButton } from '@/components/entitlements-context'

/** Примерная длительность генерации синопсиса v2 — управляет плавным прогресс-баром. */
const SYNOPSIS_V2_EXPECTED_SEC = 50
/** Примерная длительность генерации сюжета сезона (до 100 серий). */
const SEASON_PLOT_V2_EXPECTED_SEC = 120

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
type Kind = 'synopsis' | 'plot'
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

/** Диалог правок сюжета сезона (P0 + пары «правка → сюжет») — тот же подход, что у синопсиса; ключ отдельный. */
type PlotDialog = { base: string; turns: { refine: string; plot: string }[] }
const plotDialogKey = (projectId: string) => `foltum:v2:plot-dialog:${projectId}`
const loadPlotDialog = (projectId: string): PlotDialog | null => {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(plotDialogKey(projectId)) : null
    const d = raw ? JSON.parse(raw) : null
    return d && typeof d.base === 'string' && Array.isArray(d.turns) ? d : null
  } catch { return null }
}
const storePlotDialog = (projectId: string, base: string, turns: PlotDialog['turns']) => {
  try {
    if (!base) window.localStorage.removeItem(plotDialogKey(projectId))
    else window.localStorage.setItem(plotDialogKey(projectId), JSON.stringify({ base, turns } satisfies PlotDialog))
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
const LANG_LABELS: Record<SynopsisLanguage, string> = { English: 'English', Russian: 'Русский', Ukrainian: 'Українська' }
/** Язык синопсиса по умолчанию — язык интерфейса (ru → Русский, uk → Українська, иначе English). */
const langFromLocale = (locale: string): SynopsisLanguage => (locale === 'ru' ? 'Russian' : locale === 'uk' ? 'Ukrainian' : 'English')
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
  plot: { generate: '/api/ai/v2/plot', preview: '/api/ai/v2/plot/preview' },
}
const KIND_LABEL_KEY: Record<Kind, string> = { synopsis: 'ideaV2.kind.synopsis', plot: 'ideaV2.kind.plot' } // genitive, for {kind} params

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

  // Только что сгенерированный результат (из завершённой job) — показывается сразу, пока `project` не подтянется
  // через onRefresh: без этого между завершением задачи и ответом /api/projects/[id] результат «пропадал» на секунду.
  // Снимается эффектом ниже, когда project уже содержит этот же текст (`freshOut`). Новый синопсис обнуляет сюжет (бэкенд его стирает).
  const [freshOut, setFreshOut] = useState<{ synopsis: string; plot: string }>({ synopsis: '', plot: '' })
  const projectSynopsis = String(project?.synopsis ?? '').trim()
  const projectPlot = String(project?.seasonPlotV2 ?? '').trim()
  useEffect(() => {
    setFreshOut((f) => {
      const synopsis = f.synopsis && f.synopsis === projectSynopsis ? '' : f.synopsis
      const plot = f.plot && f.plot === projectPlot ? '' : f.plot
      return synopsis === f.synopsis && plot === f.plot ? f : { synopsis, plot }
    })
  }, [projectSynopsis, projectPlot])
  useEffect(() => { setFreshOut({ synopsis: '', plot: '' }) }, [project?.id])

  // ─── Данные проекта
  const stage = freshOut.plot ? SEASON_PLOT_V2_STAGE : freshOut.synopsis ? SYNOPSIS_V2_STAGE : project?.stage
  const savedSynopsis = freshOut.synopsis || projectSynopsis
  const hasSynopsis = (stage === SYNOPSIS_V2_STAGE || stage === SEASON_PLOT_V2_STAGE) && !!savedSynopsis && !downstreamReset
  // Шаг 3: сюжет сезона по сериям (Project.seasonPlotV2) — есть только на стадии season_plot_v2 (правка синопсиса его сбрасывает).
  const savedPlot = freshOut.plot || (freshOut.synopsis ? '' : projectPlot)
  const hasPlot = stage === SEASON_PLOT_V2_STAGE && hasSynopsis && !!savedPlot
  // Сюжет сезона утверждён → шаги 1–3 только для чтения; редактируются лишь сценарии серий (страница эпизода).
  const locked = stage === SEASON_PLOT_V2_STAGE && !!savedPlot
  const autoView: StepKey = hasPlot ? 'plot' : hasSynopsis ? 'synopsis' : 'idea'
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
  // Правка сюжета сезона (шаг 3): поле, EN-перевод из preview, диалог P0 + ходы (localStorage по projectId).
  const [plotRefineText, setPlotRefineText] = useState('')
  const [plotRefineEn, setPlotRefineEn] = useState('')
  const [plotBase, setPlotBase] = useState('')
  const [plotTurns, setPlotTurns] = useState<{ refine: string; plot: string }[]>([])
  const lastPlotRefineRef = useRef<string>('')
  useEffect(() => {
    const d = loadPlotDialog(project.id)
    if (!d || !savedPlot) return
    const lastKnown = d.turns.length ? d.turns[d.turns.length - 1].plot : d.base
    if (lastKnown.trim() === savedPlot) { setPlotBase(d.base); setPlotTurns(d.turns) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])
  useEffect(() => { storePlotDialog(project.id, plotBase, plotTurns) }, [project.id, plotBase, plotTurns])

  // Ввод менялся после последнего «Продолжить» → шаг «Синопсис» недоступен,
  // но его данные НЕ сбрасываются, пока пользователь не подтвердит сброс в модалке.
  const [inputDirty, setInputDirty] = useState(false)

  // ─── Промпты: диалог messages из preview (system первым) + правки system и крайнего user
  const { t, locale } = useTranslation()
  // Доступы по тарифу: правки инструкцией — Pro+, просмотр/правка промптов — Studio (сервер проверяет то же).
  const ent = useEntitlements()
  const canInstruct = ent.prompt_instruct_edit
  const canViewPrompt = ent.prompt_view
  const lockHint = useLockHint()
  // Стоимость шага в кредитах — показывается на каждой кнопке генерации (списывается сервером при старте job).
  const costTag = (n: number) => <span className="ml-0.5 whitespace-nowrap text-[11px] font-normal opacity-80" data-testid="idea-v2-cost">· {t('ideaV2.costCredits', { n })}</span>
  useEffect(() => {
    // Язык: если синопсис уже сохранён — приоритет у Project.language (его пишут воркеры синопсиса/сюжета,
    // по нему же генерируются сценарии), иначе localStorage, иначе язык интерфейса.
    const saved = (savedSynopsis ? langFromCode(project?.language) : null) ?? loadLang(project.id)
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
  const [ready, setReady] = useState<Record<Kind, boolean>>({ synopsis: false, plot: false })
  // Оригинальный диалог из preview: system (правила) → user (ввод) → assistant (S0) → user (правка) → … → крайний user.
  const [msgs, setMsgs] = useState<Record<Kind, Msg[]>>({ synopsis: [], plot: [] })
  // Редактируемый текст system (первое сообщение; «Сбросить к авто» возвращает шаблон).
  const [sysEdit, setSysEdit] = useState<Record<Kind, string>>({ synopsis: '', plot: '' })
  const [note, setNote] = useState<Record<Kind, string>>({ synopsis: '', plot: '' })
  const [copied, setCopied] = useState(false)
  // Подтверждение «Сохранено» у кнопки «Сохранить» (~1.5 с), модалка остаётся открытой.
  const [saved, setSaved] = useState(false)
  // Аккордеон «История» в модалке промпта: свёрнут по умолчанию (read-only список, новые сверху).
  const [historyOpen, setHistoryOpen] = useState(false)
  // Отпечаток вводных, под который собран текущий промпт шага k (для кэша черновика).
  const fpRef = useRef<Record<Kind, string>>({ synopsis: '', plot: '' })
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
    refineEn: k === 'plot' ? plotRefineEn : refineEn, wishesEn, ideaEn,
  })
  /** Per-kind доступ к правке: текст поля, EN-перевод, сохранённый текст-основа и ref активной правки. */
  const refineTextOf = (k: Kind) => (k === 'plot' ? plotRefineText : refineText)
  const refineEnOf = (k: Kind) => (k === 'plot' ? plotRefineEn : refineEn)
  const setRefineEnFor = (k: Kind, v: string) => (k === 'plot' ? setPlotRefineEn(v) : setRefineEn(v))
  const savedTextOf = (k: Kind) => (k === 'plot' ? savedPlot : savedSynopsis)
  const lastRefineRefOf = (k: Kind) => (k === 'plot' ? lastPlotRefineRef : lastRefineRef)
  const resetPrompt = (k: Kind) => setReady((p) => ({ ...p, [k]: false }))

  // Сброс синопсиса — вызывается ТОЛЬКО после подтверждения в модалке-предупреждении.
  // Собранный промпт НЕ сбрасываем: он уже собран и (возможно) отредактирован в модалке — уходит в генерацию.
  const invalidateDownstream = () => {
    setPreviewOpen(false)
    setDownstreamReset(true)
    setRefineText(''); setRefineEn(''); setSynopsisBase(''); setSynopsisTurns([]); lastRefineRef.current = ''
    setPlotRefineText(''); setPlotRefineEn(''); setPlotBase(''); setPlotTurns([]); lastPlotRefineRef.current = ''
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
      const fresh = String((k === 'plot' ? res.job.result?.plot : res.job.result?.synopsis) ?? res.job.streamedText ?? '').trim()
      // Ход диалога: правка → результат становится парой в транскрипте; генерация с нуля → результат = база S0 / P0.
      if (k === 'plot') {
        if (lastPlotRefineRef.current) {
          const applied = lastPlotRefineRef.current; lastPlotRefineRef.current = ''
          if (fresh) setPlotTurns((t) => [...t, { refine: applied, plot: fresh }])
        } else { setPlotBase(fresh); setPlotTurns([]) }
        setPlotRefineText(''); setPlotRefineEn('')
      } else {
        if (lastRefineRef.current) {
          const applied = lastRefineRef.current; lastRefineRef.current = ''
          if (fresh) setSynopsisTurns((t) => [...t, { refine: applied, synopsis: fresh }])
        } else { setSynopsisBase(fresh); setSynopsisTurns([]) }
        setRefineText(''); setRefineEn('')
        // Новый синопсис → прежний сюжет сезона недействителен (бэкенд его стирает) — чистим диалог шага 3.
        setPlotRefineText(''); setPlotRefineEn(''); setPlotBase(''); setPlotTurns([]); lastPlotRefineRef.current = ''
      }
      setInputDirty(false); setInputSaved(true); setDownstreamReset(false)
      // Результат — сразу на экран (см. `freshOut`): не ждём onRefresh, иначе результат мигает/пропадает.
      if (fresh) setFreshOut((f) => (k === 'plot' ? { ...f, plot: fresh } : { synopsis: fresh, plot: '' }))
      setView(k)
      onRefresh()
    } else if (res.job.status === 'canceled') {
      setCanceled(k)
    } else {
      setError(res.job.error ?? t('ideaV2.genFailed', { kind: t(KIND_LABEL_KEY[k]) }))
    }
  }
  const synopsisJob = useJobPolling({ intervalMs: 800, onFinish: finish('synopsis') })
  const plotJob = useJobPolling({ intervalMs: 800, onFinish: finish('plot') })
  const jobs: Record<Kind, typeof synopsisJob> = { synopsis: synopsisJob, plot: plotJob }
  const isActive = (j: any) => !!j && (j.status === 'pending' || j.status === 'processing')
  const activeKind: Kind | null = starting ?? (isActive(synopsisJob.job) ? 'synopsis' : isActive(plotJob.job) ? 'plot' : null)
  const generating = !!activeKind

  // Возобновление: подхватываем уже крутящуюся задачу синопсиса.
  useEffect(() => {
    let ignore = false
    ;(async () => {
      for (const k of ['synopsis', 'plot'] as Kind[]) {
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
  const inputBody = (k: Kind = 'synopsis') => k === 'plot' ? ({
    synopsis: savedSynopsis,
    synopsisLanguage: synopsisLang,
    episodesCount: episodes,
  }) : ({
    synopsisLanguage: synopsisLang,
    episodesCount: episodes,
    ...(mode === 'idea'
      ? { idea: idea.trim(), ideaEn: ideaEn || undefined }
      : { genres, wishes: wishes.trim() || undefined, wishesEn: wishes.trim() && wishesEn ? wishesEn : undefined }),
  })
  // Аргументы уточнения синопсиса: добавляются, когда есть непустая правка и текущий синопсис.
  // noRefine — принудительно «с нуля» (шаг 1 → модалка, «Перегенерировать»), даже если поле правки заполнено.
  const refineArgs = (k: Kind, noRefine = false) => {
    if (k === 'plot') {
      return !noRefine && plotRefineText.trim() && savedPlot
        ? { plot: savedPlot, refine: plotRefineText.trim(), ...(plotRefineEn ? { refineEn: plotRefineEn } : {}), ...(plotBase ? { plotBase, plotTurns } : {}) }
        : {}
    }
    return !noRefine && refineText.trim() && savedSynopsis
      ? { synopsis: savedSynopsis, refine: refineText.trim(), ...(refineEn ? { refineEn } : {}), ...(synopsisBase ? { synopsisBase, synopsisTurns } : {}) }
      : {}
  }
  const onRefineChange = (v: string) => { setRefineText(v); setRefineEn(''); resetPrompt('synopsis') }
  const onPlotRefineChange = (v: string) => { setPlotRefineText(v); setPlotRefineEn(''); resetPrompt('plot') }

  const chooseMode = (m: 'idea' | 'genres') => {
    if (locked) return
    if (m !== mode) markInputDirty()
    setMode(m); setError(''); setCanceled(null); setScreen('input')
  }

  /**
   * Отпечаток вводных промпта: всё, от чего зависит собираемый preview (нормализовано) —
   * режим, идея / жанры (сортированы) + пожелания, язык синопсиса, количество эпизодов,
   * правка (текст + текущий синопсис + база S0 + ходы).
   */
  const fingerprint = (k: Kind, noRefine = false) => {
    if (k === 'plot') {
      // Сюжет сезона: синопсис (как есть) + язык + число эпизодов (+ правка с текущим сюжетом, P0 и ходами).
      const refine = !noRefine && plotRefineText.trim() && savedPlot
        ? { refine: normFp(plotRefineText), plot: normFp(savedPlot), base: normFp(plotBase), turns: plotTurns.map((t) => [normFp(t.refine), normFp(t.plot)]) }
        : null
      return JSON.stringify({ k, synopsis: normFp(savedSynopsis), lang: synopsisLang, episodes, refine })
    }
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
      if (k === 'synopsis') { setWishesEn(cached.wishesEn ?? ''); setIdeaEn(cached.ideaEn ?? '') }
      setRefineEnFor(k, refineEnNow)
      setMsgsRu(null); setMsgsRuOn(false)
      setReady((s) => ({ ...s, [k]: true }))
      return { list, sysEdit: sysE, refineEn: refineEnNow }
    }
    try {
      const args = refineArgs(k, noRefine)
      const res = await fetch(API[k].preview, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, ...inputBody(k), ...args }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? t('ideaV2.promptBuildFailed')); return null }
      if (typeof d.wishesEn === 'string') setWishesEn(d.wishesEn)
      if (typeof d.ideaEn === 'string') setIdeaEn(d.ideaEn)
      const refineEnNow = typeof d.refineEn === 'string' ? d.refineEn : ''
      setRefineEnFor(k, refineEnNow)
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
        ? t('ideaV2.dialogNoteHistory', { hist })
        : t('ideaV2.dialogNoteSingle', { input: t('ideaV2.dialogInput.user') })
      // contextNote from the server is Russian-only — render the localized equivalent by step kind instead.
      const noteText = `${d.contextNote ? t(k === 'plot' ? 'ideaV2.ctxNote.plot' : 'ideaV2.ctxNote.synopsis') : ''}${dialogNote}`
      setNote((s) => ({ ...s, [k]: noteText }))
      setReady((s) => ({ ...s, [k]: true }))
      // Кэш: собранный промпт под отпечаток текущих вводных (+ применённые правки) — следующее открытие без preview.
      fpRef.current[k] = fp
      storeDraft(project.id, k, {
        sysOrig: sysO, sysEdit: sysE, fp, list, note: noteText,
        refineEn: refineEnNow, wishesEn: typeof d.wishesEn === 'string' ? d.wishesEn : '', ideaEn: typeof d.ideaEn === 'string' ? d.ideaEn : '',
      })
      return { list, sysEdit: sysE, refineEn: refineEnNow }
    } catch { setError(t('common.networkError')); return null }
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
    if (locked) return
    setError(''); setCanceled(null); jobs[k].clear(); setStarting(k); setPreviewOpen(false)
    try {
      // Генерация НЕ открывает модалку: уходит последний сохранённый промпт («Сохранить» в превью), если он есть
      // и собран под текущие вводные. Правка system → уходит ВЕСЬ диалог (изменённый system + авто-история).
      const fpNow = fingerprint(k, noRefine)
      let override: Msg[] | null = ready[k] && fpRef.current[k] === fpNow && isSysEdited(k) ? sendMessages(k) : null
      let refineEnNow = ready[k] && fpRef.current[k] === fpNow ? refineEnOf(k) : ''
      if (!override && !(ready[k] && fpRef.current[k] === fpNow) && loadDraft(project.id, k)) {
        const b = await buildPrompt(k, noRefine)
        if (b) {
          if (b.sysEdit !== systemOf(b.list)) override = withSystem(b.list, b.sysEdit)
          if (b.refineEn) refineEnNow = b.refineEn
        }
      }
      // Активная правка → запомним её (АНГЛИЙСКИЙ вариант из preview, чтобы вся история была английской):
      // по завершении она станет ходом диалога. Иначе (генерация «с нуля») результат станет новой базой S0.
      const refNow = refineTextOf(k)
      if (!noRefine && refNow.trim() && savedTextOf(k)) lastRefineRefOf(k).current = refineEnNow.trim() || refNow.trim()
      else { lastRefineRefOf(k).current = ''; if (noRefine) (k === 'plot' ? setPlotRefineText('') : setRefineText('')) }
      const body: any = { projectId: project.id, ...inputBody(k), ...refineArgs(k, noRefine), ...(refineEnNow ? { refineEn: refineEnNow } : {}) }
      if (override) body.overrideMessages = override
      const res = await fetch(API[k].generate, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? t('ideaV2.genFailed', { kind: t(KIND_LABEL_KEY[k]) })); return }
      if (d?.jobId) { activeJobIdRef.current = d.jobId; jobs[k].start(d.jobId) }
      else onRefresh()
    } catch { setError(t('common.networkError')) }
    finally { setStarting(null) }
  }

  // «Продолжить» на шаге 1: модалку НЕ открываем — сразу запускаем генерацию синопсиса «с нуля»
  // (уйдёт последний сохранённый промпт из «Превью», если он есть). При изменённом вводе и готовом синопсисе —
  // сначала предупреждение о сбросе.
  const continueFromIdea = () => {
    if (locked) return
    if (!canProceed) {
      setError(mode === 'idea' ? t('ideaV2.ideaTooShort') : t('ideaV2.pickGenre'))
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

  // «Продолжить» на шаге 2: синопсис принят как основа → шаг 3 + генерация сюжета сезона «с нуля»
  // (уйдёт сохранённый в «Превью» system, если он есть). Бэкенд ставит synopsisApproved и stage=season_plot_v2.
  const continueFromSynopsis = () => {
    if (locked) return
    if (!hasSynopsis || inputDirty || generating) return
    setError(''); setCanceled(null)
    setPlotRefineText(''); setPlotRefineEn('')
    setView('plot')
    void generate('plot', true)
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
        setSavingInput(false); setError(d?.error ?? t('ideaV2.resetSynopsisFailed')); return
      }
    } catch { setSavingInput(false); setError(t('common.networkError')); return }
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
    plot: hasPlot && !inputDirty && !generating,
  }
  const goStep = (key: StepKey) => {
    if (key === currentStepKey || !stepClickable[key]) return
    setError(''); setPreviewOpen(false)
    if (key === 'idea') setScreen('input')
    setView(key)
  }
  const V2_STEPS: { key: StepKey; label: string }[] = [
    { key: 'idea', label: t('ideaV2.stepIdea') },
    { key: 'synopsis', label: t('ideaV2.stepSynopsis') },
    { key: 'plot', label: t('ideaV2.seasonPlot') },
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
  // Прозрачная (outline) кнопка для второстепенных действий «Превью» и «Открыть».
  const btnGhost = 'inline-flex items-center gap-1.5 rounded-lg border border-border bg-transparent px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted/60 hover:border-foreground/30 disabled:opacity-50'
  // Без Studio кнопка остаётся видимой: disabled + бейдж тарифа (единый паттерн GatedButton).
  const previewBtn = (k: Kind, noRefine: boolean, testId: string, disabled = false) => (
    <GatedButton feature="prompt_view" allowed={canViewPrompt} onClick={() => openPreview(k, noRefine)} disabled={disabled || previewLoading === k || generating} className={btnGhost} data-testid={testId} title={t('ideaV2.previewTitle')}>
      {previewLoading === k ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('ideaV2.promptBuilding')}</> : <><Eye className="h-3.5 w-3.5" /> {t('ideaV2.preview')}</>}
    </GatedButton>
  )

  // ─── Модалка просмотра / редактирования промпта синопсиса (только «Сохранить» и «Закрыть»; генерацию не запускает)
  // system закреплён сверху (единственное редактируемое, «Сбросить к авто»); ниже история ОТ НОВЫХ К СТАРЫМ —
  // read-only, свёрнута по умолчанию в аккордеон «История».
  const renderPromptModal = () => {
    if (!previewOpen || generating) return null
    // «Сохранить» = запомнить правку system (localStorage) БЕЗ вызова ИИ; модалка остаётся открытой,
    // подпись кнопки на ~1.5 с меняется на «Сохранено». Reset-предупреждение не трогаем.
    const saveDraft = () => {
      storeDraft(project.id, promptKind, draftNow(promptKind))
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    }
    return (
      <PromptModal
        kind={promptKind}
        title={t('ideaV2.promptOf', { kind: t(KIND_LABEL_KEY[promptKind]) })}
        firstAnswerTag={promptKind === 'plot' ? 'P0' : 'S0'}
        messages={curMsgs}
        sysEdit={sysEdit[promptKind]}
        sysEdited={isSysEdited(promptKind)}
        note={note[promptKind]}
        onSysChange={onSysChange}
        onResetSys={resetSys}
        copied={copied}
        onCopy={() => void copyHistory()}
        ruOn={msgsRuOn}
        ruLoading={msgsRuLoading}
        ru={msgsRu}
        onToggleRu={() => void toggleMsgsRu()}
        historyOpen={historyOpen}
        onToggleHistory={() => setHistoryOpen((v) => !v)}
        saved={saved}
        saveDisabled={generating}
        onSave={saveDraft}
        onClose={() => setPreviewOpen(false)}
        readOnly={locked}
      />
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
              <Info className="h-5 w-5 text-amber-500" /> {t('ideaV2.resetTitle')}
            </h3>
            <button onClick={close} className="rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground" aria-label={t('common.close')}>
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="px-5 py-4 text-sm text-muted-foreground">
            {t('ideaV2.resetBody', { what: t(mode === 'idea' ? 'ideaV2.resetWhat.idea' : 'ideaV2.resetWhat.genres') })}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
            <button onClick={close} className="rounded-lg border border-border bg-background px-5 py-2.5 text-sm font-semibold text-foreground transition hover:bg-muted" data-testid="idea-v2-reset-cancel">
              {t('common.cancel')}
            </button>
            <button onClick={() => void confirmResetAndSend()} className="flex items-center gap-2 rounded-lg bg-secondary px-5 py-2.5 text-sm font-semibold text-secondary-foreground transition hover:brightness-110" data-testid="idea-v2-reset-confirm">
              <RotateCcw className="h-4 w-4" /> {t('ideaV2.resetConfirm')}{costTag(V2_COSTS.synopsis)}
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
  if (activeKind) {
    const gk: Kind = activeKind
    const j = jobs[gk].job
    return (
      <div className="space-y-6" data-testid="idea-stage-v2">
        {stepsBar}
        {errorBox}
        <div className={cardCls} style={cardStyle} data-testid="idea-v2-generating" data-kind={gk}>
          <h2 className="flex items-center gap-2 font-display text-xl font-bold">
            <Wand2 className="h-5 w-5 text-primary" /> {t('ideaV2.generatingKind', { kind: t(KIND_LABEL_KEY[gk]) })}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('ideaV2.sentTo')} <span className="font-semibold text-foreground" data-testid="idea-v2-model">{FABLE_MODEL_LABEL}</span>.
          </p>
          <div className="mt-4 space-y-2" data-testid="idea-v2-progress">
            {j ? (
              <SmoothProgress job={j} expectedTotalSec={gk === 'plot' ? SEASON_PLOT_V2_EXPECTED_SEC : SYNOPSIS_V2_EXPECTED_SEC} />
            ) : (
              <p className="inline-flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin text-primary" /> {t('ideaV2.starting')}</p>
            )}
            {String(j?.streamedText ?? '').trim() && (
              <GrowingStream text={String(j?.streamedText ?? '')} active={isActive(j)} className={SYNOPSIS_TEXT_CLS} testId={gk === 'plot' ? 'idea-v2-plot-streaming' : 'idea-v2-synopsis-streaming'} />
            )}
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 text-xs text-muted-foreground">
                {gk === 'plot' ? t('ideaV2.plotGenerating') : t('ideaV2.synopsisGenerating')} {t('ideaV2.canClose')}
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
                <BookOpen className="h-5 w-5 text-primary" /> {t('ideaV2.step2Synopsis')}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('common.model')} <span className="font-semibold text-foreground" data-testid="idea-v2-model">{FABLE_MODEL_LABEL}</span>
              </p>
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground" data-testid="idea-v2-synopsis-empty">
            {t('ideaV2.synopsisEmpty')}
          </div>
          {error && <div className="mt-4">{errorBox}</div>}
          {canceled === 'synopsis' && <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-canceled">{t('ideaV2.synopsisCanceled')}</p>}
        </div>
        {stepFooter(
          'idea-v2-synopsis-footer',
          <div className="flex flex-wrap items-center gap-2">
            {previewBtn('synopsis', true, 'idea-v2-synopsis-generate-preview')}
            <button onClick={() => generate('synopsis', true)} disabled={generating} className={btnPrimary} data-testid="idea-v2-synopsis-generate">
              <Wand2 className="h-4 w-4" /> {t('ideaV2.generate')}{costTag(V2_COSTS.synopsis)}
            </button>
          </div>,
          <button onClick={() => goStep('idea')} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground" data-testid="idea-v2-synopsis-back">
            <ArrowLeft className="h-4 w-4" /> {t('ideaV2.toIdea')}
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
                <BookOpen className="h-5 w-5 text-primary" /> {t('ideaV2.step2SynopsisReady')}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('common.model')} <span className="font-semibold text-foreground" data-testid="idea-v2-result-model">{FABLE_MODEL_LABEL}</span>
              </p>
            </div>
          </div>

          <div className={`mt-4 ${SYNOPSIS_TEXT_CLS}`} data-testid="idea-v2-result-text">
            {savedSynopsis}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{t('ideaV2.synopsisSaved')}</p>
          {inputDirty && (
            <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-result-stale">{t('ideaV2.synopsisStale')}</p>
          )}
          {locked && <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="idea-v2-locked"><Lock className="h-3.5 w-3.5" /> {t('ideaV2.lockedHint')}</p>}
          {!inputDirty && !locked && (
            <div className="mt-5 rounded-lg border border-border/70 bg-muted/30 px-4 py-3" data-testid="idea-v2-synopsis-refine">
              <label htmlFor="idea-v2-synopsis-refine-input" className="text-xs font-semibold text-foreground">{t('ideaV2.synopsisRefineLabel')}</label>
              <textarea
                id="idea-v2-synopsis-refine-input"
                value={refineText}
                onChange={(e) => onRefineChange(e.target.value)}
                placeholder={canInstruct ? t('ideaV2.synopsisRefinePlaceholder') : lockHint('prompt_instruct_edit')}
                rows={2}
                disabled={generating || !canInstruct}
                className="mt-2 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
                data-testid="idea-v2-synopsis-refine-input"
              />
              <p className="mt-1.5 text-[11px] text-muted-foreground">{t('ideaV2.refineNote', { what: t('ideaV2.refineWhat.synopsis'), preview: t('ideaV2.preview'), change: t('ideaV2.change') })}</p>
              <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                {previewBtn('synopsis', false, 'idea-v2-synopsis-refine-preview', !refineText.trim())}
                <GatedButton
                  feature="prompt_instruct_edit"
                  allowed={canInstruct}
                  onClick={() => generate('synopsis')}
                  disabled={generating || !refineText.trim()}
                  className={`${btnMain} flex-shrink-0`}
                  data-testid="idea-v2-synopsis-refine-edit"
                >
                  <Pencil className="h-3.5 w-3.5" /> {t('ideaV2.change')}{costTag(V2_COSTS.synopsis)}
                </GatedButton>
              </div>
            </div>
          )}
          {error && <div className="mt-4">{errorBox}</div>}
          {canceled === 'synopsis' && <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-canceled">{t('ideaV2.scriptCanceled')}</p>}
        </div>
        {stepFooter(
          'idea-v2-result-footer',
          locked ? null : <div className="flex flex-wrap items-center gap-2">
            {previewBtn('plot', true, 'idea-v2-result-plot-preview', inputDirty)}
            <button onClick={continueFromSynopsis} disabled={generating || inputDirty} className={btnPrimary} data-testid="idea-v2-result-continue">
              {t('common.continue')}{costTag(V2_COSTS.plot)} <ArrowRight className="h-4 w-4" />
            </button>
          </div>,
          <button onClick={() => goStep('idea')} disabled={!stepClickable.idea} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground disabled:opacity-50" data-testid="idea-v2-result-back">
            <ArrowLeft className="h-4 w-4" /> {t('ideaV2.toIdea')}
          </button>,
        )}
        {renderPromptModal()}
      </div>
    )
  }

  // ═══════════════════════ Шаг 3: сюжет сезона — до генерации ═══════════════════════
  if (currentView === 'plot' && !hasPlot) {
    return (
      <div className="space-y-6" data-testid="idea-stage-v2">
        {stepsBar}
        <div className={cardCls} style={cardStyle} data-testid="idea-v2-plot-pregen">
          <h2 className="flex items-center gap-2 font-display text-xl font-bold">
            <ListOrdered className="h-5 w-5 text-primary" /> {t('ideaV2.step3')} {t('ideaV2.seasonPlotStep').toLowerCase()}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('common.model')} <span className="font-semibold text-foreground" data-testid="idea-v2-model">{FABLE_MODEL_LABEL}</span> · {t('ideaV2.episodesShort', { n: episodes })}
          </p>
          <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground" data-testid="idea-v2-plot-empty">
            {t('ideaV2.plotEmpty')}
          </div>
          {error && <div className="mt-4">{errorBox}</div>}
          {canceled === 'plot' && <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-canceled">{t('ideaV2.plotCanceled')}</p>}
        </div>
        {stepFooter(
          'idea-v2-plot-footer',
          <div className="flex flex-wrap items-center gap-2">
            {previewBtn('plot', true, 'idea-v2-plot-generate-preview')}
            <button onClick={() => generate('plot', true)} disabled={generating || !hasSynopsis} className={btnPrimary} data-testid="idea-v2-plot-generate">
              <Wand2 className="h-4 w-4" /> {t('ideaV2.generate')}{costTag(V2_COSTS.plot)}
            </button>
          </div>,
          <button onClick={() => goStep('synopsis')} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground" data-testid="idea-v2-plot-back">
            <ArrowLeft className="h-4 w-4" /> {t('ideaV2.toSynopsis')}
          </button>,
        )}
        {renderPromptModal()}
      </div>
    )
  }

  // ═══════════════════════ Шаг 3: сюжет сезона готов ═══════════════════════
  if (currentView === 'plot' && hasPlot) {
    const episodesList = parseSeasonPlotV2(savedPlot)
    return (
      <div className="space-y-6" data-testid="idea-stage-v2">
        {stepsBar}
        <div className={cardCls} style={cardStyle} data-testid="idea-v2-plot-result">
          <h2 className="flex items-center gap-2 font-display text-xl font-bold">
            <ListOrdered className="h-5 w-5 text-primary" /> {t('ideaV2.step3')} {t('ideaV2.seasonPlotStep').toLowerCase()}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('common.model')} <span className="font-semibold text-foreground" data-testid="idea-v2-result-model">{FABLE_MODEL_LABEL}</span>
            {episodesList && <> · {t('ideaV2.plotParsedCount', { n: episodesList.length, total: episodes })}</>}
          </p>

          {episodesList ? (
            <ol className="mt-4 space-y-3" data-testid="idea-v2-plot-episodes">
              {episodesList.map((ep, i) => (
                <li key={`${ep.n}-${i}`} className="rounded-lg border border-border bg-background px-4 py-3" data-testid="idea-v2-plot-episode" data-n={ep.n}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-primary">{t('ideaV2.episode')} {ep.n}</div>
                    <Link href={`/project/${project.id}/v2/episode/${ep.n}`} className={btnGhost} data-testid="idea-v2-plot-episode-open">
                      {t('ideaV2.open')} <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">{ep.text}</p>
                </li>
              ))}
            </ol>
          ) : (
            <div className={`mt-4 ${SYNOPSIS_TEXT_CLS}`} data-testid="idea-v2-plot-raw">{savedPlot}</div>
          )}

          {inputDirty && (
            <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-plot-stale">{t('ideaV2.plotStale')}</p>
          )}
          {locked && <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="idea-v2-locked"><Lock className="h-3.5 w-3.5" /> {t('ideaV2.lockedHint')}</p>}
          {!inputDirty && !locked && (
            <div className="mt-5 rounded-lg border border-border/70 bg-muted/30 px-4 py-3" data-testid="idea-v2-plot-refine">
              <label htmlFor="idea-v2-plot-refine-input" className="text-xs font-semibold text-foreground">{t('ideaV2.plotRefineLabel')}</label>
              <textarea
                id="idea-v2-plot-refine-input"
                value={plotRefineText}
                onChange={(e) => onPlotRefineChange(e.target.value)}
                placeholder={canInstruct ? t('ideaV2.plotRefinePlaceholder') : lockHint('prompt_instruct_edit')}
                rows={2}
                disabled={generating || !canInstruct}
                className="mt-2 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
                data-testid="idea-v2-plot-refine-input"
              />
              <p className="mt-1.5 text-[11px] text-muted-foreground">{t('ideaV2.refineNote', { what: t('ideaV2.refineWhat.plot'), preview: t('ideaV2.preview'), change: t('ideaV2.change') })}</p>
              <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                {previewBtn('plot', false, 'idea-v2-plot-refine-preview', !plotRefineText.trim())}
                <GatedButton
                  feature="prompt_instruct_edit"
                  allowed={canInstruct}
                  onClick={() => generate('plot')}
                  disabled={generating || !plotRefineText.trim()}
                  className={`${btnMain} flex-shrink-0`}
                  data-testid="idea-v2-plot-refine-edit"
                >
                  <Pencil className="h-3.5 w-3.5" /> {t('ideaV2.change')}{costTag(V2_COSTS.plot)}
                </GatedButton>
              </div>
            </div>
          )}
          {error && <div className="mt-4">{errorBox}</div>}
          {canceled === 'plot' && <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-canceled">{t('ideaV2.scriptCanceled')}</p>}
        </div>
        {stepFooter(
          'idea-v2-plot-result-footer',
          // Шаг 3 — финальный шаг потока v2: перехода к следующей стадии (structure / v1) нет.
          null,
          <button onClick={() => goStep('synopsis')} disabled={!stepClickable.synopsis} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground disabled:opacity-50" data-testid="idea-v2-plot-result-back">
            <ArrowLeft className="h-4 w-4" /> {t('ideaV2.toSynopsis')}
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
            <Sparkles className="h-6 w-6 text-primary" /> {t('ideaV2.step1Title')}
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">
            {t('ideaV2.step1Intro')}
          </p>
          <div className="mt-8 grid gap-4 text-left sm:grid-cols-2">
            <button type="button" onClick={() => chooseMode('idea')} disabled={locked} className="group disabled:opacity-50 flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 text-left transition hover:border-primary/60" data-testid="idea-v2-choose-idea">
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary"><Lightbulb className="h-6 w-6" /></div>
              <div className="font-display text-lg font-semibold">{t('ideaV2.ownIdea')}</div>
              <p className="text-sm text-muted-foreground">{t('ideaV2.ownIdeaDesc')}</p>
              <span className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-primary">{t('ideaV2.describeIdea')} <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" /></span>
            </button>
            <button type="button" onClick={() => chooseMode('genres')} disabled={locked} className="group disabled:opacity-50 flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 text-left transition hover:border-primary/60" data-testid="idea-v2-choose-genres">
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary"><Tags className="h-6 w-6" /></div>
              <div className="font-display text-lg font-semibold">{t('ideaV2.fromGenres')}</div>
              <p className="text-sm text-muted-foreground">{t('ideaV2.fromGenresDesc')}</p>
              <span className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-primary">{t('ideaV2.pickGenres')} <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" /></span>
            </button>
          </div>
        </div>
      )}

      {screen === 'input' && (
        <div className={cardCls} style={cardStyle} data-testid="idea-v2-input-screen">
          <h2 className="flex items-center gap-2 font-display text-xl font-bold">
            {mode === 'idea' ? <><Lightbulb className="h-5 w-5 text-primary" /> {t('ideaV2.ownIdea')}</> : <><Tags className="h-5 w-5 text-primary" /> {t('ideaV2.fromGenres')}</>}
          </h2>

          {mode === 'idea' ? (
            <textarea
              value={idea}
              onChange={(e) => onIdeaChange(e.target.value)}
              readOnly={locked}
              placeholder={t('ideaV2.ideaPlaceholder')}
              rows={5}
              className="mt-4 w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
              data-testid="idea-v2-input"
            />
          ) : (
            <div className="mt-4">
              <p className="mb-2 text-xs font-medium text-muted-foreground">{t('ideaV2.pickGenresLabel')}</p>
              <div className="flex flex-wrap gap-2" data-testid="idea-v2-genres">
                {GENRES.map((g) => {
                  const on = genres.includes(g.id)
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => toggleGenre(g.id)}
                      disabled={locked}
                      aria-pressed={on}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${on ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-foreground hover:border-primary/60'}`}
                      data-testid={`idea-v2-genre-${g.id}`}
                    >
                      {g.label}
                    </button>
                  )
                })}
              </div>
              <p className="mb-2 mt-5 text-xs font-medium text-muted-foreground">{t('ideaV2.wishesLabel')}</p>
              <textarea
                value={wishes}
                onChange={(e) => onWishesChange(e.target.value)}
                readOnly={locked}
                placeholder={t('ideaV2.wishesPlaceholder')}
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
                disabled={locked}
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
                disabled={locked}
                onBlur={(e) => commitEpisodes(e.target.value)}
                className="w-24 rounded-lg border border-input bg-background px-3 py-1.5 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
                data-testid="idea-v2-episodes-count"
              />
              <span className="text-[11px] text-muted-foreground">{MIN_EPISODES_COUNT}–{MAX_EPISODES_COUNT}</span>
            </div>
          </div>

          <p className="mt-4 text-sm text-muted-foreground">
            {t('ideaV2.sentTo')} <span className="font-semibold text-foreground" data-testid="idea-v2-model">{FABLE_MODEL_LABEL}</span>.
            {t('ideaV2.step1Outro')}
          </p>

          {locked && <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="idea-v2-locked"><Lock className="h-3.5 w-3.5" /> {t('ideaV2.lockedHint')}</p>}
          {canceled === 'synopsis' && (
            <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-canceled">{t('ideaV2.canceledRestart')}</p>
          )}
        </div>
      )}
      {screen === 'input' && stepFooter(
        'idea-v2-input-footer',
        locked ? null : <div className="flex flex-wrap items-center gap-2">
          {previewBtn('synopsis', true, 'idea-v2-generate-preview', !canProceed || savingInput)}
          <button
            onClick={continueFromIdea}
            disabled={!canProceed || savingInput || generating}
            className={btnPrimary}
            data-testid="idea-v2-generate"
          >
            {savingInput ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />} {t('common.continue')}{costTag(V2_COSTS.synopsis)}
          </button>
        </div>,
        hasSynopsis && !inputDirty ? (
          <button onClick={() => goStep('synopsis')} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground" data-testid="idea-v2-input-to-synopsis">
            {t('ideaV2.toReadySynopsis')} <ArrowRight className="h-4 w-4" />
          </button>
        ) : null,
      )}

      {renderPromptModal()}
      {renderResetConfirmModal()}
    </div>
  )
}
