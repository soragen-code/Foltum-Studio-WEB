export const dynamic = "force-dynamic";
/**
 * Stage 46A — POST /api/ai/short-synopsis { projectId, comment? }
 * Writes (or reworks, when a comment / previous version exists) the SHORT season synopsis with the fast
 * model and stores it as JSON in Project.shortSynopsis. Approval happens through the existing
 * approve-idea → /api/ai/season chain; the season-structure prompt then receives it as a mandatory outline.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { chatJSON } from "@/lib/ai";
import { toCharacterCard, normalizeLanguage } from "@/lib/idea";
import { SEASON_DEFAULT_EPISODES } from "@/lib/season";
import { clampEpisodeCount, normalizeShortSynopsis, parseStoredShortSynopsis, shortSynopsisSystemPrompt, shortSynopsisUserPrompt } from "@/lib/short-synopsis";

const bodySchema = z.object({
  projectId: z.string().min(1),
  comment: z.string().max(2000).optional(),
  /** Requested episode count (the idea form value); persisted on the project so the season uses the same number. */
  episodeCount: z.number().int().optional(),
});

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:short-synopsis", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    const { projectId, comment, episodeCount: requested } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, include: { characters: { orderBy: { createdAt: "asc" } } } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (!project.synopsis) return NextResponse.json({ error: "Сначала опишите идею" }, { status: 400 });

    const episodeCount = clampEpisodeCount(requested ?? project.episodeCount, SEASON_DEFAULT_EPISODES);
    const language = normalizeLanguage(project.language, project.idea || project.synopsis);
    const previous = parseStoredShortSynopsis(project.shortSynopsis);
    const cards = project.characters.map(toCharacterCard);

    let result;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 2 && !result; attempt++) {
      try {
        const raw = await chatJSON(
          shortSynopsisSystemPrompt(language, episodeCount),
          shortSynopsisUserPrompt({ idea: project.idea ?? "", synopsis: project.synopsis, characters: cards, episodeCount, previous, comment }),
          { temperature: attempt === 1 ? 0.8 : 0.6, maxTokens: 2500 },
        );
        result = normalizeShortSynopsis(raw, episodeCount);
      } catch (e) { lastErr = e; console.warn(`[short-synopsis] attempt ${attempt} failed:`, e instanceof Error ? e.message : e); }
    }
    if (!result) throw lastErr ?? new Error("short synopsis failed");

    await prisma.project.update({ where: { id: projectId }, data: { shortSynopsis: JSON.stringify(result), episodeCount } });
    return NextResponse.json({ shortSynopsis: result, episodeCount });
  } catch (err) {
    console.error("[short-synopsis] error:", err);
    return NextResponse.json({ error: "Не удалось составить краткий синопсис" }, { status: 500 });
  }
}
