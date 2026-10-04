export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { failStaleJobs, STALE_JOB_MS } from "@/lib/jobs";

/**
 * GET /api/jobs/[id] — status polling for a GenerationJob (v2 pipeline + /manual).
 * (v1-specific resume hooks — video/season jobs, characters/scene includes — removed with flow 1.)
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  let job = await prisma.generationJob.findUnique({ where: { id } });
  // Stale processing job (function was killed) → mark failed so the UI stops waiting
  if (job && ["pending", "processing"].includes(job.status) && Date.now() - job.updatedAt.getTime() > STALE_JOB_MS) {
    await failStaleJobs({ projectId: job.projectId, type: job.type });
    job = await prisma.generationJob.findUnique({ where: { id } });
  }
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  let result: any = null;
  if (job.resultData) { try { result = JSON.parse(job.resultData); } catch {} }

  return NextResponse.json(
    { job: { ...job, result } },
    { headers: { "Cache-Control": "no-store" } }
  );
}
