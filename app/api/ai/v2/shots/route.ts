export const dynamic = "force-dynamic";
export const maxDuration = 800; // разбивка на кадры крутится в фоне этой инвокации через after()

import { NextResponse } from "next/server";
import { serverT, sessionLocale } from "@/lib/i18n/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { chargeV2Credits } from "@/lib/v2-credits";
import { V2_COSTS } from "@/lib/v2-costs";
import { runEpisodeShotsV2Job, EPISODE_SHOTS_V2_JOB_TYPE } from "@/lib/workers/episode-shots-v2-job";
import { episodeScriptV2From, episodeShotsV2From, episodeShotsV2SystemPrompt, episodeHandoffBlockV2, synopsisLanguageFromCode } from "@/lib/idea-v2";
import { activeEpisodeJob, latestEpisodeJob, patchEpisodeShotV2 } from "@/lib/episode-shots-v2-store";
import { denyFeature, hasText } from "@/lib/feature-gate";

/**
 * Поток v2 · вкладка «Шот-лист» серии n.
 * POST  { projectId, episode, system? }                 → разбить сценарий на кадры (GenerationJob "episode_shots_v2"; идемпотентно по серии). system — переопределённый системный промпт.
 * GET   ?projectId&episode                              → { job, items, scriptText, autoSystem }.
 * PATCH { projectId, episode, id, frame?, action?, ending?, durationSec? } → сохранить правку кадра (edited=true — не перезатирается при повторной разбивке).
 */
const postSchema = z.object({ projectId: z.string().min(1), episode: z.coerce.number().int().min(1).max(999), system: z.string().max(200000).optional() });
const patchSchema = z.object({
  projectId: z.string().min(1),
  episode: z.coerce.number().int().min(1).max(999),
  id: z.string().min(1).max(200),
  action: z.string().max(2000).optional(),
  durationSec: z.coerce.number().int().min(4).max(6).optional(),
  frame: z.string().max(2000).optional(),
  ending: z.string().max(2000).optional(),
});

/** Необязательные строковые поля кадра, которые можно править вручную (кроме action/durationSec). */
const SHOT_PATCH_STR_FIELDS = ["frame", "ending"] as const;

async function ownedProject(email: string, projectId: string) {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) return null;
  return prisma.project.findFirst({ where: { id: projectId, userId: user.id }, select: { id: true, userId: true, language: true, episodeScriptsV2: true, episodeShotsV2: true } });
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    const t = serverT(sessionLocale(session));
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // Без активной подписки (Basic+) генерация недоступна целиком.
    { const dAuto = await denyFeature(session.user.email, "auto_generate"); if (dAuto) return dAuto; }
    const limited = rateLimitByUser(request, "ai:v2:shots", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;
    const parsed = postSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    if (hasText(parsed.data.system)) { const d = await denyFeature(session.user.email, "prompt_edit"); if (d) return d; } // свой системный промпт — Studio
    const { projectId, episode, system } = parsed.data;

    const project = await ownedProject(session.user.email, projectId);
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    const script = episodeScriptV2From(project.episodeScriptsV2, episode);
    if (!script?.trim()) return NextResponse.json({ error: t('api.needScript') }, { status: 400 });

    await failStaleJobs({ projectId, type: EPISODE_SHOTS_V2_JOB_TYPE });
    const active = await activeEpisodeJob(projectId, EPISODE_SHOTS_V2_JOB_TYPE, episode);
    if (active) return NextResponse.json({ jobId: active.id, resumed: true });

    const job = await prisma.generationJob.create({
      data: { type: EPISODE_SHOTS_V2_JOB_TYPE, status: "pending", progress: 0, message: "Starting...", projectId, resultData: JSON.stringify({ episode }) },
    });
    const charge = await chargeV2Credits(project.userId, V2_COSTS.shots, "shots", job.id);
    if (!charge.ok) {
      await prisma.generationJob.delete({ where: { id: job.id } }).catch(() => {});
      return NextResponse.json(charge.body, { status: charge.status });
    }
    runInBackground(() => runEpisodeShotsV2Job(job.id, projectId, { episode, script, synopsisLanguage: synopsisLanguageFromCode(project.language), systemOverride: system, handoff: episodeHandoffBlockV2(project.episodeShotsV2, project.episodeScriptsV2, episode) }));
    return NextResponse.json({ jobId: job.id, resumed: false, cost: charge.cost, creditsRemaining: charge.creditsRemaining });
  } catch (err: any) {
    console.error("Episode shots v2 split error:", err);
    return NextResponse.json({ error: "Shot split failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Без активной подписки (Basic+) генерация недоступна целиком.
  { const dAuto = await denyFeature(session.user.email, "auto_generate"); if (dAuto) return dAuto; }
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") ?? "";
  const episode = Number(url.searchParams.get("episode"));
  if (!projectId || !Number.isInteger(episode)) return NextResponse.json({ error: "projectId and episode required" }, { status: 400 });
  const project = await ownedProject(session.user.email, projectId);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  await failStaleJobs({ projectId, type: EPISODE_SHOTS_V2_JOB_TYPE });
  const job = await latestEpisodeJob(projectId, EPISODE_SHOTS_V2_JOB_TYPE, episode);
  return NextResponse.json({
    job,
    items: episodeShotsV2From(project.episodeShotsV2, episode),
    scriptText: episodeScriptV2From(project.episodeScriptsV2, episode),
    autoSystem: episodeShotsV2SystemPrompt(synopsisLanguageFromCode(project.language)),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // Без активной подписки (Basic+) генерация недоступна целиком.
    { const dAuto = await denyFeature(session.user.email, "auto_generate"); if (dAuto) return dAuto; }
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    const { projectId, episode, id, action, durationSec } = parsed.data;
    const hasStr = SHOT_PATCH_STR_FIELDS.some((k) => (parsed.data as any)[k] !== undefined);
    if (action === undefined && durationSec === undefined && !hasStr) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
    const project = await ownedProject(session.user.email, projectId);
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    const patch: Record<string, unknown> = { edited: true };
    if (action !== undefined) patch.action = action;
    if (durationSec !== undefined) patch.durationSec = durationSec;
    for (const k of SHOT_PATCH_STR_FIELDS) {
      const v = (parsed.data as any)[k];
      if (v !== undefined) patch[k] = v.trim(); // "" = явно очищено (не подменяется legacy-синтезом)
    }
    const updated = await patchEpisodeShotV2(projectId, episode, id, patch);
    if (!updated) return NextResponse.json({ error: "Shot not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("Episode shots v2 patch error:", err);
    return NextResponse.json({ error: "Save failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
