export const dynamic = "force-dynamic";
// Stage 92: the scene breakdown is now written by gpt-6-astra (SCRIPT_MODEL) in a background
// GenerationJob (see lib/workers/scenes-job.ts) — the astra generation runs in the background of
// this invocation via after(), so the route needs the long-job maxDuration.
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, scenesSchema } from "@/lib/validations";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runScenesJob, SCENES_JOB_TYPE } from "@/lib/workers/scenes-job";

/**
 * POST /api/ai/scenes  { projectId, episodeId }  →  { jobId, resumed }
 *
 * Stage 92 — the ~12-shot scene breakdown is written by gpt-6-astra. A gpt-6-astra completion of a
 * full breakdown takes minutes and a synchronous call dies at ~300 s (undici headers timeout), so
 * this step now runs as a resumable GenerationJob (type "scenes"): the route validates, guards
 * against duplicate jobs, creates the job and returns its id immediately; runScenesJob() then runs
 * in the background of this invocation (after()) and the client polls GET /api/jobs/[id].
 * Idempotent: an active scenes job for the same episode is returned as-is (a refresh must not start
 * a second one, nor charge/re-run anything).
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:scenes", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const parsed = await parseBody(request, scenesSchema);
    if (!parsed.ok) return parsed.response;
    const { projectId, episodeId } = parsed.data;

    const episode = await prisma.episode.findUnique({
      where: { id: episodeId },
      include: { season: { include: { project: true } } },
    });
    if (!episode)
      return NextResponse.json({ error: "Episode not found" }, { status: 404 });

    const pid = projectId || episode.season?.projectId;
    if (!pid) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    // Reap dead jobs, then reuse an active one for THIS episode (idempotent — a refresh or a
    // re-select must not start a second breakdown).
    await failStaleJobs({ projectId: pid, type: SCENES_JOB_TYPE });
    const active = await prisma.generationJob.findFirst({
      where: { projectId: pid, type: SCENES_JOB_TYPE, sceneId: null, status: { in: ["pending", "processing"] }, resultData: { contains: `"episodeId":"${episodeId}"` } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const job = await prisma.generationJob.create({
      data: {
        type: SCENES_JOB_TYPE,
        status: "pending",
        progress: 0,
        message: "Starting…",
        projectId: pid,
        // The owning episode id lives in resultData so the idempotency lookup above (and the client
        // resume) can find the right job — GenerationJob has no episodeId column.
        resultData: JSON.stringify({ episodeId }),
      },
    });
    runInBackground(() => runScenesJob(job.id, pid, episodeId));
    return NextResponse.json({ jobId: job.id, resumed: false });
  } catch (err: any) {
    console.error("Scene generation error:", err);
    return NextResponse.json({ error: "Generation failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

/**
 * GET /api/ai/scenes?projectId=…&episodeId=… → the latest scenes job for that episode (with its
 * parsed result), so the client can resume the progress bar / pick up a finished breakdown after a
 * reload or navigation.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") ?? "";
  const episodeId = url.searchParams.get("episodeId") ?? "";
  if (!projectId || !episodeId) return NextResponse.json({ error: "projectId and episodeId required" }, { status: 400 });

  await failStaleJobs({ projectId, type: SCENES_JOB_TYPE });
  const latest = await prisma.generationJob.findFirst({
    where: { projectId, type: SCENES_JOB_TYPE, sceneId: null, resultData: { contains: `"episodeId":"${episodeId}"` } },
    orderBy: { createdAt: "desc" },
  });
  let result: any = null;
  if (latest?.resultData) { try { result = JSON.parse(latest.resultData); } catch {} }
  return NextResponse.json(
    { job: latest ? { ...latest, result } : null },
    { headers: { "Cache-Control": "no-store" } }
  );
}
