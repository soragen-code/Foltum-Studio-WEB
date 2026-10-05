/**
 * Credit-pack catalog + tier-aware credit math.
 * Client-safe (no secrets, no Node built-ins) so /pricing can import it directly.
 * Prices are USD and NEVER depend on the tier; only the granted credits do (Studio => x2).
 */

export const CREDIT_PACKAGE_IDS = ["mini", "plus", "max"] as const;
export type CreditPackageId = (typeof CREDIT_PACKAGE_IDS)[number];

export type CreditPackage = { id: CreditPackageId; amount: number; credits: number };

/** Base packs: 150/$9.99, 800/$49.99, 3000/$99.99. */
export const CREDIT_PACKAGES: readonly CreditPackage[] = [
  { id: "mini", amount: 9.99, credits: 150 },
  { id: "plus", amount: 49.99, credits: 800 },
  { id: "max", amount: 99.99, credits: 3000 },
];

/** Studio users get 2x credits per pack at the same price. */
export const STUDIO_CREDITS_MULTIPLIER = 2;

/** Multiplier applied to credit packs for the given effective tier (price is never affected). */
export function creditsMultiplierForTier(tier: string | null | undefined): number {
  return tier === "studio" ? STUDIO_CREDITS_MULTIPLIER : 1;
}

/**
 * Single source of truth for the number of credits a pack grants for a given effective tier.
 * Returns null for unknown pack ids.
 */
export function creditsForPackage(pkgId: string, tier: string | null | undefined): number | null {
  const p = CREDIT_PACKAGES.find((x) => x.id === pkgId);
  if (!p) return null;
  return p.credits * creditsMultiplierForTier(tier);
}
