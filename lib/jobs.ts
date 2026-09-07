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
 * Fire-and-forget call to an internal worker route.
 *
 * On Vercel the function may be frozen right after the response is sent, so the
 * outgoing request is scheduled with `after()` (runs after the response is flushed
 * but keeps the function alive). We wait only until the request has been
 * delivered (short timeout), never for the worker to finish.
 */
export function triggerWorker(path: string, payload: Record<string, unknown>): void {
  const url = `${getBaseUrl()}${path}`;
  const run = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [WORKER_SECRET_HEADER]: getWorkerSecret(),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (err: any) {
      // AbortError is expected — the worker keeps running after we disconnect.
      if (err?.name !== "AbortError") console.error(`[jobs] failed to trigger worker ${path}:`, err?.message ?? err);
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    after(run);
  } catch {
    // Outside of a request scope (e.g. tests) — just fire it.
    run().catch(() => {});
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
