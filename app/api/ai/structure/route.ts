export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { chatJSON } from "@/lib/ai";

// Keep episode length in sync with the scene breakdown (app/api/ai/scenes/route.ts).
// Each episode's scenes must sum to ABOUT 1 minute, but NEVER less.
const EPISODE_MIN_SECONDS = Number(process.env.EPISODE_MIN_SECONDS ?? 60);
const EPISODE_TARGET_MINUTES = EPISODE_MIN_SECONDS / 60;

function buildSystemPrompt(totalMinutes: number): string {
  const targetEpisodes = Math.max(1, Math.round(totalMinutes / EPISODE_TARGET_MINUTES));
  return `You are a professional showrunner structuring a short-form vertical drama series (TikTok/Reels style).

The creator wants the TOTAL series runtime to be approximately ${totalMinutes} minutes.
Each episode must run about ${EPISODE_TARGET_MINUTES} minute(s) (~${EPISODE_MIN_SECONDS} seconds) of screen time — approximately 1 minute, and NEVER less than 1 minute. Calculate the number of seasons and episodes accordingly:
- Total episodes ≈ ${targetEpisodes} (target runtime ${totalMinutes} min ÷ ~${EPISODE_TARGET_MINUTES} min per episode)
- If total episodes ≤ 12 → 1 season
- If total episodes 13-24 → 2 seasons
- If total episodes 25+ → 3 seasons
- Distribute episodes roughly evenly across seasons

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
- Follow the target runtime of ~${totalMinutes} minutes total
- Each episode's scenes must sum to about 1 minute (~${EPISODE_MIN_SECONDS} s) of screen time, and never less than 1 minute
- Each episode must have a cliffhanger or hook
- Titles should be evocative and short
- Descriptions should be specific to the story, not generic
- Build dramatic tension across the season arc

IMPORTANT: Write ALL text (titles, descriptions, cliffhangers) in the SAME LANGUAGE as the synopsis provided. If the synopsis is in Russian — write in Russian. If in English — write in English. Match the language exactly.`;
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { projectId, synopsis, totalDurationMinutes } = await request.json();
    if (!projectId)
      return NextResponse.json({ error: "Project ID required" }, { status: 400 });

    const project = await prisma.project.findUnique({ where: { id: projectId } });
    const synopsisText = synopsis || project?.synopsis || "";
    if (!synopsisText)
      return NextResponse.json({ error: "No synopsis available" }, { status: 400 });

    const minutes = Math.max(5, Math.min(300, Number(totalDurationMinutes) || 30));
    const systemPrompt = buildSystemPrompt(minutes);

    const data = await chatJSON<{ seasons: any[] }>(
      systemPrompt,
      `Create an episode structure for this synopsis (target total runtime: ~${minutes} min):\n\n${synopsisText}`,
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
