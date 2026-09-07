export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextResponse } from "next/server";
import { verifyWorkerSecret } from "@/lib/jobs";
import { runVideoJob } from "@/lib/workers/video-job";

/**
 * INTERNAL: POST /api/ai/workers/generate-video
 * Thin wrapper around runVideoJob() — kept for manual re-runs / debugging.
 * The main route (/api/ai/generate-video) runs the job in-process via after().
 */
export async function POST(request: Request) {
  if (!verifyWorkerSecret(request))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  if (!body?.jobId || !body?.sceneId || !body?.projectId)
    return NextResponse.json({ error: "jobId, sceneId and projectId required" }, { status: 400 });

  await runVideoJob({
    jobId: body.jobId,
    sceneId: body.sceneId,
    projectId: body.projectId,
    userId: body.userId,
    cost: Number(body.cost ?? 0),
    duration: Number(body.duration ?? 5),
    resolution: String(body.resolution ?? "480p"),
  });
  return NextResponse.json({ ok: true });
}
