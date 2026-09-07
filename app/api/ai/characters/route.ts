export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { chatJSON } from "@/lib/ai";

const SYSTEM = `You are a character designer for a short-form vertical drama series.

Given a synopsis, extract and flesh out the main characters. Return ONLY valid JSON:

{
  "characters": [
    {
      "name": "Full Name",
      "description": "1-2 sentence character summary and role in story",
      "role": "Protagonist | Deuteragonist | Antagonist | Supporting | Recurring",
      "personality": "Detailed personality traits, motivations, flaws, strengths (2-3 sentences)",
      "appearance": "Detailed physical appearance for AI image generation: age, build, hair, eyes, skin tone, clothing style, distinguishing features (2-3 sentences)"
    }
  ]
}

Rules:
- Extract 3-6 characters
- Make appearances vivid and specific enough for AI image generation
- Each character should have clear visual distinctiveness
- Personality descriptions should reveal inner conflicts
- Roles should follow classical story structure`;

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { projectId, synopsis } = await request.json();
    if (!projectId)
      return NextResponse.json({ error: "Project ID required" }, { status: 400 });

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    const synopsisText = synopsis || project?.synopsis || "";
    if (!synopsisText)
      return NextResponse.json({ error: "No synopsis available" }, { status: 400 });

    // Delete existing characters
    await prisma.character.deleteMany({ where: { projectId } });

    const data = await chatJSON<{ characters: any[] }>(
      SYSTEM,
      `Extract and design characters from this synopsis:\n\n${synopsisText}`,
      { temperature: 0.85, maxTokens: 3000 }
    );

    const placeholder = "https://placehold.co/300x400/1a1a2e/eab308?text=";

    const created = [];
    for (const c of data.characters) {
      const char = await prisma.character.create({
        data: {
          projectId,
          name: c.name,
          description: c.description,
          role: c.role,
          personality: c.personality,
          appearance: c.appearance,
          // Placeholder images until image generation service is connected
          imageFront: placeholder + encodeURIComponent(c.name + " Front"),
          imageProfile: placeholder + encodeURIComponent(c.name + " Profile"),
          imageFull: placeholder + encodeURIComponent(c.name + " Full"),
        },
      });
      created.push(char);
    }

    return NextResponse.json({ characters: created });
  } catch (err: any) {
    console.error("Character generation error:", err);
    return NextResponse.json({ error: "Generation failed" }, { status: 500 });
  }
}
