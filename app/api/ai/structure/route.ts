export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { chatJSON } from "@/lib/ai";

const SYSTEM = `You are a professional showrunner structuring a short-form vertical drama series (TikTok/Reels, 1-3 min episodes).

Given a synopsis, produce a detailed season/episode breakdown. Return ONLY valid JSON:

{
  "seasons": [
    {
      "number": 1,
      "title": "Season Title",
      "episodes": [
        {
          "number": 1,
          "title": "Episode Title",
          "description": "Brief episode description (1-2 sentences)",
          "cliffhanger": "The hook that makes viewers watch the next episode"
        }
      ]
    }
  ]
}

Rules:
- 1-3 seasons depending on story scope
- 6-12 episodes per season
- Each episode must have a cliffhanger or hook
- Titles should be evocative and short
- Descriptions should be specific to the story, not generic
- Build dramatic tension across the season arc`;

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

    const data = await chatJSON<{ seasons: any[] }>(
      SYSTEM,
      `Create an episode structure for this synopsis:\n\n${synopsisText}`,
      { temperature: 0.8, maxTokens: 4096 }
    );

    // Clear existing structure
    await prisma.season.deleteMany({ where: { projectId } });

    const createdSeasons = [];
    for (const sData of data.seasons) {
      const season = await prisma.season.create({
        data: {
          projectId,
          number: sData.number,
          title: sData.title,
        },
      });

      const eps = [];
      for (const epData of sData.episodes ?? []) {
        const ep = await prisma.episode.create({
          data: {
            seasonId: season.id,
            number: epData.number,
            title: epData.title,
            description: epData.description,
            cliffhanger: epData.cliffhanger,
          },
        });
        eps.push(ep);
      }
      createdSeasons.push({ ...season, episodes: eps });
    }

    return NextResponse.json({ seasons: createdSeasons });
  } catch (err: any) {
    console.error("Structure generation error:", err);
    return NextResponse.json({ error: "Generation failed" }, { status: 500 });
  }
}
