'use client'

import { useEffect, useRef, useState } from 'react'
import { Header } from '@/components/header'
import { IdeaStageV2 } from './idea-stage-v2'
import { motion } from 'framer-motion'
import { EntitlementsProvider } from '@/components/entitlements-context'
import { NO_ENTITLEMENTS, type Entitlements } from '@/lib/entitlements'
import { isDraftProjectV2 } from '@/lib/idea-v2'
import { GenerateLocked } from '@/components/generate-locked'

/**
 * Мастер проекта. Единственный поток приложения — экран v2:
 * Идея → Синопсис → Сюжет сезона → серии (/project/[id]/v2/episode/[n]).
 * Старый пятишаговый пайплайн (v1) удалён; любой проект, независимо от его stage, открывается здесь.
 */
export function ProjectWizard({ project: initialProject, entitlements = NO_ENTITLEMENTS }: { project: any; entitlements?: Entitlements }) {
  const [project, setProject] = useState(initialProject)

  // Черновик (сюжет сезона не утверждён) не сохраняется: при уходе со страницы — закрытие вкладки,
  // переход на дашборд, размонтирование — просим сервер удалить проект (он сам проверит, что это черновик).
  // Ref читается в момент ухода, чтобы учитывать свежий stage после onRefresh.
  const isDraftRef = useRef(isDraftProjectV2(project))
  isDraftRef.current = isDraftProjectV2(project)
  const projectId: string | undefined = project?.id
  const unmountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!projectId) return
    // Ремонт (React StrictMode в dev) отменяет отложенный discard предыдущего размонтирования.
    if (unmountTimerRef.current) { clearTimeout(unmountTimerRef.current); unmountTimerRef.current = null }
    const url = `/api/projects/${projectId}/discard`
    let fired = false
    const discard = () => {
      if (fired || !isDraftRef.current) return
      fired = true
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') navigator.sendBeacon(url)
      else void fetch(url, { method: 'POST', keepalive: true }).catch(() => {})
    }
    window.addEventListener('pagehide', discard)
    return () => {
      window.removeEventListener('pagehide', discard)
      // На размонтировании (переход на дашборд и т.п.) — с задержкой, чтобы ремонт успел отменить.
      unmountTimerRef.current = setTimeout(discard, 100)
    }
  }, [projectId])

  const refreshProject = async () => {
    try {
      const res = await fetch(`/api/projects/${project?.id}`)
      const data = await res.json()
      if (data?.project) setProject(data.project)
    } catch {}
  }

  // Без активной подписки (Basic+) — заглушка вместо мастера (сервер тоже отдаёт 403 на все генерации).
  if (!entitlements.auto_generate) return <GenerateLocked projectName={project?.name} />

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
          <EntitlementsProvider value={entitlements}>
            <IdeaStageV2 project={project} onRefresh={refreshProject} />
          </EntitlementsProvider>
        </motion.div>
      </main>
    </div>
  )
}
