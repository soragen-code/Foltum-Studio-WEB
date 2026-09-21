import { auth } from '@/auth'
import { redirect, notFound } from 'next/navigation'
import { prisma } from '@/lib/db'
import { EpisodeView } from '../episode-view'
import { computeEntitlements } from '@/lib/entitlements'

export const dynamic = 'force-dynamic'

// Stage 172 — the episode SCRIPT on its own page, separate from the references + scenes production page.
// It reuses EpisodeView with `view="script"` so all script actions (generate / regenerate / paste your own,
// which re-extract locations, sub-locations and characters) keep working exactly as before.
export default async function EpisodeScriptPage({ params }: { params: Promise<{ id: string; episodeId: string }> }) {
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
      scenes: { orderBy: { number: 'asc' }, include: {
        characters: { include: { character: { select: { id: true, name: true, imageFront: true } } } },
        // Stage 167 — per-shot generation progress shown on the episode card (status / videoUrl per shot).
        shots: { orderBy: { index: 'asc' }, select: { id: true, index: true, shotType: true, size: true, duration: true, line: true, status: true, videoUrl: true, error: true } },
      } },
      season: { include: { project: { include: { characters: true, locations: true } } } },
    },
  })
  if (!episode) notFound()

  // stage 12: sibling episodes (for "go to next episode" navigation after assemble).
  const siblings = await prisma.episode.findMany({
    where: { seasonId: episode.seasonId },
    orderBy: { number: 'asc' },
    select: { id: true, number: true, title: true, status: true, videoUrl: true, script: true },
  })

  // Feature access is computed server-side from the user's subscription and passed to the client view.
  const entitlements = computeEntitlements(user)

  return <EpisodeView view="script" episode={JSON.parse(JSON.stringify(episode))} project={JSON.parse(JSON.stringify(episode.season.project))} siblings={JSON.parse(JSON.stringify(siblings.map(({ script, ...s }) => ({ ...s, hasScript: !!script }))))} credits={user.credits ?? 0} entitlements={entitlements} />
}
