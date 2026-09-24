export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireManualUser, cleanUrls } from "@/lib/manual-credits";

/**
 * Stage 234h — Location Generator persistence.
 *
 * GET  /api/manual/locations           → { items } (the user's saved locations, newest first)
 * POST /api/manual/locations           → create a saved location entity from already-generated plates.
 *
 * Plate images are the S3 URLs returned by /api/manual/photo (each plate is a real manual photo job that
 * already persisted its result to S3), so no extra upload happens here — we only store the URLs + labels.
 * Generation itself reuses the existing manual photo pipeline (client orchestrates FRONT → back/left/right).
 */

function str(v: unknown, max = 500): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export async function GET(request: Request) {
  const authed = await requireManualUser(request, "manual:locations");
  if ("response" in authed) return authed.response;
  const items = await prisma.manualLocation.findMany({
    where: { userId: authed.user.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json({ items });
}

export async function POST(request: Request) {
  const authed = await requireManualUser(request, "manual:locations");
  if ("response" in authed) return authed.response;
  const { user } = authed;

  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const name = str(body?.name, 200);
  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  const description = str(body?.description, 4000);
  const frontLabel = str(body?.frontLabel, 200);
  const backLabel = str(body?.backLabel, 200);
  const leftLabel = str(body?.leftLabel, 200);
  const rightLabel = str(body?.rightLabel, 200);
  const [frontUrl] = cleanUrls([body?.frontUrl], 1);
  const [backUrl] = cleanUrls([body?.backUrl], 1);
  const [leftUrl] = cleanUrls([body?.leftUrl], 1);
  const [rightUrl] = cleanUrls([body?.rightUrl], 1);

  const created = await prisma.manualLocation.create({
    data: {
      userId: user.id,
      name,
      description,
      frontLabel,
      backLabel,
      leftLabel,
      rightLabel,
      frontUrl: frontUrl || null,
      backUrl: backUrl || null,
      leftUrl: leftUrl || null,
      rightUrl: rightUrl || null,
    },
  });
  return NextResponse.json({ location: created });
}
