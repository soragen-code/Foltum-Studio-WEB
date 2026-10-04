export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { buildEpisodeScriptV2Parts, seasonPlotEpisodeSummary, episodeScriptV2From, synopsisLanguageFromCode, seriesContinuityBlockV2 } from "@/lib/idea-v2";
import { translateScriptRefines } from "@/lib/translate-en";

/**
 * POST /api/ai/v2/script/preview  { projectId, episode, refine?, scriptBase?, scriptTurns? }
 * Просмотр промпта сценария серии — ровно как в генерации (buildEpisodeScriptV2Parts). Ничего не генерирует и не пишет в БД.
 */
const previewSchema = z.object({
  projectId: z.string().min(1),
  episode: z.coerce.number().int().min(1).max(999),
  refine: z.string().max(4000).optional(),
  scriptBase: z.string().max(60000).optional(),
  scriptTurns: z.array(z.object({ refine: z.string().max(8000), script: z.string().max(60000) })).max(50).optional(),
});

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const parsed = previewSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const { projectId, episode, refine, scriptBase, scriptTurns } = parsed.data;

    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true, seasonPlotV2: true, language: true, episodeScriptsV2: true, episodeRefsV2: true } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    const summary = seasonPlotEpisodeSummary(project.seasonPlotV2, episode);
    if (!summary) return NextResponse.json({ error: "Episode not found in season plot" }, { status: 404 });

    const synopsisLanguage = synopsisLanguageFromCode(project.language);
    const { refine: refineEn, scriptTurns: turnsEn } = await translateScriptRefines({ refine, scriptTurns });
    const script = refine ? episodeScriptV2From(project.episodeScriptsV2, episode) || null : null;
    const { system, user: userPrompt, assistant, model, contextIncluded, contextNote, messages } = buildEpisodeScriptV2Parts({ summary, synopsisLanguage, script, refine: refineEn, scriptBase, scriptTurns: turnsEn, continuity: seriesContinuityBlockV2(project.episodeRefsV2, project.episodeScriptsV2, episode) });
    return NextResponse.json(
      { system, user: userPrompt, assistant, model, contextIncluded, contextNote, messages, refineEn: refineEn || undefined, synopsisLanguage, episode },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err: any) {
    console.error("Episode script v2 preview error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
