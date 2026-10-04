export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { buildSeasonPlotV2Parts, normalizeSynopsisLanguage, normalizeEpisodesCount, synopsisLanguageFromCode } from "@/lib/idea-v2";
import { translatePlotRefines } from "@/lib/translate-en";
import { denyFeature, hasText } from "@/lib/feature-gate";

/**
 * POST /api/ai/v2/plot/preview  { projectId, synopsis?, synopsisLanguage?, episodesCount?, refine?, plot?, plotBase?, plotTurns? }
 *
 * Шаг 3 v2, просмотр промпта: system / user и реальная цепочка messages сюжета сезона — ровно как в генерации
 * (синопсис как есть, правки — в английском переводе → refineEn). НИЧЕГО не генерирует и не пишет в БД.
 */
const previewSchema = z.object({
  projectId: z.string().min(1),
  synopsis: z.string().max(20000).optional(),
  synopsisLanguage: z.string().max(32).optional(),
  episodesCount: z.coerce.number().optional(),
  plot: z.string().max(120000).optional(),
  refine: z.string().max(4000).optional(),
  plotBase: z.string().max(120000).optional(),
  plotTurns: z.array(z.object({ refine: z.string().max(8000), plot: z.string().max(120000) })).max(50).optional(),
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
    const { projectId, synopsis: synopsisRaw, synopsisLanguage: langRaw, episodesCount: epRaw, plot, refine, plotBase, plotTurns } = parsed.data;

    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true, synopsis: true, seasonPlotV2: true, language: true, episodeCount: true } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const synopsis = (synopsisRaw ?? "").trim() || (project.synopsis ?? "").trim();
    const synopsisLanguage = langRaw ? normalizeSynopsisLanguage(langRaw) : synopsisLanguageFromCode(project.language);
    const episodesCount = normalizeEpisodesCount(epRaw ?? project.episodeCount);
    const { refine: refineEn, plotTurns: turnsEn } = await translatePlotRefines({ refine, plotTurns });
    const currentPlot = (plot ?? "").trim() || (refine ? (project.seasonPlotV2 ?? "").trim() : "") || null;
    const { system, user: userPrompt, assistant, model, contextIncluded, contextNote, messages } = buildSeasonPlotV2Parts({ synopsis, synopsisLanguage, episodesCount, plot: currentPlot, refine: refineEn, plotBase, plotTurns: turnsEn });
    return NextResponse.json(
      { system, user: userPrompt, assistant, model, contextIncluded, contextNote, messages, refineEn: refineEn || undefined, synopsisLanguage, episodesCount },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err: any) {
    console.error("Season plot v2 preview error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
