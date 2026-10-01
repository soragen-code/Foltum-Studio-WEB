export const dynamic = "force-dynamic";
export const maxDuration = 800; // генерация картинок рефов крутится в фоне этой инвокации через after()

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runEpisodeRefImagesV2Job, EPISODE_REF_IMAGES_V2_JOB_TYPE } from "@/lib/workers/episode-ref-images-v2-job";
import { episodeRefsV2From } from "@/lib/idea-v2";
import { activeEpisodeJob, latestEpisodeJob } from "@/lib/episode-refs-v2-store";

/**
 * Поток v2 · картинки рефов серии n.
 * POST { projectId, episode, ids? } → сгенерировать все рефы (ids не задан) или выбранные (GenerationJob "episode_ref_images_v2";
 *      одна активная задача на серию — повторный POST возвращает её).
 * GET  ?projectId&episode           → { job, items } для поллинга/возобновления.
 */
const postSchema = z.object({
  projectId: z.string().min(1),
  episode: z.coerce.number().int().min(1).max(999),
  ids: z.array(z.string().min(1).max(200)).max(200).optional(),
});

async function ownedProject(email: string, projectId: string) {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return null;
  return prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true, episodeRefsV2: true } });
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:v2:refs:images", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;
    const parsed = postSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const { projectId, episode, ids } = parsed.data;

    const project = await ownedProject(session.user.email, projectId);
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    const items = episodeRefsV2From(project.episodeRefsV2, episode);
    const target = ids?.length ? items.filter((r) => ids.includes(r.id)).map((r) => r.id) : items.map((r) => r.id);
    if (!target.length) return NextResponse.json({ error: "No references to generate" }, { status: 400 });

    await failStaleJobs({ projectId, type: EPISODE_REF_IMAGES_V2_JOB_TYPE });
    const active = await activeEpisodeJob(projectId, EPISODE_REF_IMAGES_V2_JOB_TYPE, episode);
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const job = await prisma.generationJob.create({
      data: { type: EPISODE_REF_IMAGES_V2_JOB_TYPE, status: "pending", progress: 0, message: "Starting...", projectId, resultData: JSON.stringify({ episode, total: target.length }) },
    });
    runInBackground(() => runEpisodeRefImagesV2Job(job.id, projectId, { episode, ids: target }));
    return NextResponse.json({ jobId: job.id, resumed: false, total: target.length });
  } catch (err: any) {
    console.error("Episode ref images v2 error:", err);
    return NextResponse.json({ error: "Generation failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") ?? "";
  const episode = Number(url.searchParams.get("episode"));
  if (!projectId || !Number.isInteger(episode)) return NextResponse.json({ error: "projectId and episode required" }, { status: 400 });
  const project = await ownedProject(session.user.email, projectId);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  await failStaleJobs({ projectId, type: EPISODE_REF_IMAGES_V2_JOB_TYPE });
  const job = await latestEpisodeJob(projectId, EPISODE_REF_IMAGES_V2_JOB_TYPE, episode);
  return NextResponse.json({ job, items: episodeRefsV2From(project.episodeRefsV2, episode) }, { headers: { "Cache-Control": "no-store" } });
}
