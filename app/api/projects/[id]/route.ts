export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const user = await prisma.user.findUnique({ where: { email: session.user.email } })
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params

    const project = await prisma.project.findFirst({
      where: { id, userId: user.id },
      include: {
        characters: { orderBy: { createdAt: 'asc' } },
        locations: { orderBy: { createdAt: 'asc' } },
        seasons: {
          include: {
            episodes: {
              include: {
                // The episode's OWN cast (EpisodeCharacter) — so consumers derive the episode's characters
                // from this (e.g. 3 scripted people) instead of falling back to the whole project roster.
                characters: { include: { character: true } },
                scenes: {
                  include: { characters: { include: { character: true } } },
                  orderBy: { number: 'asc' },
                },
              },
              orderBy: { number: 'asc' },
            },
          },
          orderBy: { number: 'asc' },
        },
      },
    })
    if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Stage 60: never ship the whole prevSnapshot object to the client — expose only a boolean
    // `hasUndo` so the UI can show the "Undo last change" button when undo is available.
    const strip = <T extends { prevSnapshot?: unknown }>(o: T) => {
      const { prevSnapshot, ...rest } = o
      return { ...rest, hasUndo: prevSnapshot != null }
    }
    const shaped = {
      ...project,
      characters: project.characters.map(strip),
      locations: project.locations.map(strip),
      seasons: project.seasons.map((s) => ({
        ...s,
        episodes: s.episodes.map((e) => ({
          ...e,
          scenes: e.scenes.map(strip),
        })),
      })),
    }
    return NextResponse.json({ project: shaped })
  } catch (err: any) {
    console.error('Project fetch error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

/**
 * Stage 46A — DELETE /api/projects/[id]: owner-only, removes the project with everything under it.
 * Seasons/episodes/scenes/characters/locations/artifacts cascade via FK; GenerationJob has no FK
 * to Project, so its rows are removed explicitly inside the same transaction.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true } })
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params

    const project = await prisma.project.findFirst({ where: { id, userId: user.id }, select: { id: true } })
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

    const jobs = await prisma.$transaction(async (tx) => {
      const removed = await tx.generationJob.deleteMany({ where: { projectId: project.id } })
      await tx.project.delete({ where: { id: project.id } })
      return removed.count
    })
    return NextResponse.json({ ok: true, deletedJobs: jobs })
  } catch (err: any) {
    console.error('[DELETE /api/projects/[id]]', err)
    return NextResponse.json({ error: "Couldn't delete the project" }, { status: 500 })
  }
}
