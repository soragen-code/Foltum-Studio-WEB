export const dynamic = "force-dynamic";
export const maxDuration = 800; // the episode script is rewritten by the reasoning model inside this invocation

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { toCharacterCard, normalizeLanguage } from "@/lib/idea";
import { generateEpisodeScript, persistEpisodeScript, outlineFromEpisode, SEASON_JOB_TYPE } from "@/lib/workers/season-script-job";
import type { SeasonStructure } from "@/lib/season";

/**
 * POST /api/ai/episodes/[id]/revise { instruction }
 * LLM rewrites the whole episode script by the author's instruction (same schema: 10–15 scenes,
 * timing, language, coherence with neighbouring episodes) and rebuilds the episode's Scene rows.
 * Safety: scenes that already have a generated video are NOT deleted — the request is refused with
 * 409 unless `force: true` is sent (the UI warns; forcing drops the existing clips of this episode).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = rateLimitByUser(request, "ai:episode-revise", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;
  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  const instruction = String(body?.instruction ?? "").trim();
  if (instruction.length < 3) return NextResponse.json({ error: "Опишите, что изменить" }, { status: 400 });

  const episode = await prisma.episode.findFirst({
    where: { id, season: { project: { userId: session.user.id } } },
    include: { characters: { include: { character: true } }, scenes: { select: { videoUrl: true } }, season: { include: { project: { include: { characters: true } }, episodes: { orderBy: { number: "asc" }, include: { characters: { include: { character: true } } } } } } },
  });
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
  // Stage 5: the season job (generation or season-level revise) writes episodes whose `script` is null —
  // such an episode cannot be revised until the job has finished it.
  if (!episode.script) {
    const running = await prisma.generationJob.findFirst({ where: { projectId: episode.season.projectId, type: SEASON_JOB_TYPE, status: { in: ["pending", "processing"] } }, select: { id: true } });
    if (running) return NextResponse.json({ error: "Этот эпизод сейчас пишется — дождитесь, когда его сценарий будет готов.", writing: true }, { status: 409 });
  }
  const withVideo = episode.scenes.filter((s) => s.videoUrl).length;
  if (withVideo > 0 && !body?.force) {
    return NextResponse.json({ error: `У ${withVideo} сцен уже есть готовое видео. Переписывание сценария пересоберёт сцены и удалит эти ролики из эпизода.`, needsForce: true, withVideo }, { status: 409 });
  }
  const project = episode.season.project;
  const language = normalizeLanguage(project.language, project.synopsis ?? "");
  const cards = project.characters.map(toCharacterCard);
  const seasonStruct: SeasonStructure = { title: episode.season.title ?? "", logline: episode.season.logline ?? "", episodes: episode.season.episodes.map(outlineFromEpisode) };
  const outline = outlineFromEpisode(episode);
  const next = episode.season.episodes.find((e) => e.number === episode.number + 1);
  try {
    const script = await generateEpisodeScript({
      jobId: "", language, synopsis: project.synopsis ?? "", season: seasonStruct, episode: outline, characters: cards,
      previous: episode.season.episodes.filter((p) => p.number < episode.number).map((p) => ({ number: p.number, title: p.title, logline: p.logline ?? "", cliffhanger: p.cliffhanger ?? "" })),
      instruction: `${instruction}${next ? `\n(The NEXT episode ${next.number} «${next.title}» starts from: ${next.logline ?? ""} — keep this episode's ending compatible with it.)` : ""}`,
    });
    await persistEpisodeScript(episode.id, outline, script, project.characters.map((c) => ({ id: c.id, name: c.name })), language);
    return NextResponse.json({ ok: true, sceneCount: script.scenes.length });
  } catch (err) {
    console.error("[episode revise]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Revision failed" }, { status: 500 });
  }
}
