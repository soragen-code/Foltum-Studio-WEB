export const dynamic = "force-dynamic";
export const maxDuration = 800; // синопсис-задача крутится в фоне этой инвокации через after()

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runSynopsisV2Job, SYNOPSIS_V2_JOB_TYPE } from "@/lib/workers/synopsis-v2-job";

/**
 * POST /api/ai/v2/synopsis  { projectId, idea? | genres?, overrideMessages? }
 *
 * «Новый проект v2.0»: идея / жанры → синопсис (7–10 предложений) моделью «Claude Fable 5.1».
 * Создаёт фоновую GenerationJob (type "synopsis_v2") и сразу возвращает { jobId }; фактическая
 * генерация идёт в фоне (after()) через runSynopsisV2Job, клиент поллит GET /api/jobs/[id].
 * Идемпотентно: активная задача возвращается как есть. Если пользователь смотрел/правил промпт,
 * передаются overrideSystem/overrideUser (раздельно) — воркер отправит именно их двумя messages.
 */
const generateSchema = z.object({
  projectId: z.string().min(1),
  idea: z.string().trim().max(20000).optional(),
  genres: z.array(z.string().max(80)).max(30).optional(),
  overrideMessages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(60000) })).max(101).optional(),
  overrideSystem: z.string().max(60000).optional(),
  overrideUser: z.string().max(60000).optional(),
  overrideAssistant: z.string().max(60000).optional(),
});

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:v2:synopsis", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const body = await request.json().catch(() => null);
    const parsed = generateSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const { projectId, idea, genres, overrideMessages, overrideSystem, overrideUser, overrideAssistant } = parsed.data;

    if (!(idea && idea.trim()) && !(genres && genres.length))
      return NextResponse.json({ error: "Provide an idea or at least one genre" }, { status: 400 });

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (project.charactersApproved)
      return NextResponse.json({ error: "Synopsis and characters are already confirmed" }, { status: 409 });

    // Реапаем мёртвые задачи, затем переиспользуем активную (идемпотентность — рефреш не должен плодить задачи).
    await failStaleJobs({ projectId, type: SYNOPSIS_V2_JOB_TYPE });
    const active = await prisma.generationJob.findFirst({
      where: { projectId, type: SYNOPSIS_V2_JOB_TYPE, status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const job = await prisma.generationJob.create({
      data: { type: SYNOPSIS_V2_JOB_TYPE, status: "pending", progress: 0, message: "Starting…", projectId },
    });
    // v2: синопсис строится на основе утверждённого логлайна (если он есть).
    const logline = project.loglineApproved && project.logline?.trim() ? project.logline.trim() : null;
    runInBackground(() => runSynopsisV2Job(job.id, projectId, { idea, genres, logline, overrideMessages, overrideSystem, overrideUser, overrideAssistant }));
    return NextResponse.json({ jobId: job.id, resumed: false });
  } catch (err: any) {
    console.error("Synopsis v2 generation error:", err);
    return NextResponse.json({ error: "Generation failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

/**
 * GET /api/ai/v2/synopsis?projectId=… → последняя v2-задача синопсиса проекта (для возобновления
 * прогресса/стрима после перезагрузки страницы).
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const projectId = new URL(request.url).searchParams.get("projectId") ?? "";
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true } });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  await failStaleJobs({ projectId, type: SYNOPSIS_V2_JOB_TYPE });
  const latest = await prisma.generationJob.findFirst({
    where: { projectId, type: SYNOPSIS_V2_JOB_TYPE },
    orderBy: { createdAt: "desc" },
  });
  let result: any = null;
  if (latest?.resultData) { try { result = JSON.parse(latest.resultData); } catch {} }
  return NextResponse.json(
    { job: latest ? { ...latest, result } : null },
    { headers: { "Cache-Control": "no-store" } }
  );
}
