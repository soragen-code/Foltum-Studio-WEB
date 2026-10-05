export const dynamic = "force-dynamic";
export const maxDuration = 800; // задача сюжета сезона крутится в фоне этой инвокации через after()

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { chargeV2Credits } from "@/lib/v2-credits";
import { V2_COSTS } from "@/lib/v2-costs";
import { runSeasonPlotV2Job, SEASON_PLOT_V2_JOB_TYPE } from "@/lib/workers/season-plot-v2-job";
import { normalizeSynopsisLanguage, normalizeEpisodesCount, synopsisLanguageFromCode, isSeasonPlotV2Locked, SEASON_PLOT_V2_LOCKED_ERROR } from "@/lib/idea-v2";
import { denyFeature, hasText } from "@/lib/feature-gate";

/**
 * POST /api/ai/v2/plot  { projectId, synopsis?, synopsisLanguage?, episodesCount?, refine?, plot?, plotBase?, plotTurns?, overrideMessages? }
 *
 * «Новый проект v2.0», шаг 3: утверждённый синопсис → посерийный сюжет сезона (GenerationJob type "season_plot_v2").
 * Синопсис/язык/количество серий — из тела либо из проекта. Идемпотентно: активная задача возвращается как есть.
 */
const turnSchema = z.object({ refine: z.string().max(8000), plot: z.string().max(120000) });
const generateSchema = z.object({
  projectId: z.string().min(1),
  synopsis: z.string().max(20000).optional(),
  synopsisLanguage: z.string().max(32).optional(),
  episodesCount: z.coerce.number().optional(),
  plot: z.string().max(120000).optional(),
  refine: z.string().max(4000).optional(),
  refineEn: z.string().max(8000).optional(),
  plotBase: z.string().max(120000).optional(),
  plotTurns: z.array(turnSchema).max(50).optional(),
  overrideMessages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().max(200000) })).max(101).optional(),
  overrideSystem: z.string().max(60000).optional(),
  overrideUser: z.string().max(60000).optional(),
  overrideAssistant: z.string().max(120000).optional(),
});

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // Без активной подписки (Basic+) генерация недоступна целиком.
    { const dAuto = await denyFeature(session.user.email, "auto_generate"); if (dAuto) return dAuto; }

    const limited = rateLimitByUser(request, "ai:v2:plot", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const body = await request.json().catch(() => null);
    const parsed = generateSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    // Правка инструкцией (refine) — prompt_instruct_edit (Pro+); свой промпт (override*) — prompt_edit (Studio).
    if (hasText(parsed.data.refine) || hasText(parsed.data.refineEn)) { const d = await denyFeature(session.user.email, "prompt_instruct_edit"); if (d) return d; }
    if (Array.isArray(parsed.data.overrideMessages) || hasText((parsed.data as any).overrideSystem) || hasText((parsed.data as any).overrideUser) || hasText((parsed.data as any).overrideAssistant)) { const d = await denyFeature(session.user.email, "prompt_edit"); if (d) return d; }
    const { projectId, synopsis: synopsisRaw, synopsisLanguage: langRaw, episodesCount: epRaw, plot, refine, refineEn, plotBase, plotTurns, overrideMessages, overrideSystem, overrideUser, overrideAssistant } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (project.charactersApproved)
      return NextResponse.json({ error: "Synopsis and characters are already confirmed" }, { status: 409 });
    if (isSeasonPlotV2Locked(project))
      return NextResponse.json({ error: SEASON_PLOT_V2_LOCKED_ERROR, locked: true }, { status: 409 });

    const synopsis = (synopsisRaw ?? "").trim() || (project.synopsis ?? "").trim();
    if (!synopsis) return NextResponse.json({ error: "Synopsis is required" }, { status: 400 });
    const synopsisLanguage = langRaw ? normalizeSynopsisLanguage(langRaw) : synopsisLanguageFromCode(project.language);
    const episodesCount = normalizeEpisodesCount(epRaw ?? project.episodeCount);

    await failStaleJobs({ projectId, type: SEASON_PLOT_V2_JOB_TYPE });
    const active = await prisma.generationJob.findFirst({
      where: { projectId, type: SEASON_PLOT_V2_JOB_TYPE, status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const job = await prisma.generationJob.create({
      data: { type: SEASON_PLOT_V2_JOB_TYPE, status: "pending", progress: 0, message: "Starting...", projectId },
    });
    const charge = await chargeV2Credits(user.id, V2_COSTS.plot, "plot", job.id);
    if (!charge.ok) {
      await prisma.generationJob.delete({ where: { id: job.id } }).catch(() => {});
      return NextResponse.json(charge.body, { status: charge.status });
    }
    const currentPlot = (plot ?? "").trim() || (refine ? (project.seasonPlotV2 ?? "").trim() : "") || null;
    runInBackground(() => runSeasonPlotV2Job(job.id, projectId, { synopsis, synopsisLanguage, episodesCount, plot: currentPlot, refine, refineEn, plotBase, plotTurns, overrideMessages, overrideSystem, overrideUser, overrideAssistant }));
    return NextResponse.json({ jobId: job.id, resumed: false, cost: charge.cost, creditsRemaining: charge.creditsRemaining });
  } catch (err: any) {
    console.error("Season plot v2 generation error:", err);
    return NextResponse.json({ error: "Generation failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

/** GET /api/ai/v2/plot?projectId=... → последняя задача сюжета сезона (возобновление после перезагрузки). */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Без активной подписки (Basic+) генерация недоступна целиком.
  { const dAuto = await denyFeature(session.user.email, "auto_generate"); if (dAuto) return dAuto; }

  const projectId = new URL(request.url).searchParams.get("projectId") ?? "";
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true } });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  await failStaleJobs({ projectId, type: SEASON_PLOT_V2_JOB_TYPE });
  const latest = await prisma.generationJob.findFirst({ where: { projectId, type: SEASON_PLOT_V2_JOB_TYPE }, orderBy: { createdAt: "desc" } });
  let result: any = null;
  if (latest?.resultData) { try { result = JSON.parse(latest.resultData); } catch {} }
  return NextResponse.json({ job: latest ? { ...latest, result } : null }, { headers: { "Cache-Control": "no-store" } });
}
