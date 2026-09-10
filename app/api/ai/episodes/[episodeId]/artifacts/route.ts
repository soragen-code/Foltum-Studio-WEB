export const dynamic = "force-dynamic";
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runArtifactImagesJob } from "@/lib/workers/artifact-images-job";

/**
 * POST /api/ai/episodes/[episodeId]/artifacts
 * Detect this episode's important objects (once, from the script) and generate 2 reference
 * frames per object (C2PA on each). Reference frames are supplementary — no extra credits are
 * charged. Idempotent: while an "artifacts" job for the project is active, returns it.
 */
export async function POST(request: Request, ctx: { params: Promise<{ episodeId: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:episode-artifacts", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const { episodeId } = await ctx.params;
    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const episode = await prisma.episode.findFirst({
      where: { id: episodeId, season: { project: { userId: user.id } } },
      include: { season: { select: { projectId: true } } },
    });
    if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
    const projectId = episode.season.projectId;

    await failStaleJobs({ projectId, type: "artifacts" });
    const active = await prisma.generationJob.findFirst({ where: { projectId, type: "artifacts", status: { in: ["pending", "processing"] } }, orderBy: { createdAt: "desc" } });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const job = await prisma.generationJob.create({
      data: { type: "artifacts", status: "processing", progress: 5, message: "Определяю важные объекты эпизода…", projectId },
    });
    runInBackground(async () => { await runArtifactImagesJob({ jobId: job.id, projectId, episodeId }); });
    return NextResponse.json({ jobId: job.id });
  } catch (err: any) {
    console.error("Episode artifacts error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

/**
 * GET /api/ai/episodes/[episodeId]/artifacts — the episode's artifacts with their frames.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ episodeId: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { episodeId } = await ctx.params;
    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const rows = await prisma.episodeArtifact.findMany({
      where: { episodeId, episode: { season: { project: { userId: user.id } } } },
      include: { artifact: true },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({ artifacts: rows.map((r) => r.artifact) });
  } catch (err: any) {
    console.error("Episode artifacts GET error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
