'use client'

import Link from 'next/link'
import { useSession, signOut } from 'next-auth/react'
import { Coins, Film, LogOut, Plus, User, CreditCard, Crown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { hasActiveSubscription } from '@/lib/entitlements'

// Stage 76: optional project context — when `projectName` is set, the sticky header shows
// "Foltum Studio / <project name>" (the name links back to the project's main page).
export function Header({ showNewProject = true, projectName = null, projectId = null }: { showNewProject?: boolean; projectName?: string | null; projectId?: string | null } = {}) {
  const { data: session, status } = useSession()
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
          {projectName && (
            <>
              <span className="shrink-0 text-muted-foreground/60" aria-hidden="true">/</span>
              <Link
                href={`/project/${projectId ?? ''}`}
                title={projectName}
                className="font-display truncate max-w-[40vw] text-base font-semibold tracking-tight text-foreground hover:text-primary sm:max-w-[420px]"
                data-testid="header-project-name"
              >
                {projectName}
              </Link>
            </>
          )}
        </div>

        {session?.user ? (
          <div className="flex items-center gap-3">
            {showNewProject && (
              <Link
                href="/project/new"
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110"
              >
                <Plus className="h-4 w-4" />
                New Project
              </Link>
            )}
            {activeSub ? (
              <Link
                href="/pricing"
                title={`Активная подписка: ${tierLabel}`}
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
                Оформить подписку
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
                    <CreditCard className="h-4 w-4" /> Plans & Credits
                  </Link>
                  <button
                    onClick={() => signOut({ redirectTo: '/login' })}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-destructive hover:bg-muted"
                  >
                    <LogOut className="h-4 w-4" /> Sign Out
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
              Sign In
            </Link>
            <Link
              href="/signup"
              className="rounded-lg bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110"
            >
              Get Started
            </Link>
          </div>
        )}
      </div>
    </header>
  )
}
