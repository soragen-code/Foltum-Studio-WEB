'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Header } from '@/components/header'
import { Film, MonitorPlay, Sparkles, ArrowRight, Loader2 } from 'lucide-react'
import { motion } from 'framer-motion'
import { POWER_TIER_CONFIG, SEEDANCE_MAX_DURATION, type PowerTier } from '@/lib/power-tier'
import { sceneClipCost } from '@/lib/season'

/**
 * Quality choice. Seedance 2.5 on Replicate really supports only 480p and 720p (no 1080p),
 * so exactly those two are offered; internally they map to the existing powerTier (LOW/MEDIUM)
 * — no migration, legacy projects keep working. Episode count, scene count and clip length are
 * never asked here: the script decides them.
 */
const QUALITIES = [
  { id: 'LOW' as PowerTier, icon: MonitorPlay, title: '480p', subtitle: 'черновик', color: 'border-green-500/50 bg-green-500/5', activeColor: 'border-green-500 bg-green-500/10 ring-2 ring-green-500/30', iconColor: 'text-green-400' },
  { id: 'MEDIUM' as PowerTier, icon: Sparkles, title: '720p', subtitle: 'финальное', color: 'border-yellow-500/50 bg-yellow-500/5', activeColor: 'border-yellow-500 bg-yellow-500/10 ring-2 ring-yellow-500/30', iconColor: 'text-yellow-400' },
]

export function NewProjectForm() {
  const [name, setName] = useState('')
  const [tier, setTier] = useState<PowerTier>('MEDIUM')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) { setError('Введите название проекта'); return }
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), powerTier: tier }),
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
            Назовите сериал и выберите качество видео. Длину сезона, число сцен и хронометраж определит сам сценарий.
          </p>

          <form onSubmit={handleCreate} className="mt-8 space-y-6">
            {error && (
              <div className="rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>
            )}

            <div>
              <label className="mb-2 block text-sm font-medium">Название проекта</label>
              <div className="relative">
                <Film className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  placeholder="Мой сериал"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full rounded-lg border border-input bg-background py-2.5 pl-10 pr-4 text-sm outline-none transition focus:border-primary focus:ring-1 focus:ring-primary"
                  data-testid="project-name"
                />
              </div>
            </div>

            <div>
              <label className="mb-3 block text-sm font-medium">В каком качестве сделать?</label>
              <div className="grid gap-3 sm:grid-cols-2" data-testid="quality-options">
                {QUALITIES.map((q) => {
                  const Icon = q.icon
                  const cfg = POWER_TIER_CONFIG[q.id]
                  const active = tier === q.id
                  const perScene = sceneClipCost(q.id, SEEDANCE_MAX_DURATION)
                  const perSecond = (perScene / SEEDANCE_MAX_DURATION).toFixed(1).replace(/\.0$/, '')
                  return (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => setTier(q.id)}
                      className={`rounded-xl border p-4 text-left transition ${active ? q.activeColor : q.color} hover:brightness-110`}
                      data-testid={`quality-${q.id}`}
                    >
                      <Icon className={`mb-2 h-6 w-6 ${q.iconColor}`} />
                      <div className="font-semibold">{q.title} <span className="text-xs font-normal text-muted-foreground">· {q.subtitle}</span></div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {perSecond} кр./сек · до {perScene} кр. за сцену ({SEEDANCE_MAX_DURATION} с)
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">{cfg.description}</div>
                    </button>
                  )
                })}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Качество фиксируется при создании. Стоимость считается по фактической длине каждой сцены и показывается перед подтверждением.
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
