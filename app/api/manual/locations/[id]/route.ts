export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireManualUser, cleanUrls } from "@/lib/manual-credits";

/**
 * Stage 234h — update / delete a saved location entity (owner-scoped).
 * PATCH /api/manual/locations/[id]  → update labels/name/description and/or plate URLs (partial).
 * DELETE /api/manual/locations/[id] → remove the saved location.
 */

function str(v: unknown, max = 500): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authed = await requireManualUser(request, "manual:locations");
  if ("response" in authed) return authed.response;
  const { id } = await params;

  const existing = await prisma.manualLocation.findUnique({ where: { id } });
  if (!existing || existing.userId !== authed.user.id) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }

  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const data: Record<string, unknown> = {};
  if (typeof body?.name === "string" && str(body.name, 200)) data.name = str(body.name, 200);
  if (typeof body?.description === "string") data.description = str(body.description, 4000);
  if (typeof body?.frontLabel === "string") data.frontLabel = str(body.frontLabel, 200);
  if (typeof body?.backLabel === "string") data.backLabel = str(body.backLabel, 200);
  if (typeof body?.leftLabel === "string") data.leftLabel = str(body.leftLabel, 200);
  if (typeof body?.rightLabel === "string") data.rightLabel = str(body.rightLabel, 200);
  if ("frontUrl" in body) data.frontUrl = cleanUrls([body.frontUrl], 1)[0] || null;
  if ("backUrl" in body) data.backUrl = cleanUrls([body.backUrl], 1)[0] || null;
  if ("leftUrl" in body) data.leftUrl = cleanUrls([body.leftUrl], 1)[0] || null;
  if ("rightUrl" in body) data.rightUrl = cleanUrls([body.rightUrl], 1)[0] || null;

  const updated = await prisma.manualLocation.update({ where: { id }, data });
  return NextResponse.json({ location: updated });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authed = await requireManualUser(request, "manual:locations");
  if ("response" in authed) return authed.response;
  const { id } = await params;

  const existing = await prisma.manualLocation.findUnique({ where: { id } });
  if (!existing || existing.userId !== authed.user.id) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }
  await prisma.manualLocation.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
