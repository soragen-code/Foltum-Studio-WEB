import { cookies } from 'next/headers'
import { auth } from '@/auth'
import { DEFAULT_LOCALE, isLocale, type Locale } from './dictionary'

/** Cookie mirroring User.locale — lets logged-out pages (login/register) and the first SSR render use the same language. */
export const LOCALE_COOKIE = 'ui_locale'
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/**
 * UI locale for the current request, resolved on the server: signed-in user's DB value (via the session),
 * else the `ui_locale` cookie, else "ru". Used by the root layout so the initial HTML is already localized.
 */
export async function resolveRequestLocale(): Promise<Locale> {
  try {
    const session = await auth()
    const fromSession = (session?.user as { locale?: unknown } | undefined)?.locale
    if (isLocale(fromSession)) return fromSession
  } catch { /* unauthenticated or auth failure — fall through to the cookie */ }
  try {
    const fromCookie = (await cookies()).get(LOCALE_COOKIE)?.value
    if (isLocale(fromCookie)) return fromCookie
  } catch { /* no request scope */ }
  return DEFAULT_LOCALE
}
