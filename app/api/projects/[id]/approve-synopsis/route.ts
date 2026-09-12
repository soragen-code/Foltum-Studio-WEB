export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params
    const { synopsis } = await request.json()

    // Stage 59 (step 2 → step 3): in the new 4-step flow, approving the synopsis advances straight to the
    // season-story step ("structure"), where the cast, locations and season script are generated from the
    // approved synopsis. The classic flow keeps its old path (synopsis → characters).
    const project = await prisma.project.findUnique({ where: { id }, select: { newFlow: true } })
    const nextStage = project?.newFlow ? 'structure' : 'characters'

    await prisma.project.update({
      where: { id },
      data: {
        synopsis,
        synopsisApproved: true,
        stage: nextStage,
      },
    })

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('Approve synopsis error:', err)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
