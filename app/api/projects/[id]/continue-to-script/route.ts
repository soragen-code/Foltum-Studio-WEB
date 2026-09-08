export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

/**
 * POST /api/projects/[id]/continue-to-script
 *
 * "Продолжить к сценарию": locks characters and moves the project to the
 * existing "structure" stage (stage 2 of the new flow will replace this).
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { id } = await params;

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const project = await prisma.project.findFirst({ where: { id, userId: user.id }, include: { characters: true } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (!project.charactersApproved)
      return NextResponse.json({ error: "Confirm synopsis and characters first" }, { status: 400 });
    if (!project.characters.some((c) => c.imageFront || c.imageProfile || c.imageFull))
      return NextResponse.json({ error: "Wait for at least one character reference" }, { status: 400 });

    await prisma.$transaction([
      prisma.character.updateMany({ where: { projectId: id }, data: { isLocked: true, status: "references_ready" } }),
      prisma.project.update({ where: { id }, data: { charactersLocked: true, stage: "structure" } }),
    ]);

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("Continue to script error:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
