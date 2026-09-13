export const dynamic = "force-dynamic";
export const maxDuration = 800; // the synopsis job runs in the background of this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, ideaSchema } from "@/lib/validations";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runSynopsisJob, SYNOPSIS_JOB_TYPE } from "@/lib/workers/synopsis-job";

/**
 * POST /api/ai/idea  { projectId, idea | auto+genres | fromStory+story, extras?, episodeCount? }
 *
 * Stage 1 of the new flow: idea → synopsis. This used to run the LLM synchronously and hold the
 * client's fetch open for the whole generation — if the producer left the page the request aborted
 * and the UI showed «Ошибка сети» even though the server had (or would have) finished.
 *
 * It now creates a background GenerationJob (type "synopsis") and returns { jobId } immediately;
 * the actual generation runs via runSynopsisJob() in the background of this invocation (after()),
 * and the frontend polls GET /api/jobs/[id]. Idempotent: an active job is returned as-is.
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:idea", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const parsed = await parseBody(request, ideaSchema);
    if (!parsed.ok) return parsed.response;
    const { projectId, idea, auto, genres, extras, fromStory, story, episodeCount } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (project.charactersApproved)
      return NextResponse.json({ error: "Synopsis and characters are already confirmed" }, { status: 409 });

    // Reap dead jobs, then reuse an active one (idempotent — a refresh must not start a second job).
    await failStaleJobs({ projectId, type: SYNOPSIS_JOB_TYPE });
    const active = await prisma.generationJob.findFirst({
      where: { projectId, type: SYNOPSIS_JOB_TYPE, status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const job = await prisma.generationJob.create({
      data: { type: SYNOPSIS_JOB_TYPE, status: "pending", progress: 0, message: "Запуск…", projectId },
    });
    runInBackground(() => runSynopsisJob(job.id, projectId, { idea, auto, genres, extras, fromStory, story, episodeCount }));
    return NextResponse.json({ jobId: job.id, resumed: false });
  } catch (err: any) {
    console.error("Idea generation error:", err);
    return NextResponse.json({ error: "Generation failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

/**
 * GET /api/ai/idea?projectId=… → the latest synopsis job for the project (with its parsed result),
 * so the client can resume the progress bar / pick up a finished synopsis after a reload or navigation.
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

  await failStaleJobs({ projectId, type: SYNOPSIS_JOB_TYPE });
  const latest = await prisma.generationJob.findFirst({
    where: { projectId, type: SYNOPSIS_JOB_TYPE },
    orderBy: { createdAt: "desc" },
  });
  let result: any = null;
  if (latest?.resultData) { try { result = JSON.parse(latest.resultData); } catch {} }
  return NextResponse.json(
    { job: latest ? { ...latest, result } : null },
    { headers: { "Cache-Control": "no-store" } }
  );
}
