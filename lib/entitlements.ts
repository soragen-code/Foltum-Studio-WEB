/**
 * Feature entitlements — the single source of truth for which subscription tier unlocks which feature.
 *
 * Subscriptions grant FEATURE ACCESS only (they no longer grant credits — credits are pack-only).
 * A user can generate video in the base 480p quality with purchased credits WITHOUT any subscription;
 * a subscription unlocks the premium features below on top of that.
 *
 * Add a new capability by extending `Feature` and `FEATURE_MIN_TIER` (and `FEATURE_LABELS` for UI).
 */

export type Feature =
  | "own_face" // upload a real reference photo for a character's face
  | "scene_prompt_edit" // revise a scene with a natural-language instruction
  | "manual_prompt_edit" // manually edit / regenerate the final scene prompt (whole or per-block)
  | "premium_quality"; // assemble the final episode in 720p / 1080p (base is always 480p)

/** Subscription tiers, lowest → highest. "free" means no active subscription. */
export type Tier = "free" | "basic" | "pro" | "studio";

/** Ordered tier hierarchy — index encodes rank (free=0 < basic=1 < pro=2 < studio=3). */
export const TIER_ORDER: readonly Tier[] = ["free", "basic", "pro", "studio"];

/** Minimum active tier required to use each feature. */
export const FEATURE_MIN_TIER: Record<Feature, Exclude<Tier, "free">> = {
  own_face: "basic",
  scene_prompt_edit: "basic",
  manual_prompt_edit: "basic",
  premium_quality: "pro",
};

/** Human-readable RU labels for UI / pricing. */
export const FEATURE_LABELS: Record<Feature, string> = {
  own_face: "Своё лицо персонажа",
  scene_prompt_edit: "Редактирование сцены промптом",
  manual_prompt_edit: "Ручная правка промпта",
  premium_quality: "Премиум-качество (720p / 1080p)",
};

/** Minimal shape of the user needed to evaluate entitlements. */
export type EntitlementUser = {
  subscriptionTier?: string | null;
  subscriptionExpiresAt?: Date | string | null;
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
  if (!hasActiveSubscription(user)) return false;
  const required = FEATURE_MIN_TIER[feature];
  return tierRank(user!.subscriptionTier) >= tierRank(required);
}

/** Map of every feature → whether the user may use it. Computed server-side and passed to the client UI. */
export type Entitlements = Record<Feature, boolean>;

/** All feature keys (handy for iterating). */
export const FEATURES: readonly Feature[] = [
  "own_face",
  "scene_prompt_edit",
  "manual_prompt_edit",
  "premium_quality",
];

/** Compute the full entitlement map for a user (server-side), to hand to client components. */
export function computeEntitlements(user: EntitlementUser | null | undefined): Entitlements {
  return {
    own_face: canUse(user, "own_face"),
    scene_prompt_edit: canUse(user, "scene_prompt_edit"),
    manual_prompt_edit: canUse(user, "manual_prompt_edit"),
    premium_quality: canUse(user, "premium_quality"),
  };
}

/** Describes a denied feature for a 403 response. */
export type FeatureDenial = {
  error: "subscription_required";
  feature: Feature;
  requiredTier: Exclude<Tier, "free">;
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
  return { error: "subscription_required", feature, requiredTier: FEATURE_MIN_TIER[feature] };
}
