/**
 * Server-side i18n for API routes: user-facing error messages are translated into the caller's UI locale.
 * The locale is taken from the NextAuth session (auth.ts threads User.locale into session.user.locale),
 * or from a `User.locale` column value when only a DB row is at hand (e.g. lib/v2-credits.ts).
 * Falls back to "ru" (DEFAULT_LOCALE) for anything unknown.
 */
import { DEFAULT_LOCALE, isLocale, translate, type Locale } from './dictionary'

/** Normalize an unknown value (session field / DB column) to a supported Locale. */
export function localeOf(v: unknown): Locale {
  return isLocale(v) ? v : DEFAULT_LOCALE
}

/** Locale of the signed-in user from a NextAuth session object (session.user.locale). */
export function sessionLocale(session: { user?: object | null } | null | undefined): Locale {
  return localeOf((session?.user as { locale?: unknown } | null | undefined)?.locale)
}

/** Translator bound to a locale: `const t = serverT(sessionLocale(session)); t('api.needScript')`. */
export function serverT(locale: Locale) {
  return (key: string, params?: Record<string, string | number>) => translate(locale, key, params)
}
