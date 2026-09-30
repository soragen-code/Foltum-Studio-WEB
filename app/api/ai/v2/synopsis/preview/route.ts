export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { buildSynopsisV2Parts } from "@/lib/idea-v2";

/**
 * POST /api/ai/v2/synopsis/preview  { projectId, idea? | genres? }
 *
 * «Новый проект v2.0», просмотр промпта: собирает РАЗДЕЛЬНО system и user синопсиса ровно так же,
 * как это сделает генерация, и возвращает их (плюс лейбл модели и индикатор контекста). НИЧЕГО
 * не генерирует и не пишет в БД.
 */
const previewSchema = z.object({
  projectId: z.string().min(1),
  idea: z.string().trim().max(20000).optional(),
  genres: z.array(z.string().max(80)).max(30).optional(),
});

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const body = await request.json().catch(() => null);
    const parsed = previewSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const { projectId, idea, genres } = parsed.data;

    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const { system, user: userPrompt, assistant, model, contextIncluded, contextNote } = buildSynopsisV2Parts({ idea, genres });
    return NextResponse.json(
      { system, user: userPrompt, assistant, model, contextIncluded, contextNote },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err: any) {
    console.error("Synopsis v2 preview error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
