export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'

export async function POST(request: Request) {
  try {
    const session = await auth()
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { sceneId } = await request.json()
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
