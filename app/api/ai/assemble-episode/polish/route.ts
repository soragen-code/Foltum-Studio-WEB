export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800; // the LLM continuity audit + scene-job kickoff run in this invocation

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { chatJSON } from "@/lib/ai";
import { normalizeLanguage } from "@/lib/idea";
import {
  episodeContinuityAuditSchema,
  episodeContinuityAuditSystemPrompt,
  episodeContinuityAuditUserPrompt,
  sceneClipSeconds,
  sceneClipCost,
  type AuditSceneInput,
} from "@/lib/season";
import { selectPolishScenes, type PolishSceneInput } from "@/lib/polish";
import { resolvePowerTier } from "@/lib/power-tier";
import { runInBackground, failStaleJobs, heartbeatJob, updateJob } from "@/lib/jobs";
import { runVideoJob } from "@/lib/workers/video-job";

/** Mirror of GENERATE_ALL_CONCURRENCY — how many re-gen scenes run at once. */
const POLISH_CONCURRENCY = 3;
const QUEUE_HEARTBEAT_MS = 45_000;

const validUrl = (u?: string | null) => typeof u === "string" && u.startsWith("http") && u.length > 10;

/**
 * POST /api/ai/assemble-episode/polish  { episodeId }
 *
 * Stage 13 — the «Ассембл» final-polish pass. Instead of only stitching finished clips, the
 * whole episode is re-reviewed by the LLM as one continuous video: it detects LOGICAL
 * continuity errors at the seams between scenes (a character teleporting / vanishing, a reset
 * arrangement, a prop / lighting jump, a motivated move that isn't shown) and returns a
 * corrected videoPrompt for ONLY the broken scenes.
 *
 *  - No issues → returns { issues: [] }; the client then just stitches (no credits spent).
 *  - Issues → the flagged scenes get their corrected prompt, are reset (videoUrl cleared) and
 *    re-generated via Seedance (reusing the per-scene video-job machinery). Idempotent &
 *    double-charge safe: a scene that already has an active job is reused, never re-charged.
 *    The client drives the existing /generate-all/continue loop until the re-gen finishes,
 *    then calls /api/ai/assemble-episode to stitch. Cancel via /generate-all/cancel.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:assemble-polish", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const episodeId: string | undefined = body?.episodeId;
  if (!episodeId) return NextResponse.json({ error: "Episode ID required" }, { status: 400 });

  const episode = await prisma.episode.findFirst({
    where: { id: episodeId, season: { project: { userId: session.user.id } } },
    include: { season: { include: { project: true } }, scenes: { orderBy: { number: "asc" } } },
  });
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  if (episode.scenes.length === 0) return NextResponse.json({ error: "В эпизоде нет сцен" }, { status: 400 });
  // The polish pass runs on a fully generated episode only (button is gated on this client-side too).
  if (episode.scenes.some((s) => !validUrl(s.videoUrl)))
    return NextResponse.json({ error: "Сначала сгенерируйте все сцены эпизода" }, { status: 400 });

  const project = episode.season.project;
  const language = normalizeLanguage(project.language, project.synopsis ?? "");
  const tier = resolvePowerTier(project);

  // ── 1) Continuity audit across the whole ordered scene chain ──────────────────────────────
  const auditInput: AuditSceneInput[] = episode.scenes.map((s) => ({
    number: s.number,
    durationSec: s.durationSec,
    sceneKind: s.sceneKind,
    shotType: s.shotType,
    locationDesc: s.locationDesc,
    dialogueEn: s.dialogueEn,
    voiceover: s.voiceover,
    presence: s.presence,
    entrances: s.entrances,
    continuesFrom: s.continuesFrom,
    videoPrompt: s.videoPrompt,
  }));

  let audit;
  try {
    const raw = await chatJSON(
      episodeContinuityAuditSystemPrompt(language),
      episodeContinuityAuditUserPrompt(auditInput),
      { temperature: 0.4, maxTokens: 16000 }
    );
    audit = episodeContinuityAuditSchema.parse(raw);
  } catch (err) {
    console.error("[assemble-polish] audit failed:", err);
    return NextResponse.json({ error: "Не удалось проанализировать логику эпизода. Попробуйте ещё раз." }, { status: 502 });
  }

  // ── 2) Pick the scenes that actually need re-generation ───────────────────────────────────
  // Determine which flagged scenes already have an active job (idempotent double-charge guard).
  const sceneInputs: PolishSceneInput[] = [];
  for (const s of episode.scenes) {
    await failStaleJobs({ sceneId: s.id, type: "video" });
    const active = await prisma.generationJob.findFirst({
      where: { sceneId: s.id, type: "video", status: { in: ["pending", "processing"] } },
      select: { id: true },
    });
    sceneInputs.push({ id: s.id, number: s.number, videoPrompt: s.videoPrompt, hasActiveJob: !!active });
  }
  const selection = selectPolishScenes(audit.scenes, sceneInputs);

  if (selection.length === 0) {
    // Nothing to fix — the client just stitches the existing clips. No credits spent.
    return NextResponse.json({ issues: [], started: 0, message: "Логических нестыковок не найдено." });
  }

  // ── 3) Charge + reset + create per-scene re-gen jobs (reuse active jobs, never double-charge) ─
  const toCharge = selection.filter((x) => x.needsCharge);
  const need = toCharge.reduce((sum, x) => {
    const sc = episode.scenes.find((s) => s.id === x.sceneId);
    return sum + sceneClipCost(tier.id, sceneClipSeconds(tier.id, sc?.durationSec));
  }, 0);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
  if (need > 0 && (user.credits ?? 0) < need) {
    return NextResponse.json(
      { error: `Недостаточно кредитов на перегенерацию: нужно ${need}, на балансе ${user.credits ?? 0}`, issues: selection.map((x) => ({ number: x.number, issue: x.issue })) },
      { status: 402 }
    );
  }

  const queued: Array<{ jobId: string; sceneId: string; cost: number; duration: number }> = [];
  const jobs: Array<{ sceneId: string; sceneNumber: number; jobId: string; resumed?: boolean }> = [];
  for (const sel of selection) {
    const scene = episode.scenes.find((s) => s.id === sel.sceneId)!;
    if (!sel.needsCharge) {
      // A regen job is already running for this scene — reuse it, don't touch prompt/credits.
      const active = await prisma.generationJob.findFirst({
        where: { sceneId: scene.id, type: "video", status: { in: ["pending", "processing"] } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (active) { jobs.push({ sceneId: scene.id, sceneNumber: scene.number, jobId: active.id, resumed: true }); continue; }
    }
    const duration = sceneClipSeconds(tier.id, scene.durationSec);
    const cost = sceneClipCost(tier.id, duration);
    // Apply the corrected prompt + reset the clip so the re-gen (and the continue planner) picks it up.
    await prisma.scene.update({
      where: { id: scene.id },
      data: { videoPrompt: sel.correctedVideoPrompt, videoUrl: null, status: "generating", language: "en" },
    });
    await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: cost } } });
    await prisma.creditTransaction.create({ data: { userId: user.id, amount: -cost, description: `Эпизод ${episode.number}, сцена ${scene.number} — финальная полировка (перегенерация, ${tier.id})` } });
    const job = await prisma.generationJob.create({ data: { type: "video", status: "pending", progress: 1, message: "Полировка: в очереди…", projectId: project.id, sceneId: scene.id } });
    queued.push({ jobId: job.id, sceneId: scene.id, cost, duration });
    jobs.push({ sceneId: scene.id, sceneNumber: scene.number, jobId: job.id });
  }

  // ── 4) Run the re-gen jobs in the background of this invocation (client also drives /continue) ─
  if (queued.length) {
    runInBackground(async () => {
      const waiting = new Set(queued.map((q) => q.jobId));
      const hb = setInterval(() => { for (const j of waiting) void heartbeatJob(j); }, QUEUE_HEARTBEAT_MS);
      let idx = 0;
      const worker = async () => {
        while (idx < queued.length) {
          const item = queued[idx++];
          waiting.delete(item.jobId);
          await updateJob(item.jobId, { status: "processing", progress: 2, message: "Полировка: старт видеомодели…" });
          try {
            await runVideoJob({ jobId: item.jobId, sceneId: item.sceneId, projectId: project.id, userId: user.id, cost: item.cost, duration: item.duration, resolution: tier.resolution });
          } catch (err) {
            console.error("[assemble-polish] scene regen failed:", err);
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(POLISH_CONCURRENCY, queued.length) }, worker));
      } finally {
        clearInterval(hb);
      }
    });
  }

  const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
  return NextResponse.json({
    issues: selection.map((x) => ({ number: x.number, issue: x.issue })),
    jobs,
    started: queued.length,
    creditsRemaining: fresh?.credits ?? 0,
  });
}
