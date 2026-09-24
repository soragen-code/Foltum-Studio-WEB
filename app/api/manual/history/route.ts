export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireManualUser } from "@/lib/manual-credits";

/** Stage 234 — GET /api/manual/history → { items } (the user's manual generations, newest first, max 60). */
export async function GET(request: Request) {
  const authed = await requireManualUser(request, "manual:history");
  if ("response" in authed) return authed.response;
  const items = await prisma.manualGeneration.findMany({
    where: { userId: authed.user.id },
    orderBy: { createdAt: "desc" },
    take: 60,
  });
  return NextResponse.json({ items, credits: authed.user.credits });
}
