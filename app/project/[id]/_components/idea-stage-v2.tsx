'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Wand2, Sparkles, Lightbulb, Eye, Pencil, Check, ArrowLeft, Tags, Info } from 'lucide-react'
import { GENRES } from '@/lib/idea'
import { FABLE_MODEL_LABEL } from '@/lib/idea-v2'
import { CancelButton } from './cancel-button'
import { useJobPolling, SmoothProgress, StreamingText } from './use-job-polling'

/** Примерная длительность генерации синопсиса v2 — управляет плавным прогресс-баром. */
const SYNOPSIS_V2_EXPECTED_SEC = 50

/**
 * Поток «Новый проект v2.0» (шаг 1):
 *   1. Пользователь описывает идею ИЛИ собирает набор жанров и подтверждает выбор.
 *   2. Показываем модель («Claude Fable 5.1») и даём просмотреть/отредактировать промпт,
 *      либо сгенерировать без просмотра.
 *   3. Генерируем синопсис (7–10 предложений: предыстория, основной хук ближе к концу, концовка).
 *
 * Когда задача завершается, роут переводит проект на stage="synopsis" — onRefresh() показывает
 * обычный экран синопсиса (шаг 2), и проект дальше идёт по стандартному пайплайну.
 */
export function IdeaStageV2({ project, onRefresh }: { project: any; onRefresh: () => void }) {
  const [mode, setMode] = useState<'idea' | 'genres'>('idea')
  const [idea, setIdea] = useState<string>(project?.idea && !String(project.idea).startsWith('[v2 · genres]') ? project.idea : '')
  const [genres, setGenres] = useState<string[]>([])
  const [confirmed, setConfirmed] = useState(false)

  // Просмотр / редактирование промпта.
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [editSystem, setEditSystem] = useState('')
  const [editUser, setEditUser] = useState('')
  const [contextNote, setContextNote] = useState('')

  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [canceled, setCanceled] = useState(false)
  const activeJobIdRef = useRef<string | null>(null)

  const { job, start: startPolling, clear: clearJob } = useJobPolling({
    intervalMs: 800,
    onFinish: (res) => {
      activeJobIdRef.current = null
      if (res.job.status === 'completed') {
        setError(''); setCanceled(false)
        onRefresh() // проект переведён на stage="synopsis" — мастер отрисует шаг 2
      } else if (res.job.status === 'canceled') {
        setCanceled(true)
      } else {
        setError(res.job.error ?? 'Не удалось сгенерировать синопсис')
      }
    },
  })
  const jobActive = !!job && (job.status === 'pending' || job.status === 'processing')
  const generating = starting || jobActive

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
          setConfirmed(true)
          activeJobIdRef.current = j.id
          startPolling(j.id)
        }
      } catch { /* транзиентно — кнопки всё равно позволят запустить заново */ }
    })()
    return () => { ignore = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  const toggleGenre = (id: string) =>
    setGenres((prev) => (prev.includes(id) ? prev.filter((g) => g !== id) : [...prev, id]))

  const canConfirm = mode === 'idea' ? idea.trim().length >= 10 : genres.length > 0

  const confirmStep1 = () => {
    if (!canConfirm) {
      setError(mode === 'idea' ? 'Опишите идею хотя бы одним–двумя предложениями' : 'Выберите хотя бы один жанр')
      return
    }
    setError(''); setConfirmed(true)
  }

  const openPreview = async () => {
    setError(''); setPreviewLoading(true)
    try {
      const res = await fetch('/api/ai/v2/synopsis/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, ...(mode === 'idea' ? { idea: idea.trim() } : { genres }) }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { setError(d?.error ?? 'Не удалось собрать промпт'); return }
      setEditSystem(d.system ?? '')
      setEditUser(d.user ?? '')
      setContextNote(d.contextNote ?? '')
      setPreviewOpen(true)
    } catch { setError('Ошибка сети') }
    finally { setPreviewLoading(false) }
  }

  const generate = async (withOverride: boolean) => {
    setError(''); setCanceled(false); clearJob(); setStarting(true)
    try {
      const body: any = { projectId: project.id, ...(mode === 'idea' ? { idea: idea.trim() } : { genres }) }
      if (withOverride) { body.overrideSystem = editSystem; body.overrideUser = editUser }
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

  const cancel = async () => {
    const id = activeJobIdRef.current
    if (!id) return
    try { await fetch(`/api/ai/jobs/${id}/cancel`, { method: 'POST' }) } catch { /* поллинг повторит */ }
  }

  return (
    <div className="space-y-6" data-testid="idea-stage-v2">
      {/* Шаг 1 — идея или жанры */}
      <div className="rounded-xl border border-border bg-card p-4 sm:p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 font-display text-xl font-bold">
            <Sparkles className="h-5 w-5 text-primary" /> Новый проект v2.0 — Шаг 1: идея
          </h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Опишите свою идею словами или соберите набор жанров — и ИИ придумает историю. Дальше вы сможете просмотреть
          и при желании отредактировать промпт перед генерацией синопсиса.
        </p>

        <div className="mt-4 flex flex-wrap gap-1 rounded-lg border border-border bg-muted/40 p-1" role="tablist" data-testid="idea-v2-mode-toggle">
          <button
            type="button"
            onClick={() => { setMode('idea'); setConfirmed(false) }}
            disabled={generating}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition sm:text-sm ${mode === 'idea' ? 'bg-background text-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}
            data-testid="idea-v2-mode-idea"
          >
            <Lightbulb className="h-4 w-4" /> Описать идею
          </button>
          <button
            type="button"
            onClick={() => { setMode('genres'); setConfirmed(false) }}
            disabled={generating}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition sm:text-sm ${mode === 'genres' ? 'bg-background text-foreground shadow' : 'text-muted-foreground hover:text-foreground'}`}
            data-testid="idea-v2-mode-genres"
          >
            <Tags className="h-4 w-4" /> Собрать по жанрам
          </button>
        </div>

        {error && <div className="mt-4 rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive" data-testid="idea-v2-error">{error}</div>}

        {mode === 'idea' ? (
          <textarea
            value={idea}
            onChange={(e) => { setIdea(e.target.value); setConfirmed(false) }}
            placeholder="Например: молодая смотрительница маяка на северном острове находит дневник своей пропавшей предшественницы…"
            rows={5}
            disabled={generating || confirmed}
            className="mt-4 w-full resize-none rounded-lg border border-input bg-background px-4 py-3 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-60"
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
                    onClick={() => { toggleGenre(g.id); setConfirmed(false) }}
                    disabled={generating || confirmed}
                    aria-pressed={on}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition disabled:opacity-60 ${on ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-foreground hover:border-primary/60'}`}
                    data-testid={`idea-v2-genre-${g.id}`}
                  >
                    {g.label}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {!confirmed ? (
          <button
            onClick={confirmStep1}
            disabled={generating || !canConfirm}
            className="mt-4 flex items-center justify-center gap-2 rounded-lg bg-secondary px-5 py-2.5 text-sm font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50"
            data-testid="idea-v2-confirm"
          >
            <Check className="h-4 w-4" />
            {mode === 'idea' ? 'Сохранить идею' : 'Подтвердить жанры'}
          </button>
        ) : (
          <button
            onClick={() => setConfirmed(false)}
            disabled={generating}
            className="mt-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground disabled:opacity-50"
            data-testid="idea-v2-edit"
          >
            <ArrowLeft className="h-4 w-4" /> Изменить {mode === 'idea' ? 'идею' : 'жанры'}
          </button>
        )}
      </div>

      {/* Шаг 2 — промпт и генерация */}
      {confirmed && (
        <div className="rounded-xl border border-border bg-card p-4 sm:p-6" style={{ boxShadow: 'var(--shadow-md)' }} data-testid="idea-v2-step2">
          <h3 className="flex items-center gap-2 font-display text-lg font-semibold">
            <Wand2 className="h-5 w-5 text-primary" /> Шаг 2: генерация синопсиса
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Отправляется в: <span className="font-semibold text-foreground" data-testid="idea-v2-model">{FABLE_MODEL_LABEL}</span>.
            Будет сгенерирован синопсис на 7–10 предложений: предыстория, основной хук (главный клиффхэнгер ближе к концу сезона) и концовка.
          </p>

          {!generating && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                onClick={openPreview}
                disabled={previewLoading}
                className="flex items-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-semibold transition hover:bg-muted disabled:opacity-50"
                data-testid="idea-v2-preview-open"
              >
                {previewLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                Просмотреть / редактировать промпт
              </button>
              <button
                onClick={() => generate(false)}
                disabled={previewLoading}
                className="flex items-center gap-2 rounded-lg bg-secondary px-5 py-2.5 text-sm font-semibold text-secondary-foreground transition hover:brightness-110 disabled:opacity-50"
                data-testid="idea-v2-generate"
              >
                <Wand2 className="h-4 w-4" /> Сгенерировать без просмотра
              </button>
            </div>
          )}

          {previewOpen && !generating && (
            <div className="mt-5 space-y-4" data-testid="idea-v2-preview">
              {contextNote && (
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="idea-v2-context-note">
                  <Info className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> {contextNote}
                </p>
              )}
              <div>
                <label className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Pencil className="h-3.5 w-3.5" /> System (правила)
                </label>
                <textarea
                  value={editSystem}
                  onChange={(e) => setEditSystem(e.target.value)}
                  rows={12}
                  className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-primary"
                  data-testid="idea-v2-preview-system"
                />
              </div>
              <div>
                <label className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <Pencil className="h-3.5 w-3.5" /> User (запрос)
                </label>
                <textarea
                  value={editUser}
                  onChange={(e) => setEditUser(e.target.value)}
                  rows={8}
                  className="w-full resize-y rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-primary"
                  data-testid="idea-v2-preview-user"
                />
              </div>
              <button
                onClick={() => generate(true)}
                className="flex items-center gap-2 rounded-lg bg-secondary px-5 py-2.5 text-sm font-semibold text-secondary-foreground transition hover:brightness-110"
                data-testid="idea-v2-generate-edited"
              >
                <Wand2 className="h-4 w-4" /> Сгенерировать с этим промптом
              </button>
            </div>
          )}

          {generating && (
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
          )}

          {canceled && !generating && (
            <p className="mt-3 text-xs text-amber-500" data-testid="idea-v2-canceled">Генерация отменена. Нажмите кнопку выше, чтобы запустить снова.</p>
          )}
        </div>
      )}
    </div>
  )
}
