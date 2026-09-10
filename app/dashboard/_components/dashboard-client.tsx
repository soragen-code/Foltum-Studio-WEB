'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Header } from '@/components/header'
import { Film, Plus, Clapperboard, Clock, ChevronRight, Sparkles, Zap, Crown } from 'lucide-react'
import { motion } from 'framer-motion'

interface Project {
  id: string
  name: string
  tier: string
  stage: string
  isTest?: boolean
  createdAt: string
  updatedAt: string
}

const tierConfig: Record<string, { icon: React.ElementType; color: string; label: string }> = {
  minimum: { icon: Zap, color: 'text-green-400', label: 'Minimum' },
  medium: { icon: Sparkles, color: 'text-yellow-400', label: 'Medium' },
  maximum: { icon: Crown, color: 'text-red-400', label: 'Maximum' },
}

const stageLabels: Record<string, string> = {
  synopsis: 'Synopsis',
  characters: 'Characters',
  structure: 'Structure',
  scenes: 'Scenes & Video',
}

export function DashboardClient() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((d: any) => setProjects(d?.projects ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="min-h-screen bg-background">
      <Header showNewProject={false} />
      <main className="mx-auto max-w-[1200px] px-4 py-8">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="font-display text-3xl font-bold tracking-tight">
              Your <span className="text-primary">Projects</span>
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Create AI-powered films and series from a single prompt
            </p>
          </div>
          <Link
            href="/project/new"
            className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110"
          >
            <Plus className="h-4 w-4" />
            New Project
          </Link>
        </div>

        {loading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i: number) => (
              <div key={i} className="h-48 animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        ) : (projects?.length ?? 0) === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-20"
          >
            <Clapperboard className="mb-4 h-16 w-16 text-muted-foreground/40" />
            <h2 className="text-lg font-semibold">No projects yet</h2>
            <p className="mb-6 mt-1 text-sm text-muted-foreground">
              Start your first AI film or series
            </p>
            <Link
              href="/project/new"
              className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110"
            >
              <Plus className="h-4 w-4" />
              Create Project
            </Link>
          </motion.div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(projects ?? []).map((project: Project, idx: number) => {
              const tier = tierConfig[project?.tier] ?? tierConfig.minimum
              const TierIcon = tier?.icon ?? Zap
              return (
                <motion.div
                  key={project?.id ?? idx}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.05 }}
                >
                  <Link
                    href={`/project/${project?.id}`}
                    className="group block rounded-xl border border-border bg-card p-5 transition hover:border-primary/30 hover:bg-card/80"
                    style={{ boxShadow: 'var(--shadow-md)' }}
                  >
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Film className="h-5 w-5 text-primary" />
                        <h3 className="font-display font-semibold tracking-tight">
                          {project?.name ?? 'Untitled'}
                        </h3>
                        {project?.isTest && (
                          <span data-testid="project-test-badge" className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-400">
                            Тест
                          </span>
                        )}
                      </div>
                      <ChevronRight className="h-4 w-4 text-muted-foreground transition group-hover:text-primary" />
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span className={`flex items-center gap-1 ${tier?.color ?? ''}`}>
                        <TierIcon className="h-3 w-3" />
                        {tier?.label ?? 'Minimum'}
                      </span>
                      <span className="rounded bg-muted px-2 py-0.5">
                        {stageLabels[project?.stage] ?? project?.stage ?? 'Synopsis'}
                      </span>
                    </div>
                    <div className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      Created {project?.createdAt ? new Date(project.createdAt).toLocaleDateString('en-US', { timeZone: 'UTC' }) : ''}
                    </div>
                  </Link>
                </motion.div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
