/**
 * Background job helpers for Vercel serverless.
 *
 * Pattern: the user-facing route creates a GenerationJob, triggers an internal
 * worker route (fire-and-forget) and returns the jobId. The worker updates the
 * job row as it progresses; the frontend polls GET /api/jobs/[id].
 */
import { after } from "next/server";
import { prisma } from "@/lib/db";

export const WORKER_SECRET_HEADER = "x-worker-secret";

/** Shared secret used to authenticate internal worker calls. */
export function getWorkerSecret(): string {
  return process.env.WORKER_SECRET || process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "";
}

/** Verify the internal worker secret header. */
export function verifyWorkerSecret(request: Request): boolean {
  const expected = getWorkerSecret();
  if (!expected) return false;
  return request.headers.get(WORKER_SECRET_HEADER) === expected;
}

/** Resolve the public base URL of this deployment (used to call our own worker routes). */
export function getBaseUrl(): string {
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

/**
 * Run a long task in the background of the CURRENT serverless invocation.
 *
 * `after()` lets the route return its response immediately while Vercel keeps
 * the function alive (up to the route's `maxDuration`) until `fn` settles.
 * This avoids the self-HTTP-call pattern, where aborting the outgoing request
 * would make Vercel kill the worker invocation mid-way.
 *
 * NOTE: the calling route MUST export `maxDuration = JOB_MAX_DURATION`.
 */
export function runInBackground(fn: () => Promise<void>): void {
  const run = () => fn().catch((err) => console.error("[jobs] background task failed:", err));
  try {
    after(run);
  } catch {
    // Outside of a request scope (e.g. tests) — just fire it.
    run();
  }
}

/** Jobs that haven't been touched for this long are considered dead (function killed). */
export const STALE_JOB_MS = 3 * 60 * 1000;

/** Route-level `maxDuration` for routes that host background jobs (Vercel Pro / Fluid compute allows up to 800s). */
export const JOB_MAX_DURATION = 800;

/** Touch a job so it is not considered stale (progress unchanged). */
export async function heartbeatJob(jobId: string): Promise<void> {
  try {
    await prisma.generationJob.update({ where: { id: jobId }, data: { updatedAt: new Date() } });
  } catch {}
}

/**
 * Mark "processing"/"pending" jobs that stopped updating as failed.
 * Called before checking for active jobs so a dead job never blocks a new one.
 */
export async function failStaleJobs(where: { projectId?: string; sceneId?: string; type?: string }): Promise<number> {
  try {
    const res = await prisma.generationJob.updateMany({
      where: {
        ...where,
        status: { in: ["pending", "processing"] },
        updatedAt: { lt: new Date(Date.now() - STALE_JOB_MS) },
      },
      data: { status: "failed", message: "Failed", error: "Generation timed out (worker stopped responding)" },
    });
    return res.count;
  } catch (err) {
    console.error("[jobs] failStaleJobs error:", err);
    return 0;
  }
}

/** Update job progress / message. Never throws (a failed progress write must not kill the worker). */
export async function updateJob(
  jobId: string,
  data: { progress?: number; message?: string; status?: string; resultData?: string | null; error?: string | null }
): Promise<void> {
  try {
    await prisma.generationJob.update({
      where: { id: jobId },
      data: {
        ...(data.progress !== undefined ? { progress: Math.max(0, Math.min(100, Math.round(data.progress))) } : {}),
        ...(data.message !== undefined ? { message: data.message } : {}),
        ...(data.status !== undefined ? { status: data.status } : {}),
        ...(data.resultData !== undefined ? { resultData: data.resultData } : {}),
        ...(data.error !== undefined ? { error: data.error } : {}),
      },
    });
  } catch (err) {
    console.error(`[jobs] failed to update job ${jobId}:`, err);
  }
}

export async function completeJob(jobId: string, resultData?: unknown, message = "Completed"): Promise<void> {
  await updateJob(jobId, {
    status: "completed",
    progress: 100,
    message,
    resultData: resultData === undefined ? undefined : JSON.stringify(resultData),
  });
}

export async function failJob(jobId: string, error: string): Promise<void> {
  await updateJob(jobId, { status: "failed", message: "Failed", error: error.slice(0, 2000) });
}
