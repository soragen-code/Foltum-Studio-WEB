export const dynamic = "force-dynamic";
export const maxDuration = 800; // may host a resumed job finalization via after()

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authorizeCron, failStaleJobs, JOB_MAX_DURATION } from "@/lib/jobs";
import { resumeManualJob, MANUAL_VIDEO_JOB_TYPE, MANUAL_PHOTO_JOB_TYPE } from "@/lib/workers/manual-job";
import { resumeEpisodeScenesV2Jobs } from "@/lib/workers/episode-scenes-v2-resume";

// Keep the route-level maxDuration in step with the shared constant used by other job hosts.
void JOB_MAX_DURATION;

/**
 * Server-side job sweeper (Vercel cron, every minute). Keeps background generation going with NO
 * browser tab open:
 *   • v2 «Сцены» (кадры / видео / склейка серии) — переподхват замолчавших job;
 *   • /manual photo & video — переподхват рендеров WaveSpeed;
 *   • failStaleJobs — зачистка мёртвых невосстановимых job.
 * (Пайплайн v1 — video/board/season job'ы — удалён вместе с потоком 1.)
 *
 * Guarded: only the scheduler (Vercel `Authorization: Bearer $CRON_SECRET`) or an internal caller with
 * the worker secret (`x-worker-secret`) may invoke it — never an unauthenticated generation trigger.
 */
export async function GET(request: Request) {
  if (!authorizeCron(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const summary = { staleFailed: 0, resumedManual: 0, v2Scenes: { resumed: 0, gaveUp: 0, canceled: 0 } };
  try {
    // v2 «Сцены» (кадры / видео / склейка): переподхват замолчавших job без открытой вкладки. Воркеры
    // возобновляемые; failStaleJobs эти типы не реапит (CRON_RESUMED_JOB_TYPES) — сдаётся здесь же по лимиту.
    try {
      summary.v2Scenes = await resumeEpisodeScenesV2Jobs();
    } catch (err) {
      console.error("[cron/advance-chains] v2 scenes resume failed:", err);
    }

    // Clean up dead, non-recoverable jobs. Jobs that hold a live provider handle are deliberately
    // skipped by failStaleJobs — they are advanced by resume/poll recovery, not by age.
    summary.staleFailed = await failStaleJobs({});

    // Resume every quiet manual job (/manual photo & video) once. A manual render whose submitting
    // invocation died keeps rendering on WaveSpeed (its task id is persisted in resultData); this picks
    // it up with NO browser tab open — succeeded → persist+complete, failed → refund, still rendering →
    // heartbeat & leave (given up only after MANUAL_MAX_AGE_MS).
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
  } catch (err) {
    console.error("[cron/advance-chains] sweep error:", err);
    return NextResponse.json({ ok: false, error: "sweep failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ...summary }, { headers: { "Cache-Control": "no-store" } });
}
