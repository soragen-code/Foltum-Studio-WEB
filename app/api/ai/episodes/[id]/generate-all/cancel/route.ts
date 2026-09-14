export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

const hasPredictionId = (resultData: string | null) => !!resultData && resultData.includes('"predictionId":');

/**
 * POST /api/ai/episodes/[id]/generate-all/cancel — Stage 11.
 *
 * Stops the batch video auto-continuation for an episode:
 *  - every video job that has NOT yet submitted a Replicate prediction (pending/processing,
 *    no predictionId) is flagged cancelRequested and moved to "canceled" so the continue
 *    planner never resubmits it and no new charge happens;
 *  - jobs whose prediction is already live are left alone (Replicate is the provider; the
 *    already-charged clip is allowed to finish — no NEW predictions start after this).
 * The client stops its auto-continue polling on success. Idempotent.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  const episode = await prisma.episode.findFirst({
    where: { id, season: { project: { userId: session.user.id } } },
    include: { scenes: { select: { id: true } } },
  });
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });

  const sceneIds = episode.scenes.map((s) => s.id);
  if (!sceneIds.length) return NextResponse.json({ ok: true, canceled: 0, keptRunning: 0 });

  const activeJobs = await prisma.generationJob.findMany({
    where: { sceneId: { in: sceneIds }, type: "video", status: { in: ["pending", "processing"] } },
    select: { id: true, resultData: true, sceneId: true },
  });

  let canceled = 0;
  let keptRunning = 0;
  for (const job of activeJobs) {
    if (hasPredictionId(job.resultData)) {
      // A live Replicate prediction — flag it so its worker won't re-queue, but let the clip finish.
      await prisma.generationJob.update({ where: { id: job.id }, data: { cancelRequested: true } }).catch(() => {});
      keptRunning++;
    } else {
      // Never submitted → cancel outright so the planner won't resubmit and no charge happens.
      await prisma.generationJob.update({ where: { id: job.id }, data: { cancelRequested: true, status: "canceled", message: "Generation canceled" } }).catch(() => {});
      if (job.sceneId) await prisma.scene.update({ where: { id: job.sceneId }, data: { status: "pending" } }).catch(() => {});
      canceled++;
    }
  }

  return NextResponse.json({ ok: true, canceled, keptRunning });
}
