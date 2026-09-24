/**
 * Stage 234 — background workers for "Manual mode" (/manual).
 *
 * Both photo and video run as GenerationJob rows (type manual_photo / manual_video) hosted by the
 * submitting route via `runInBackground` (after()). The loop heartbeats the job on every poll so
 * `failStaleJobs` never reaps a live render; cancel requests are honoured between polls.
 * Result files are persisted to S3 under manual/{userId}/…; on failure the charged credits are refunded.
 */
import { prisma } from "@/lib/db";
import { wavespeedSubmit, wavespeedResult, wavespeedCancel } from "@/lib/wavespeed";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { heartbeatJob, updateJob, completeJob, failJob, isCancelRequested, markCanceled } from "@/lib/jobs";

export const MANUAL_PHOTO_JOB_TYPE = "manual_photo";
export const MANUAL_VIDEO_JOB_TYPE = "manual_video";
/** Sentinel projectId for manual jobs (GenerationJob.projectId is required; manual work has no project). */
export const MANUAL_PROJECT_ID = "manual";

/** Refund credits that were charged for a manual generation (idempotent per generation: guarded by status). */
export async function refundManual(userId: string, amount: number, description: string): Promise<void> {
  if (amount <= 0) return;
  try {
    await prisma.user.update({ where: { id: userId }, data: { credits: { increment: amount } } });
    await prisma.creditTransaction.create({ data: { userId, amount, description } });
  } catch (err) {
    console.error("[manual] refund failed:", err);
  }
}

/**
 * Poll a WaveSpeed task until terminal, heartbeating the job on every tick.
 * Returns the output URL; throws on failure / cancel / timeout.
 */
async function pollWithHeartbeat(
  taskId: string,
  jobId: string,
  opts: { timeoutMs: number; label: string; progressFrom: number; progressTo: number },
): Promise<string> {
  const started = Date.now();
  for (;;) {
    if (await isCancelRequested(jobId)) {
      await wavespeedCancel(taskId);
      throw new Error("canceled");
    }
    const st = await wavespeedResult(taskId, opts.label);
    if (st.status === "succeeded") {
      if (st.url) return st.url;
      throw new Error(`${opts.label} returned no output`);
    }
    if (st.status === "failed" || st.status === "canceled") throw new Error(st.error || `${opts.label} ${st.status}`);
    const elapsed = Date.now() - started;
    if (elapsed > opts.timeoutMs) throw new Error(`${opts.label} timed out; no automatic resubmission`);
    const frac = Math.min(1, elapsed / opts.timeoutMs);
    await updateJob(jobId, { progress: opts.progressFrom + (opts.progressTo - opts.progressFrom) * frac });
    await heartbeatJob(jobId);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function finishFailure(genId: string, jobId: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  const canceled = msg === "canceled";
  const gen = await prisma.manualGeneration.findUnique({ where: { id: genId } });
  if (gen && gen.status !== "completed" && gen.status !== "failed") {
    await prisma.manualGeneration.update({ where: { id: genId }, data: { status: "failed", error: canceled ? "Canceled" : msg.slice(0, 2000) } });
    await refundManual(gen.userId, gen.cost, `Refund: manual ${gen.kind} (${canceled ? "canceled" : "failed"})`);
  }
  if (canceled) await markCanceled(jobId);
  else await failJob(jobId, msg);
}

/** Run one manual generation (photo or video): submit → poll → persist → complete. */
export async function runManualJob(jobId: string, genId: string, slug: string, body: Record<string, unknown>): Promise<void> {
  const gen = await prisma.manualGeneration.findUnique({ where: { id: genId } });
  if (!gen) { await failJob(jobId, "Generation record not found"); return; }
  const isVideo = gen.kind === "video";
  const label = isVideo ? "WaveSpeed video" : "WaveSpeed image";
  try {
    await updateJob(jobId, { status: "processing", progress: 5, message: isVideo ? "Submitting video…" : "Submitting image…" });
    await prisma.manualGeneration.update({ where: { id: genId }, data: { status: "processing" } });
    const taskId = await wavespeedSubmit(slug, body, label);
    await updateJob(jobId, { progress: 10, message: isVideo ? "Rendering video…" : "Rendering image…", resultData: JSON.stringify({ genId, taskId }) });
    const providerUrl = await pollWithHeartbeat(taskId, jobId, {
      timeoutMs: isVideo ? 600_000 : 240_000,
      label,
      progressFrom: 10,
      progressTo: 90,
    });
    await updateJob(jobId, { progress: 92, message: "Saving…" });
    await heartbeatJob(jobId);
    const ext = isVideo ? "mp4" : "png";
    const contentType = isVideo ? "video/mp4" : "image/png";
    let finalUrl = providerUrl;
    try {
      finalUrl = await uploadRemoteToS3(providerUrl, `manual/${gen.userId}/${genId}.${ext}`, contentType);
    } catch (err) {
      console.error("[manual] S3 persist failed, keeping provider URL:", err);
    }
    await prisma.manualGeneration.update({ where: { id: genId }, data: { status: "completed", resultUrl: finalUrl, error: null } });
    await completeJob(jobId, { genId, resultUrl: finalUrl, kind: gen.kind }, "Completed");
  } catch (err) {
    await finishFailure(genId, jobId, err);
  }
}
