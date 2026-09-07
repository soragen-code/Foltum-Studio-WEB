export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextResponse } from "next/server";
import { verifyWorkerSecret } from "@/lib/jobs";
import { runCharacterImagesJob } from "@/lib/workers/character-images-job";

/**
 * INTERNAL: POST /api/ai/workers/character-images
 * Thin wrapper around runCharacterImagesJob() — kept for manual re-runs / debugging.
 * The main route (/api/ai/characters) runs the job in-process via after().
 */
export async function POST(request: Request) {
  if (!verifyWorkerSecret(request))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await request.json();
  if (!body?.jobId || !body?.projectId || !Array.isArray(body?.characterIds))
    return NextResponse.json({ error: "jobId, projectId and characterIds required" }, { status: 400 });

  await runCharacterImagesJob({ jobId: body.jobId, projectId: body.projectId, characterIds: body.characterIds });
  return NextResponse.json({ ok: true });
}
