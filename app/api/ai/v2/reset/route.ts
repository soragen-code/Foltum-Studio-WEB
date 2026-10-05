export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { isSeasonPlotV2Locked, SEASON_PLOT_V2_LOCKED_ERROR } from "@/lib/idea-v2";
import { denyFeature } from "@/lib/feature-gate";

/**
 * POST /api/ai/v2/reset  { projectId }
 *
 * «Новый проект v2.0»: пользователь изменил идею/жанры и подтвердил сброс в модалке-предупреждении.
 * Реально стираем последующие шаги (логлайн + синопсис) в БД и откатываем стадию на "idea",
 * чтобы после перезагрузки страницы старые данные НЕ возвращались.
 */
const schema = z.object({ projectId: z.string().min(1) });

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // Без активной подписки (Basic+) генерация недоступна целиком.
    { const dAuto = await denyFeature(session.user.email, "auto_generate"); if (dAuto) return dAuto; }

    const body = await request.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const { projectId } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: user.id },
      select: { id: true, charactersApproved: true, stage: true, seasonPlotV2: true },
    });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (project.charactersApproved)
      return NextResponse.json({ error: "Synopsis and characters are already confirmed" }, { status: 409 });
    if (isSeasonPlotV2Locked(project))
      return NextResponse.json({ error: SEASON_PLOT_V2_LOCKED_ERROR, locked: true }, { status: 409 });

    await prisma.project.update({
      where: { id: projectId },
      data: { logline: null, loglineApproved: false, synopsis: null, synopsisApproved: false, seasonPlotV2: null, stage: "idea" },
    });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("V2 reset downstream error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
