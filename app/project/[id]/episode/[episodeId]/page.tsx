import { auth } from '@/auth'
import { redirect, notFound } from 'next/navigation'
import { prisma } from '@/lib/db'
import { EpisodeView } from './episode-view'

export const dynamic = 'force-dynamic'

export default async function EpisodePage({ params }: { params: Promise<{ id: string; episodeId: string }> }) {
  const session = await auth()
  if (!session?.user) redirect('/login')
  const { id, episodeId } = await params
  const user = await prisma.user.findUnique({ where: { email: session.user.email! } })
  if (!user) redirect('/login')

  const episode = await prisma.episode.findFirst({
    where: { id: episodeId, season: { projectId: id, project: { userId: user.id } } },
    include: {
      characters: { include: { character: true } },
      location: true, // stage 12: bound location with reference images
      scenes: { orderBy: { number: 'asc' }, include: { characters: { include: { character: { select: { id: true, name: true, imageFront: true } } } } } },
      season: { include: { project: { include: { characters: true, locations: true } } } },
    },
  })
  if (!episode) notFound()

  // stage 12: sibling episodes (for "go to next episode" navigation after assemble).
  const siblings = await prisma.episode.findMany({
    where: { seasonId: episode.seasonId },
    orderBy: { number: 'asc' },
    select: { id: true, number: true, title: true, status: true, videoUrl: true },
  })

  return <EpisodeView episode={JSON.parse(JSON.stringify(episode))} project={JSON.parse(JSON.stringify(episode.season.project))} siblings={JSON.parse(JSON.stringify(siblings))} credits={user.credits ?? 0} />
}
