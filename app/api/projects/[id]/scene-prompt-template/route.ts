export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

/**
 * POST /api/projects/[id]/scene-prompt-template
 *
 * Stage 242 — save the project-level EDITABLE scene-prompt template. buildScenePrompt() renders every
 * NON-override scene prompt from it (via {{SETTING}}/{{CHARACTERS}}/{{ACTIONS}} tokens); the "View Prompt"
 * preview and the video worker both read it, so a save immediately changes every scene's final prompt.
 *
 * Body: { template: string }. An empty / whitespace-only template is stored as NULL → the code falls back
 * to DEFAULT_SCENE_PROMPT_TEMPLATE (byte-for-byte the previous hard-coded output). Existing scene.videoPrompt
 * rows are NOT rewritten — the final prompt is assembled on the fly, so the new template applies at once.
 * Ownership: the project must belong to the authenticated user.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await params;

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const project = await prisma.project.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const raw = body?.template;
    if (raw !== undefined && raw !== null && typeof raw !== "string")
      return NextResponse.json({ error: "template must be a string" }, { status: 400 });
    // Empty / whitespace → NULL (= default template). Otherwise keep the text VERBATIM (no trimming — a
    // producer may intentionally use leading/trailing blank lines), only treating a blank string as reset.
    const template = typeof raw === "string" && raw.trim().length > 0 ? raw : null;

    await prisma.project.update({ where: { id }, data: { scenePromptTemplate: template } });

    return NextResponse.json({ success: true, scenePromptTemplate: template });
  } catch (err: any) {
    console.error("Save scene prompt template error:", err);
    return NextResponse.json({ error: "Failed to save template" }, { status: 500 });
  }
}
