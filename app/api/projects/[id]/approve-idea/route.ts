export const dynamic = "force-dynamic";
export const maxDuration = 800; // background character-images job runs inside this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runCharacterImagesJob } from "@/lib/workers/character-images-job";

/**
 * POST /api/projects/[id]/approve-idea
 *
 * "Confirm synopsis and characters": marks synopsis + characters approved,
 * moves the project to the "references" step and starts the existing
 * character-images job (Seedream) for every character that has no reference yet.
 * Idempotent: if a job is already running it is returned instead of a new one.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    // { next: "structure" } — stage 5 auto-chain: the idea screen goes straight to the season script;
    // references become an optional tab, so no reference job is started here.
    const body = await request.json().catch(() => ({}));
    const straightToScript = body?.next === "structure";
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await params;

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const project = await prisma.project.findFirst({
      where: { id, userId: user.id },
      include: { characters: { orderBy: { createdAt: "asc" } } },
    });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (!project.synopsis) return NextResponse.json({ error: "Generate a synopsis first" }, { status: 400 });
    if (project.characters.length === 0) return NextResponse.json({ error: "No characters to approve" }, { status: 400 });

    await prisma.$transaction([
      prisma.project.update({
        where: { id },
        data: { synopsisApproved: true, charactersApproved: true, stage: straightToScript ? "structure" : "references" },
      }),
      prisma.character.updateMany({ where: { projectId: id, status: "draft" }, data: { status: "approved" } }),
    ]);
    if (straightToScript) return NextResponse.json({ success: true, jobId: null, stage: "structure" });

    await failStaleJobs({ projectId: id, type: "characters" });
    const active = await prisma.generationJob.findFirst({
      where: { projectId: id, type: "characters", status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    if (active) return NextResponse.json({ success: true, jobId: active.id, resumed: true });

    // Free auto-generation covers the MAIN cast only; supporting/minor/crowd references are
    // started from the References stage buttons (charged per character).
    // Stage 53: a character reference is the single full-body photo (imageFull); legacy characters that
    // only have the old front portrait already count as done (video falls back to imageFront).
    const pending = project.characters.filter((c) => c.tier === "MAIN" && !c.imageFull && !c.imageFront);
    if (pending.length === 0) return NextResponse.json({ success: true, jobId: null });

    const job = await prisma.generationJob.create({
      data: {
        type: "characters",
        status: "processing",
        progress: 5,
        message: `Starting reference generation for ${pending.length} character(s)...`,
        projectId: id,
        resultData: JSON.stringify({ characterIds: pending.map((c) => c.id) }),
      },
    });
    runInBackground(() =>
      runCharacterImagesJob({ jobId: job.id, projectId: id, characterIds: pending.map((c) => c.id) })
    );

    return NextResponse.json({ success: true, jobId: job.id });
  } catch (err: any) {
    console.error("Approve idea error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
