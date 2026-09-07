export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'

export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.email) {
      return NextResponse.json({ projects: [] }, { status: 401 })
    }
    const user = await prisma.user.findUnique({ where: { email: session.user.email } })
    if (!user) return NextResponse.json({ projects: [] }, { status: 401 })

    const projects = await prisma.project.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: 'desc' },
    })
    return NextResponse.json({ projects })
  } catch (err: any) {
    console.error('Projects fetch error:', err)
    return NextResponse.json({ projects: [] }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const session = await auth()
    if (!session?.user?.email) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const user = await prisma.user.findUnique({ where: { email: session.user.email } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { name, tier } = await request.json()
    if (!name) {
      return NextResponse.json({ error: 'Project name is required' }, { status: 400 })
    }

    const project = await prisma.project.create({
      data: {
        userId: user.id,
        name,
        tier: tier ?? 'minimum',
        stage: 'synopsis',
      },
    })

    return NextResponse.json({ project }, { status: 201 })
  } catch (err: any) {
    console.error('Project create error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
