export const dynamic = "force-dynamic";
export const maxDuration = 800; // the Seedream frame is rendered inside this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, storyboardApproveSchema } from "@/lib/validations";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { CHARACTER_REFERENCE_COST } from "@/lib/power-tier";
import { loadStoryboardInput, runStoryboardJob, STORYBOARD_JOB_TYPE } from "@/lib/workers/storyboard-job";

/** Ownership chain scene → episode → season → project → userId; returns the scene with its episode/project ids. */
async function ownedScene(sceneId: string, userId: string) {
  return prisma.scene.findFirst({
    where: { id: sceneId, episode: { season: { project: { userId } } } },
    select: {
      id: true, number: true, videoPrompt: true, storyboardUrl: true, storyboardApproved: true, storyboardPrompt: true,
      episode: { select: { id: true, number: true, sceneMode: true, season: { select: { projectId: true } } } },
    },
  });
}

/**
 * GET /api/ai/scenes/[id]/storyboard — read-only preview of the Seedream prompt EXACTLY as the storyboard
 * worker builds it (same lib/storyboard-prompt.ts) plus the reference kinds. No URLs are exposed and nothing
 * is generated. Response: { prompt, refs: [{kind,id}], continuesPrevious, storyboardUrl, storyboardApproved }.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:scene-prompt", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const { id } = await ctx.params;
  const scene = await ownedScene(id, session.user.id);
  if (!scene) return NextResponse.json({ error: "Сцена не найдена" }, { status: 404 });
  if (!(scene.videoPrompt ?? "").trim()) return NextResponse.json({ error: "У сцены ещё нет видео-промпта" }, { status: 400 });
  try {
    const input = await loadStoryboardInput(scene.id);
    return NextResponse.json({
      prompt: input.built.prompt,
      refs: input.built.refs.map(r => ({ kind: r.kind, id: r.id })),
      continuesPrevious: input.built.continuesPrevious,
      storyboardUrl: scene.storyboardUrl,
      storyboardApproved: scene.storyboardApproved,
      // The prompt the CURRENT frame was actually rendered with (may differ from the live preview after edits).
      renderedPrompt: scene.storyboardPrompt,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Не удалось собрать промпт кадра" }, { status: 400 });
  }
}

/**
 * POST /api/ai/scenes/[id]/storyboard — render (or re-render) the 9:16 storyboard frame of ONE scene.
 * Charges CHARACTER_REFERENCE_COST up front (refunded by the worker on failure/cancel), creates a
 * GenerationJob of type "storyboard" and renders in the background. Response: { jobId, creditsRemaining }.
 * A second call while a frame is already rendering returns the active job ({ jobId, resumed: true }).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:storyboard", session.user.email ?? session.user.id, RATE_LIMITS.ai);
    if (limited) return limited;
    const { id } = await ctx.params;
    const scene = await ownedScene(id, session.user.id);
    if (!scene) return NextResponse.json({ error: "Сцена не найдена" }, { status: 404 });
    if (!(scene.videoPrompt ?? "").trim()) return NextResponse.json({ error: "У сцены ещё нет видео-промпта" }, { status: 400 });
    const projectId = scene.episode.season.projectId;

    await failStaleJobs({ sceneId: scene.id, type: STORYBOARD_JOB_TYPE });
    const active = await prisma.generationJob.findFirst({
      where: { sceneId: scene.id, type: STORYBOARD_JOB_TYPE, status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { id: true, credits: true } });
    if (!user) return NextResponse.json({ error: "Пользователь не найден" }, { status: 404 });
    const cost = CHARACTER_REFERENCE_COST;
    if ((user.credits ?? 0) < cost)
      return NextResponse.json({ error: `Недостаточно кредитов: нужно ${cost}, на балансе ${user.credits ?? 0}` }, { status: 402 });

    await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: cost } } });
    await prisma.creditTransaction.create({
      data: { userId: user.id, amount: -cost, description: `Эпизод ${scene.episode.number}, сцена ${scene.number} — кадр сториборда` },
    });
    const job = await prisma.generationJob.create({
      data: { type: STORYBOARD_JOB_TYPE, status: "processing", progress: 5, message: "Кадр сториборда в очереди…", projectId, sceneId: scene.id },
    });

    runInBackground(async () => {
      await runStoryboardJob({ jobId: job.id, sceneId: scene.id, projectId, userId: user.id, cost });
    });

    return NextResponse.json({ jobId: job.id, creditsRemaining: (user.credits ?? 0) - cost });
  } catch (err: any) {
    console.error("[scenes/storyboard] POST error:", err);
    return NextResponse.json({ error: "Не удалось запустить генерацию кадра: " + (err?.message ?? "неизвестная ошибка") }, { status: 500 });
  }
}

/**
 * PATCH /api/ai/scenes/[id]/storyboard { approved: boolean } — approve / un-approve the rendered frame.
 * Approving requires a rendered frame; the video of this scene can only start from an APPROVED frame.
 * Response: { ok, scene: { id, storyboardUrl, storyboardApproved } }.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:storyboard", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const { id } = await ctx.params;
  const parsed = await parseBody(request, storyboardApproveSchema);
  if (!parsed.ok) return parsed.response;
  const scene = await ownedScene(id, session.user.id);
  if (!scene) return NextResponse.json({ error: "Сцена не найдена" }, { status: 404 });
  if (parsed.data.approved && !(scene.storyboardUrl ?? "").trim())
    return NextResponse.json({ error: "Сначала сгенерируйте кадр сториборда" }, { status: 400 });
  const updated = await prisma.scene.update({
    where: { id: scene.id },
    data: { storyboardApproved: parsed.data.approved },
    select: { id: true, storyboardUrl: true, storyboardApproved: true },
  });
  return NextResponse.json({ ok: true, scene: updated });
}
