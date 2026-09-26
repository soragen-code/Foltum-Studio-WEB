export const dynamic = "force-dynamic";
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { verifyWorkerSecret, runInBackground } from "@/lib/jobs";
import { runRedrawStartFramesJob, type RedrawChainState } from "@/lib/workers/redraw-start-frame-job";

/**
 * INTERNAL: POST /api/ai/workers/start-frame-redraw  { jobId, projectId, episodeId, sceneIds, chain }
 * Continuation hop of the start-frame redraw batch: the previous invocation ran out of its time budget and
 * hands the REMAINING scenes here under the same GenerationJob. Responds immediately and keeps rendering
 * in the background (after()), so the caller never waits on this request.
 */
export async function POST(request: Request) {
  if (!verifyWorkerSecret(request)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null);
  if (!body?.jobId || !body?.projectId || !body?.episodeId || !Array.isArray(body?.sceneIds) || body.sceneIds.length === 0)
    return NextResponse.json({ error: "jobId, projectId, episodeId and sceneIds required" }, { status: 400 });
  const sceneIds = (body.sceneIds as unknown[]).filter((s): s is string => typeof s === "string");
  const chain: RedrawChainState | null = body.chain && typeof body.chain.total === "number"
    ? { total: body.chain.total, done: Number(body.chain.done ?? 0), failed: Number(body.chain.failed ?? 0),
        updated: Array.isArray(body.chain.updated) ? body.chain.updated : [], errors: Array.isArray(body.chain.errors) ? body.chain.errors : [] }
    : null;
  runInBackground(() => runRedrawStartFramesJob(String(body.jobId), String(body.projectId), String(body.episodeId), sceneIds, chain));
  return NextResponse.json({ ok: true, accepted: sceneIds.length });
}
