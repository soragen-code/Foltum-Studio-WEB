export const dynamic = "force-dynamic";
export const maxDuration = 800; // Vercel Pro / Fluid compute max — background job runs inside this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, charactersSchema } from "@/lib/validations";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { CHARACTERS_FROM_SCRIPT_JOB_TYPE, runCharactersFromScriptJob } from "@/lib/workers/characters-from-script-job";

/**
 * POST /api/ai/characters — References step (Step 5), MANUAL action "Create characters from script".
 *
 * Characters are created ONLY here, after the episode scripts exist: the background worker reads ALL saved
 * episode scripts (+ synopsis for context), extracts the complete cast (incl. extras) with one streaming
 * Claude Opus 5 call, persists the NEW characters (idempotent — existing rows are kept, never deleted) and links
 * the episodes/scenes to them by name. Reference images are NOT started here (existing buttons do that).
 *
 * Returns { jobId, characters } immediately; the frontend polls GET /api/jobs/[jobId] (progress + live
 * `streamedText` + current characters).
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:characters", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const parsed = await parseBody(request, charactersSchema);
    if (!parsed.ok) return parsed.response;
    const { projectId } = parsed.data;

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        user: { select: { email: true } },
        seasons: { select: { episodes: { where: { script: { not: null } }, select: { id: true, script: true } } } },
      },
    });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (project.user?.email && project.user.email !== session.user.email)
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const scriptedEpisodes = project.seasons.flatMap((s) => s.episodes).filter((e) => (e.script ?? "").trim().length > 0);
    if (!scriptedEpisodes.length)
      return NextResponse.json({ error: "No saved episode scripts yet. Write the script first (Step 4), then create the characters from it." }, { status: 400 });

    // Don't start a second run while one is still processing for this project
    await failStaleJobs({ projectId, type: CHARACTERS_FROM_SCRIPT_JOB_TYPE });
    const active = await prisma.generationJob.findFirst({
      where: { projectId, type: CHARACTERS_FROM_SCRIPT_JOB_TYPE, status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    const characters = await prisma.character.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
    if (active) return NextResponse.json({ jobId: active.id, characters, resumed: true });

    const job = await prisma.generationJob.create({
      data: {
        type: CHARACTERS_FROM_SCRIPT_JOB_TYPE,
        status: "processing",
        progress: 2,
        message: `Reading ${scriptedEpisodes.length} episode script(s)…`,
        projectId,
      },
    });

    // Runs after the response is flushed; Vercel keeps this invocation alive up to maxDuration
    runInBackground(() => runCharactersFromScriptJob(job.id, projectId));

    return NextResponse.json({ jobId: job.id, characters });
  } catch (err: any) {
    console.error("Character extraction error:", err);
    return NextResponse.json({ error: "Generation failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
