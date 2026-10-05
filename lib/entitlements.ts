/**
 * Feature entitlements — the single source of truth for which subscription tier unlocks which feature.
 *
 * Subscriptions grant FEATURE ACCESS only (they no longer grant credits — credits are pack-only).
 * WITHOUT an active subscription the user can do NOTHING (no project creation, no generation, no manual mode):
 * Basic is the entry ticket; Pro/Studio unlock the premium features below on top of it.
 *
 * Add a new capability by extending `Feature` and `FEATURE_MIN_TIER` (and `FEATURE_LABELS` for UI).
 * Admin / test accounts (lib/admin.ts) bypass every gate — pass `email` in `EntitlementUser` for that.
 */
import { isAdminEmail } from "@/lib/admin";

export type Feature =
  | "auto_generate" // create projects & run the automatic v2 pipeline (idea → synopsis → plot → episodes); Basic+ only
  | "prompt_instruct_edit" // revise a result with a natural-language instruction ("what to change") — synopsis/plot/script/appearance
  | "manual_mode" // /manual page + /api/manual/* (standalone photo/video generation)
  | "manual_prompt_edit" // edit / regenerate prompts inside manual mode
  | "prompt_view" // see the raw generation prompts (preview modals, «Промпт» buttons)
  | "prompt_edit" // edit & save raw generation prompts (overrides for synopsis/plot/script/shots/storyboard/scenes/refs)
  | "own_references"; // upload own reference images for characters/locations (face photo, "use as reference")

/** Subscription tiers, lowest → highest. "free" means no active subscription. */
export type Tier = "free" | "basic" | "pro" | "studio";

/** Ordered tier hierarchy — index encodes rank (free=0 < basic=1 < pro=2 < studio=3). */
export const TIER_ORDER: readonly Tier[] = ["free", "basic", "pro", "studio"];

/**
 * Minimum tier required to use each feature.
 * Basic  — automatic generation only (no instruction edits, no prompts, no manual mode).
 * Pro    — + edits by instruction + manual mode (incl. manual prompt edit).
 * Studio — + view/edit raw prompts + own character/location references.
 * Free (no active subscription) — nothing: `auto_generate` requires Basic, so every generation route and
 * project creation return 403 subscription_required (credits are kept and usable once a subscription is active).
 */
export const FEATURE_MIN_TIER: Record<Feature, Tier> = {
  auto_generate: "basic",
  prompt_instruct_edit: "pro",
  manual_mode: "pro",
  manual_prompt_edit: "pro",
  prompt_view: "studio",
  prompt_edit: "studio",
  own_references: "studio",
};

/** Human-readable labels for UI / pricing (RU + EN). */
export const FEATURE_LABELS: Record<Feature, { ru: string; en: string; uk: string }> = {
  auto_generate: { ru: "Автоматическая генерация сериала", en: "Automatic series generation", uk: "Автоматична генерація серіалу" },
  prompt_instruct_edit: { ru: "Правки промптом", en: "Edits by instruction", uk: "Правки промптом" },
  manual_mode: { ru: "Ручной режим", en: "Manual mode", uk: "Ручний режим" },
  manual_prompt_edit: { ru: "Правка промптов в ручном режиме", en: "Prompt editing in manual mode", uk: "Правка промптів у ручному режимі" },
  prompt_view: { ru: "Просмотр промптов генерации", en: "View generation prompts", uk: "Перегляд промптів генерації" },
  prompt_edit: { ru: "Редактирование промптов генерации", en: "Edit generation prompts", uk: "Редагування промптів генерації" },
  own_references: { ru: "Свои референсы персонажей и локаций", en: "Own character & location references", uk: "Власні референси персонажів і локацій" },
};

/** Display name of a tier (same in RU/EN/UK). */
export const TIER_NAMES: Record<Tier, string> = { free: "Free", basic: "Basic", pro: "Pro", studio: "Studio" };

/** Minimal shape of the user needed to evaluate entitlements. */
export type EntitlementUser = {
  subscriptionTier?: string | null;
  subscriptionExpiresAt?: Date | string | null;
  /** Optional — when present, admin / test accounts (lib/admin.ts) bypass every gate. */
  email?: string | null;
};

function tierRank(tier: string | null | undefined): number {
  if (!tier) return 0;
  const idx = TIER_ORDER.indexOf(tier as Tier);
  return idx < 0 ? 0 : idx;
}

/**
 * True when the user has a subscription tier that is present, not "free", AND not expired.
 * A null/absent `subscriptionExpiresAt` counts as INACTIVE (no open-ended access).
 */
export function hasActiveSubscription(user: EntitlementUser | null | undefined): boolean {
  if (!user) return false;
  const tier = user.subscriptionTier;
  if (!tier || tier === "free") return false;
  const expires = user.subscriptionExpiresAt;
  if (!expires) return false;
  const expiresAt = expires instanceof Date ? expires : new Date(expires);
  if (Number.isNaN(expiresAt.getTime())) return false;
  return expiresAt.getTime() > Date.now();
}

/** True when the user has an active subscription whose tier is high enough for `feature`. */
export function canUse(user: EntitlementUser | null | undefined, feature: Feature): boolean {
  // Admin / test account: everything is available regardless of subscription.
  if (isAdminEmail(user?.email)) return true;
  const required = FEATURE_MIN_TIER[feature];
  if (required === "free") return true;
  if (!hasActiveSubscription(user)) return false;
  return tierRank(user!.subscriptionTier) >= tierRank(required);
}

/** Effective tier of the user ("free" when there is no active subscription). */
export function effectiveTier(user: EntitlementUser | null | undefined): Tier {
  if (isAdminEmail(user?.email)) return "studio";
  if (!hasActiveSubscription(user)) return "free";
  const t = user!.subscriptionTier as Tier;
  return TIER_ORDER.includes(t) ? t : "free";
}

/** Map of every feature → whether the user may use it. Computed server-side and passed to the client UI. */
export type Entitlements = Record<Feature, boolean>;

/** All feature keys (handy for iterating). */
export const FEATURES: readonly Feature[] = [
  "auto_generate",
  "prompt_instruct_edit",
  "manual_mode",
  "manual_prompt_edit",
  "prompt_view",
  "prompt_edit",
  "own_references",
];

/** Entitlements of a user with no access at all (client-side default before the server map arrives). */
export const NO_ENTITLEMENTS: Entitlements = Object.freeze(
  Object.fromEntries(FEATURES.map((f) => [f, false])) as Entitlements
);

/** Compute the full entitlement map for a user (server-side), to hand to client components. */
export function computeEntitlements(user: EntitlementUser | null | undefined): Entitlements {
  return Object.fromEntries(FEATURES.map((f) => [f, canUse(user, f)])) as Entitlements;
}

/** Describes a denied feature for a 403 response. */
export type FeatureDenial = {
  error: "subscription_required";
  feature: Feature;
  requiredTier: Tier;
  /** Human-readable message for toasts/alerts (RU; the UI usually maps `requiredTier` itself). */
  message: string;
};

/**
 * Returns null when the user may use `feature`, otherwise a denial object ready to be returned
 * as `NextResponse.json(denial, { status: 403 })`.
 */
export function requireFeature(
  user: EntitlementUser | null | undefined,
  feature: Feature
): FeatureDenial | null {
  if (canUse(user, feature)) return null;
  const requiredTier = FEATURE_MIN_TIER[feature];
  return { error: "subscription_required", feature, requiredTier, message: `Доступно с тарифа ${TIER_NAMES[requiredTier]}` };
}
