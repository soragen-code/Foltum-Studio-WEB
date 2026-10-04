export const dynamic = "force-dynamic";
export const maxDuration = 800; // задача логлайна крутится в фоне этой инвокации через after()

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { chargeV2Credits } from "@/lib/v2-credits";
import { V2_COSTS } from "@/lib/v2-costs";
import { runLoglineV2Job, LOGLINE_V2_JOB_TYPE } from "@/lib/workers/logline-v2-job";
import { isSeasonPlotV2Locked, SEASON_PLOT_V2_LOCKED_ERROR } from "@/lib/idea-v2";

/**
 * POST /api/ai/v2/logline  { projectId, idea? | genres?, loglineLanguage?, overrideMessages? }
 *
 * «Новый проект v2.0», шаг 2: идея / жанры → логлайн (1 предложение, 25–40 слов, без имён) моделью «Claude Fable 5.1».
 * Создаёт фоновую GenerationJob (type "logline_v2") и сразу возвращает { jobId }. Идемпотентно:
 * активная задача возвращается как есть.
 *
 * GET /api/ai/v2/logline?projectId=... → последняя задача логлайна (возобновление после перезагрузки).
 */
const generateSchema = z.object({
  projectId: z.string().min(1),
  idea: z.string().trim().max(20000).optional(),
  /** Английский перевод идеи из preview — уходит в промпт как есть (паритет с модалкой). */
  ideaEn: z.string().max(40000).optional(),
  /** Язык вывода логлайна ("Russian", "English", …); валидируется whitelist'ом в воркере, дефолт Russian. */
  loglineLanguage: z.string().max(32).optional(),
  genres: z.array(z.string().max(80)).max(30).optional(),
  wishes: z.string().max(2000).optional(),
  /** Английский перевод пожеланий из preview — уходит в промпт как есть (без повторного перевода). */
  wishesEn: z.string().max(4000).optional(),
  logline: z.string().max(4000).optional(),
  refine: z.string().max(4000).optional(),
  /** Английский перевод правки из preview — уходит в промпт как есть. */
  refineEn: z.string().max(8000).optional(),
  loglineBase: z.string().max(4000).optional(),
  loglineTurns: z.array(z.object({ refine: z.string().max(4000), logline: z.string().max(4000) })).max(50).optional(),
  overrideMessages: z.array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string().max(60000) })).max(101).optional(),
  overrideSystem: z.string().max(60000).optional(),
  overrideUser: z.string().max(60000).optional(),
  overrideAssistant: z.string().max(60000).optional(),
});

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:v2:logline", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const body = await request.json().catch(() => null);
    const parsed = generateSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const { projectId, idea, ideaEn, loglineLanguage, genres, wishes, wishesEn, logline, refine, refineEn, loglineBase, loglineTurns, overrideMessages, overrideSystem, overrideUser, overrideAssistant } = parsed.data;

    if (!(idea && idea.trim()) && !(genres && genres.length))
      return NextResponse.json({ error: "Provide an idea or at least one genre" }, { status: 400 });

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (project.charactersApproved)
      return NextResponse.json({ error: "Synopsis and characters are already confirmed" }, { status: 409 });
    if (isSeasonPlotV2Locked(project))
      return NextResponse.json({ error: SEASON_PLOT_V2_LOCKED_ERROR, locked: true }, { status: 409 });

    // Реапаем мёртвые задачи, затем переиспользуем активную (идемпотентность — рефреш не должен плодить задачи).
    await failStaleJobs({ projectId, type: LOGLINE_V2_JOB_TYPE });
    const active = await prisma.generationJob.findFirst({
      where: { projectId, type: LOGLINE_V2_JOB_TYPE, status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const job = await prisma.generationJob.create({
      data: { type: LOGLINE_V2_JOB_TYPE, status: "pending", progress: 0, message: "Starting…", projectId },
    });
    const charge = await chargeV2Credits(user.id, V2_COSTS.logline, "logline", job.id);
    if (!charge.ok) {
      await prisma.generationJob.delete({ where: { id: job.id } }).catch(() => {});
      return NextResponse.json(charge.body, { status: charge.status });
    }
    runInBackground(() => runLoglineV2Job(job.id, projectId, { idea, ideaEn, loglineLanguage, genres, wishes, wishesEn, logline, refine, refineEn, loglineBase, loglineTurns, overrideMessages, overrideSystem, overrideUser, overrideAssistant }));
    return NextResponse.json({ jobId: job.id, resumed: false, cost: charge.cost, creditsRemaining: charge.creditsRemaining });
  } catch (err: any) {
    console.error("Logline v2 generation error:", err);
    return NextResponse.json({ error: "Generation failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

/** GET: последняя v2-задача логлайна проекта. */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const projectId = new URL(request.url).searchParams.get("projectId") ?? "";
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true } });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  await failStaleJobs({ projectId, type: LOGLINE_V2_JOB_TYPE });
  const latest = await prisma.generationJob.findFirst({
    where: { projectId, type: LOGLINE_V2_JOB_TYPE },
    orderBy: { createdAt: "desc" },
  });
  let result: any = null;
  if (latest?.resultData) { try { result = JSON.parse(latest.resultData); } catch {} }
  return NextResponse.json(
    { job: latest ? { ...latest, result } : null },
    { headers: { "Cache-Control": "no-store" } }
  );
}
