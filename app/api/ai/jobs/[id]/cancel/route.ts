export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { requestCancel } from "@/lib/jobs";

/**
 * POST /api/ai/jobs/[id]/cancel — Stage 11.
 * Sets `cancelRequested` on a GenerationJob the caller owns. The worker checks the flag
 * at its next resume point and stops taking new units of work, marking the job "canceled"
 * (already-produced artefacts are kept). Idempotent: safe to click repeatedly.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  // Scope to the owner: the job's project must belong to the user.
  const job = await prisma.generationJob.findUnique({ where: { id }, select: { id: true, status: true, projectId: true } });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  const owns = await prisma.project.findFirst({ where: { id: job.projectId, userId: session.user.id }, select: { id: true } });
  if (!owns) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const result = await requestCancel(id);
  return NextResponse.json({ ok: true, result, status: result === "already-finished" ? job.status : "canceled" });
}
