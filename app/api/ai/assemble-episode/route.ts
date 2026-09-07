export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'

// STUB: FFmpeg episode assembly
export async function POST(request: Request) {
  try {
    const session = await auth()
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { episodeId } = await request.json()
    if (!episodeId) return NextResponse.json({ error: 'Episode ID required' }, { status: 400 })

    // Check all scenes are accepted
    const scenes = await prisma.scene.findMany({ where: { episodeId } })
    const allAccepted = (scenes ?? []).every((s: any) => s?.status === 'accepted')
    if (!allAccepted) {
      return NextResponse.json({ error: 'All scenes must be accepted first' }, { status: 400 })
    }

    // STUB: In production, this would use FFmpeg to concatenate scene videos
    // For now, return a placeholder assembled video URL
    const videoUrl = `https://placehold.co/1280x720/1a1a2e/eab308?text=Assembled+Episode`

    await prisma.episode.update({
      where: { id: episodeId },
      data: { videoUrl },
    })

    return NextResponse.json({ videoUrl })
  } catch (err: any) {
    console.error('Episode assembly error:', err)
    return NextResponse.json({ error: 'Assembly failed' }, { status: 500 })
  }
}
