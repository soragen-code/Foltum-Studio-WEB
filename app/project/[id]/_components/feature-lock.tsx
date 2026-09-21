'use client'

import Link from 'next/link'
import { Lock } from 'lucide-react'

/**
 * Small RU "locked feature" hint shown next to a feature that requires a subscription.
 * Purely visual — the server enforces the gate (returns 403). It does not remove functionality,
 * it only signals that access is closed and links to the pricing page.
 */
export function FeatureLockBadge({
  text,
  className = '',
}: {
  text: string
  className?: string
}) {
  return (
    <Link
      href="/pricing"
      className={`inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-500 transition hover:bg-amber-500/20 ${className}`}
      title="Открыть по подписке"
      data-testid="feature-lock-badge"
    >
      <Lock className="h-3 w-3" />
      {text}
    </Link>
  )
}
