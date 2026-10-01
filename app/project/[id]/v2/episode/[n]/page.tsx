import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db'
import { seasonPlotEpisodeSummary, episodeScriptV2From } from '@/lib/idea-v2'
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

  const user = await prisma.user.findUnique({ where: { email: session.user.email! }, select: { id: true } })
  if (!user) redirect('/login')
  const project = await prisma.project.findFirst({
    where: { id, userId: user.id },
    select: { id: true, name: true, seasonPlotV2: true, episodeScriptsV2: true },
  })
  if (!project) redirect('/dashboard')

  const back = `/project/${project.id}?flow=v2`
  const n = Number(nRaw)
  const summary = Number.isInteger(n) && n > 0 ? seasonPlotEpisodeSummary(project.seasonPlotV2, n) : null
  if (!summary) redirect(back)

  return (
    <EpisodeV2View
      projectId={project.id}
      projectTitle={String(project.name ?? '')}
      n={n}
      summary={summary}
      initialScript={episodeScriptV2From(project.episodeScriptsV2, n)}
      backHref={back}
    />
  )
}
