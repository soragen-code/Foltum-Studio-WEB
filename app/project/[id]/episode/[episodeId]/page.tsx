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
      scenes: { orderBy: { number: 'asc' }, include: { characters: { include: { character: { select: { id: true, name: true, imageFront: true } } } } } },
      season: { include: { project: { include: { characters: true } } } },
    },
  })
  if (!episode) notFound()

  return <EpisodeView episode={JSON.parse(JSON.stringify(episode))} project={JSON.parse(JSON.stringify(episode.season.project))} credits={user.credits ?? 0} />
}
