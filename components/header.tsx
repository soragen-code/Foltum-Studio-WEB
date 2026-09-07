'use client'

import Link from 'next/link'
import { useSession, signOut } from 'next-auth/react'
import { Coins, Film, LogOut, Plus, User, CreditCard } from 'lucide-react'
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'

export function Header() {
  const { data: session, status } = useSession()
  const [credits, setCredits] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)

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
        <Link href="/dashboard" className="flex items-center gap-2">
          <Film className="h-6 w-6 text-primary" />
          <span className="font-display text-lg font-bold tracking-tight">
            <span className="text-primary">Foltum</span> Studio
          </span>
        </Link>

        {session?.user ? (
          <div className="flex items-center gap-3">
            <Link
              href="/project/new"
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground transition hover:brightness-110"
            >
              <Plus className="h-4 w-4" />
              New Project
            </Link>
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
