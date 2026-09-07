export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'

export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.email) {
      return NextResponse.json({ credits: 0 }, { status: 401 })
    }
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: { credits: true },
    })
    return NextResponse.json({ credits: user?.credits ?? 0 })
  } catch {
    return NextResponse.json({ credits: 0 })
  }
}
