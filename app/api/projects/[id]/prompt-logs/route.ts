export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { PROMPT_LOG_VERSION } from "@/lib/prompt-log";

/**
 * GET /api/projects/[id]/prompt-logs?kind=idea,logline&episodeId=&sceneId=&limit=20
 *
 * The prompts actually sent to the LLM / WaveSpeed for this project (see lib/prompt-log.ts — rows of
 * GenerationLog with promptVersion = "prompt-log"; the prompt text lives in `notes`). Newest first.
 * `kind` is a comma-separated list; `limit` defaults to 20 (max 100).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await params;

    const project = await prisma.project.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const sp = new URL(request.url).searchParams;
    const kinds = (sp.get("kind") ?? "").split(",").map((k) => k.trim()).filter(Boolean);
    const episodeId = sp.get("episodeId")?.trim() || null;
    const sceneId = sp.get("sceneId")?.trim() || null;
    const limitRaw = Number.parseInt(sp.get("limit") ?? "20", 10);
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 20));

    const rows = await prisma.generationLog.findMany({
      where: {
        projectId: id,
        promptVersion: PROMPT_LOG_VERSION,
        ...(kinds.length ? { kind: { in: kinds } } : {}),
        ...(episodeId ? { episodeId } : {}),
        // sceneId is stored inside `notes` (Json) — filter after the query, over-fetching a little.
      },
      orderBy: { createdAt: "desc" },
      take: sceneId ? limit * 5 : limit,
      select: { id: true, kind: true, model: true, createdAt: true, episodeId: true, notes: true },
    });

    const logs = rows
      .map((r) => {
        const n = (r.notes && typeof r.notes === "object" && !Array.isArray(r.notes) ? r.notes : {}) as Record<string, unknown>;
        return {
          id: r.id,
          kind: r.kind,
          model: r.model,
          createdAt: r.createdAt.toISOString(),
          episodeId: r.episodeId,
          provider: typeof n.provider === "string" ? n.provider : null,
          endpoint: typeof n.endpoint === "string" ? n.endpoint : null,
          system: typeof n.system === "string" ? n.system : null,
          user: typeof n.user === "string" ? n.user : "",
          extra: n.extra && typeof n.extra === "object" ? (n.extra as Record<string, unknown>) : null,
          sceneId: typeof n.sceneId === "string" ? n.sceneId : null,
        };
      })
      .filter((l) => !sceneId || l.sceneId === sceneId)
      .slice(0, limit);

    return NextResponse.json({ logs });
  } catch (err) {
    console.error("[prompt-logs] GET failed:", err);
    return NextResponse.json({ error: "Failed to load prompt logs" }, { status: 500 });
  }
}
