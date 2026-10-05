'use client'

import { createContext, useContext, type ButtonHTMLAttributes, type ReactNode } from 'react'
import Link from 'next/link'
import { Lock } from 'lucide-react'
import { FEATURE_MIN_TIER, NO_ENTITLEMENTS, TIER_NAMES, type Entitlements, type Feature } from '@/lib/entitlements'
import { useTranslation } from '@/lib/i18n/context'

/**
 * Client-side access to the server-computed entitlement map (see lib/entitlements.ts).
 * Pages compute `computeEntitlements(user)` on the server and wrap their client tree in <EntitlementsProvider>.
 * Outside a provider everything is treated as locked (safe default — never over-grants).
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

/** Короткое имя требуемого тарифа для фичи (из FEATURE_MIN_TIER — не хардкодить). */
export function requiredTierName(feature: Feature): string {
  return TIER_NAMES[FEATURE_MIN_TIER[feature]]
}

const TIER_BADGE_CLS: Record<string, string> = {
  basic: 'border-green-500/40 bg-green-500/10 text-green-400',
  pro: 'border-primary/40 bg-primary/10 text-primary',
  studio: 'border-red-500/40 bg-red-500/10 text-red-400',
}

/**
 * Капсула «🔒 Pro» / «🔒 Studio» — ставится ВНУТРИ кнопки справа от текста, когда фича закрыта тарифом.
 * Цвета совпадают с карточками тарифов на /pricing.
 */
export function TierBadge({ feature, className = '' }: { feature: Feature; className?: string }) {
  const tier = FEATURE_MIN_TIER[feature]
  return (
    <span
      className={`ml-1.5 inline-flex items-center gap-0.5 rounded-full border px-1.5 py-px text-[9px] font-bold uppercase leading-tight tracking-wide ${TIER_BADGE_CLS[tier] ?? 'border-border bg-muted/40 text-muted-foreground'} ${className}`}
      data-testid={`tier-badge-${feature}`}
    >
      <Lock className="h-2.5 w-2.5" /> {TIER_NAMES[tier]}
    </span>
  )
}

type GatedButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Фича, которой гейтится кнопка. */
  feature: Feature
  /** Внешнее состояние доступа (если уже посчитано снаружи); по умолчанию берётся из контекста. */
  allowed?: boolean
}

/**
 * Единый паттерн «недостаточная подписка»: кнопка остаётся на месте и выглядит как обычная кнопка проекта
 * (className передаётся как есть), но при отсутствии фичи она disabled + aria-disabled, приглушена,
 * с бейджем требуемого тарифа справа от текста и tooltip «Доступно с тарифа X» (RU/EN).
 * Клик по disabled-кнопке браузер глушит, поэтому ссылка на /pricing не вшивается — только tooltip.
 * С достаточным тарифом рендерится ровно та же <button>, что и раньше (ничего не меняется).
 */
export function GatedButton({ feature, allowed, children, className = '', disabled, title, onClick, ...rest }: GatedButtonProps) {
  const fromCtx = useFeature(feature)
  const hint = useLockHint()
  const ok = allowed ?? fromCtx
  if (ok) {
    return <button className={className} disabled={disabled} title={title} onClick={onClick} {...rest}>{children}</button>
  }
  return (
    <button
      {...rest}
      type={rest.type ?? 'button'}
      disabled
      aria-disabled="true"
      title={hint(feature)}
      className={`${className} cursor-not-allowed opacity-60`}
      data-locked-feature={feature}
    >
      {children}
      <TierBadge feature={feature} />
    </button>
  )
}
