'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Header } from '@/components/header'
import { Sparkles, Upload, ArrowRight, Loader2 } from 'lucide-react'
import { motion } from 'framer-motion'

/**
 * ПРАВКА 1 — экран нового проекта: вместо блока о качестве сцен предлагаем два пути:
 *  (а) «Создать с нуля» — придумать идею/сюжет внутри редактора;
 *  (б) «Загрузить готовый сценарий» — загрузить свой текст сюжета файлом (или вставить его).
 * Оба варианта создают проект одинаково (POST /api/projects, powerTier LOW) — различается только
 * начальный режим на экране идеи: путь «с нуля» открывает /project/{id}, путь «загрузить готовый
 * сценарий» открывает /project/{id}?source=upload, где сразу активен режим загрузки сюжета.
 */
export function NewProjectForm() {
  const [loading, setLoading] = useState<null | 'scratch' | 'upload'>(null)
  const [error, setError] = useState('')
  const router = useRouter()

  const createProject = async (source: 'scratch' | 'upload') => {
    if (loading) return
    setError('')
    setLoading(source)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Название генерируется автоматически из сюжета; качество/длина сезона определяются сценарием.
        body: JSON.stringify({ powerTier: 'LOW' }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data?.error ?? 'Не удалось создать проект'); setLoading(null); return }
      const id = data?.project?.id
      router.push(source === 'upload' ? `/project/${id}?source=upload` : `/project/${id}`)
    } catch {
      setError('Что-то пошло не так')
      setLoading(null)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-[720px] px-4 py-12">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="font-display text-3xl font-bold tracking-tight">
            Новый <span className="text-primary">проект</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Выберите, с чего начать. Название проекта сгенерируется автоматически по сюжету, а длина сезона, число сцен и хронометраж определятся сценарием.
          </p>

          {error && (
            <div className="mt-6 rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>
          )}

          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {/* (а) Создать с нуля */}
            <button
              type="button"
              onClick={() => createProject('scratch')}
              disabled={!!loading}
              className="group flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 text-left transition hover:border-primary/60 disabled:opacity-50"
              data-testid="project-create-scratch"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
                {loading === 'scratch' ? <Loader2 className="h-6 w-6 animate-spin" /> : <Sparkles className="h-6 w-6" />}
              </div>
              <div className="font-display text-lg font-semibold">Создать с нуля</div>
              <p className="text-sm text-muted-foreground">
                Опишите идею сами или доверьте её ИИ по выбранному жанру. Мы придумаем короткую идею, синопсис, персонажей, локации и сценарий.
              </p>
              <span className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-primary">
                Начать <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
              </span>
            </button>

            {/* (б) Загрузить готовый сценарий */}
            <button
              type="button"
              onClick={() => createProject('upload')}
              disabled={!!loading}
              className="group flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-5 text-left transition hover:border-primary/60 disabled:opacity-50"
              data-testid="project-create-upload"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
                {loading === 'upload' ? <Loader2 className="h-6 w-6 animate-spin" /> : <Upload className="h-6 w-6" />}
              </div>
              <div className="font-display text-lg font-semibold">Загрузить готовый сценарий</div>
              <p className="text-sm text-muted-foreground">
                Уже есть готовый сюжет? Загрузите его файлом (.txt, .md, .docx, .pdf) или вставьте текстом — ИИ структурирует его в сезон с сериями, локациями и персонажами.
              </p>
              <span className="mt-1 inline-flex items-center gap-1 text-sm font-semibold text-primary">
                Загрузить <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
              </span>
            </button>
          </div>
        </motion.div>
      </main>
    </div>
  )
}
