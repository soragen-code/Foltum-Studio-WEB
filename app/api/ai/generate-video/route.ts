export const dynamic = "force-dynamic";
export const maxDuration = 800; // Vercel Pro / Fluid compute max — background job runs inside this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runVideoJob } from "@/lib/workers/video-job";

/** Tier determines credit cost AND video quality */
const VIDEO_TIERS: Record<string, { cost: number; duration: number; resolution: string }> = {
  minimum: { cost: 1, duration: 5, resolution: "480p" },
  medium: { cost: 3, duration: 5, resolution: "720p" },
  maximum: { cost: 8, duration: 10, resolution: "720p" },
};

/**
 * POST /api/ai/generate-video  { projectId, sceneId }
 *
 * 1. Validates credits, deducts them
 * 2. Creates a GenerationJob (type "video") and starts the job in the background (after())
 * 3. Returns { jobId } immediately — the frontend polls GET /api/jobs/[jobId]
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const { projectId, sceneId } = await request.json();

    const project = await prisma.project.findFirst({ where: { id: projectId } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const config = VIDEO_TIERS[project.tier] ?? VIDEO_TIERS.minimum;

    const sceneData = await prisma.scene.findUnique({ where: { id: sceneId } });
    if (!sceneData) return NextResponse.json({ error: "Scene not found" }, { status: 404 });
    if (!sceneData.videoPrompt)
      return NextResponse.json({ error: "Scene has no video prompt" }, { status: 400 });

    // Dead jobs (killed function) must not block new generations
    await failStaleJobs({ sceneId, type: "video" });

    // Already running for this scene? Return the existing job instead of charging again.
    const active = await prisma.generationJob.findFirst({
      where: { sceneId, type: "video", status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    if ((user.credits ?? 0) < config.cost) {
      return NextResponse.json(
        { error: `Not enough credits. Need ${config.cost}, have ${user.credits ?? 0}` },
        { status: 400 }
      );
    }

    // Deduct credits (refunded by the worker if generation fails)
    await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: config.cost } } });
    await prisma.creditTransaction.create({
      data: {
        userId: user.id,
        amount: -config.cost,
        description: `Video generation for scene ${sceneData.number} (${project.tier} tier)`,
      },
    });

    await prisma.scene.update({ where: { id: sceneId }, data: { status: "generating" } });

    const job = await prisma.generationJob.create({
      data: {
        type: "video",
        status: "processing",
        progress: 2,
        message: "Queued — starting video model...",
        projectId,
        sceneId,
      },
    });

    // Runs after the response is flushed; Vercel keeps this invocation alive up to maxDuration
    runInBackground(() =>
      runVideoJob({
        jobId: job.id,
        sceneId,
        projectId,
        userId: user.id,
        cost: config.cost,
        duration: config.duration,
        resolution: config.resolution,
      })
    );

    return NextResponse.json({ jobId: job.id, creditsRemaining: (user.credits ?? 0) - config.cost });
  } catch (err: any) {
    console.error("Video generation error:", err);
    return NextResponse.json(
      { error: "Video generation failed: " + (err?.message ?? "Unknown error") },
      { status: 500 }
    );
  }
}
