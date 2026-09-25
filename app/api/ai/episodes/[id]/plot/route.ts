export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { streamChatText, EPISODE_SCRIPT_MODEL } from "@/lib/ai";
import {
  episodePlotSystemPrompt,
  episodePlotUserPrompt,
  type SeasonStructure,
} from "@/lib/season";
import { outlineFromEpisode } from "@/lib/workers/season-script-job";
import type { IdeaLanguage } from "@/lib/idea";

/**
 * Stage 173 (task 2) — POST /api/ai/episodes/[id]/plot → { plot }
 * Generates (or regenerates) the PLOT (сюжет) of ONE episode from the approved synopsis, the season structure
 * and the plots of the PREVIOUS episodes. Plots are written SEQUENTIALLY: episode N's plot can only be
 * generated once episode N-1 already has a plot (episode 1 has no prerequisite). Regenerating an episode that
 * already has a plot is always allowed. The plot is the AUTHORITATIVE BASIS for that episode's script (task 3).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await rateLimitByUser(request, "ai:episode-plot", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;

  const episode = await prisma.episode.findFirst({
    where: { id, season: { project: { userId: session.user.id } } },
    include: {
      characters: { include: { character: { select: { name: true } } } },
      location: { select: { detailLevel: true } },
      season: {
        select: {
          id: true,
          title: true,
          logline: true,
          project: { select: { synopsis: true, language: true } },
          episodes: {
            orderBy: { number: "asc" },
            include: { characters: { include: { character: { select: { name: true } } } }, location: { select: { detailLevel: true } } },
          },
        },
      },
    },
  });
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });

  const season = episode.season;
  const synopsis = season.project.synopsis?.trim() ?? "";
  if (!synopsis) return NextResponse.json({ error: "First approve the synopsis" }, { status: 400 });

  const all = season.episodes;
  const target = all.find((e) => e.id === episode.id)!;

  // Sequential gate — the immediately-preceding episode (by number) must already have a plot, unless this is
  // the first episode or this episode is being REGENERATED (already has a plot).
  const prevEp = all.filter((e) => e.number < target.number).sort((a, b) => b.number - a.number)[0] ?? null;
  const alreadyHasPlot = !!target.plot?.trim();
  if (prevEp && !prevEp.plot?.trim() && !alreadyHasPlot) {
    return NextResponse.json({ error: `Сначала сгенерируйте сюжет серии ${prevEp.number}` }, { status: 409 });
  }

  const language = ((season.project.language as IdeaLanguage) ?? "en");
  const structure: SeasonStructure = {
    title: season.title ?? "",
    logline: season.logline ?? "",
    episodes: all.map(outlineFromEpisode),
  };
  const previousPlots = all
    .filter((e) => e.number < target.number && !!e.plot?.trim())
    .map((e) => ({ number: e.number, plot: e.plot as string }));

  await prisma.episode.update({ where: { id: target.id }, data: { plotStatus: "generating" } });

  let plot = "";
  try {
    // STREAMING (not chat()): Claude Opus 5 on WaveSpeed emits hidden interleaved "thinking" tokens that
    // on a non-streaming call consume the whole budget and return truncated/empty visible prose. Streaming
    // accumulates only the visible content; a generous budget fits the thinking + the episode plot.
    plot = (
      await streamChatText(
        episodePlotSystemPrompt(language, target.number),
        episodePlotUserPrompt({ synopsis, season: structure, episode: outlineFromEpisode(target), previousPlots, language }),
        { model: EPISODE_SCRIPT_MODEL, maxTokens: 6000, temperature: 0.8 },
      )
    ).trim();
  } catch (err) {
    console.error("[episode-plot] generation failed:", err);
    await prisma.episode.update({ where: { id: target.id }, data: { plotStatus: alreadyHasPlot ? "ready" : null } });
    return NextResponse.json({ error: "Не удалось сгенерировать сюжет" }, { status: 502 });
  }

  if (!plot) {
    await prisma.episode.update({ where: { id: target.id }, data: { plotStatus: alreadyHasPlot ? "ready" : null } });
    return NextResponse.json({ error: "Пустой ответ модели" }, { status: 502 });
  }

  await prisma.episode.update({ where: { id: target.id }, data: { plot, plotStatus: "ready" } });
  return NextResponse.json({ plot, number: target.number });
}
