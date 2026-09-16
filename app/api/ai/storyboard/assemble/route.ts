export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800; // download + concatenation of 12-15 board clips can take a while

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, storyboardAssembleSchema } from "@/lib/validations";
import { assembleStoryboardVideo } from "@/lib/assemble";
import { completeJob, failJob, heartbeatJob, runInBackground, updateJob } from "@/lib/jobs";
import { STORYBOARD_ASSEMBLE_JOB_TYPE } from "@/lib/workers/storyboard-job";
import { DEFAULT_ASSEMBLE_FPS, DEFAULT_ASSEMBLE_QUALITY } from "@/lib/assemble-options";

const HEARTBEAT_MS = 45_000;

/**
 * Stage 127 — POST /api/ai/storyboard/assemble  →  { jobId }
 *
 * Stitch a Storyboard episode's 12-15 animated board clips (in board order) into one ~90s cut with
 * hard cuts (no fades, Stage 117) and one thematic music track — mirrors the Scenes assemble flow but
 * reads Board.videoUrl instead of Scene videos. Idempotent: one active stitch per episode.
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:storyboard-assemble", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const parsed = await parseBody(request, storyboardAssembleSchema);
    if (!parsed.ok) return parsed.response;
    const { episodeId } = parsed.data;
    const quality = parsed.data.quality ?? DEFAULT_ASSEMBLE_QUALITY;
    const fps = parsed.data.fps ?? DEFAULT_ASSEMBLE_FPS;

    // Scope to the owner and require Storyboard mode before stitching.
    const owned = await prisma.episode.findFirst({
      where: { id: episodeId, mode: "STORYBOARD", season: { project: { user: { email: session.user.email } } } },
      select: { id: true, season: { select: { projectId: true } } },
    });
    if (!owned) return NextResponse.json({ error: "Storyboard episode not found" }, { status: 404 });
    const projectId = owned.season.projectId;

    // One active stitch per episode — return the running job instead of starting a second one.
    const active = await prisma.generationJob.findMany({
      where: { projectId, type: STORYBOARD_ASSEMBLE_JOB_TYPE, status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, resultData: true },
    });
    for (const j of active) {
      try { if (JSON.parse(j.resultData ?? "{}")?.episodeId === episodeId) return NextResponse.json({ jobId: j.id }); } catch {}
    }

    const job = await prisma.generationJob.create({
      data: {
        type: STORYBOARD_ASSEMBLE_JOB_TYPE,
        status: "processing",
        progress: 0,
        message: "Preparing",
        projectId,
        resultData: JSON.stringify({ episodeId, quality, fps }),
      },
    });
    const jobId = job.id;

    runInBackground(async () => {
      const hb = setInterval(() => void heartbeatJob(jobId), HEARTBEAT_MS);
      try {
        const result = await assembleStoryboardVideo(episodeId, {
          quality,
          fps,
          onProgress: (progress, message) => updateJob(jobId, { progress, message }),
        });
        await completeJob(
          jobId,
          { episodeId, quality, fps, videoUrl: result.videoUrl, sceneCount: result.sceneCount, mood: result.mood, musicApplied: result.musicApplied, musicPlan: result.musicPlan, musicSummary: result.musicSummary, musicError: result.musicError, note: result.note },
          result.note ?? "Storyboard assembled"
        );
      } catch (err: any) {
        console.error("Storyboard assembly error:", err);
        await failJob(jobId, err?.message ?? "Storyboard assembly failed");
      } finally {
        clearInterval(hb);
      }
    });

    return NextResponse.json({ jobId });
  } catch (err: any) {
    console.error("Storyboard assembly error:", err);
    return NextResponse.json({ error: err?.message ?? "Assembly failed" }, { status: 500 });
  }
}
