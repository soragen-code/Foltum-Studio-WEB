export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'

export async function POST(request: Request) {
  try {
    const session = await auth()
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const user = await prisma.user.findUnique({ where: { email: session.user.email } })
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

    const { amount, description } = await request.json()
    if (!amount || amount <= 0) return NextResponse.json({ error: 'Invalid amount' }, { status: 400 })

    await prisma.user.update({
      where: { id: user.id },
      data: { credits: { increment: amount } },
    })
    await prisma.creditTransaction.create({
      data: {
        userId: user.id,
        amount,
        description: description ?? 'Credit purchase',
      },
    })

    return NextResponse.json({ success: true, newBalance: (user?.credits ?? 0) + amount })
  } catch (err: any) {
    console.error('Add credits error:', err)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
