export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'

export async function POST(request: Request) {
  try {
    const session = await auth()
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { characterId } = await request.json()
    const placeholder = 'https://placehold.co/300x400/1a1a2e/eab308?text=Regen'

    const character = await prisma.character.update({
      where: { id: characterId },
      data: {
        appearance: 'Regenerated appearance — tall, striking features, distinctive style, presence that commands attention.',
        imageFront: placeholder + '+Front',
        imageProfile: placeholder + '+Profile',
        imageFull: placeholder + '+Full',
      },
    })

    return NextResponse.json({ character })
  } catch (err: any) {
    console.error('Character regen error:', err)
    return NextResponse.json({ error: 'Regeneration failed' }, { status: 500 })
  }
}
