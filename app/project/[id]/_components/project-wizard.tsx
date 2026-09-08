'use client'

import { useState } from 'react'
import { Header } from '@/components/header'
import { SynopsisStage } from './synopsis-stage'
import { CharactersStage } from './characters-stage'
import { StructureStage } from './structure-stage'
import { ScenesStage } from './scenes-stage'
import { IdeaStage } from './idea-stage'
import { ReferencesStage } from './references-stage'
import { SeasonStage } from './season-stage'
import { resolvePowerTier } from '@/lib/power-tier'
import { FileText, Users, GitBranch, Video, Check, Lightbulb, Gauge } from 'lucide-react'
import { motion } from 'framer-motion'

// Legacy flow (projects created before the new flow) keeps its stage ids.
const legacyStages = [
  { id: 'synopsis', label: 'Synopsis', icon: FileText },
  { id: 'characters', label: 'Characters', icon: Users },
  { id: 'structure', label: 'Structure', icon: GitBranch },
  { id: 'scenes', label: 'Scenes & Video', icon: Video },
]

// New flow (stage 1): idea → references → script/scenes (stage 2 replaces the last two).
const newFlowStages = [
  { id: 'idea', label: 'Идея', icon: Lightbulb },
  { id: 'references', label: 'Персонажи', icon: Users },
  { id: 'structure', label: 'Сценарий', icon: GitBranch },
  { id: 'scenes', label: 'Сцены и видео', icon: Video },
]

function isNewFlow(project: any): boolean {
  if (!project) return false
  if (project.stage === 'idea' || project.stage === 'references') return true
  // A new-flow project that already moved on to structure/scenes still has charactersApproved set.
  return Boolean(project.charactersApproved)
}

export function ProjectWizard({ project: initialProject }: { project: any }) {
  const [project, setProject] = useState(initialProject)
  const stages = isNewFlow(project) ? newFlowStages : legacyStages
  const currentStage = project?.stage ?? 'synopsis'
  const stageIdx = stages.findIndex((s) => s.id === currentStage)
  const power = resolvePowerTier(project ?? {})

  const refreshProject = async () => {
    try {
      const res = await fetch(`/api/projects/${project?.id}`)
      const data = await res.json()
      if (data?.project) setProject(data.project)
    } catch {}
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-[1200px] px-4 py-6">
        <div className="mb-6">
          <h1 className="font-display text-2xl font-bold tracking-tight">
            {project?.name ?? 'Project'}
          </h1>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 uppercase"
              title={`Мощность: ${power.label} · ${power.resolution} · ${power.costPerScene} кр./сцена`}
              data-testid="power-badge"
            >
              <Gauge className="h-3 w-3" />
              {power.label}
            </span>
            <span className="hidden sm:inline">{power.resolution} · {power.costPerScene} кр./сцена</span>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="mb-8 flex items-center gap-2">
          {stages.map((s, i) => {
            const Icon = s.icon
            const done = i < stageIdx
            const active = i === stageIdx
            return (
              <div key={s.id} className="flex flex-1 items-center gap-2">
                <div
                  className={`flex h-9 w-9 items-center justify-center rounded-full border-2 transition ${
                    done
                      ? 'border-primary bg-primary text-primary-foreground'
                      : active
                      ? 'border-primary text-primary'
                      : 'border-border text-muted-foreground'
                  }`}
                >
                  {done ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                </div>
                <span
                  className={`hidden text-xs font-medium sm:block ${
                    active ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {s.label}
                </span>
                {i < stages.length - 1 && (
                  <div
                    className={`mx-2 h-0.5 flex-1 rounded ${
                      done ? 'bg-primary' : 'bg-border'
                    }`}
                  />
                )}
              </div>
            )
          })}
        </div>

        <motion.div
          key={currentStage}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.3 }}
        >
          {currentStage === 'idea' && (
            <IdeaStage project={project} onRefresh={refreshProject} />
          )}
          {currentStage === 'references' && (
            <ReferencesStage project={project} onRefresh={refreshProject} />
          )}
          {currentStage === 'synopsis' && (
            <SynopsisStage project={project} onRefresh={refreshProject} />
          )}
          {currentStage === 'characters' && (
            <CharactersStage project={project} onRefresh={refreshProject} />
          )}
          {currentStage === 'structure' && isNewFlow(project) && (
            <SeasonStage project={project} onRefresh={refreshProject} />
          )}
          {currentStage === 'structure' && !isNewFlow(project) && (
            <StructureStage project={project} onRefresh={refreshProject} />
          )}
          {currentStage === 'scenes' && (
            <ScenesStage project={project} onRefresh={refreshProject} />
          )}
        </motion.div>
      </main>
    </div>
  )
}
