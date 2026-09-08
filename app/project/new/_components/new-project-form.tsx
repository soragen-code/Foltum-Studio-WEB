'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Header } from '@/components/header'
import { Film, Zap, Sparkles, Crown, ArrowRight, Loader2 } from 'lucide-react'
import { motion } from 'framer-motion'
import { POWER_TIER_CONFIG, type PowerTier } from '@/lib/power-tier'

const tiers = [
  {
    id: 'LOW',
    label: 'Low',
    icon: Zap,
    color: 'border-green-500/50 bg-green-500/5',
    activeColor: 'border-green-500 bg-green-500/10 ring-2 ring-green-500/30',
    iconColor: 'text-green-400',
    credits: `${POWER_TIER_CONFIG.LOW.costPerScene} кредит/сцена`,
    desc: POWER_TIER_CONFIG.LOW.description,
  },
  {
    id: 'MEDIUM',
    label: 'Medium',
    icon: Sparkles,
    color: 'border-yellow-500/50 bg-yellow-500/5',
    activeColor: 'border-yellow-500 bg-yellow-500/10 ring-2 ring-yellow-500/30',
    iconColor: 'text-yellow-400',
    credits: `${POWER_TIER_CONFIG.MEDIUM.costPerScene} кредита/сцена`,
    desc: POWER_TIER_CONFIG.MEDIUM.description,
  },
  {
    id: 'HIGH',
    label: 'High',
    icon: Crown,
    color: 'border-red-500/50 bg-red-500/5',
    activeColor: 'border-red-500 bg-red-500/10 ring-2 ring-red-500/30',
    iconColor: 'text-red-400',
    credits: `${POWER_TIER_CONFIG.HIGH.costPerScene} кредитов/сцена`,
    desc: POWER_TIER_CONFIG.HIGH.description,
  },
] as const

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
            Назовите сериал и выберите мощность генерации
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
                />
              </div>
            </div>

            <div>
              <label className="mb-3 block text-sm font-medium">Мощность</label>
              <div className="grid gap-3 sm:grid-cols-3">
                {tiers.map((t) => {
                  const Icon = t.icon
                  const active = tier === t.id
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTier(t.id)}
                      className={`rounded-xl border p-4 text-left transition ${
                        active ? t.activeColor : t.color
                      } hover:brightness-110`}
                    >
                      <Icon className={`mb-2 h-6 w-6 ${t.iconColor}`} />
                      <div className="font-semibold">{t.label}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {t.credits} · {POWER_TIER_CONFIG[t.id].resolution}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">{t.desc}</div>
                    </button>
                  )
                })}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                ⚠️ Мощность фиксируется при создании и влияет на разрешение видео и стоимость сцен.
              </p>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-3 text-sm font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-50"
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
