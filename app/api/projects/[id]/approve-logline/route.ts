export const dynamic = "force-dynamic";
export const maxDuration = 800; // the synopsis job runs in the background of this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runSynopsisJob, SYNOPSIS_JOB_TYPE } from "@/lib/workers/synopsis-job";

/**
 * POST /api/projects/[id]/approve-logline  { logline? }
 *
 * STEP 1 → STEP 2 of the 3-step approval flow. Approves the logline (optionally the producer's edited
 * text), then kicks off the season-synopsis generation FROM THE APPROVED LOGLINE as a background job —
 * exactly like /api/ai/idea does. The project stays on stage="logline" until runSynopsisJob completes and
 * flips it to stage="synopsis"; the client polls GET /api/ai/idea for that transition. Returns { jobId }.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const editedLogline = typeof body?.logline === "string" ? body.logline.trim() : "";

    const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const project = await prisma.project.findFirst({ where: { id, userId: user.id } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (project.synopsisApproved || project.charactersApproved)
      return NextResponse.json({ error: "The story is already past the idea step" }, { status: 409 });

    const logline = editedLogline || (project.logline ?? "").trim();
    if (!logline) return NextResponse.json({ error: "No logline to approve" }, { status: 400 });

    await prisma.project.update({
      where: { id },
      data: { logline, loglineApproved: true },
    });

    // Kick the synopsis generation FROM the approved logline (mirrors /api/ai/idea POST). Idempotent:
    // reap dead jobs, reuse an active one so a double-click / refresh never starts a second job.
    await failStaleJobs({ projectId: id, type: SYNOPSIS_JOB_TYPE });
    const active = await prisma.generationJob.findFirst({
      where: { projectId: id, type: SYNOPSIS_JOB_TYPE, status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const job = await prisma.generationJob.create({
      data: { type: SYNOPSIS_JOB_TYPE, status: "pending", progress: 0, message: "Starting…", projectId: id },
    });
    runInBackground(() =>
      runSynopsisJob(job.id, id, { idea: logline, episodeCount: project.episodeCount ?? undefined })
    );
    return NextResponse.json({ jobId: job.id, resumed: false });
  } catch (err: any) {
    console.error("Approve logline error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
