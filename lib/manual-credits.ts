/**
 * Stage 234 — shared auth + credit charge helpers for the manual-mode API routes.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";

export interface ManualUser { id: string; email: string; credits: number }

/** Resolve the signed-in user (401 otherwise) and apply the AI rate limit. */
export async function requireManualUser(request: Request, scope: string): Promise<{ user: ManualUser } | { response: NextResponse }> {
  const session = await auth();
  if (!session?.user?.email) return { response: NextResponse.json({ error: "Login required" }, { status: 401 }) };
  const limited = rateLimitByUser(request, scope, session.user.email, RATE_LIMITS.ai);
  if (limited) return { response: limited };
  const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true, email: true, credits: true } });
  if (!user) return { response: NextResponse.json({ error: "User not found" }, { status: 404 }) };
  return { user: { id: user.id, email: user.email, credits: user.credits ?? 0 } };
}

/** Charge `cost` credits or return a 402 response. */
export async function chargeCredits(user: ManualUser, cost: number, description: string): Promise<NextResponse | null> {
  if (user.credits < cost) {
    return NextResponse.json({ error: `Not enough credits. Need ${cost}, have ${user.credits}` }, { status: 402 });
  }
  await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: cost } } });
  await prisma.creditTransaction.create({ data: { userId: user.id, amount: -cost, description } });
  return null;
}

/** Clean a list of reference URLs (http(s) only, deduped, capped). */
export function cleanUrls(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const u of v) {
    if (typeof u === "string" && /^https?:\/\//i.test(u.trim()) && u.length < 2000 && !out.includes(u.trim())) out.push(u.trim());
    if (out.length >= max) break;
  }
  return out;
}
