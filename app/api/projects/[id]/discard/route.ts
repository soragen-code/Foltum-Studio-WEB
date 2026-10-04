export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { isDraftProjectV2 } from '@/lib/idea-v2'

/**
 * POST /api/projects/[id]/discard — удаляет проект ТОЛЬКО если он ещё черновик (сюжет сезона не утверждён).
 * Вызывается с клиента при уходе со страницы проекта (navigator.sendBeacon / fetch keepalive), поэтому
 * безопасен к запоздалым вызовам: утверждённый проект никогда не удаляется. Owner-only.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true } })
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const { id } = await params

    const project = await prisma.project.findFirst({
      where: { id, userId: user.id },
      select: { id: true, stage: true, newFlow: true, seasonPlotV2: true },
    })
    if (!project) return NextResponse.json({ ok: true, discarded: false })
    if (!isDraftProjectV2(project)) return NextResponse.json({ ok: true, discarded: false })

    await prisma.$transaction(async (tx) => {
      await tx.generationJob.deleteMany({ where: { projectId: project.id } })
      await tx.project.delete({ where: { id: project.id } })
    })
    return NextResponse.json({ ok: true, discarded: true })
  } catch (err: any) {
    console.error('[POST /api/projects/[id]/discard]', err)
    return NextResponse.json({ error: "Couldn't discard the draft" }, { status: 500 })
  }
}
