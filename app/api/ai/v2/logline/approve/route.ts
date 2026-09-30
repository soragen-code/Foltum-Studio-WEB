export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { LOGLINE_V2_STAGE } from "@/lib/idea-v2";

/**
 * POST /api/ai/v2/logline/approve  { projectId, logline }
 *
 * «Новый проект v2.0»: пользователь утверждает логлайн (возможно, отредактированный). Сохраняем
 * текст и loglineApproved=true; стадия остаётся "logline_v2" до готовности синопсиса (его генерацию
 * клиент запускает сразу после аппрува через POST /api/ai/v2/synopsis — он возьмёт этот логлайн за основу).
 */
const approveSchema = z.object({
  projectId: z.string().min(1),
  logline: z.string().trim().min(10).max(2000),
});

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await request.json().catch(() => null);
    const parsed = approveSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Логлайн слишком короткий или пустой" }, { status: 400 });
    const { projectId, logline } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: user.id },
      select: { id: true, charactersApproved: true },
    });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (project.charactersApproved)
      return NextResponse.json({ error: "Synopsis and characters are already confirmed" }, { status: 409 });

    await prisma.project.update({
      where: { id: projectId },
      data: { logline, loglineApproved: true, synopsis: null, synopsisApproved: false, stage: LOGLINE_V2_STAGE },
    });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("Logline v2 approve error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
