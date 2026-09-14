'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Header } from '@/components/header'
import { Film, Plus, Clapperboard, Clock, ChevronRight, Sparkles, Zap, Crown, Trash2, Loader2 } from 'lucide-react'
import { motion } from 'framer-motion'

interface Project {
  id: string
  name: string
  tier: string
  stage: string
  isTest?: boolean
  coverUrl?: string | null // Stage 76: first episode's location image (first season) or null
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
  // Stage 46A — delete a project from the list: two-step confirm inside the card, then DELETE /api/projects/[id].
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const deleteProject = async (id: string) => {
    setDeletingId(id); setDeleteError(null)
    try {
      const res = await fetch(`/api/projects/${id}`, { method: 'DELETE' })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d?.error || "Couldn't delete the project")
      setProjects((list) => list.filter((p) => p.id !== id))
      setConfirmId(null)
    } catch (e: any) {
      setDeleteError(e?.message || "Couldn't delete the project")
    } finally {
      setDeletingId(null)
    }
  }

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
              <div key={i} className="h-72 animate-pulse rounded-xl bg-muted" />
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
                  <div className="rounded-xl border border-border bg-card transition hover:border-primary/30" style={{ boxShadow: 'var(--shadow-md)' }} data-testid="project-card">
                  <Link
                    href={`/project/${project?.id}`}
                    className="group block p-5 pb-3"
                  >
                    {/* Stage 76: 16:9 project cover — location image of the first episode, or a muted placeholder. */}
                    <div className="mb-4 aspect-video w-full overflow-hidden rounded-lg bg-muted" data-testid="project-cover">
                      {project?.coverUrl ? (
                        <img
                          src={project.coverUrl}
                          alt={project?.name ?? 'Untitled'}
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center" data-testid="project-cover-placeholder">
                          <Film className="h-8 w-8 text-muted-foreground/40" />
                        </div>
                      )}
                    </div>
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Film className="h-5 w-5 text-primary" />
                        <h3 className="font-display font-semibold tracking-tight">
                          {project?.name ?? 'Untitled'}
                        </h3>
                        {project?.isTest && (
                          <span data-testid="project-test-badge" className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-400">
                            Test
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
                  <div className="flex flex-wrap items-center justify-end gap-2 px-5 pb-4">
                    {confirmId === project?.id ? (
                      <>
                        <span className="mr-auto text-xs text-destructive" data-testid="project-delete-confirm-text">Delete the project permanently?</span>
                        <button
                          type="button"
                          onClick={() => deleteProject(project.id)}
                          disabled={deletingId === project.id}
                          className="inline-flex items-center gap-1 rounded-lg bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground disabled:opacity-50"
                          data-testid="project-delete-confirm"
                        >
                          {deletingId === project.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />} Yes, delete
                        </button>
                        <button type="button" onClick={() => { setConfirmId(null); setDeleteError(null) }} disabled={deletingId === project.id} className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50" data-testid="project-delete-cancel">Cancel</button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setConfirmId(project.id); setDeleteError(null) }}
                        className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-destructive/50 hover:text-destructive"
                        data-testid="project-delete"
                      >
                        <Trash2 className="h-3 w-3" /> Delete
                      </button>
                    )}
                    {deleteError && confirmId === project?.id && <p className="w-full text-right text-xs text-destructive" data-testid="project-delete-error">{deleteError}</p>}
                  </div>
                  </div>
                </motion.div>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}
