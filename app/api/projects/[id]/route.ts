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
        characters: true,
        seasons: {
          include: {
            episodes: {
              include: {
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
    return NextResponse.json({ project })
  } catch (err: any) {
    console.error('Project fetch error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
