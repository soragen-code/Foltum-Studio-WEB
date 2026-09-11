'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Header } from '@/components/header'
import { MonitorPlay, ArrowRight, Loader2 } from 'lucide-react'
import { motion } from 'framer-motion'
import { SEEDANCE_MAX_DURATION, SCENE_RESOLUTION } from '@/lib/power-tier'
import { sceneClipCost } from '@/lib/season'

/**
 * Stage 46B: no quality choice any more — every scene clip is rendered at a fixed 480p
 * (`SCENE_RESOLUTION`); the production quality (480p/720p/1080p, 30/60 fps) is picked later,
 * when the finished episode is assembled. Projects are created with powerTier LOW, which is the
 * 480p pricing. Episode count, scene count and clip length are never asked here: the script
 * decides them.
 */
export function NewProjectForm() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()
  const perScene = sceneClipCost('LOW', SEEDANCE_MAX_DURATION)
  const perSecond = (perScene / SEEDANCE_MAX_DURATION).toFixed(1).replace(/\.0$/, '')

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Stage 40: no name — it is generated automatically from the plot once the idea / test scene exists.
        body: JSON.stringify({ powerTier: 'LOW' }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data?.error ?? 'Не удалось создать проект'); setLoading(false); return }
      router.push(`/project/${data?.project?.id}`)
    } catch {
      setError('Что-то пошло не так')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-[600px] px-4 py-12">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="font-display text-3xl font-bold tracking-tight">
            Новый <span className="text-primary">проект</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Название проекта придумается само — коротко, по сюжету; длину сезона, число сцен и хронометраж определит сам сценарий.
          </p>

          <form onSubmit={handleCreate} className="mt-8 space-y-6">
            {error && (
              <div className="rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>
            )}

            <div className="rounded-xl border border-border bg-card p-4" data-testid="scene-quality-info">
              <div className="flex items-center gap-2 font-semibold"><MonitorPlay className="h-5 w-5 text-green-400" /> Сцены рендерятся в {SCENE_RESOLUTION}</div>
              <p className="mt-1 text-xs text-muted-foreground">
                {perSecond} кр./сек · до {perScene} кр. за сцену ({SEEDANCE_MAX_DURATION} с). Стоимость считается по фактической длине каждой сцены и показывается перед подтверждением.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Качество готовой серии (480p / 720p / 1080p, 30 или 60 кадров/с) выбирается при сборке эпизода.
              </p>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-3 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
              data-testid="project-create"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
              Создать
            </button>
          </form>
        </motion.div>
      </main>
    </div>
  )
}
