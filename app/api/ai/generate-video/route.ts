export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'

// STUB: Seedance 2.5 video generation
export async function POST(request: Request) {
  try {
    const session = await auth()
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { email: session.user.email } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { projectId, sceneId } = await request.json()

    // Get project tier to determine credit cost
    const project = await prisma.project.findFirst({ where: { id: projectId } })
    const tierCost: Record<string, number> = { minimum: 1, medium: 3, maximum: 8 }
    const cost = tierCost[project?.tier ?? 'minimum'] ?? 1

    if ((user?.credits ?? 0) < cost) {
      return NextResponse.json({ error: `Not enough credits. Need ${cost}, have ${user?.credits ?? 0}` }, { status: 400 })
    }

    // Deduct credits (STUB)
    await prisma.user.update({
      where: { id: user.id },
      data: { credits: { decrement: cost } },
    })
    await prisma.creditTransaction.create({
      data: {
        userId: user.id,
        amount: -cost,
        description: `Video generation for scene (${project?.tier} tier)`,
      },
    })

    // STUB: placeholder video URL
    const scene = await prisma.scene.update({
      where: { id: sceneId },
      data: {
        videoUrl: `https://placehold.co/640x360/1a1a2e/eab308?text=Scene+${Date.now()}`,
        status: 'generated',
      },
    })

    return NextResponse.json({ scene, creditsRemaining: (user?.credits ?? 0) - cost })
  } catch (err: any) {
    console.error('Video generation error:', err)
    return NextResponse.json({ error: 'Generation failed' }, { status: 500 })
  }
}
