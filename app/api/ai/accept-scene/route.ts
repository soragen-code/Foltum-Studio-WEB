export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { rateLimitByUser, RATE_LIMITS } from '@/lib/rate-limit'
import { parseBody, acceptSceneSchema } from '@/lib/validations'

export async function POST(request: Request) {
  try {
    const session = await auth()
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const limited = rateLimitByUser(request, 'ai:accept-scene', session.user.email, RATE_LIMITS.ai)
    if (limited) return limited

    const parsed = await parseBody(request, acceptSceneSchema)
    if (!parsed.ok) return parsed.response
    const { sceneId } = parsed.data
    const scene = await prisma.scene.update({
      where: { id: sceneId },
      data: { status: 'accepted' },
    })
    return NextResponse.json({ scene })
  } catch (err: any) {
    console.error('Accept scene error:', err)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
