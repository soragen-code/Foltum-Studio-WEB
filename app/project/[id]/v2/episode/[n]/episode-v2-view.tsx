'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Loader2, Eye, Pencil, ArrowLeft, Wand2, FileText, Images, Clapperboard, LayoutGrid, Film } from 'lucide-react'
import { Header } from '@/components/header'
import { FABLE_MODEL_LABEL, type EpisodeRefV2, type EpisodeShotV2, type EpisodeStoryboardV2, type EpisodeSceneV2 } from '@/lib/idea-v2'
import { useTranslation } from '@/lib/i18n/context'
import { CancelButton } from '../../../_components/cancel-button'
import { useJobPolling, SmoothProgress } from '../../../_components/use-job-polling'
import { PromptModal, type PromptMsg } from '../../../_components/v2-prompt-modal'
import { EpisodeRefsTab } from './refs-tab'
import { ShotlistTab } from './shotlist-tab'
import { StoryboardTab } from './storyboard-tab'
import { ScenesTab } from './scenes-tab'

/**
 * Поток v2 · страница эпизода. Вкладки расширяемы (TABS): «Сценарий», «Референсы» (refs-tab.tsx).
 * Сценарий: «Сгенерировать» / «Превью» → единая модалка промпта (kind=script, изолировано per-episode);
 * есть сценарий → текст + поле правки + «Изменить» (диалог scriptBase/scriptTurns в localStorage per-episode).
 */
type Msg = PromptMsg
type TabKey = 'script' | 'refs' | 'shots' | 'storyboard' | 'scenes'
const SCRIPT_EXPECTED_SEC = 60
const API = { generate: '/api/ai/v2/script', preview: '/api/ai/v2/script/preview' }

const systemOf = (m: Msg[]) => (m[0]?.role === 'system' ? m[0].content : '')
const withSystem = (m: Msg[], text: string): Msg[] => (m[0]?.role === 'system' ? [{ role: 'system', content: text }, ...m.slice(1)] : m)
const nonSystem = (m: Msg[]) => m.filter((x) => x.role !== 'system')
const historyText = (m: Msg[]) => m.map((x) => `${x.role.toUpperCase()}:\n${x.content}`).join('\n\n')
const normFp = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ')
const isMsgList = (l: unknown): l is Msg[] => Array.isArray(l) && l.every((m: any) => m && (m.role === 'system' || m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')

/** Черновик промпта сценария серии (как PromptDraft в idea-stage-v2): ключ per-episode, не пересекается с synopsis/plot. */
type PromptDraft = { sysOrig?: string; sysEdit?: string; fp?: string; list?: Msg[]; note?: string; refineEn?: string }
const draftKey = (pid: string, n: number) => `foltum:v2:prompt-draft:${pid}:script:${n}`
const loadDraft = (pid: string, n: number): PromptDraft | null => {
  try {
    const raw = window.localStorage.getItem(draftKey(pid, n))
    const d = raw ? JSON.parse(raw) : null
    if (!d || typeof d !== 'object') return null
    if (d.list !== undefined && !isMsgList(d.list)) delete d.list
    return d
  } catch { return null }
}
const storeDraft = (pid: string, n: number, d: PromptDraft) => {
  try { window.localStorage.setItem(draftKey(pid, n), JSON.stringify(d)) } catch { /* localStorage недоступен */ }
}

/** Диалог правок сценария (S0 + пары «правка → сценарий»), per-episode. */
type ScriptTurn = { refine: string; script: string }
type ScriptDialog = { base: string; turns: ScriptTurn[] }
const dialogKey = (pid: string, n: number) => `foltum:v2:script-dialog:${pid}:${n}`
const loadDialog = (pid: string, n: number): ScriptDialog | null => {
  try {
    const raw = window.localStorage.getItem(dialogKey(pid, n))
    const d = raw ? JSON.parse(raw) : null
    return d && typeof d.base === 'string' && Array.isArray(d.turns) ? d : null
  } catch { return null }
}
const storeDialog = (pid: string, n: number, base: string, turns: ScriptTurn[]) => {
  try {
    if (!base) window.localStorage.removeItem(dialogKey(pid, n))
    else window.localStorage.setItem(dialogKey(pid, n), JSON.stringify({ base, turns } satisfies ScriptDialog))
  } catch { /* localStorage недоступен */ }
}

export function EpisodeV2View({ projectId, projectTitle, n, summary, initialScript, initialRefs = [], initialShots = [], initialStoryboard = null, initialScenes = [], backHref, ownFace = false }: {
  projectId: string; projectTitle: string; n: number; summary: string; initialScript: string; initialRefs?: EpisodeRefV2[]; initialShots?: EpisodeShotV2[]; initialStoryboard?: EpisodeStoryboardV2 | null; initialScenes?: EpisodeSceneV2[]; backHref: string; ownFace?: boolean
}) {
  const { t, locale } = useTranslation()
  const TABS: { key: TabKey; label: string; icon: typeof FileText }[] = [
    { key: 'refs', label: t('ideaV2.refsTab'), icon: Images },
    { key: 'script', label: t('ideaV2.scriptTab'), icon: FileText },
    { key: 'shots', label: t('ideaV2.shotsTab'), icon: Clapperboard },
    { key: 'storyboard', label: t('ideaV2.storyboardTab'), icon: LayoutGrid },
    { key: 'scenes', label: t('ideaV2.scenesTab'), icon: Film },
  ]
  const [tab, setTab] = useState<TabKey>('script')

  const [script, setScript] = useState(initialScript.trim())
  const [refineText, setRefineText] = useState('')
  const [refineEn, setRefineEn] = useState('')
  const [scriptBase, setScriptBase] = useState('')
  const [scriptTurns, setScriptTurns] = useState<ScriptTurn[]>([])
  const lastRefineRef = useRef('')
  useEffect(() => {
    const d = loadDialog(projectId, n)
    if (!d || !script) return
    const lastKnown = d.turns.length ? d.turns[d.turns.length - 1].script : d.base
    if (lastKnown.trim() === script) { setScriptBase(d.base); setScriptTurns(d.turns) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, n])
  useEffect(() => { storeDialog(projectId, n, scriptBase, scriptTurns) }, [projectId, n, scriptBase, scriptTurns])

  // ─── Модалка промпта (kind=script)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [ready, setReady] = useState(false)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [sysEdit, setSysEdit] = useState('')
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [msgsRuOn, setMsgsRuOn] = useState(false)
  const [msgsRu, setMsgsRu] = useState<string[] | null>(null)
  const [msgsRuLoading, setMsgsRuLoading] = useState(false)
  const fpRef = useRef('')
  const isSysEdited = ready && sysEdit !== systemOf(msgs)
  const sendMessages = () => withSystem(msgs, sysEdit)

  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [canceled, setCanceled] = useState(false)
  const activeJobIdRef = useRef<string | null>(null)

  const finish = (res: any) => {
    activeJobIdRef.current = null
    if (res.job.status === 'completed') {
      setError(''); setCanceled(false); setPreviewOpen(false)
      // История изменилась → кэш собранного промпта устарел (правка system сохраняется).
      { const prev = loadDraft(projectId, n); if (prev) storeDraft(projectId, n, { ...prev, fp: undefined, list: undefined, note: undefined }) }
      setReady(false)
      const fresh = String(res.job.result?.script ?? res.job.streamedText ?? '').trim()
      if (lastRefineRef.current) {
        const applied = lastRefineRef.current; lastRefineRef.current = ''
        if (fresh) setScriptTurns((tt) => [...tt, { refine: applied, script: fresh }])
      } else { setScriptBase(fresh); setScriptTurns([]) }
      setRefineText(''); setRefineEn('')
      if (fresh) setScript(fresh)
    } else if (res.job.status === 'canceled') {
      setCanceled(true)
    } else {
      setError(res.job.error ?? 'Не удалось сгенерировать сценарий')
    }
  }
  const job = useJobPolling({ intervalMs: 800, onFinish: finish })
  const isActive = (j: any) => !!j && (j.status === 'pending' || j.status === 'processing')
  const generating = starting || isActive(job.job)

  // Возобновление уже идущей задачи этой серии.
  useEffect(() => {
    let ignore = false
    ;(async () => {
      try {
        const res = await fetch(`${API.generate}?projectId=${projectId}&episode=${n}`, { cache: 'no-store' })
        if (!res.ok) return
        const j = (await res.json().catch(() => null))?.job
        if (!ignore && j && isActive(j)) { activeJobIdRef.current = j.id; job.start(j.id) }
      } catch { /* транзиентно */ }
    })()
    return () => { ignore = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, n])

  const hasRefine = (noRefine: boolean) => !noRefine && !!refineText.trim() && !!script
  // Отпечаток: краткий сюжет серии + N + язык (+ правка с текущим сценарием, S0 и ходами).
  const fingerprint = (noRefine = false) => JSON.stringify({
    k: 'script', n, summary: normFp(summary), lang: locale,
    refine: hasRefine(noRefine) ? { refine: normFp(refineText), script: normFp(script), base: normFp(scriptBase), turns: scriptTurns.map((x) => [normFp(x.refine), normFp(x.script)]) } : null,
  })
  const refineArgs = (noRefine = false) => hasRefine(noRefine)
    ? { refine: refineText.trim(), ...(refineEn ? { refineEn } : {}), ...(scriptBase ? { scriptBase, scriptTurns } : {}) }
    : {}

  const buildPrompt = async (noRefine = false): Promise<{ list: Msg[]; sysEdit: string; refineEn: string } | null> => {
    const fp = fingerprint(noRefine)
    const cached = loadDraft(projectId, n)
    if (cached && cached.fp === fp && cached.list && nonSystem(cached.list).length) {
      const list = cached.list
      const sysE = cached.sysEdit?.trim() ? cached.sysEdit : systemOf(list)
      fpRef.current = fp
      setMsgs(list); setSysEdit(sysE); setNote(cached.note ?? ''); setRefineEn(cached.refineEn ?? '')
      setMsgsRu(null); setMsgsRuOn(false); setReady(true)
      return { list, sysEdit: sysE, refineEn: cached.refineEn ?? '' }
    }
    try {
      const res = await fetch(API.preview, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, episode: n, ...refineArgs(noRefine) }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? 'Не удалось собрать промпт'); return null }
      const refineEnNow = typeof d.refineEn === 'string' ? d.refineEn : ''
      setRefineEn(refineEnNow)
      let list: Msg[] = isMsgList(d.messages) ? d.messages.map((m: Msg) => ({ role: m.role, content: m.content })) : []
      if (!nonSystem(list).length) list = [{ role: 'user', content: String(d.user ?? '').trim() }]
      if (list[0]?.role !== 'system') {
        const sys = String(d.system ?? '').trim()
        list = sys ? [{ role: 'system', content: sys }, ...nonSystem(list)] : nonSystem(list)
      }
      const draft = loadDraft(projectId, n)
      const sysO = systemOf(list)
      const sysE = draft && typeof draft.sysEdit === 'string' && draft.sysEdit.trim() && (draft.sysOrig ?? '') === sysO ? draft.sysEdit : sysO
      const hist = nonSystem(list).length
      const dialogNote = hist > 1
        ? ` Запрос уйдёт диалогом: system (правила) + ${hist} сообщений истории (свёрнута ниже, новые сверху): модель видит свои прежние ответы и все ранние правки. Редактировать можно только system.`
        : ' Запрос уйдёт как system (правила) + user (краткий сюжет серии). Редактировать можно только system.'
      const noteText = `${d.contextNote ?? ''}${dialogNote}`
      setMsgs(list); setSysEdit(sysE); setNote(noteText)
      setMsgsRu(null); setMsgsRuOn(false); setReady(true)
      fpRef.current = fp
      storeDraft(projectId, n, { sysOrig: sysO, sysEdit: sysE, fp, list, note: noteText, refineEn: refineEnNow })
      return { list, sysEdit: sysE, refineEn: refineEnNow }
    } catch { setError('Ошибка сети'); return null }
  }

  // «Превью»: собирает промпт (из кэша, если вводные не менялись) и показывает модалку. Генерацию не запускает.
  const openPreview = async (noRefine = false) => {
    setError('')
    setMsgsRuOn(false); setCopied(false); setSaved(false); setHistoryOpen(false)
    if (ready && fpRef.current === fingerprint(noRefine)) { setPreviewOpen(true); return }
    setPreviewLoading(true)
    const ok = await buildPrompt(noRefine)
    setPreviewLoading(false)
    if (ok) setPreviewOpen(true)
  }

  const generate = async (noRefine = false) => {
    setError(''); setCanceled(false); job.clear(); setStarting(true); setPreviewOpen(false)
    try {
      // Уходит последний сохранённый промпт («Сохранить» в превью), если он собран под текущие вводные.
      const fpNow = fingerprint(noRefine)
      let override: Msg[] | null = ready && fpRef.current === fpNow && isSysEdited ? sendMessages() : null
      let refineEnNow = ready && fpRef.current === fpNow ? refineEn : ''
      if (!override && !(ready && fpRef.current === fpNow) && loadDraft(projectId, n)) {
        const b = await buildPrompt(noRefine)
        if (b) {
          if (b.sysEdit !== systemOf(b.list)) override = withSystem(b.list, b.sysEdit)
          if (b.refineEn) refineEnNow = b.refineEn
        }
      }
      if (hasRefine(noRefine)) lastRefineRef.current = refineEnNow.trim() || refineText.trim()
      else { lastRefineRef.current = ''; if (noRefine) setRefineText('') }
      const body: any = { projectId, episode: n, ...refineArgs(noRefine), ...(refineEnNow ? { refineEn: refineEnNow } : {}) }
      if (override) body.overrideMessages = override
      const res = await fetch(API.generate, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? 'Не удалось сгенерировать сценарий'); return }
      if (d?.jobId) { activeJobIdRef.current = d.jobId; job.start(d.jobId) }
    } catch { setError('Ошибка сети') }
    finally { setStarting(false) }
  }

  const cancel = async () => {
    const id = activeJobIdRef.current
    if (!id) return
    try { await fetch(`/api/ai/jobs/${id}/cancel`, { method: 'POST' }) } catch { /* поллинг повторит */ }
  }
  const copyHistory = async () => {
    try { await navigator.clipboard.writeText(historyText(sendMessages())); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* буфер недоступен */ }
  }
  const toggleMsgsRu = async () => {
    const next = !msgsRuOn
    setMsgsRuOn(next)
    if (!next || msgsRu) return
    setMsgsRuLoading(true)
    try {
      const out = await Promise.all(sendMessages().map(async (m) => {
        try {
          const res = await fetch('/api/ai/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: m.content }) })
          const d = await res.json().catch(() => ({}))
          return res.ok && typeof d?.text === 'string' && d.text.trim() ? d.text : m.content
        } catch { return m.content }
      }))
      setMsgsRu(out)
    } finally { setMsgsRuLoading(false) }
  }
  const saveDraft = () => {
    storeDraft(projectId, n, { sysOrig: systemOf(msgs), sysEdit, fp: fpRef.current || undefined, list: msgs, note, refineEn })
    setSaved(true); setTimeout(() => setSaved(false), 1500)
  }

  const cardCls = 'rounded-xl border border-border bg-card p-4 sm:p-6'
  const cardStyle = { boxShadow: 'var(--shadow-md)' }
  const btnMain = 'flex items-center gap-1.5 rounded-lg bg-secondary px-3 py-1.5 text-xs font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50'
  const btnPrimary = 'flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50'
  // Прозрачная (outline) кнопка для второстепенного действия «Превью».
  const btnGhost = 'inline-flex items-center gap-1.5 rounded-lg border border-border bg-transparent px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-muted/60 hover:border-foreground/30 disabled:opacity-50'
  const previewBtn = (noRefine: boolean, testId: string, disabled = false) => (
    <button onClick={() => openPreview(noRefine)} disabled={disabled || previewLoading || generating} className={btnGhost} data-testid={testId} title="Посмотреть/отредактировать промпт перед отправкой">
      {previewLoading ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Собираем промпт...</> : <><Eye className="h-3.5 w-3.5" /> {t('ideaV2.preview')}</>}
    </button>
  )
  const errorBox = error && (
    <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="episode-v2-error">{error}</div>
  )

  const renderScriptTab = () => {
    if (generating) {
      const j = job.job
      return (
        <div data-testid="episode-v2-script-generating">
          <p className="text-sm text-muted-foreground">
            Отправляется в: <span className="font-semibold text-foreground">{FABLE_MODEL_LABEL}</span>.
          </p>
          <div className="mt-4 space-y-2">
            {j ? <SmoothProgress job={j} expectedTotalSec={SCRIPT_EXPECTED_SEC} /> : (
              <p className="inline-flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin text-primary" /> Запуск генерации...</p>
            )}
            {String(j?.streamedText ?? '').trim() && (
              <pre className="max-h-[480px] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-background px-4 py-3 font-mono text-xs leading-relaxed text-foreground" data-testid="episode-v2-script-streaming">{String(j?.streamedText ?? '')}</pre>
            )}
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 text-xs text-muted-foreground">{t('ideaV2.scriptGenerating')} Вкладку можно закрыть — прогресс и текст сохранятся.</p>
              <CancelButton onCancel={cancel} testId="episode-v2-cancel" className="flex-shrink-0" />
            </div>
          </div>
        </div>
      )
    }
    if (!script) {
      return (
        <div data-testid="episode-v2-script-empty">
          <p className="text-sm text-muted-foreground">{t('ideaV2.scriptEmpty')}</p>
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            {previewBtn(true, 'episode-v2-script-preview')}
            <button onClick={() => generate(true)} disabled={generating} className={btnPrimary} data-testid="episode-v2-script-generate">
              <Wand2 className="h-4 w-4" /> {t('ideaV2.generate')}
            </button>
          </div>
          {canceled && <p className="mt-3 text-xs text-amber-500">{t('ideaV2.scriptCanceled')}</p>}
        </div>
      )
    }
    return (
      <div data-testid="episode-v2-script-result">
        <p className="text-sm text-muted-foreground">Модель: <span className="font-semibold text-foreground">{FABLE_MODEL_LABEL}</span></p>
        <pre className="mt-3 whitespace-pre-wrap break-words rounded-lg border border-border bg-background px-4 py-3 font-mono text-[13px] leading-relaxed text-foreground" data-testid="episode-v2-script-text">{script}</pre>
        <div className="mt-5 rounded-lg border border-border/70 bg-muted/30 px-4 py-3" data-testid="episode-v2-script-refine">
          <label htmlFor="episode-v2-script-refine-input" className="text-xs font-semibold text-foreground">{t('ideaV2.scriptRefineLabel')}</label>
          <textarea
            id="episode-v2-script-refine-input"
            value={refineText}
            onChange={(e) => { setRefineText(e.target.value); setRefineEn(''); setReady(false) }}
            placeholder={t('ideaV2.scriptRefinePlaceholder')}
            rows={2}
            className="mt-2 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
            data-testid="episode-v2-script-refine-input"
          />
          <p className="mt-1.5 text-[11px] text-muted-foreground">Правка уйдёт диалогом: модель видит прежний сценарий и все ранние правки. «{t('ideaV2.preview')}» — посмотреть/сохранить промпт, «{t('ideaV2.change')}» — отправить.</p>
          <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
            {previewBtn(false, 'episode-v2-script-refine-preview', !refineText.trim())}
            <button onClick={() => generate()} disabled={generating || !refineText.trim()} className={btnMain} data-testid="episode-v2-script-refine-edit">
              <Pencil className="h-3.5 w-3.5" /> {t('ideaV2.change')}
            </button>
          </div>
        </div>
        {canceled && <p className="mt-3 text-xs text-amber-500">{t('ideaV2.scriptCanceled')}</p>}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <Header projectName={projectTitle} projectId={projectId} />
      <main className="mx-auto max-w-[1200px] space-y-6 px-4 py-6" data-testid="episode-v2-page" data-n={n}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link href={backHref} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground" data-testid="episode-v2-back">
            <ArrowLeft className="h-4 w-4" /> {t('ideaV2.back')}
          </Link>
        </div>
        <div className={cardCls} style={cardStyle}>
          <h1 className="font-display text-2xl font-bold tracking-tight" data-testid="episode-v2-title">{t('ideaV2.episodeTitle', { n })}</h1>
          <div className="mt-5 flex gap-1 overflow-x-auto border-b border-border [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist" data-testid="episode-v2-tabs">
            {TABS.map((x) => (
              <button
                key={x.key}
                role="tab"
                aria-selected={tab === x.key}
                onClick={() => setTab(x.key)}
                className={`-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-semibold transition ${tab === x.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
                data-testid={`episode-v2-tab-${x.key}`}
              >
                <x.icon className="h-4 w-4" /> {x.label}
              </button>
            ))}
          </div>
          <div className="mt-4" role="tabpanel">
            {tab === 'script' && renderScriptTab()}
            {tab === 'refs' && <EpisodeRefsTab projectId={projectId} n={n} hasScript={!!script && !generating} initialRefs={initialRefs} ownFace={ownFace} />}
            {tab === 'shots' && <ShotlistTab projectId={projectId} n={n} hasScript={!!script && !generating} scriptText={script} initialShots={initialShots} />}
            {tab === 'storyboard' && <StoryboardTab projectId={projectId} n={n} hasShots={initialShots.length > 0} initialStoryboard={initialStoryboard} onOpenScenes={() => setTab('scenes')} />}
            {tab === 'scenes' && <ScenesTab projectId={projectId} n={n} initialScenes={initialScenes} initialApproved={!!initialStoryboard?.approved} />}
          </div>
          {error && tab === 'script' && <div className="mt-4">{errorBox}</div>}
        </div>
      </main>
      {previewOpen && !generating && (
        <PromptModal
          kind="script"
          title="Промпт сценария серии"
          firstAnswerTag="S0"
          messages={msgs}
          sysEdit={sysEdit}
          sysEdited={isSysEdited}
          note={note}
          onSysChange={(v) => { setSysEdit(v); setMsgsRu(null) }}
          onResetSys={() => { setSysEdit(systemOf(msgs)); setMsgsRu(null) }}
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
        />
      )}
    </div>
  )
}
