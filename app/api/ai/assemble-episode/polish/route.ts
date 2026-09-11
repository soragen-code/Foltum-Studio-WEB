export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800; // the LLM audit + per-scene regen + final stitch all run in this invocation

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
import {
  runInBackground,
  failStaleJobs,
  heartbeatJob,
  updateJob,
  completeJob,
  failJob,
  markCanceled,
  isCancelRequested,
} from "@/lib/jobs";
import { runVideoJob } from "@/lib/workers/video-job";
import { assembleEpisodeVideo } from "@/lib/assemble";
import {
  ASSEMBLE_JOB_TYPE,
  assembleProgress,
  buildAssembleResult,
  shouldStitchWithoutCharge,
  type AssembleResultData,
} from "@/lib/assemble-plan";

// Stage 23 (frame-sync): the polish regen runs SEQUENTIALLY in ascending scene order (see the
// regen loop below), so the previous per-scene concurrency pool was removed — the last-frame →
// first-frame chain requires a scene's predecessor to be committed before the scene starts.
const QUEUE_HEARTBEAT_MS = 45_000;

const validUrl = (u?: string | null) => typeof u === "string" && u.startsWith("http") && u.length > 10;

/**
 * POST /api/ai/assemble-episode/polish  { episodeId }  →  { jobId }
 *
 * Stage 19 — the «Ассембл» final-polish pass now runs as a SERVER-DRIVEN background job
 * (type `episode_assemble`). The route validates, guards against duplicate jobs, creates the
 * job and returns its id immediately; the whole orchestration runs via runInBackground() so
 * it survives the browser navigating away. The client just polls GET /api/jobs/[jobId] and
 * renders phase/issues/done/total/failed from the job's resultData.
 *
 * Phases (resultData.phase): analyzing → regen → stitching → done.
 *   (a) Audit — the LLM re-reviews the whole ordered scene chain for continuity errors.
 *   (b) Regen — only the flagged scenes are reset + re-generated (idempotent, double-charge safe).
 *   (c) Stitch — the shared assembleEpisodeVideo() muxes + concatenates + uploads.
 *   (d) Done — completeJob({ videoUrl, phase:'done', issues, fixedCount }).
 * Zero issues → skip regen, stitch straight away (no credits spent).
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

  // ── Idempotency: reuse an already-running assemble job for THIS episode ────────────────────
  await failStaleJobs({ projectId: project.id, type: ASSEMBLE_JOB_TYPE });
  const activeAssemble = await prisma.generationJob.findMany({
    where: { projectId: project.id, type: ASSEMBLE_JOB_TYPE, status: { in: ["pending", "processing"] } },
    orderBy: { createdAt: "desc" },
  });
  for (const j of activeAssemble) {
    try {
      const rd = JSON.parse(j.resultData ?? "{}");
      if (rd?.episodeId === episodeId) return NextResponse.json({ jobId: j.id });
    } catch {}
  }

  // ── Create the job and return immediately ─────────────────────────────────────────────────
  const initialResult: AssembleResultData = { episodeId, phase: "analyzing", issues: [], done: 0, total: 0, failed: 0 };
  const job = await prisma.generationJob.create({
    data: {
      type: ASSEMBLE_JOB_TYPE,
      status: "processing",
      progress: assembleProgress("analyzing"),
      message: "Анализ логики эпизода…",
      projectId: project.id,
      resultData: buildAssembleResult(initialResult),
    },
  });
  const jobId = job.id;

  const language = normalizeLanguage(project.language, project.synopsis ?? "");
  const tier = resolvePowerTier(project);

  runInBackground(async () => {
    const hb = setInterval(() => void heartbeatJob(jobId), QUEUE_HEARTBEAT_MS);
    try {
      const canceled = async () => isCancelRequested(jobId);

      // ── (a) Continuity audit across the whole ordered scene chain ──────────────────────────
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
        endState: s.endState,
        startState: s.startState,
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
        await failJob(jobId, "Не удалось проанализировать логику эпизода. Попробуйте ещё раз.");
        return;
      }

      if (await canceled()) { await markCanceled(jobId, "Полировка отменена."); return; }

      // ── (b) Select the scenes that actually need re-generation ─────────────────────────────
      const sceneInputs: PolishSceneInput[] = [];
      for (const s of episode.scenes) {
        await failStaleJobs({ sceneId: s.id, type: "video" });
        const active = await prisma.generationJob.findFirst({
          where: { sceneId: s.id, type: "video", status: { in: ["pending", "processing"] } },
          select: { id: true },
        });
        sceneInputs.push({ id: s.id, number: s.number, videoPrompt: s.videoPrompt, hasActiveJob: !!active });
      }
      // Stage 23 (frame-sync): regenerate flagged scenes in ASCENDING scene order so the
      // last-frame(N-1) → first-frame(N) chain is built in order (a scene reads the freshly
      // committed last frame of its — possibly just-regenerated — predecessor).
      const selection = selectPolishScenes(audit.scenes, sceneInputs).sort((a, b) => a.number - b.number);
      const issues = selection.map((x) => ({ number: x.number, issue: x.issue }));

      // Write the found issues into the job so the client can render them, move to the regen phase.
      const total = selection.length;
      const writeRegen = (done: number, failed: number, phase: AssembleResultData["phase"] = "regen") =>
        updateJob(jobId, {
          progress: assembleProgress(phase, done, total),
          message:
            phase === "regen"
              ? `Перегенерация проблемных сцен… ${done}/${total}${failed > 0 ? ` · не удалось ${failed}` : ""}`
              : "Склейка сцен прямым стыком…",
          resultData: buildAssembleResult({ episodeId, phase, issues, done, total, failed }),
        });

      // ── Zero issues → straight to stitch, no credits spent ─────────────────────────────────
      if (shouldStitchWithoutCharge(selection.length)) {
        await updateJob(jobId, {
          progress: assembleProgress("stitching"),
          message: "Склейка сцен прямым стыком…",
          resultData: buildAssembleResult({ episodeId, phase: "stitching", issues: [], done: 0, total: 0, failed: 0 }),
        });
        try {
          const { videoUrl } = await assembleEpisodeVideo(episodeId);
          await completeJob(jobId, { episodeId, phase: "done", issues: [], done: 0, total: 0, failed: 0, videoUrl, fixedCount: 0 } as AssembleResultData);
        } catch (err: any) {
          console.error("[assemble-polish] stitch failed (no issues):", err);
          await failJob(jobId, err?.message ?? "Сборка эпизода не удалась");
        }
        return;
      }

      await updateJob(jobId, {
        message: "Перегенерация проблемных сцен…",
        progress: assembleProgress("regen", 0, total),
        resultData: buildAssembleResult({ episodeId, phase: "regen", issues, done: 0, total, failed: 0 }),
      });

      // ── (c) Charge + reset + create per-scene re-gen jobs (reuse active jobs, never double-charge) ─
      const toCharge = selection.filter((x) => x.needsCharge);
      const need = toCharge.reduce((sum, x) => {
        const sc = episode.scenes.find((s) => s.id === x.sceneId);
        return sum + sceneClipCost(tier.id, sceneClipSeconds(tier.id, sc?.durationSec));
      }, 0);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: session.user!.id } });
      if (need > 0 && (user.credits ?? 0) < need) {
        await failJob(jobId, `Недостаточно кредитов на перегенерацию: нужно ${need}, на балансе ${user.credits ?? 0}`);
        return;
      }

      const queued: Array<{ jobId: string; sceneId: string; cost: number; duration: number }> = [];
      const reusedSceneIds: string[] = [];
      for (const sel of selection) {
        const scene = episode.scenes.find((s) => s.id === sel.sceneId)!;
        if (!sel.needsCharge) {
          const active = await prisma.generationJob.findFirst({
            where: { sceneId: scene.id, type: "video", status: { in: ["pending", "processing"] } },
            orderBy: { createdAt: "desc" },
            select: { id: true },
          });
          if (active) { reusedSceneIds.push(scene.id); continue; }
        }
        const duration = sceneClipSeconds(tier.id, scene.durationSec);
        const cost = sceneClipCost(tier.id, duration);
        await prisma.scene.update({
          where: { id: scene.id },
          // Stage 40 — the corrected scene gets its corrected scripted end state; the vision-described actual state is stale.
          data: { videoPrompt: sel.correctedVideoPrompt, videoUrl: null, status: "generating", language: "en", ...(sel.correctedEndState ? { endState: sel.correctedEndState } : {}), ...(sel.correctedStartState ? { startState: sel.correctedStartState } : {}), endStateActual: null },
        });
        await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: cost } } });
        await prisma.creditTransaction.create({
          data: { userId: user.id, amount: -cost, description: `Эпизод ${episode.number}, сцена ${scene.number} — финальная полировка (перегенерация, ${tier.id})` },
        });
        const vjob = await prisma.generationJob.create({ data: { type: "video", status: "pending", progress: 1, message: "Полировка: в очереди…", projectId: project.id, sceneId: scene.id } });
        queued.push({ jobId: vjob.id, sceneId: scene.id, cost, duration });
      }

      // ── Run the re-gen jobs SEQUENTIALLY in ascending scene order, honouring cancel between scenes ──
      // Stage 23 (frame-sync): the flagged scenes MUST be regenerated one-by-one in scene order so the
      // last-frame → first-frame chain is respected: when scene N runs, runVideoJob reads its previous
      // scene's freshly committed `lastFrameUrl` (via canChainFrame) and uses it as the start frame.
      // `queued` is already ascending because `selection` was sorted above. Parallel regen would let an
      // adjacent successor read a stale predecessor frame and break the chain.
      let completed = 0;
      const refreshProgress = () => writeRegen(completed, 0);
      for (const item of queued) {
        if (await canceled()) break;
        await updateJob(item.jobId, { status: "processing", progress: 2, message: "Полировка: старт видеомодели…" });
        try {
          await runVideoJob({ jobId: item.jobId, sceneId: item.sceneId, projectId: project.id, userId: user.id, cost: item.cost, duration: item.duration, resolution: tier.resolution });
        } catch (err) {
          console.error("[assemble-polish] scene regen failed:", err);
        }
        completed += 1;
        await refreshProgress();
        await new Promise((r) => setTimeout(r, 1200));
      }

      if (await canceled()) { await markCanceled(jobId, "Полировка отменена."); return; }

      // ── Wait for any reused (already-running) scene jobs to reach a terminal state ──────────
      if (reusedSceneIds.length) {
        const deadline = Date.now() + 10 * 60 * 1000;
        while (Date.now() < deadline) {
          if (await canceled()) { await markCanceled(jobId, "Полировка отменена."); return; }
          const scenes = await prisma.scene.findMany({ where: { id: { in: reusedSceneIds } }, select: { id: true, videoUrl: true } });
          const pending = scenes.filter((s) => !validUrl(s.videoUrl));
          if (pending.length === 0) break;
          const stillActive = await prisma.generationJob.count({ where: { sceneId: { in: pending.map((p) => p.id) }, type: "video", status: { in: ["pending", "processing"] } } });
          if (stillActive === 0) break; // their jobs finished (possibly failed) — stop waiting
          await new Promise((r) => setTimeout(r, 4000));
        }
      }

      // ── Verify every flagged scene now has a clip before stitching ─────────────────────────
      const finalScenes = await prisma.scene.findMany({ where: { id: { in: selection.map((s) => s.sceneId) } }, select: { videoUrl: true } });
      const failed = finalScenes.filter((s) => !validUrl(s.videoUrl)).length;
      if (failed > 0) {
        await updateJob(jobId, { resultData: buildAssembleResult({ episodeId, phase: "regen", issues, done: total - failed, total, failed }) });
        await failJob(jobId, "Часть проблемных сцен не удалось перегенерировать. Проверьте сцены и запустите «Ассембл» ещё раз.");
        return;
      }

      // ── (c) Stitch ─────────────────────────────────────────────────────────────────────────
      await updateJob(jobId, {
        progress: assembleProgress("stitching"),
        message: "Склейка сцен прямым стыком…",
        resultData: buildAssembleResult({ episodeId, phase: "stitching", issues, done: total, total, failed: 0 }),
      });
      let videoUrl: string;
      try {
        const stitched = await assembleEpisodeVideo(episodeId);
        videoUrl = stitched.videoUrl;
      } catch (err: any) {
        console.error("[assemble-polish] stitch failed:", err);
        await failJob(jobId, err?.message ?? "Сборка эпизода не удалась");
        return;
      }

      // ── (d) Done ───────────────────────────────────────────────────────────────────────────
      await completeJob(jobId, { episodeId, phase: "done", issues, done: total, total, failed: 0, videoUrl, fixedCount: total } as AssembleResultData);
    } catch (err: any) {
      console.error("[assemble-polish] background job crashed:", err);
      await failJob(jobId, err?.message ?? "Финальная полировка не удалась");
    } finally {
      clearInterval(hb);
    }
  });

  return NextResponse.json({ jobId });
}
