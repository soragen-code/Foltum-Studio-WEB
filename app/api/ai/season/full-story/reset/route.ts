export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { normalizeLanguage } from "@/lib/idea";
import { rebuildAutoStory } from "@/lib/reset-to-auto";

/**
 * POST /api/ai/season/full-story/reset { projectId }
 *
 * Stage 151 — "Reset to Auto" for the season STORY / plot (сюжет) on the "Plot" screen. Unlike the
 * edit-by-prompt revise (which rewrites the structure by an author instruction and can drift from the
 * synopsis), a reset DISCARDS whatever prose is currently stored in Season.fullStory (auto, manually
 * revised, or cached) and REGENERATES it from scratch under the CURRENT generation rules, driven by the
 * CURRENT synopsis + the current validated episode structure — via the same live deterministic builder
 * (buildFullStoryFromStructure) the season generator uses. No LLM call, no paid generation.
 *
 * This is non-destructive to episodes/scenes: it only rewrites the plot prose (the same field the
 * deterministic fullStory step of the season job writes), never the scripts or scenes.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await rateLimitByUser(request, "ai-season-story-reset", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const projectId = String(body?.projectId ?? "");
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

  const project = await prisma.project.findFirst({
    where: { id: projectId, userId: session.user.id },
    select: { id: true, synopsis: true, language: true },
  });
  if (!project?.synopsis) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const season = await prisma.season.findFirst({
    where: { projectId, number: 1 },
    include: { episodes: { orderBy: { number: "asc" }, select: { number: true, title: true, description: true } } },
  });
  if (!season) return NextResponse.json({ error: "No season to reset" }, { status: 404 });

  // Rebuild the plot from scratch under the current rules: current structure + current synopsis, live builder.
  const language = normalizeLanguage(project.language, project.synopsis);
  const fullStory = rebuildAutoStory(
    {
      title: season.title,
      logline: season.logline,
      episodes: season.episodes.map((e) => ({ number: e.number, title: e.title, description: e.description })),
    },
    language,
    project.synopsis,
  );

  await prisma.season.update({ where: { id: season.id }, data: { fullStory } });
  return NextResponse.json({ ok: true, fullStory }, { headers: { "Cache-Control": "no-store" } });
}
