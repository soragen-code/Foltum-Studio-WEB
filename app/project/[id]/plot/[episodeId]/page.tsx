import { auth } from '@/auth'
import { redirect, notFound } from 'next/navigation'
import { prisma } from '@/lib/db'
import { PlotView } from './plot-view'

export const dynamic = 'force-dynamic'

/**
 * Stage 173 (task 2) — the episode PLOT page. After the season structure is built, this page shows the PLOT
 * (сюжет) of ONE episode. From here the producer can go to that episode's SCRIPT, or generate the plot of the
 * NEXT episode (opening its analogous plot page). Plots are generated sequentially, one episode at a time.
 */
export default async function PlotPage({ params }: { params: Promise<{ id: string; episodeId: string }> }) {
  const session = await auth()
  if (!session?.user) redirect('/login')
  const { id, episodeId } = await params
  const user = await prisma.user.findUnique({ where: { email: session.user.email! } })
  if (!user) redirect('/login')

  const episode = await prisma.episode.findFirst({
    where: { id: episodeId, season: { projectId: id, project: { userId: user.id } } },
    select: { id: true, number: true, title: true, plot: true, plotStatus: true, script: true, seasonId: true },
  })
  if (!episode) notFound()

  // All sibling episodes (ordered) drive sequential navigation: which plot is next, whether the previous
  // plot exists (gate), and the links to each episode's plot/script page.
  const siblings = await prisma.episode.findMany({
    where: { seasonId: episode.seasonId },
    orderBy: { number: 'asc' },
    select: { id: true, number: true, title: true, plot: true, script: true },
  })

  const project = await prisma.project.findFirst({
    where: { id, userId: user.id },
    select: { id: true, name: true },
  })
  if (!project) notFound()

  return (
    <PlotView
      projectId={id}
      projectName={project.name}
      episode={{ id: episode.id, number: episode.number, title: episode.title, plot: episode.plot ?? null, plotStatus: episode.plotStatus ?? null, hasScript: !!episode.script }}
      siblings={siblings.map((s) => ({ id: s.id, number: s.number, title: s.title, hasPlot: !!s.plot?.trim(), hasScript: !!s.script }))}
    />
  )
}
