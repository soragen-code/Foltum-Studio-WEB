import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { Suspense } from 'react'
import { prisma } from '@/lib/db'
import { seasonPlotEpisodeSummary, parseSeasonPlotV2, episodeScriptV2From, episodeRefsV2From, episodeShotsV2From, episodeStoryboardV2From, episodeScenesV2From } from '@/lib/idea-v2'
import { computeEntitlements } from '@/lib/entitlements'
import { EntitlementsProvider } from '@/components/entitlements-context'
import { GenerateLocked } from '@/components/generate-locked'
import { EpisodeV2View } from './episode-v2-view'

export const dynamic = 'force-dynamic'

/**
 * Поток v2, уровень эпизода: /project/[id]/v2/episode/[n] (n — номер серии 1-based из "#<n>" сюжета сезона).
 * Отдельный путь `v2/episode/...`, т.к. `episode/[episodeId]` уже занят страницей эпизода v1 (Next запрещает
 * разные имена динамического сегмента на одном уровне). Стадию проекта не меняет; «Назад» → шаг 3 v2.
 */
export default async function EpisodeV2Page({ params }: { params: Promise<{ id: string; n: string }> }) {
  const session = await auth()
  if (!session?.user) redirect('/login')
  const { id, n: nRaw } = await params

  const user = await prisma.user.findUnique({ where: { email: session.user.email! }, select: { id: true, email: true, subscriptionTier: true, subscriptionExpiresAt: true } })
  if (!user) redirect('/login')
  // Матрица доступов по тарифу (Basic/Pro/Studio) — считается на сервере, клиент читает через useEntitlements().
  const entitlements = computeEntitlements(user)
  const project = await prisma.project.findFirst({
    where: { id, userId: user.id },
    select: { id: true, name: true, seasonPlotV2: true, episodeScriptsV2: true, episodeRefsV2: true, episodeShotsV2: true, episodeStoryboardV2: true, episodeScenesV2: true },
  })
  if (!project) redirect('/dashboard')
  // Без активной подписки (Basic+) — заглушка вместо экрана серии.
  if (!entitlements.auto_generate) return <GenerateLocked projectName={String(project.name ?? '')} />

  const back = `/project/${project.id}`
  const n = Number(nRaw)
  const summary = Number.isInteger(n) && n > 0 ? seasonPlotEpisodeSummary(project.seasonPlotV2, n) : null
  if (!summary) redirect(back)
  // Соседние серии (по маркерам "#<n>" сюжета сезона) — для кнопок «← Серия N-1 / Серия N+1 →» на странице.
  const episodeNumbers = (parseSeasonPlotV2(project.seasonPlotV2) ?? []).map((e) => e.n).filter((x) => Number.isInteger(x) && x > 0).sort((a, b) => a - b)
  const idx = episodeNumbers.indexOf(n)
  const prevN = idx > 0 ? episodeNumbers[idx - 1] : null
  const nextN = idx >= 0 && idx < episodeNumbers.length - 1 ? episodeNumbers[idx + 1] : null

  return (
    <Suspense>
    <EntitlementsProvider value={entitlements}>
    <EpisodeV2View
      projectId={project.id}
      projectTitle={String(project.name ?? '')}
      n={n}
      summary={summary}
      initialScript={episodeScriptV2From(project.episodeScriptsV2, n)}
      initialRefs={episodeRefsV2From(project.episodeRefsV2, n)}
      initialShots={episodeShotsV2From(project.episodeShotsV2, n)}
      initialStoryboard={episodeStoryboardV2From(project.episodeStoryboardV2, n)}
      initialScenes={episodeScenesV2From(project.episodeScenesV2, n)}
      backHref={back}
      prevN={prevN}
      nextN={nextN}
    />
    </EntitlementsProvider>
    </Suspense>
  )
}
