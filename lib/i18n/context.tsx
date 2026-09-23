'use client'

/**
 * Client-side i18n: a React context that holds the current UI locale and a `t()` translator.
 *
 * The initial locale comes from the logged-in user's session (User.locale, threaded through auth.ts),
 * falling back to "ru". Changing the language persists to the DB (PATCH /api/user/locale) and updates
 * the provider state immediately so all text switches without a reload.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useSession } from 'next-auth/react'
import { DEFAULT_LOCALE, isLocale, translate, type Locale } from './dictionary'

type Ctx = {
  locale: Locale
  setLocale: (l: Locale) => Promise<void>
  t: (key: string, params?: Record<string, string | number>) => string
}

const LocaleContext = createContext<Ctx | null>(null)

export function LocaleProvider({ children, initialLocale }: { children: React.ReactNode; initialLocale?: Locale }) {
  const { data: session } = useSession()
  const [locale, setLocaleState] = useState<Locale>(initialLocale ?? DEFAULT_LOCALE)

  // Adopt the session's locale once it hydrates (e.g. after login / on first client render). Only overrides
  // the default until the user has explicitly changed the language this session.
  const [userTouched, setUserTouched] = useState(false)
  useEffect(() => {
    const sessLocale = (session?.user as any)?.locale
    if (!userTouched && isLocale(sessLocale)) setLocaleState(sessLocale)
  }, [session, userTouched])

  const setLocale = useCallback(async (l: Locale) => {
    setUserTouched(true)
    setLocaleState(l)
    try {
      await fetch('/api/user/locale', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: l }),
      })
    } catch {
      /* keep the optimistic UI change even if persistence fails */
    }
  }, [])

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(locale, key, params),
    [locale],
  )

  const value = useMemo<Ctx>(() => ({ locale, setLocale, t }), [locale, setLocale, t])

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useTranslation(): Ctx {
  const ctx = useContext(LocaleContext)
  if (!ctx) {
    // Safe fallback if a component renders outside the provider — always returns Russian.
    return {
      locale: DEFAULT_LOCALE,
      setLocale: async () => {},
      t: (key, params) => translate(DEFAULT_LOCALE, key, params),
    }
  }
  return ctx
}
