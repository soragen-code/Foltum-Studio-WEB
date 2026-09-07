export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

/**
 * GET /api/jobs/[id] — status polling for a GenerationJob.
 * For character jobs the current characters (with image URLs so far) are included;
 * for video jobs the scene row is included.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const job = await prisma.generationJob.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  let characters: any[] | undefined;
  let scene: any | undefined;
  if (job.type === "characters") {
    characters = await prisma.character.findMany({ where: { projectId: job.projectId }, orderBy: { createdAt: "asc" } });
  } else if (job.type === "video" && job.sceneId) {
    scene = await prisma.scene.findUnique({ where: { id: job.sceneId } });
  }

  let result: any = null;
  if (job.resultData) { try { result = JSON.parse(job.resultData); } catch {} }

  return NextResponse.json(
    { job: { ...job, result }, characters, scene },
    { headers: { "Cache-Control": "no-store" } }
  );
}
