export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { isGenerationProvider } from "@/lib/validations";

/**
 * PATCH /api/ai/projects/[id]/providers { imageProvider?, videoProvider? }
 * Stage 73: per-project generation provider — separately for reference images and scene videos.
 * Allowed values: replicate | wavespeed | modelark. Returns both current values.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:providers", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as { imageProvider?: unknown; videoProvider?: unknown } | null;
  if (!body || (body.imageProvider === undefined && body.videoProvider === undefined)) {
    return NextResponse.json({ error: "Ожидается imageProvider и/или videoProvider" }, { status: 400 });
  }
  const data: { imageProvider?: string; videoProvider?: string } = {};
  if (body.imageProvider !== undefined) {
    if (!isGenerationProvider(body.imageProvider)) return NextResponse.json({ error: "Некорректный провайдер изображений: ожидается replicate, wavespeed или modelark" }, { status: 400 });
    data.imageProvider = body.imageProvider;
  }
  if (body.videoProvider !== undefined) {
    if (!isGenerationProvider(body.videoProvider)) return NextResponse.json({ error: "Некорректный провайдер видео: ожидается replicate, wavespeed или modelark" }, { status: 400 });
    data.videoProvider = body.videoProvider;
  }
  const project = await prisma.project.findFirst({ where: { id, userId: session.user.id }, select: { id: true } });
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });
  const updated = await prisma.project.update({ where: { id: project.id }, data, select: { imageProvider: true, videoProvider: true } });
  return NextResponse.json({ ok: true, ...updated });
}
