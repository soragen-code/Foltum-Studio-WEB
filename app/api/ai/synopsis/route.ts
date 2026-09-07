export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { chat } from "@/lib/ai";

const SYSTEM = `You are a professional screenwriter and showrunner. You write compelling, cinematic synopses for short-form vertical drama series (think TikTok / Reels format, episodes 1-3 minutes).

When given an idea, produce a rich synopsis (300-600 words) that covers:
- Core premise and hook
- Main characters (brief intro)
- Central conflict and stakes
- Tone & genre
- Target format (number of seasons, episodes per season)

Write in vivid, engaging prose. Be specific — avoid generic descriptions.
If a correction/revision is requested, rewrite the synopsis incorporating the feedback while keeping what works.`;

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { projectId, prompt, correction, currentSynopsis } = await request.json();
    if (!projectId)
      return NextResponse.json({ error: "Project ID required" }, { status: 400 });

    let userMessage: string;
    if (correction && currentSynopsis) {
      userMessage = `Here is the current synopsis:\n\n${currentSynopsis}\n\nPlease revise it based on this feedback: ${correction}`;
    } else {
      userMessage = `Create a synopsis for this idea: ${prompt}`;
    }

    const synopsis = await chat(SYSTEM, userMessage, { temperature: 0.9, maxTokens: 2048 });

    await prisma.project.update({
      where: { id: projectId },
      data: { synopsis },
    });

    return NextResponse.json({ synopsis });
  } catch (err: any) {
    console.error("Synopsis generation error:", err);
    return NextResponse.json({ error: "Generation failed" }, { status: 500 });
  }
}
