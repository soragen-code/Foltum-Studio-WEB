export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { chatJSON } from "@/lib/ai";

const SYSTEM = `You are a character designer. Given a character's current data and the project synopsis, regenerate a fresh take on their appearance and personality while keeping their name and role.

Return ONLY valid JSON:
{
  "personality": "Updated personality (2-3 sentences)",
  "appearance": "Updated detailed physical appearance for AI image generation (2-3 sentences)"
}`;

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { characterId, projectId } = await request.json();
    if (!characterId)
      return NextResponse.json({ error: "Character ID required" }, { status: 400 });

    const existing = await prisma.character.findUnique({ where: { id: characterId } });
    if (!existing)
      return NextResponse.json({ error: "Character not found" }, { status: 404 });

    let synopsisText = "";
    if (projectId || existing.projectId) {
      const project = await prisma.project.findUnique({
        where: { id: projectId || existing.projectId },
      });
      synopsisText = project?.synopsis ?? "";
    }

    const data = await chatJSON<{ personality: string; appearance: string }>(
      SYSTEM,
      `Character: ${existing.name} (${existing.role})
Description: ${existing.description}
Current appearance: ${existing.appearance}
Current personality: ${existing.personality}
${synopsisText ? `\nProject synopsis: ${synopsisText}` : ""}

Generate a fresh, different take on this character's appearance and personality.`,
      { temperature: 1.0, maxTokens: 1000 }
    );

    const placeholder = "https://placehold.co/300x400/1a1a2e/eab308?text=";
    const character = await prisma.character.update({
      where: { id: characterId },
      data: {
        personality: data.personality,
        appearance: data.appearance,
        imageFront: placeholder + encodeURIComponent(existing.name + " Front v2"),
        imageProfile: placeholder + encodeURIComponent(existing.name + " Profile v2"),
        imageFull: placeholder + encodeURIComponent(existing.name + " Full v2"),
      },
    });

    return NextResponse.json({ character });
  } catch (err: any) {
    console.error("Character regen error:", err);
    return NextResponse.json({ error: "Regeneration failed" }, { status: 500 });
  }
}
