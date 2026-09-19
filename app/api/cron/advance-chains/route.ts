export const dynamic = "force-dynamic";
export const maxDuration = 800; // may host a resumed video finalization via after()

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authorizeCron, failStaleJobs, JOB_MAX_DURATION } from "@/lib/jobs";
import { resumeVideoJob } from "@/lib/workers/video-job";

// Keep the route-level maxDuration in step with the shared constant used by other job hosts.
void JOB_MAX_DURATION;

/**
 * Stage 153 — server-side sequential-generation sweeper (Vercel cron).
 *
 * Sequential scene chains ("Сгенерировать все") already advance server-side: after a scene publishes,
 * `finalizeVideoJob` charges and starts the next pending scene. But that hand-off only fires once a long
 * provider prediction is FINALIZED, which historically depended on the browser polling
 * GET /api/jobs/[id] (which calls `resumeVideoJob`). If the user closes the tab, a finished prediction
 * is never picked up, the scene is never published, and the whole chain stalls.
 *
 * This cron makes the chain keep going with NO browser open, idempotently: every "processing" video
 * job is resumed once (lease-guarded, one provider check per call). A finished prediction gets finalized
 * here → `finalizeVideoJob` → `continueShotChain` starts the next shot of the chain. `resumeVideoJob`
 * carries its own idempotency guard, so the sweeper never double-finalizes a job.
 *
 * (The legacy scene re-arm step was removed together with the rest of the legacy scene video path in
 * Stage167 commit 1/3.)
 *
 * Guarded: only the scheduler (Vercel `Authorization: Bearer $CRON_SECRET`) or an internal caller with
 * the worker secret (`x-worker-secret`) may invoke it — never an unauthenticated generation trigger.
 */
export async function GET(request: Request) {
  if (!authorizeCron(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const summary = { staleFailed: 0, resumed: 0 };
  try {
    // Clean up dead, non-recoverable jobs first. Video/season jobs that hold a live provider handle are
    // deliberately skipped by failStaleJobs — they are advanced by resume/poll recovery, not by age.
    summary.staleFailed = await failStaleJobs({});

    // Resume every quiet video job once. Finalizes completed predictions and, via finalizeVideoJob →
    // continueShotChain, starts the next shot of any active chain.
    const videoJobs = await prisma.generationJob.findMany({
      where: { type: "video", status: "processing" },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    for (const job of videoJobs) {
      try {
        if (await resumeVideoJob(job)) summary.resumed++;
      } catch (err) {
        console.error("[cron/advance-chains] resume failed:", err);
      }
    }
  } catch (err) {
    console.error("[cron/advance-chains] sweep error:", err);
    return NextResponse.json({ ok: false, error: "sweep failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ...summary }, { headers: { "Cache-Control": "no-store" } });
}
