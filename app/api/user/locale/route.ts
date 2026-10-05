export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { isLocale } from '@/lib/i18n/dictionary'
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from '@/lib/i18n/request-locale'

// GET current user's UI locale (fallback "ru").
export async function GET() {
  try {
    const session = await auth()
    if (!session?.user?.email) return NextResponse.json({ locale: 'ru' }, { status: 401 })
    const user = await prisma.user.findUnique({
      where: { email: session.user.email },
      select: { locale: true },
    })
    return NextResponse.json({ locale: user?.locale ?? 'ru' })
  } catch {
    return NextResponse.json({ locale: 'ru' })
  }
}

// PATCH { locale: "ru" | "en" | "uk" } — persist the current user's UI language.
export async function PATCH(req: Request) {
  try {
    const session = await auth()
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    const body = await req.json().catch(() => ({}))
    const locale = body?.locale
    if (!isLocale(locale)) return NextResponse.json({ error: 'Invalid locale' }, { status: 400 })
    await prisma.user.update({ where: { email: session.user.email }, data: { locale } })
    const res = NextResponse.json({ ok: true, locale })
    // Mirror the DB value into a long-lived cookie so the login page / first SSR pick the same language.
    res.cookies.set(LOCALE_COOKIE, locale, { path: '/', maxAge: LOCALE_COOKIE_MAX_AGE, sameSite: 'lax' })
    return res
  } catch {
    return NextResponse.json({ error: 'Request failed' }, { status: 500 })
  }
}
