export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { buildLoglineV2Parts } from "@/lib/idea-v2";
import { translateToEnglish } from "@/lib/translate-en";

/**
 * POST /api/ai/v2/logline/preview  { projectId, idea? | genres? }
 * Собирает system/user/assistant логлайна v2 ровно так же, как генерация. Ничего не пишет в БД.
 */
const previewSchema = z.object({
  projectId: z.string().min(1),
  idea: z.string().trim().max(20000).optional(),
  genres: z.array(z.string().max(80)).max(30).optional(),
  wishes: z.string().max(2000).optional(),
  logline: z.string().max(4000).optional(),
  refine: z.string().max(4000).optional(),
  loglineBase: z.string().max(4000).optional(),
  loglineTurns: z.array(z.object({ refine: z.string().max(4000), logline: z.string().max(4000) })).max(50).optional(),
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
    const { projectId, idea, genres, wishes, logline, refine, loglineBase, loglineTurns } = parsed.data;

    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    // Пожелания (режим жанров) пишутся по-русски → в промпт идёт английский перевод. Возвращаем его
    // клиенту (wishesEn): в generate он уйдёт как есть, чтобы промпт совпал с показанным в модалке.
    const wishesEn = await translateToEnglish(wishes);
    const { system, user: userPrompt, assistant, model, contextIncluded, contextNote, messages } = buildLoglineV2Parts({ idea, genres, wishes: wishesEn, logline, refine, loglineBase, loglineTurns });
    // messages — реальный диалог БЕЗ system (правила в первом user; при loglineBase + refine — многоходовый): клиент показывает его как есть.
    return NextResponse.json(
      { system, user: userPrompt, assistant, model, contextIncluded, contextNote, wishesEn: wishesEn || undefined, messages },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err: any) {
    console.error("Logline v2 preview error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
