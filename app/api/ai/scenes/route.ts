export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { chatJSON } from "@/lib/ai";

const EPISODE_MIN_SECONDS = Number(process.env.EPISODE_MIN_SECONDS ?? 60);
// Seedance 2.5 renders one scene = one ~5 s clip. To reach ~1 minute per episode
// (and NEVER less), we need enough scenes to cover EPISODE_MIN_SECONDS at 5 s each.
const SCENE_SECONDS = Number(process.env.SCENE_SECONDS ?? 5);
const SCENES_PER_EPISODE = Number(
  process.env.SCENES_PER_EPISODE ?? Math.ceil(EPISODE_MIN_SECONDS / SCENE_SECONDS)
);

const SYSTEM = `You are a professional screenwriter creating scene breakdowns for a short-form vertical drama series (TikTok/Reels format). Every episode must run AT LEAST ${EPISODE_MIN_SECONDS} seconds of screen time.

Given the project synopsis, episode description, and characters, break the episode into exactly ${SCENES_PER_EPISODE} scenes of about ${SCENE_SECONDS} seconds each (total ≥ ${EPISODE_MIN_SECONDS} s). Return ONLY valid JSON:

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
- Exactly ${SCENES_PER_EPISODE} scenes per episode, each written for ~${SCENE_SECONDS} seconds of screen time (a Seedance clip is short — typically 1-2 spoken lines, or a single beat of action, fit into ~${SCENE_SECONDS} s)
- Dialogue should be natural and dramatic, in screenplay format
- Location descriptions should be vivid and filmable
- Video prompts should be detailed enough for AI video generation (Seedance/Minimax style)
- Include camera directions in video prompts (close-up, wide shot, tracking, etc.)
- Build tension within each episode toward the cliffhanger
- Some scenes can have no dialogue (use [NO DIALOGUE] or [VISUAL MONTAGE])

IMPORTANT LANGUAGE RULES:
- Write dialogue and locationDesc in the SAME LANGUAGE as the synopsis/episode description. If they are in Russian — write in Russian.
- EXCEPTION: The "videoPrompt" field must ALWAYS be in English — it is used as a prompt for AI video generation (Seedance) and works best in English.`;

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
