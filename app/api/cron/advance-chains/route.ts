export const dynamic = "force-dynamic";
export const maxDuration = 800; // may host a resumed video finalization via after()

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authorizeCron, failStaleJobs, JOB_MAX_DURATION } from "@/lib/jobs";
import { resumeVideoJob } from "@/lib/workers/video-job";
import { advanceChainScene } from "@/lib/chain-advance";
import { chainSceneToResume } from "@/lib/chain-run";

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
 * This cron makes the chain keep going with NO browser open, idempotently:
 *   1. Every "processing" video job is resumed once (lease-guarded, one provider check per call). A
 *      finished prediction gets finalized here → `finalizeVideoJob` → the next scene of the chain starts.
 *   2. Belt-and-suspenders: any active chain whose EARLIEST ungenerated scene is idle (not already
 *      generating, no in-flight job) is re-armed via `continueChainRun`. This covers the case where no
 *      video job exists at all (e.g. the `after()` invocation died before the next job was created).
 *
 * The sequential invariant is preserved: `chainSceneToResume` only ever returns the lowest-numbered
 * not-yet-generated scene and only when it is idle, so the sweeper never starts N+1 before N is done and
 * never double-starts. `resumeVideoJob` and `continueChainRun` each carry their own idempotency guards.
 *
 * Guarded: only the scheduler (Vercel `Authorization: Bearer $CRON_SECRET`) or an internal caller with
 * the worker secret (`x-worker-secret`) may invoke it — never an unauthenticated generation trigger.
 */
export async function GET(request: Request) {
  if (!authorizeCron(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const summary = { staleFailed: 0, resumed: 0, rearmed: 0 };
  try {
    // Clean up dead, non-recoverable jobs first. Video/season jobs that hold a live provider handle are
    // deliberately skipped by failStaleJobs — they are advanced by resume/poll recovery, not by age.
    summary.staleFailed = await failStaleJobs({});

    // 1) Resume every quiet video job once. Finalizes completed predictions and, via finalizeVideoJob,
    //    starts the next scene of any active chain.
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

    // 2) Re-arm stalled chains: an active chain whose earliest ungenerated scene has no in-flight job.
    const episodes = await prisma.episode.findMany({
      where: { chainRunActive: true },
      select: {
        id: true,
        scenes: {
          orderBy: { number: "asc" },
          select: { id: true, number: true, videoUrl: true, videoPrompt: true, status: true },
        },
      },
    });
    for (const ep of episodes) {
      try {
        const sceneIds = ep.scenes.map((s) => s.id);
        const activeJobs = sceneIds.length
          ? await prisma.generationJob.findMany({
              where: { sceneId: { in: sceneIds }, type: "video", status: { in: ["pending", "processing"] } },
              select: { sceneId: true },
            })
          : [];
        const activeSceneIds = new Set(activeJobs.map((j) => j.sceneId));
        const scenes = ep.scenes.map((s) => ({ ...s, hasActiveJob: activeSceneIds.has(s.id) }));
        const target = chainSceneToResume({ chainRunActive: true, scenes });
        if (target) {
          // finishedSceneNumber = target-1 so advanceChainScene's nextChainScene() re-selects exactly this
          // scene; advanceChainScene re-checks for an active job before charging (extra idempotency).
          if (await advanceChainScene(ep.id, target.number - 1)) summary.rearmed++;
        }
      } catch (err) {
        console.error("[cron/advance-chains] re-arm failed:", err);
      }
    }
  } catch (err) {
    console.error("[cron/advance-chains] sweep error:", err);
    return NextResponse.json({ ok: false, error: "sweep failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ...summary }, { headers: { "Cache-Control": "no-store" } });
}
