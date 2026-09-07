export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { chatJSON } from "@/lib/ai";

const SYSTEM = `You are a professional screenwriter creating scene breakdowns for a short-form vertical drama series (TikTok/Reels format, 1-3 min episodes).

Given the project synopsis, episode description, and characters, break the episode into 4-6 scenes. Return ONLY valid JSON:

{
  "scenes": [
    {
      "number": 1,
      "dialogue": "CHARACTER_NAME: \\"Line of dialogue.\\"\\nCHARACTER2: \\"Response.\\"",
      "locationDesc": "INT/EXT — Location — Time. Vivid description of the setting, lighting, atmosphere.",
      "videoPrompt": "Detailed prompt for AI video generation: camera angle, movement, lighting, mood, visual style. Be cinematic and specific."
    }
  ]
}

Rules:
- 4-6 scenes per episode
- Dialogue should be natural and dramatic, in screenplay format
- Location descriptions should be vivid and filmable
- Video prompts should be detailed enough for AI video generation (Seedance/Minimax style)
- Include camera directions in video prompts (close-up, wide shot, tracking, etc.)
- Build tension within each episode toward the cliffhanger
- Some scenes can have no dialogue (use [NO DIALOGUE] or [VISUAL MONTAGE])`;

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { projectId, episodeId } = await request.json();
    if (!episodeId)
      return NextResponse.json({ error: "Episode ID required" }, { status: 400 });

    const episode = await prisma.episode.findUnique({
      where: { id: episodeId },
      include: { season: { include: { project: true } } },
    });
    if (!episode)
      return NextResponse.json({ error: "Episode not found" }, { status: 404 });

    const pid = projectId || episode.season?.projectId;
    const synopsis = episode.season?.project?.synopsis ?? "";

    const characters = await prisma.character.findMany({
      where: { projectId: pid },
      select: { name: true, role: true, description: true, appearance: true },
    });

    const charSummary = characters
      .map((c) => `- ${c.name} (${c.role}): ${c.description}. Appearance: ${c.appearance}`)
      .join("\n");

    const userMsg = `Project synopsis: ${synopsis}

Characters:
${charSummary || "No characters defined yet."}

Episode ${episode.number}: "${episode.title}"
Description: ${episode.description}
Cliffhanger: ${episode.cliffhanger ?? "N/A"}

Generate scenes for this episode.`;

    const data = await chatJSON<{ scenes: any[] }>(SYSTEM, userMsg, {
      temperature: 0.85,
      maxTokens: 4096,
    });

    // Clear existing scenes
    await prisma.scene.deleteMany({ where: { episodeId } });

    const created = [];
    for (const s of data.scenes) {
      const scene = await prisma.scene.create({
        data: {
          episodeId,
          number: s.number,
          dialogue: s.dialogue,
          locationDesc: s.locationDesc,
          videoPrompt: s.videoPrompt,
          status: "pending",
        },
      });
      created.push(scene);
    }

    return NextResponse.json({ scenes: created });
  } catch (err: any) {
    console.error("Scene generation error:", err);
    return NextResponse.json({ error: "Generation failed" }, { status: 500 });
  }
}
