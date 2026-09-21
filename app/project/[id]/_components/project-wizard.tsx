'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Header } from '@/components/header'
import { SynopsisStage } from './synopsis-stage'
import { CharactersStage } from './characters-stage'
import { StructureStage } from './structure-stage'
import { ScenesStage } from './scenes-stage'
import { IdeaStage } from './idea-stage'
import { LoglineStage } from './logline-stage'
import { ReferencesStage } from './references-stage'
import { StoryStage } from './story-stage'
import { SCENE_RESOLUTION } from '@/lib/power-tier'
import { Gauge, ArrowLeft } from 'lucide-react'
import { motion } from 'framer-motion'

function isNewFlow(project: any): boolean {
  if (!project) return false
  // Stage 59: durable marker set on creation — the only reliable signal at stage=synopsis/early-structure
  // (where charactersApproved is still false in the new 4-step flow).
  if (project.newFlow) return true
  if (project.stage === 'idea' || project.stage === 'references') return true
  // A legacy new-flow project that already moved on to structure/scenes still has charactersApproved set.
  return Boolean(project.charactersApproved)
}

export function ProjectWizard({ project: initialProject, entitlements }: { project: any; entitlements?: import('@/lib/entitlements').Entitlements }) {
  const [project, setProject] = useState(initialProject)
  const currentStage = project?.stage ?? 'synopsis'
  // Optional «"References" tab (stage 5), opened via ?tab=references from the season/episode screens.
  const searchParams = useSearchParams()
  const referencesTab = searchParams?.get('tab') === 'references' && isNewFlow(project) && currentStage !== 'idea'

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

        <motion.div
          key={referencesTab ? 'references-tab' : currentStage}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.3 }}
        >
          {referencesTab && (
            <div className="space-y-4" data-testid="references-tab">
              <Link href={`/project/${project.id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" data-testid="back-to-season">
                <ArrowLeft className="h-4 w-4" /> To season script
              </Link>
              <ReferencesStage project={project} onRefresh={refreshProject} optional />
            </div>
          )}
          {!referencesTab && currentStage === 'idea' && (
            <IdeaStage project={project} onRefresh={refreshProject} />
          )}
          {!referencesTab && currentStage === 'logline' && (
            <LoglineStage project={project} onRefresh={refreshProject} />
          )}
          {!referencesTab && currentStage === 'references' && (
            <ReferencesStage project={project} onRefresh={refreshProject} />
          )}
          {/* Legacy flow: synopsis is its own screen (synopsis → characters). */}
          {!referencesTab && currentStage === 'synopsis' && !isNewFlow(project) && (
            <SynopsisStage project={project} onRefresh={refreshProject} />
          )}
          {/* ПРАВКА 2 — новый флоу: синопсис и сюжет на ОДНОЙ странице. Синопсис сверху; после его
             аппрува ниже раскрывается сюжет по сериям. Покрывает и стадию 'synopsis', и 'structure',
             поэтому после аппрува навигация не нужна — сюжет появляется на той же странице. */}
          {!referencesTab && (currentStage === 'synopsis' || currentStage === 'structure') && isNewFlow(project) && (
            <div className="space-y-6" data-testid="synopsis-story-combined">
              <SynopsisStage project={project} onRefresh={refreshProject} />
              {project.synopsisApproved && <StoryStage project={project} onRefresh={refreshProject} />}
            </div>
          )}
          {!referencesTab && currentStage === 'characters' && (
            <CharactersStage project={project} onRefresh={refreshProject} entitlements={entitlements} />
          )}
          {!referencesTab && currentStage === 'structure' && !isNewFlow(project) && (
            <StructureStage project={project} onRefresh={refreshProject} />
          )}
          {!referencesTab && currentStage === 'scenes' && (
            <ScenesStage project={project} onRefresh={refreshProject} />
          )}
        </motion.div>
      </main>
    </div>
  )
}
