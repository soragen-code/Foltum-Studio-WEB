export const dynamic = "force-dynamic";
export const maxDuration = 800; // извлечение рефов крутится в фоне этой инвокации через after()

import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { chargeV2Credits } from "@/lib/v2-credits";
import { V2_COSTS } from "@/lib/v2-costs";
import { runEpisodeRefsV2Job, EPISODE_REFS_V2_JOB_TYPE } from "@/lib/workers/episode-refs-v2-job";
import { episodeScriptV2From, episodeRefsV2From, synopsisLanguageFromCode } from "@/lib/idea-v2";
import { activeEpisodeJob, latestEpisodeJob, patchEpisodeRefV2 } from "@/lib/episode-refs-v2-store";
import { denyFeature, hasText } from "@/lib/feature-gate";

/**
 * Поток v2 · вкладка «Референсы» серии n.
 * POST  { projectId, episode }            → извлечь рефы из сценария (GenerationJob "episode_refs_v2"; идемпотентно по серии).
 * GET   ?projectId&episode                → { job (последняя задача извлечения), items (рефы серии) }.
 * PATCH { projectId, episode, id, prompt } → сохранить правку EN-промпта (edited=true — не перезатирается при повторном извлечении).
 */
const postSchema = z.object({ projectId: z.string().min(1), episode: z.coerce.number().int().min(1).max(999) });
const patchSchema = postSchema.extend({ id: z.string().min(1).max(200), prompt: z.string().max(8000) });

async function ownedProject(email: string, projectId: string) {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return null;
  return prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true, userId: true, language: true, episodeScriptsV2: true, episodeRefsV2: true } });
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:v2:refs", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;
    const parsed = postSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const { projectId, episode } = parsed.data;

    const project = await ownedProject(session.user.email, projectId);
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    const script = episodeScriptV2From(project.episodeScriptsV2, episode);
    if (!script?.trim()) return NextResponse.json({ error: "Сначала сгенерируйте сценарий" }, { status: 400 });

    await failStaleJobs({ projectId, type: EPISODE_REFS_V2_JOB_TYPE });
    const active = await activeEpisodeJob(projectId, EPISODE_REFS_V2_JOB_TYPE, episode);
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const job = await prisma.generationJob.create({
      data: { type: EPISODE_REFS_V2_JOB_TYPE, status: "pending", progress: 0, message: "Starting...", projectId, resultData: JSON.stringify({ episode }) },
    });
    const charge = await chargeV2Credits(project.userId, V2_COSTS.refsExtract, "refs-extract", job.id);
    if (!charge.ok) {
      await prisma.generationJob.delete({ where: { id: job.id } }).catch(() => {});
      return NextResponse.json(charge.body, { status: charge.status });
    }
    runInBackground(() => runEpisodeRefsV2Job(job.id, projectId, { episode, script, synopsisLanguage: synopsisLanguageFromCode(project.language) }));
    return NextResponse.json({ jobId: job.id, resumed: false, cost: charge.cost, creditsRemaining: charge.creditsRemaining });
  } catch (err: any) {
    console.error("Episode refs v2 extraction error:", err);
    return NextResponse.json({ error: "Extraction failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
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

  await failStaleJobs({ projectId, type: EPISODE_REFS_V2_JOB_TYPE });
  const job = await latestEpisodeJob(projectId, EPISODE_REFS_V2_JOB_TYPE, episode);
  return NextResponse.json({ job, items: episodeRefsV2From(project.episodeRefsV2, episode) }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const deniedEdit = await denyFeature(session.user.email, "prompt_edit"); if (deniedEdit) return deniedEdit; // правка EN-промпта рефа — Studio
    const { projectId, episode, id, prompt } = parsed.data;
    const project = await ownedProject(session.user.email, projectId);
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    const updated = await patchEpisodeRefV2(projectId, episode, id, { prompt, edited: true, promptDirty: true });
    if (!updated) return NextResponse.json({ error: "Reference not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("Episode refs v2 patch error:", err);
    return NextResponse.json({ error: "Save failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
