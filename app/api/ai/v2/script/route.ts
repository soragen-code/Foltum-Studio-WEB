export const dynamic = "force-dynamic";
export const maxDuration = 800; // задача сценария крутится в фоне этой инвокации через after()

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { chargeV2Credits } from "@/lib/v2-credits";
import { V2_COSTS } from "@/lib/v2-costs";
import { runEpisodeScriptV2Job, episodeOfScriptJob, EPISODE_SCRIPT_V2_JOB_TYPE } from "@/lib/workers/episode-script-v2-job";
import { seasonPlotEpisodeSummary, episodeScriptV2From, synopsisLanguageFromCode, seriesContinuityBlockV2 } from "@/lib/idea-v2";
import { denyFeature, hasText } from "@/lib/feature-gate";

/**
 * POST /api/ai/v2/script  { projectId, episode, refine?, refineEn?, scriptBase?, scriptTurns?, overrideMessages? }
 *
 * Поток v2, уровень эпизода: краткий сюжет серии (Project.seasonPlotV2 по "#<n>") → сценарий (GenerationJob
 * type "episode_script_v2", resultData.episode = n). Идемпотентно по серии: активная задача серии возвращается как есть.
 */
const generateSchema = z.object({
  projectId: z.string().min(1),
  episode: z.coerce.number().int().min(1).max(999),
  refine: z.string().max(4000).optional(),
  refineEn: z.string().max(8000).optional(),
  scriptBase: z.string().max(60000).optional(),
  scriptTurns: z.array(z.object({ refine: z.string().max(8000), script: z.string().max(60000) })).max(50).optional(),
  overrideMessages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().max(200000) })).max(101).optional(),
});

async function activeJobFor(projectId: string, episode: number) {
  const active = await prisma.generationJob.findMany({
    where: { projectId, type: EPISODE_SCRIPT_V2_JOB_TYPE, status: { in: ["pending", "processing"] } },
    orderBy: { createdAt: "desc" },
  });
  return active.find((j) => episodeOfScriptJob(j) === episode) ?? null;
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:v2:script", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const parsed = generateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    // Правка инструкцией (refine) — prompt_instruct_edit (Pro+); свой промпт (override*) — prompt_edit (Studio).
    if (hasText(parsed.data.refine) || hasText(parsed.data.refineEn)) { const d = await denyFeature(session.user.email, "prompt_instruct_edit"); if (d) return d; }
    if (Array.isArray(parsed.data.overrideMessages) || hasText((parsed.data as any).overrideSystem) || hasText((parsed.data as any).overrideUser) || hasText((parsed.data as any).overrideAssistant)) { const d = await denyFeature(session.user.email, "prompt_edit"); if (d) return d; }
    const { projectId, episode, refine, refineEn, scriptBase, scriptTurns, overrideMessages } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true, seasonPlotV2: true, language: true, episodeScriptsV2: true, episodeRefsV2: true, episodeShotsV2: true } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    const summary = seasonPlotEpisodeSummary(project.seasonPlotV2, episode);
    if (!summary) return NextResponse.json({ error: "Episode not found in season plot" }, { status: 404 });

    await failStaleJobs({ projectId, type: EPISODE_SCRIPT_V2_JOB_TYPE });
    const active = await activeJobFor(projectId, episode);
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const job = await prisma.generationJob.create({
      data: { type: EPISODE_SCRIPT_V2_JOB_TYPE, status: "pending", progress: 0, message: "Starting...", projectId, resultData: JSON.stringify({ episode }) },
    });
    const charge = await chargeV2Credits(user.id, V2_COSTS.script, "script", job.id);
    if (!charge.ok) {
      await prisma.generationJob.delete({ where: { id: job.id } }).catch(() => {});
      return NextResponse.json(charge.body, { status: charge.status });
    }
    const script = refine ? episodeScriptV2From(project.episodeScriptsV2, episode) || null : null;
    runInBackground(() => runEpisodeScriptV2Job(job.id, projectId, {
      episode, summary, synopsisLanguage: synopsisLanguageFromCode(project.language), script, refine, refineEn, scriptBase, scriptTurns, overrideMessages,
      // Имена персонажей/локаций из ранних серий — те же полные имена (имя + фамилия) в этой серии.
      continuity: seriesContinuityBlockV2(project.episodeRefsV2, project.episodeScriptsV2, episode, project.episodeShotsV2),
    }));
    return NextResponse.json({ jobId: job.id, resumed: false, cost: charge.cost, creditsRemaining: charge.creditsRemaining });
  } catch (err: any) {
    console.error("Episode script v2 generation error:", err);
    return NextResponse.json({ error: "Generation failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

/** GET /api/ai/v2/script?projectId=...&episode=n → последняя задача сценария этой серии (возобновление). */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") ?? "";
  const episode = Number(url.searchParams.get("episode"));
  if (!projectId || !Number.isInteger(episode)) return NextResponse.json({ error: "projectId and episode required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true } });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  await failStaleJobs({ projectId, type: EPISODE_SCRIPT_V2_JOB_TYPE });
  const recent = await prisma.generationJob.findMany({ where: { projectId, type: EPISODE_SCRIPT_V2_JOB_TYPE }, orderBy: { createdAt: "desc" }, take: 50 });
  const latest = recent.find((j) => episodeOfScriptJob(j) === episode) ?? null;
  let result: any = null;
  if (latest?.resultData) { try { result = JSON.parse(latest.resultData); } catch {} }
  return NextResponse.json({ job: latest ? { ...latest, result } : null }, { headers: { "Cache-Control": "no-store" } });
}
