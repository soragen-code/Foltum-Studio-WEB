/**
 * Server-side feature gate for API routes: looks the user up by e-mail and returns a ready 403 response
 * (`FeatureDenial` JSON) when the subscription tier is too low, or null when the request may proceed.
 * Keep UI gating in sync via `computeEntitlements` (lib/entitlements.ts) — this is the authoritative check.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireFeature, TIER_NAMES, type Feature } from "@/lib/entitlements";
import { translate } from "@/lib/i18n/dictionary";
import { localeOf } from "@/lib/i18n/server";

export async function denyFeature(email: string, feature: Feature): Promise<NextResponse | null> {
  const user = await prisma.user.findUnique({ where: { email }, select: { email: true, subscriptionTier: true, subscriptionExpiresAt: true, locale: true } });
  const denied = requireFeature(user, feature);
  if (!denied) return null;
  // Localize the human-readable message to the user's UI locale (requireFeature itself stays pure / Russian default).
  const message = translate(localeOf(user?.locale), "ent.lockedTier", { tier: TIER_NAMES[denied.requiredTier] });
  return NextResponse.json({ ...denied, message }, { status: 403 });
}

/** True when `v` is a non-empty instruction / override string (the only case that needs a paid feature). */
export function hasText(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}
