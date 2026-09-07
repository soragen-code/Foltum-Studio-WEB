export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import bcrypt from 'bcryptjs'
import { rateLimitByIp, RATE_LIMITS } from '@/lib/rate-limit'
import { parseBody, loginSchema } from '@/lib/validations'
import { unauthorized, serverError } from '@/lib/api-errors'
import { publicIdentity } from '@/lib/sanitize-user'

export async function POST(request: Request) {
  try {
    // 10 login attempts / minute / IP
    const limited = rateLimitByIp(request, 'login', RATE_LIMITS.login)
    if (limited) return limited

    const parsed = await parseBody(request, loginSchema)
    if (!parsed.ok) return parsed.response
    const { email, password } = parsed.data

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, password: true },
    })
    if (!user?.password) return unauthorized('Invalid credentials')

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) return unauthorized('Invalid credentials')

    // Only return the public identity — never the password hash or full record
    return NextResponse.json(publicIdentity(user))
  } catch (err: any) {
    console.error('Login error:', err)
    return serverError()
  }
}
