export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { loadGridInputs } from "@/lib/workers/storyboard-grid-job";
import { buildGridPrompt } from "@/lib/storyboard-grid";

/**
 * Stage 240 — GRID STORYBOARD prompt editor endpoint (drives the shared PromptModal).
 *
 * GET  /api/ai/storyboard/grid/prompt?episodeId=...  →  { prompt, hasOverride }
 *   Returns the producer's saved prompt if any (hasOverride true), otherwise the freshly built default prompt.
 *
 * PUT  /api/ai/storyboard/grid/prompt  { prompt }  →  { prompt, hasOverride }
 *   Empty prompt → reset to the auto-built default (clears the override). Non-empty → save as the override.
 */
async function ownedEpisode(userId: string, episodeId: string) {
  return prisma.episode.findFirst({
    where: { id: episodeId, season: { project: { userId } } },
    select: { id: true, gridPrompt: true },
  });
}

/** Build the default (auto) grid prompt from the episode's current data. */
async function buildDefault(episodeId: string): Promise<string> {
  const { characters, location, locations, scenes, keyElement } = await loadGridInputs(episodeId);
  const { prompt } = buildGridPrompt({ characters, location, locations, scenes, keyElement, template: null });
  return prompt;
}

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const episodeId = url.searchParams.get("episodeId") ?? "";
  if (!episodeId) return NextResponse.json({ error: "episodeId required" }, { status: 400 });

  const episode = await ownedEpisode(session.user.id, episodeId);
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });

  const auto = await buildDefault(episodeId);
  const saved = (episode.gridPrompt ?? "").trim();
  const hasOverride = saved.length > 0 && saved !== auto.trim();
  return NextResponse.json(
    { prompt: saved || auto, hasOverride },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = rateLimitByUser(request, "ai:storyboard-grid-prompt", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const body = await request.json().catch(() => ({}));
  const episodeId = typeof body?.episodeId === "string" ? body.episodeId : (new URL(request.url).searchParams.get("episodeId") ?? "");
  if (!episodeId) return NextResponse.json({ error: "episodeId required" }, { status: 400 });

  const episode = await ownedEpisode(session.user.id, episodeId);
  if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });

  const next = typeof body?.prompt === "string" ? String(body.prompt).trim() : "";
  if (!next) {
    // Reset to auto — drop the override.
    await prisma.episode.update({ where: { id: episodeId }, data: { gridPrompt: null } });
    const auto = await buildDefault(episodeId);
    return NextResponse.json({ prompt: auto, hasOverride: false });
  }
  await prisma.episode.update({ where: { id: episodeId }, data: { gridPrompt: next } });
  const auto = await buildDefault(episodeId);
  return NextResponse.json({ prompt: next, hasOverride: next !== auto.trim() });
}
