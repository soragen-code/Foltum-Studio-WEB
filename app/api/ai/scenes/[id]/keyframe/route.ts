export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { KEYFRAME_JOB_TYPE } from "@/lib/keyframe";
import { runKeyframeJob } from "@/lib/workers/keyframe-job";

/**
 * POST /api/ai/scenes/[id]/keyframe — Stage 104
 *
 * (Re)generate the scene's KEYFRAME: the Seedream still that is the exact opening frame of the shot and
 * seeds the Seedance image-to-video clip. Creates a "scene-keyframe" GenerationJob and runs it in the
 * background; the scene card polls Scene.keyframeStatus / keyframeUrl. The scene's video and last frame
 * are NEVER touched by a keyframe regeneration. No credits are charged for a keyframe.
 *
 * Response: { jobId }. Ownership: scene → episode → season → project → userId.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Login required" }, { status: 401 });

  const limited = rateLimitByUser(request, "ai:scene-keyframe", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;
  const scene = await prisma.scene.findFirst({
    where: { id, episode: { season: { project: { userId: session.user.id } } } },
    select: { id: true, videoPrompt: true, episode: { select: { season: { select: { projectId: true } } } } },
  });
  if (!scene) return NextResponse.json({ error: "Scene not found" }, { status: 404 });
  if (!scene.videoPrompt) return NextResponse.json({ error: "Scene has no video prompt yet" }, { status: 400 });

  await failStaleJobs({ sceneId: id, type: KEYFRAME_JOB_TYPE });
  const active = await prisma.generationJob.findFirst({ where: { sceneId: id, type: KEYFRAME_JOB_TYPE, status: { in: ["pending", "processing"] } } });
  if (active) return NextResponse.json({ error: "A keyframe is already being generated for this scene", jobId: active.id }, { status: 409 });

  const job = await prisma.generationJob.create({
    data: { type: KEYFRAME_JOB_TYPE, status: "processing", progress: 0, message: "Keyframe queued", projectId: scene.episode.season.projectId, sceneId: id },
  });
  await prisma.scene.update({ where: { id }, data: { keyframeStatus: "pending", keyframeError: null } });

  runInBackground(() => runKeyframeJob({ jobId: job.id, sceneId: id }).then(() => undefined, () => undefined));

  return NextResponse.json({ jobId: job.id });
}
