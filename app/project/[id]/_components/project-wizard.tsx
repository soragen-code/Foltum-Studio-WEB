'use client'

import { useState } from 'react'
import { Header } from '@/components/header'
import { IdeaStageV2 } from './idea-stage-v2'
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
