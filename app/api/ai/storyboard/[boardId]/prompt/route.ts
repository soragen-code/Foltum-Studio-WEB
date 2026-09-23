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
    //   • per-scene board (has castInFrame): the start frame shows everyone present at the START
    //     (onScreen ∪ exiting, minus entering); the end frame shows everyone present at the END
    //     (onScreen ∪ entering, minus exiting) — mirrors the split's startVisible/endVisible logic.
    //   • legacy board (null castInFrame): fall back to the direction/position/action heuristic.
    const cif = (board.castInFrame ?? null) as CastInFrameLite | null;
    let coverage: BoardCoverage;
    if (cif && Array.isArray(cif.onScreen)) {
      const onScreen = cif.onScreen ?? [];
      const entering = cif.entering ?? [];
      const exiting = cif.exiting ?? [];
      const inFrame = board.boardRole === "end"
        ? fullCast.filter((c) => (onScreen.includes(c) || entering.includes(c)) && !exiting.includes(c))
        : fullCast.filter((c) => (onScreen.includes(c) || exiting.includes(c)) && !entering.includes(c));
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

    await prisma.board.update({ where: { id: board.id }, data: { imagePrompt: prompt } });

    return NextResponse.json({ prompt });
  } catch (err: any) {
    console.error("Board prompt rebuild error:", err);
    return NextResponse.json({ error: "Prompt rebuild failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
