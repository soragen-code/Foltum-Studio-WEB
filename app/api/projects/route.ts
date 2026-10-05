export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { parseBody, createProjectSchema } from '@/lib/validations'
import { legacyTierToPower, powerToLegacyTier, DEFAULT_POWER_TIER } from '@/lib/power-tier'
import { PLACEHOLDER_PROJECT_NAME } from '@/lib/project-name'
import { pickProjectCover } from '@/lib/project-cover'
import { DRAFT_V2_STAGES } from '@/lib/idea-v2'
import { denyFeature } from '@/lib/feature-gate'

// Черновики (сюжет сезона не утверждён) не сохраняются: скрыты из списка, а брошенные дольше этого срока удаляются.
const STALE_DRAFT_MS = 2 * 60 * 60 * 1000

export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.email) {
      return NextResponse.json({ projects: [] }, { status: 401 })
    }
    const user = await prisma.user.findUnique({ where: { email: session.user.email } })
    if (!user) return NextResponse.json({ projects: [] }, { status: 401 })

    // Черновики v2 (stage idea/logline_v2/synopsis_v2) не сохраняются: обычно их удаляет discard при уходе
    // со страницы, а брошенные (закрытая вкладка, обрыв) — подчищаем здесь. GenerationJob без FK → явно.
    const draftWhere = { userId: user.id, newFlow: true, stage: { in: [...DRAFT_V2_STAGES] } }
    try {
      const stale = await prisma.project.findMany({
        where: { ...draftWhere, updatedAt: { lt: new Date(Date.now() - STALE_DRAFT_MS) } },
        select: { id: true },
      })
      if (stale.length) {
        const ids = stale.map((p) => p.id)
        await prisma.$transaction([
          prisma.generationJob.deleteMany({ where: { projectId: { in: ids } } }),
          prisma.project.deleteMany({ where: { id: { in: ids }, ...draftWhere } }),
        ])
      }
    } catch (gcErr) {
      console.error('Stale draft GC error:', gcErr)
    }

    const rows = await prisma.project.findMany({
      where: { userId: user.id, NOT: draftWhere },
      orderBy: { updatedAt: 'desc' },
      // Stage 76: minimal season/episode/location slice to compute the dashboard cover.
      include: {
        seasons: {
          select: {
            number: true,
            createdAt: true,
            episodes: { select: { number: true, location: { select: { imageUrl: true } } } },
          },
        },
      },
    })
    // `coverUrl` = первая сгенерированная локация проекта (v2: Project.episodeRefsV2, серии по возрастанию);
    // legacy-фолбэк — локация первой серии первого сезона. Nested seasons are stripped (additive field only).
    const projects = rows.map(({ seasons, ...project }) => ({ ...project, coverUrl: pickProjectCover(project.episodeRefsV2, seasons) }))
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
    // Без активной подписки (Basic+) проекты не создаются — 403 subscription_required.
    { const dAuto = await denyFeature(session.user.email, 'auto_generate'); if (dAuto) return dAuto; }

    const parsed = await parseBody(request, createProjectSchema)
    if (!parsed.ok) return parsed.response
    const { name, tier, powerTier } = parsed.data

    // New flow: powerTier (LOW/MEDIUM/HIGH) is the source of truth; legacy `tier`
    // is kept in sync so the dashboard and older routes keep working.
    const power = powerTier ?? (tier ? legacyTierToPower(tier) : DEFAULT_POWER_TIER)
    const project = await prisma.project.create({
      data: {
        userId: user.id,
        // Stage 40: the name is never asked — a placeholder until the story gives the project its title.
        name: (name ?? '').trim() || PLACEHOLDER_PROJECT_NAME,
        tier: powerToLegacyTier(power),
        powerTier: power,
        // New projects start at the "idea" step of the new flow; legacy projects keep their old stages.
        stage: 'idea',
        // Stage 59: mark the durable 4-step flow so the wizard renders the right screen at every stage
        // (charactersApproved is still false at synopsis/early-structure, so it cannot be relied on).
        newFlow: true,
      },
    })

    return NextResponse.json({ project }, { status: 201 })
  } catch (err: any) {
    console.error('Project create error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
