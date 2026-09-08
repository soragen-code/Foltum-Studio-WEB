export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { parseBody, createProjectSchema } from '@/lib/validations'
import { legacyTierToPower, powerToLegacyTier, DEFAULT_POWER_TIER } from '@/lib/power-tier'

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

    const parsed = await parseBody(request, createProjectSchema)
    if (!parsed.ok) return parsed.response
    const { name, tier, powerTier } = parsed.data

    // New flow: powerTier (LOW/MEDIUM/HIGH) is the source of truth; legacy `tier`
    // is kept in sync so the dashboard and older routes keep working.
    const power = powerTier ?? (tier ? legacyTierToPower(tier) : DEFAULT_POWER_TIER)
    const project = await prisma.project.create({
      data: {
        userId: user.id,
        name,
        tier: powerToLegacyTier(power),
        powerTier: power,
        // New projects start at the "idea" step of the new flow; legacy projects keep their old stages.
        stage: 'idea',
      },
    })

    return NextResponse.json({ project }, { status: 201 })
  } catch (err: any) {
    console.error('Project create error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
