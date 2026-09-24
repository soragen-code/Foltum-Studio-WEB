export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { buildBoardFramePrompt } from "@/lib/storyboard-prompt";
import { loadEpisodeCharacters, coverageFromNames } from "@/lib/workers/storyboard-job";
import { resolveVisibleCast, type BoardCoverage } from "@/lib/board-coverage";
import { readBoardDirection } from "@/lib/storyboard-direction";

type CastInFrameLite = { onScreen?: string[]; entering?: string[]; exiting?: string[] };

/**
 * POST /api/ai/storyboard/[boardId]/prompt  →  { prompt }
 *
 * Rebuild ONLY the board's English FRAME prompt TEXT (Board.imagePrompt) with the CURRENT builder rules
 * (buildBoardFramePrompt, "planned" variant — the same call the split uses at lib/workers/storyboard-job.ts).
 * This is a light, synchronous, deterministic text rebuild:
 *   - it does NOT render the keyframe, does NOT call any image/video provider, and creates NO background job;
 *   - it NEVER clears or touches Board.imageUrl / Board.videoUrl / animateRefs / status — only imagePrompt.
 * The scenario/text inputs come straight from the board (index, actionOrDialogue, castInFrame/boardRole) and
 * its episode (cast identity links, location), so the rebuilt prompt reflects the up-to-date builder.
 */
export async function POST(request: Request, ctx: { params: Promise<{ boardId: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:board-prompt", session.user.email ?? session.user.id, RATE_LIMITS.ai);
    if (limited) return limited;

    const { boardId } = await ctx.params;
    const board = await prisma.board.findFirst({
      where: { id: boardId, episode: { mode: "STORYBOARD", season: { project: { userId: session.user.id } } } },
      select: {
        id: true,
        index: true,
        actionOrDialogue: true,
        boardRole: true,
        castInFrame: true,
        directionJson: true,
        episodeId: true,
        episode: { select: { locationName: true, locationDesc: true } },
      },
    });
    if (!board) return NextResponse.json({ error: "Board not found" }, { status: 404 });

    // Cast identity links (same loader the worker uses) — no reference images are rendered or attached here.
    const { links } = await loadEpisodeCharacters(board.episodeId);
    const fullCast = links.map((l) => l.name);

    // Resolve EXACTLY who is in frame for this board, deterministically and without any rendered image:
    //   • per-scene board (has castInFrame): the keyframe shows everyone present at the scene start
    //     (onScreen ∪ exiting, minus entering) — mirrors the split's startVisible logic.
    //   • legacy board (null castInFrame): fall back to the direction/position/action heuristic.
    const cif = (board.castInFrame ?? null) as CastInFrameLite | null;
    let coverage: BoardCoverage;
    if (cif && Array.isArray(cif.onScreen)) {
      const onScreen = cif.onScreen ?? [];
      const entering = cif.entering ?? [];
      const exiting = cif.exiting ?? [];
      const inFrame = fullCast.filter((c) => (onScreen.includes(c) || exiting.includes(c)) && !entering.includes(c));
      coverage = coverageFromNames(inFrame.length ? inFrame : onScreen, fullCast);
    } else {
      const direction = readBoardDirection(board.directionJson);
      coverage = resolveVisibleCast(direction, board.index, fullCast, board.actionOrDialogue);
    }

    // Only the visible characters' identity lines go into the prompt (fall back to the full cast if none matched).
    const visibleLinks = links.filter((l) => coverage.visible.includes(l.name));
    const characters = visibleLinks.length ? visibleLinks : links;

    // "Planned" builder call — text only (no plate, anchor, continuity or ref images). Matches the split's
    // framePrompt() at lib/workers/storyboard-job.ts, so the text follows the current builder rules exactly.
    const prompt = buildBoardFramePrompt({
      board: { index: board.index, actionOrDialogue: board.actionOrDialogue, motion: null, directionJson: null },
      characters,
      coverage,
      locationName: board.episode.locationName,
      locationDesc: board.episode.locationDesc,
    }).prompt;

    // Stage 233 — a rebuild returns to the AUTO prompt, so any manual override is cleared as well.
    await prisma.board.update({ where: { id: board.id }, data: { imagePrompt: prompt, imagePromptOverride: null } });

    return NextResponse.json({ prompt });
  } catch (err: any) {
    console.error("Board prompt rebuild error:", err);
    return NextResponse.json({ error: "Prompt rebuild failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

/**
 * PATCH /api/ai/storyboard/[boardId]/prompt  →  { imagePrompt, motionPrompt }
 *
 * Stage 233 — SAVE (or CLEAR) the board's USER-EDITED prompt overrides. The render workers use these VERBATIM when
 * set (imagePromptOverride for the frame, motionPromptOverride for the i2v animation), so a manual edit sticks
 * across re-renders. Body fields are OPTIONAL and independent:
 *   - imagePrompt / motionPrompt: a non-empty string SETS the override; an empty string / null CLEARS it (reset to
 *     the auto-composed prompt). A field left undefined is not touched.
 * Editing prompt TEXT never renders anything and never clears imageUrl/videoUrl/status — it only updates the text.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ boardId: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:board-prompt-edit", session.user.email ?? session.user.id, RATE_LIMITS.ai);
    if (limited) return limited;

    const { boardId } = await ctx.params;
    const board = await prisma.board.findFirst({
      where: { id: boardId, episode: { mode: "STORYBOARD", season: { project: { userId: session.user.id } } } },
      select: { id: true },
    });
    if (!board) return NextResponse.json({ error: "Board not found" }, { status: 404 });

    const body = (await request.json().catch(() => ({}))) as { imagePrompt?: string | null; motionPrompt?: string | null };
    const data: { imagePromptOverride?: string | null; imagePrompt?: string; motionPromptOverride?: string | null } = {};
    if (body.imagePrompt !== undefined) {
      const v = (body.imagePrompt ?? "").trim();
      data.imagePromptOverride = v || null;
      // Mirror the edited text into imagePrompt so the UI shows the saved prompt immediately (until next render).
      if (v) data.imagePrompt = v;
    }
    if (body.motionPrompt !== undefined) {
      const v = (body.motionPrompt ?? "").trim();
      data.motionPromptOverride = v || null;
    }
    if (Object.keys(data).length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

    const updated = await prisma.board.update({
      where: { id: board.id },
      data,
      select: { imagePromptOverride: true, motionPromptOverride: true, imagePrompt: true, motionEn: true, motionPromptEn: true },
    });
    return NextResponse.json({ ok: true, board: updated });
  } catch (err: any) {
    console.error("Board prompt edit error:", err);
    return NextResponse.json({ error: "Prompt save failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
