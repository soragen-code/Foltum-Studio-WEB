export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import bcrypt from 'bcryptjs'
import { rateLimitByIp, RATE_LIMITS } from '@/lib/rate-limit'
import { parseBody, signupSchema } from '@/lib/validations'
import { conflict, serverError } from '@/lib/api-errors'
import { publicIdentity } from '@/lib/sanitize-user'

export async function POST(request: Request) {
  try {
    // 5 signups / minute / IP
    const limited = rateLimitByIp(request, 'signup', RATE_LIMITS.signup)
    if (limited) return limited

    const parsed = await parseBody(request, signupSchema)
    if (!parsed.ok) return parsed.response
    const { name, email, password } = parsed.data

    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } })
    if (existing) return conflict('Email already in use')

    const hashed = await bcrypt.hash(password, 12)
    const user = await prisma.user.create({
      data: {
        name: name?.trim() || 'User',
        email,
        password: hashed,
        credits: 100,
      },
      select: { id: true, email: true },
    })

    // Only return the public identity — never the full user record
    return NextResponse.json(publicIdentity(user), { status: 201 })
  } catch (err: any) {
    console.error('Signup error:', err)
    return serverError()
  }
}
