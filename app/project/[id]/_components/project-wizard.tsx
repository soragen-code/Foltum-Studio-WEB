'use client'

import { useState } from 'react'
import { Header } from '@/components/header'
import { IdeaStageV2 } from './idea-stage-v2'
import { SCENE_RESOLUTION } from '@/lib/power-tier'
import { Gauge } from 'lucide-react'
import { motion } from 'framer-motion'

/**
 * Мастер проекта. Единственный поток приложения — экран v2:
 * Идея → Синопсис → Сюжет сезона → серии (/project/[id]/v2/episode/[n]).
 * Старый пятишаговый пайплайн (v1) удалён; любой проект, независимо от его stage, открывается здесь.
 */
export function ProjectWizard({ project: initialProject }: { project: any; entitlements?: import('@/lib/entitlements').Entitlements }) {
  const [project, setProject] = useState(initialProject)

  const refreshProject = async () => {
    try {
      const res = await fetch(`/api/projects/${project?.id}`)
      const data = await res.json()
      if (data?.project) setProject(data.project)
    } catch {}
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Stage 76: project name in the sticky header on every project screen. */}
      <Header projectName={project?.name} projectId={project?.id} />
      <main className="mx-auto max-w-[1200px] px-4 py-6">
        <div className="mb-6">
          <h1 className="font-display text-2xl font-bold tracking-tight">
            {project?.name ?? 'Project'}
          </h1>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            {/* Stage 46B: scenes are always 480p; the production quality is chosen when the episode is assembled. */}
            <span
              className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 uppercase"
              title={`Scenes are rendered in ${SCENE_RESOLUTION}; episode quality is selected during assembly`}
              data-testid="power-badge"
            >
              <Gauge className="h-3 w-3" />
              {SCENE_RESOLUTION}
            </span>
            <span className="hidden sm:inline">scenes {SCENE_RESOLUTION} · episode quality — during assembly</span>
          </div>
        </div>

        {/* Один key на весь поток: смена stage не ремонтирует IdeaStageV2 и не сбрасывает его локальный экран. */}
        <motion.div
          key="v2-flow"
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.3 }}
        >
          <IdeaStageV2 project={project} onRefresh={refreshProject} />
        </motion.div>
      </main>
    </div>
  )
}
