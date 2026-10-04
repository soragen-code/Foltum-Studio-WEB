export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { buildSynopsisV2Parts, normalizeSynopsisLanguage, normalizeEpisodesCount } from "@/lib/idea-v2";
import { translateToEnglish, translateSynopsisRefines } from "@/lib/translate-en";
import { denyFeature, hasText } from "@/lib/feature-gate";

/**
 * POST /api/ai/v2/synopsis/preview  { projectId, idea? | genres?, wishes?, synopsisLanguage?, episodesCount?, refine?, synopsisBase?, synopsisTurns? }
 *
 * «Новый проект v2.0», просмотр промпта: собирает system / user / assistant и реальную цепочку messages
 * синопсиса ровно так же, как это сделает генерация (идея/пожелания/правки — в английском переводе,
 * перевод возвращается клиенту: ideaEn / wishesEn / refineEn). НИЧЕГО не генерирует и не пишет в БД.
 */
const previewSchema = z.object({
  projectId: z.string().min(1),
  idea: z.string().trim().max(20000).optional(),
  genres: z.array(z.string().max(80)).max(30).optional(),
  wishes: z.string().max(2000).optional(),
  synopsisLanguage: z.string().max(32).optional(),
  episodesCount: z.coerce.number().optional(),
  synopsis: z.string().max(20000).optional(),
  refine: z.string().max(4000).optional(),
  synopsisBase: z.string().max(20000).optional(),
  synopsisTurns: z.array(z.object({ refine: z.string().max(8000), synopsis: z.string().max(20000) })).max(50).optional(),
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
    // Просмотр промптов генерации — фича prompt_view (Studio).
    const deniedView = await denyFeature(session.user.email, "prompt_view");
    if (deniedView) return deniedView;
    const { projectId, idea, genres, wishes, synopsisLanguage: langRaw, episodesCount: epRaw, synopsis, refine, synopsisBase, synopsisTurns } = parsed.data;

    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true, synopsis: true } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const ideaEn = await translateToEnglish(idea);
    const wishesEn = await translateToEnglish(wishes);
    const synopsisLanguage = normalizeSynopsisLanguage(langRaw);
    const episodesCount = normalizeEpisodesCount(epRaw);
    const { refine: refineEn, synopsisTurns: turnsEn } = await translateSynopsisRefines({ refine, synopsisTurns });
    const currentSynopsis = (synopsis ?? "").trim() || (refine ? (project.synopsis ?? "").trim() : "") || null;
    const { system, user: userPrompt, assistant, model, contextIncluded, contextNote, messages } = buildSynopsisV2Parts({ idea: ideaEn, genres, wishes: wishesEn, synopsisLanguage, episodesCount, synopsis: currentSynopsis, refine: refineEn, synopsisBase, synopsisTurns: turnsEn });
    // messages — реальный диалог: system → user (ввод) → assistant (S0) → ... → крайний user (правка); клиент показывает его как есть.
    return NextResponse.json(
      { system, user: userPrompt, assistant, model, contextIncluded, contextNote, messages, ideaEn: ideaEn || undefined, wishesEn: wishesEn || undefined, refineEn: refineEn || undefined, synopsisLanguage, episodesCount },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err: any) {
    console.error("Synopsis v2 preview error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
