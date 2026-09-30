'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

/**
 * Project-level step bar: Идея → Логлайн → Синопсис → Сюжет → Серии. Rendered above every project screen
 * (wizard stages, the episode plot page and the episode pages). Passed steps are links back to a READ-ONLY
 * view of that stage (`/project/{id}?step=idea|logline|synopsis|story`); «Серии» links to the project root once
 * the project reached the episodes phase. The current step is highlighted; steps not reached yet are grey and
 * not clickable. Nothing here changes `project.stage`.
 */
export type ProjectStepKey = 'idea' | 'logline' | 'synopsis' | 'story' | 'scenes'

export const PROJECT_STEPS: { key: ProjectStepKey; label: string }[] = [
  { key: 'idea', label: 'Идея' },
  { key: 'logline', label: 'Логлайн' },
  { key: 'synopsis', label: 'Синопсис' },
  { key: 'story', label: 'Сюжет' },
  { key: 'scenes', label: 'Серии' },
]

/** Index of the project's stage on the step bar (project.stage → 0..4). Unknown / legacy stages count as «Серии». */
export function projectStageIndex(stage: string | null | undefined): number {
  switch (stage) {
    case 'idea': return 0
    case 'logline': return 1
    case 'synopsis':
    case 'synopsis_v2': return 2 // «Новый проект v2.0»: конечная стадия потока v2 (синопсис)
    case 'structure': return 3
    case 'characters':
    case 'references':
    case 'scenes': return 4
    default: return stage ? 4 : 0
  }
}

/** Which read-only ?step= views are allowed for a project at `stage` (only PASSED stages). */
export function isStepPassed(step: ProjectStepKey, stage: string | null | undefined): boolean {
  const idx = PROJECT_STEPS.findIndex((s) => s.key === step)
  return idx >= 0 && idx < projectStageIndex(stage)
}

export function ProjectSteps({ projectId, stage, current, className }: { projectId: string; stage: string | null | undefined; current: ProjectStepKey; className?: string }) {
  const stageIdx = projectStageIndex(stage)
  return (
    <div className={`flex flex-wrap items-center gap-2 text-xs ${className ?? ''}`} data-testid="project-steps">
      {PROJECT_STEPS.map((s, idx) => {
        const active = s.key === current
        const passed = idx < stageIdx
        const reached = passed || idx === stageIdx
        const cls = `rounded-full border px-3 py-1 font-medium transition ${active ? 'border-primary bg-primary text-primary-foreground' : reached ? 'border-border hover:bg-muted' : 'border-border/50 text-muted-foreground/50'}`
        const label = `${idx + 1} · ${s.label}`
        if (active) return <span key={s.key} data-testid={`project-step-${s.key}`} data-active="true" aria-current="step" className={cls}>{label}</span>
        if (!reached) return <span key={s.key} data-testid={`project-step-${s.key}`} aria-disabled="true" className={cls}>{label}</span>
        // Reached: passed stages open read-only; the current stage of the project (when we are on another screen,
        // e.g. an episode page) opens the wizard itself.
        const href = s.key === 'scenes' || !passed ? `/project/${projectId}` : `/project/${projectId}?step=${s.key}`
        return <Link key={s.key} href={href} data-testid={`project-step-${s.key}`} className={cls}>{label}</Link>
      })}
    </div>
  )
}

/**
 * Степпер потока «Новый проект v2.0». Отдельный, самостоятельный путь: Идея → Синопсис — и на этом он
 * заканчивается (v2 НЕ продолжается в пайплайн v1: логлайн/сюжет/серии здесь не показываются). Оба шага
 * не кликабельны — это чистый индикатор прогресса потока v2.
 */
export type ProjectStepV2Key = 'idea' | 'synopsis'

export const PROJECT_STEPS_V2: { key: ProjectStepV2Key; label: string }[] = [
  { key: 'idea', label: 'Идея' },
  { key: 'synopsis', label: 'Синопсис' },
]

export function ProjectStepsV2({ current, className }: { current: ProjectStepV2Key; className?: string }) {
  const currentIdx = PROJECT_STEPS_V2.findIndex((s) => s.key === current)
  return (
    <div className={`flex flex-wrap items-center gap-2 text-xs ${className ?? ''}`} data-testid="project-steps-v2">
      {PROJECT_STEPS_V2.map((s, idx) => {
        const active = s.key === current
        const reached = idx <= currentIdx
        const cls = `rounded-full border px-3 py-1 font-medium transition ${active ? 'border-primary bg-primary text-primary-foreground' : reached ? 'border-border' : 'border-border/50 text-muted-foreground/50'}`
        return (
          <span
            key={s.key}
            data-testid={`project-step-v2-${s.key}`}
            data-active={active ? 'true' : undefined}
            aria-current={active ? 'step' : undefined}
            aria-disabled={!reached ? 'true' : undefined}
            className={cls}
          >
            {`${idx + 1} · ${s.label}`}
          </span>
        )
      })}
    </div>
  )
}

/** «← Назад к текущему шагу» — shown above a read-only stage view. */
export function BackToCurrentStep({ projectId }: { projectId: string }) {
  return (
    <Link href={`/project/${projectId}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" data-testid="back-to-current-step">
      <ArrowLeft className="h-4 w-4" /> Назад к текущему шагу
    </Link>
  )
}

/**
 * Read-only card for the text stages (idea / logline / synopsis): title, the approved text and an optional
 * right-side slot (the «Промпт» button). Used by the stage components when `readOnly` is set.
 */
export function ReadOnlyStageCard({ title, text, emptyText = 'Текст ещё не создан.', aside, testId }: { title: string; text: string | null | undefined; emptyText?: string; aside?: ReactNode; testId?: string }) {
  return (
    <div className="space-y-6" data-testid={testId}>
      <div className="rounded-xl border border-border bg-card p-4 sm:p-6" style={{ boxShadow: 'var(--shadow-md)' }}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-xl font-bold">{title}</h2>
          {aside}
        </div>
        <p className="mb-3 text-xs text-muted-foreground">Просмотр утверждённого шага. Редактирование недоступно — текущая работа идёт на более позднем шаге.</p>
        {text?.trim() ? (
          <div className="whitespace-pre-wrap rounded-lg border border-border bg-background p-3 text-sm leading-relaxed">{text}</div>
        ) : (
          <p className="text-sm text-muted-foreground">{emptyText}</p>
        )}
      </div>
    </div>
  )
}
