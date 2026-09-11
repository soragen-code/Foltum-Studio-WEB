export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { buildTestEpisodeRecords, missingPromptTags, TEST_EPISODE_DURATION_SEC, TEST_EPISODE_TITLE, TEST_PROMPT_MAX_CHARS, TEST_PROMPT_MIN_CHARS } from "@/lib/test-episode";
import { detectLanguage } from "@/lib/idea";

/**
 * POST /api/projects/[id]/test-episode
 * { prompt, projectTitle?, title?, locationDesc?, dialogue?, action?, durationSec?, sceneKind?, startState?, endState? }
 * Stage 40: turns the project into a «Тестовая серия» sandbox — one season, one episode, ONE scene built
 * straight from the given Seedance prompt — and jumps the project to the `scenes` stage so the regular
 * episode page (prompt preview, generation, chain hand-off, assembly) can be used at the cost of a single clip.
 * Re-running on the same project replaces the test scene (the previous test episode's scenes are deleted).
 * The project name is never asked from the author: it is derived from the scene (LLM title or first words of the prompt).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:test-episode", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length < TEST_PROMPT_MIN_CHARS) return NextResponse.json({ error: `Промпт сцены слишком короткий (минимум ${TEST_PROMPT_MIN_CHARS} символов)` }, { status: 400 });
  if (prompt.length > TEST_PROMPT_MAX_CHARS) return NextResponse.json({ error: `Промпт сцены слишком длинный (максимум ${TEST_PROMPT_MAX_CHARS} символов)` }, { status: 400 });
  const str = (k: string) => (typeof body?.[k] === "string" ? (body[k] as string) : null);

  const project = await prisma.project.findFirst({ where: { id, userId: session.user.id }, select: { id: true, isTest: true, language: true } });
  if (!project) return NextResponse.json({ error: "Проект не найден" }, { status: 404 });

  const records = buildTestEpisodeRecords({
    prompt,
    projectTitle: str("projectTitle"),
    title: str("title"),
    locationDesc: str("locationDesc"),
    dialogue: str("dialogue"),
    action: str("action"),
    durationSec: TEST_EPISODE_DURATION_SEC,
    sceneKind: str("sceneKind"),
    endState: str("endState"),
    startState: str("startState"),
    language: detectLanguage(str("projectTitle") || str("title") || prompt),
  });

  const episodeId = await prisma.$transaction(async (tx) => {
    await tx.project.update({ where: { id: project.id }, data: { ...records.project, idea: prompt } });
    let season = await tx.season.findFirst({ where: { projectId: project.id, number: 1 }, select: { id: true } });
    if (!season) season = await tx.season.create({ data: { projectId: project.id, ...records.season }, select: { id: true } });
    else await tx.season.update({ where: { id: season.id }, data: { title: records.season.title, logline: records.season.logline } });
    let episode = await tx.episode.findFirst({ where: { seasonId: season.id, title: TEST_EPISODE_TITLE }, select: { id: true } })
      ?? await tx.episode.findFirst({ where: { seasonId: season.id, number: 1 }, select: { id: true } });
    const epData = { ...records.episode, chainMode: "parallel", chainRunActive: false, chainRunNote: null, videoUrl: null };
    if (!episode) {
      episode = await tx.episode.create({ data: { seasonId: season.id, ...epData }, select: { id: true } });
    } else {
      await tx.scene.deleteMany({ where: { episodeId: episode.id } });
      await tx.episode.update({ where: { id: episode.id }, data: epData });
    }
    await tx.scene.create({ data: { episodeId: episode.id, ...records.scene } });
    return episode.id;
  });

  return NextResponse.json({ ok: true, episodeId, projectName: records.project.name, missingTags: missingPromptTags(prompt) });
}
