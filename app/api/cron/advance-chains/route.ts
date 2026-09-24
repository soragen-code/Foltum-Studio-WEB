export const dynamic = "force-dynamic";
export const maxDuration = 800; // may host a resumed video finalization via after()

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authorizeCron, failStaleJobs, runInBackground, JOB_MAX_DURATION, STALE_JOB_MS, isCancelRequested, completeJob, heartbeatJob } from "@/lib/jobs";
import { resumeVideoJob } from "@/lib/workers/video-job";
import { resumeManualJob, MANUAL_VIDEO_JOB_TYPE, MANUAL_PHOTO_JOB_TYPE } from "@/lib/workers/manual-job";
import { reconcileEpisodeAssets } from "@/lib/asset-gathering";
import { runStoryboardBoardsJob, STORYBOARD_BOARDS_JOB_TYPE, runBoardImageJob, BOARD_IMAGE_JOB_TYPE } from "@/lib/workers/storyboard-job";

const isHttpUrl = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);

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

  const summary = { staleFailed: 0, resumed: 0, resumedFrames: 0, resumedManual: 0, boardGatesReleased: 0 };
  try {
    // Resume interrupted board keyframe (image) jobs BEFORE failStaleJobs reaps them. A frame POST already
    // enqueues a background job (after()-hosted) rather than rendering synchronously, but nothing used to
    // re-drive a frame job whose hosting serverless invocation was killed mid-render. After STALE_JOB_MS of
    // silence failStaleJobs would mark it "Generation timed out (worker stopped responding)" with no retry —
    // exactly the timeout users saw. Here we pick up every quiet board_image job once: if the board already
    // has a valid image (the render actually finished, only the completion write was lost) we finalize it;
    // otherwise we touch the job (heartbeat, so failStaleJobs skips it this pass) and re-run the idempotent
    // worker in the background. runBoardImageJob overwrites the board's imageUrl and charges no credits, so
    // re-driving never double-bills. This makes frame generation survive a dead worker with no tab open.
    const staleBefore = new Date(Date.now() - STALE_JOB_MS);
    const frameJobs = await prisma.generationJob.findMany({
      where: { type: BOARD_IMAGE_JOB_TYPE, status: { in: ["pending", "processing"] }, updatedAt: { lt: staleBefore } },
      orderBy: { createdAt: "asc" },
      take: 30,
    });
    for (const job of frameJobs) {
      try {
        let boardId: string | null = null;
        try { boardId = JSON.parse(job.resultData ?? "{}")?.boardId ?? null; } catch { boardId = null; }
        if (!boardId || !job.projectId) continue;
        if (await isCancelRequested(job.id)) continue;
        const board = await prisma.board.findUnique({ where: { id: boardId }, select: { imageUrl: true } });
        if (board && isHttpUrl(board.imageUrl)) {
          // Render already produced an image — the completion write was just lost. Finalize the job.
          await completeJob(job.id, { boardId, imageUrl: board.imageUrl }, "Frame ready");
          continue;
        }
        // Not rendered yet — keep the job alive past this failStaleJobs pass and re-drive it in the background.
        await heartbeatJob(job.id);
        runInBackground(() => runBoardImageJob(job.id, job.projectId!, boardId!));
        summary.resumedFrames++;
      } catch (err) {
        console.error("[cron/advance-chains] frame resume failed:", err);
      }
    }

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

    // Resume every quiet manual job (/manual photo & video) once. A manual render whose submitting
    // invocation died keeps rendering on WaveSpeed (its task id is persisted in resultData); this picks
    // it up with NO browser tab open — succeeded → persist+complete, failed → refund, still rendering →
    // heartbeat & leave (given up only after MANUAL_MAX_AGE_MS). Mirrors the video sweep above.
    const manualJobs = await prisma.generationJob.findMany({
      where: { type: { in: [MANUAL_VIDEO_JOB_TYPE, MANUAL_PHOTO_JOB_TYPE] }, status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    for (const job of manualJobs) {
      try {
        await resumeManualJob(job);
        summary.resumedManual++;
      } catch (err) {
        console.error("[cron/advance-chains] manual resume failed:", err);
      }
    }

    // Stage 174 — release storyboard "asset-gathering" gates with NO browser open. Any episode parked at
    // boardGate="assets" is re-reconciled; once its blocking references (characters + locations) are all
    // ready, the gate clears and the board split is kicked off in the background — exactly what the POST
    // /storyboard/boards handler would have done had the user still been watching.
    const gated = await prisma.episode.findMany({
      where: { boardGate: "assets", mode: "STORYBOARD" },
      select: { id: true, season: { select: { projectId: true } } },
      take: 20,
    });
    for (const ep of gated) {
      const projectId = ep.season?.projectId;
      if (!projectId) continue;
      try {
        const recon = await reconcileEpisodeAssets(ep.id);
        if (recon.blockingMissing > 0) continue; // still generating — check again next minute
        await prisma.episode.update({ where: { id: ep.id }, data: { boardGate: null } });
        // Don't double-start: only kick off a split if there is no active one for this episode.
        const active = await prisma.generationJob.findFirst({
          where: {
            projectId,
            type: STORYBOARD_BOARDS_JOB_TYPE,
            status: { in: ["pending", "processing"] },
            resultData: { contains: `"episodeId":"${ep.id}"` },
          },
        });
        if (!active) {
          const job = await prisma.generationJob.create({
            data: {
              type: STORYBOARD_BOARDS_JOB_TYPE,
              status: "pending",
              progress: 0,
              message: "Ассеты готовы — строим кадры…",
              projectId,
              resultData: JSON.stringify({ episodeId: ep.id }),
            },
          });
          runInBackground(() => runStoryboardBoardsJob(job.id, projectId, ep.id));
        }
        summary.boardGatesReleased++;
      } catch (err) {
        console.error("[cron/advance-chains] board gate release failed:", err);
      }
    }
  } catch (err) {
    console.error("[cron/advance-chains] sweep error:", err);
    return NextResponse.json({ ok: false, error: "sweep failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ...summary }, { headers: { "Cache-Control": "no-store" } });
}
