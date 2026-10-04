'use client'

import { createContext, useContext, type ReactNode } from 'react'
import Link from 'next/link'
import { Lock } from 'lucide-react'
import { FEATURE_MIN_TIER, NO_ENTITLEMENTS, TIER_NAMES, type Entitlements, type Feature } from '@/lib/entitlements'
import { useTranslation } from '@/lib/i18n/context'

/**
 * Client-side access to the server-computed entitlement map (see lib/entitlements.ts).
 * Pages compute `computeEntitlements(user)` on the server and wrap their client tree in <EntitlementsProvider>.
 * Outside a provider everything but auto-generation is treated as locked (safe default — never over-grants).
 */
const Ctx = createContext<Entitlements>(NO_ENTITLEMENTS)

export function EntitlementsProvider({ value, children }: { value: Entitlements; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useEntitlements(): Entitlements {
  return useContext(Ctx)
}

/** True when the current user may use `feature`. */
export function useFeature(feature: Feature): boolean {
  return useContext(Ctx)[feature] === true
}

/** Localized «Доступно с тарифа Pro/Studio» for tooltips (title=) and hints. */
export function useLockHint(): (feature: Feature) => string {
  const { t } = useTranslation()
  return (feature) => t('ent.lockedTier', { tier: TIER_NAMES[FEATURE_MIN_TIER[feature]] })
}

/** Small inline lock badge with the required tier, linking to /pricing. */
export function LockedBadge({ feature, className = '' }: { feature: Feature; className?: string }) {
  const hint = useLockHint()
  return (
    <Link
      href="/pricing"
      className={`inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-muted ${className}`}
      data-testid={`locked-${feature}`}
      title={hint(feature)}
    >
      <Lock className="h-3 w-3" /> {hint(feature)}
    </Link>
  )
}
