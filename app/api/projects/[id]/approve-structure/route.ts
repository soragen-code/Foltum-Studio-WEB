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

    await prisma.project.update({
      where: { id },
      data: {
        structureApproved: true,
        stage: 'scenes',
      },
    })

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('Approve structure error:', err)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
