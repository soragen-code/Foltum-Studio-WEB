/**
 * Server-side feature gate for API routes: looks the user up by e-mail and returns a ready 403 response
 * (`FeatureDenial` JSON) when the subscription tier is too low, or null when the request may proceed.
 * Keep UI gating in sync via `computeEntitlements` (lib/entitlements.ts) — this is the authoritative check.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireFeature, type Feature } from "@/lib/entitlements";

export async function denyFeature(email: string, feature: Feature): Promise<NextResponse | null> {
  const user = await prisma.user.findUnique({ where: { email }, select: { subscriptionTier: true, subscriptionExpiresAt: true } });
  const denied = requireFeature(user, feature);
  return denied ? NextResponse.json(denied, { status: 403 }) : null;
}

/** True when `v` is a non-empty instruction / override string (the only case that needs a paid feature). */
export function hasText(v: unknown): boolean {
  return typeof v === "string" && v.trim().length > 0;
}
