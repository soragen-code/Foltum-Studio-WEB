'use client'

import Link from 'next/link'
import { useSession, signOut } from 'next-auth/react'
import { Coins, Film, LogOut, User, CreditCard, Crown, Languages, Check } from 'lucide-react'
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { hasActiveSubscription } from '@/lib/entitlements'
import { useTranslation } from '@/lib/i18n/context'
import { LOCALES, LOCALE_LABELS } from '@/lib/i18n/dictionary'

// Stage 76: optional project context — when `projectName` is set, the sticky header shows
// "Foltum Studio / <project name>" (the name links back to the project's main page).
export function Header({ projectName = null, projectId = null }: { projectName?: string | null; projectId?: string | null } = {}) {
  const { data: session, status } = useSession()
  const { t, locale, setLocale } = useTranslation()
  const [credits, setCredits] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)

  // Active subscription (tier + expiry come from the session — see auth.ts callbacks).
  const sessionUser = session?.user as any
  const activeSub = hasActiveSubscription({
    subscriptionTier: sessionUser?.subscriptionTier,
    subscriptionExpiresAt: sessionUser?.subscriptionExpiresAt,
  })
  const tierRaw = (sessionUser?.subscriptionTier as string | null | undefined) ?? ''
  const tierLabel = tierRaw ? tierRaw.charAt(0).toUpperCase() + tierRaw.slice(1) : ''

  useEffect(() => {
    if (session?.user) {
      fetch('/api/user/credits')
        .then((r) => r.json())
        .then((d: any) => setCredits(d?.credits ?? 0))
        .catch(() => {})
    }
  }, [session])

  if (status === 'loading') return null

  return (
    <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Link href="/dashboard" className="flex shrink-0 items-center gap-2">
            <Film className="h-6 w-6 text-primary" />
            <span className="font-display text-lg font-bold tracking-tight">
              <span className="text-primary">Foltum</span> Studio
            </span>
          </Link>
        </div>

        {session?.user ? (
          <div className="flex items-center gap-3">
            {activeSub ? (
              <Link
                href="/pricing"
                title={t('nav.activeSub', { tier: tierLabel })}
                className="flex items-center gap-1.5 rounded-full bg-primary/15 px-3 py-1.5 text-sm font-semibold text-primary transition hover:bg-primary/25"
                data-testid="header-plan-badge"
              >
                <Crown className="h-4 w-4" />
                {tierLabel}
              </Link>
            ) : (
              <Link
                href="/pricing"
                className="hidden items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:text-foreground sm:flex"
                data-testid="header-subscribe-link"
              >
                {t('nav.subscribe')}
              </Link>
            )}
            <Link
              href="/pricing"
              className="flex items-center gap-1.5 rounded-lg bg-muted px-3 py-1.5 text-sm font-medium transition hover:bg-muted/80"
            >
              <Coins className="h-4 w-4 text-primary" />
              <span className="font-mono text-primary">{credits}</span>
            </Link>

            <div className="relative">
              <button
                onClick={() => setMenuOpen(!menuOpen)}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-muted transition hover:bg-muted/80"
              >
                <User className="h-4 w-4" />
              </button>
              {menuOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="absolute right-0 top-full mt-2 w-48 rounded-lg border border-border bg-card p-1"
                  style={{ boxShadow: 'var(--shadow-lg)' }}
                >
                  <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
                    {session?.user?.email ?? ''}
                  </div>
                  <Link
                    href="/pricing"
                    onClick={() => setMenuOpen(false)}
                    className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted"
                  >
                    <CreditCard className="h-4 w-4" /> {t('nav.plansCredits')}
                  </Link>
                  {/* Language switcher — persists to User.locale via PATCH /api/user/locale and switches the UI instantly. */}
                  <div className="border-t border-border pt-1 mt-1">
                    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
                      <Languages className="h-3.5 w-3.5" /> {t('common.language')}
                    </div>
                    {LOCALES.map((lc) => (
                      <button
                        key={lc}
                        onClick={() => { setLocale(lc) }}
                        className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted"
                        data-testid={`header-locale-${lc}`}
                      >
                        <span>{LOCALE_LABELS[lc]}</span>
                        {locale === lc && <Check className="h-4 w-4 text-primary" />}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => signOut({ redirectTo: '/login' })}
                    className="mt-1 flex w-full items-center gap-2 rounded-md border-t border-border px-3 py-2 text-sm text-destructive hover:bg-muted"
                  >
                    <LogOut className="h-4 w-4" /> {t('nav.signOut')}
                  </button>
                </motion.div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="rounded-lg px-4 py-1.5 text-sm font-medium transition hover:bg-muted"
            >
              {t('nav.signIn')}
            </Link>
            <Link
              href="/signup"
              className="rounded-lg bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110"
            >
              {t('nav.getStarted')}
            </Link>
          </div>
        )}
      </div>
    </header>
  )
}
