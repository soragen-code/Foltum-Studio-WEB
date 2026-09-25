import { auth } from '@/auth'
import { redirect, notFound } from 'next/navigation'
import { prisma } from '@/lib/db'
import { StoryboardGridPanel } from '../storyboard-grid-panel'

export const dynamic = 'force-dynamic'

/**
 * Stage 240 — dedicated GRID STORYBOARD page for an episode. Kept out of the 2000-line episode-view so the
 * grid flow (generate sheet → edit prompt → approve → slice → generate videos) is self-contained.
 */
export default async function StoryboardGridPage({ params }: { params: Promise<{ id: string; episodeId: string }> }) {
  const session = await auth()
  if (!session?.user?.email) redirect('/login')
  const { id, episodeId } = await params

  const episode = await prisma.episode.findFirst({
    where: { id: episodeId, season: { projectId: id, project: { user: { email: session.user.email } } } },
    select: { id: true },
  })
  if (!episode) notFound()

  return <StoryboardGridPanel projectId={id} episodeId={episodeId} />
}
