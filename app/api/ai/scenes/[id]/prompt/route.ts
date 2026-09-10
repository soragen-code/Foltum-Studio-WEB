export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { buildScenePrompt } from "@/lib/scene-prompt";

/**
 * GET /api/ai/scenes/[id]/prompt
 *
 * Returns the FINAL Seedance prompt for the scene EXACTLY as the video worker assembles it
 * (both go through the same lib/scene-prompt.ts), with two deliberate differences that make this a
 * safe read-only preview:
 *   - no LLM dialogue translation is run (the stored dialogueEn / dialogue is voiced verbatim);
 *   - no real reference image is generated or exposed — references appear only as the
 *     `[Image1]…[ImageN]` placeholders the worker itself writes into the prompt.
 *
 * Response: { prompt, model }. Ownership: scene → episode → season → project → userId.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });

  const limited = rateLimitByUser(request, "ai:scene-prompt", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;

  // Ownership is enforced in the query: a scene of another user's project simply returns null.
  const scene = await prisma.scene.findFirst({
    where: { id, episode: { season: { project: { userId: session.user.id } } } },
    include: {
      characters: { include: { character: true } },
      episode: { select: { id: true, location: { select: { id: true, name: true, imageUrl: true, imageReverse: true, imageDetail: true } } } },
    },
  });
  if (!scene) return NextResponse.json({ error: "Сцена не найдена" }, { status: 404 });
  if (!scene.videoPrompt) return NextResponse.json({ error: "У сцены ещё нет видео-промпта" }, { status: 400 });

  // Adjacent previous scene — same lookup the worker uses to decide frame chaining.
  const previous = scene.number > 1 ? await prisma.scene.findFirst({
    where: { episodeId: scene.episodeId, number: scene.number - 1 },
    select: { id: true, number: true, locationDesc: true, lastFrameUrl: true },
  }) : null;

  const built = buildScenePrompt({
    scene,
    characters: scene.characters.map(l => ({ characterId: l.characterId, name: l.character.name, tier: l.character.tier, imageFront: l.character.imageFront })),
    location: scene.episode.location ?? null,
    previous,
    // The scene's chosen model ("seedance" | "seedance-2.0"); the worker resolves it the same way.
    provider: scene.videoModel,
  });

  return NextResponse.json({ prompt: built.prompt, model: built.model, hasOverride: !!(scene.promptOverride ?? "").trim() });
}

/**
 * PUT /api/ai/scenes/[id]/prompt
 *
 * Save (or reset) the scene's manual final-prompt override. Body: { prompt: string }.
 *   - non-empty  → stored verbatim (edge-trimmed) and used as the final prompt TEXT on the next
 *                  generation(s) of this scene, until changed;
 *   - empty / whitespace → resets to null, so the auto-assembled prompt is used again.
 *
 * The override changes only the TEXT — frame/reference chaining is always recomputed at generation
 * time. Response: { ok: true, hasOverride: boolean }. Same ownership chain as GET.
 */
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Требуется вход" }, { status: 401 });

  const limited = rateLimitByUser(request, "ai:scene-prompt", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Некорректный запрос" }, { status: 400 });
  }
  const raw = (body as { prompt?: unknown } | null)?.prompt;
  if (raw !== undefined && typeof raw !== "string") {
    return NextResponse.json({ error: "Некорректный промпт" }, { status: 400 });
  }
  const trimmed = (raw ?? "").toString().trim();
  const promptOverride = trimmed.length ? trimmed : null;

  // Ownership is enforced in the query: a scene of another user's project simply returns null.
  const scene = await prisma.scene.findFirst({
    where: { id, episode: { season: { project: { userId: session.user.id } } } },
    select: { id: true },
  });
  if (!scene) return NextResponse.json({ error: "Сцена не найдена" }, { status: 404 });

  await prisma.scene.update({ where: { id: scene.id }, data: { promptOverride } });

  return NextResponse.json({ ok: true, hasOverride: promptOverride !== null });
}
