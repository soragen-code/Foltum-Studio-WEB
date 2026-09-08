export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { chatJSON } from "@/lib/ai";
import { generateImage } from "@/lib/replicate";
import { uploadRemoteToS3 } from "@/lib/s3-upload";

import { characterImagePrompt, VISUAL_STYLE_ID } from "@/lib/visual-style";

const SYSTEM = `You are a character designer. Given a character's current data and the project synopsis, regenerate a fresh take on their appearance and personality while keeping their name and role.

Return ONLY valid JSON:
{
  "personality": "Updated personality (2-3 sentences)",
  "appearance": "Updated detailed physical appearance for AI image generation (2-3 sentences)"
}

IMPORTANT LANGUAGE RULES:
- Write "personality" in the SAME LANGUAGE as the existing character data. If it's in Russian — write in Russian.
- The "appearance" field must ALWAYS be in English — it is used as a prompt for AI image generation.`;

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:characters-regenerate", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

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

    // Generate 3 new images in parallel
    const shots = ["front", "profile", "full"] as const;
    const aspectRatios = { front: "3:4", profile: "3:4", full: "9:16" };
    const pid = existing.projectId;

    const imgResults = await Promise.all(
      shots.map(async (shot) => {
        const prompt = characterImagePrompt(data.appearance, shot, existing.name);
        const replicateUrl = await generateImage({
          prompt,
          aspect_ratio: aspectRatios[shot],
        }, { characterId: existing.id });
        const s3Key = `media/public/characters/${pid}/${existing.id}/${VISUAL_STYLE_ID}/${shot}_${Date.now()}.png`;
        const s3Url = await uploadRemoteToS3(replicateUrl, s3Key, "image/png");
        return { shot, url: s3Url };
      })
    );

    const imgMap = Object.fromEntries(imgResults.map((r) => [r.shot, r.url]));

    const character = await prisma.character.update({
      where: { id: characterId },
      data: {
        personality: data.personality,
        appearance: data.appearance,
        imageFront: imgMap.front,
        imageProfile: imgMap.profile,
        imageFull: imgMap.full,
      },
    });

    return NextResponse.json({ character });
  } catch (err: any) {
    console.error("Character regen error:", err);
    return NextResponse.json({ error: "Regeneration failed" }, { status: 500 });
  }
}
