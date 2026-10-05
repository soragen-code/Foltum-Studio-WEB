export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { isDraftProjectV2, IDEA_V2_JOB_TYPES, ACTIVE_JOB_STATUSES } from '@/lib/idea-v2'

/**
 * POST /api/projects/[id]/discard — удаляет проект ТОЛЬКО если он ещё черновик (синопсис не готов: стадия
 * idea/logline_v2 или synopsis_v2 с пустым синопсисом). Вызывается с клиента при уходе со страницы проекта
 * (navigator.sendBeacon / fetch keepalive), поэтому безопасен к запоздалым вызовам: проект с готовым синопсисом
 * никогда не удаляется. Пока крутится фоновая задача синопсиса/сюжета (вкладку закрыли во время генерации) —
 * тоже не удаляем (busy): задача допишет синопсис, и проект останется. Owner-only.
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
      select: { id: true, stage: true, newFlow: true, synopsis: true, seasonPlotV2: true },
    })
    if (!project) return NextResponse.json({ ok: true, discarded: false })
    if (!isDraftProjectV2(project)) return NextResponse.json({ ok: true, discarded: false })
    const busy = await prisma.generationJob.findFirst({
      where: { projectId: project.id, type: { in: [...IDEA_V2_JOB_TYPES] }, status: { in: [...ACTIVE_JOB_STATUSES] } },
      select: { id: true },
    })
    if (busy) return NextResponse.json({ ok: true, discarded: false, busy: true })

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
