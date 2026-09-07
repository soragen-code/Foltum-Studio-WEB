export const dynamic = "force-dynamic";
export const maxDuration = 300; // image generation takes time

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { chatJSON } from "@/lib/ai";
import { generateImage } from "@/lib/replicate";
import { uploadRemoteToS3 } from "@/lib/s3-upload";

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

/** Build a FLUX prompt for a specific shot type */
function imagePrompt(appearance: string, name: string, shotType: "front" | "profile" | "full"): string {
  const base = `Cinematic character portrait, dramatic lighting, dark moody atmosphere, film still quality. Character: ${appearance}.`;
  switch (shotType) {
    case "front":
      return `${base} Close-up front view, facing camera directly, eye contact, shallow depth of field, studio portrait.`;
    case "profile":
      return `${base} Side profile view, dramatic rim lighting, silhouette edge, cinematic composition.`;
    case "full":
      return `${base} Full body shot, standing pose, environmental portrait, wide angle, atmospheric background.`;
  }
}

/** Generate 3 images for a character and upload to S3 */
async function generateCharacterImages(
  projectId: string,
  characterId: string,
  name: string,
  appearance: string
): Promise<{ imageFront: string; imageProfile: string; imageFull: string }> {
  const shots = ["front", "profile", "full"] as const;
  const aspectRatios = { front: "3:4", profile: "3:4", full: "9:16" };

  const results = await Promise.all(
    shots.map(async (shot) => {
      const prompt = imagePrompt(appearance, name, shot);
      const replicateUrl = await generateImage({
        prompt,
        aspect_ratio: aspectRatios[shot],
      });
      const s3Key = `media/public/characters/${projectId}/${characterId}/${shot}.webp`;
      const s3Url = await uploadRemoteToS3(replicateUrl, s3Key, "image/webp");
      return { shot, url: s3Url };
    })
  );

  const map = Object.fromEntries(results.map((r) => [r.shot, r.url]));
  return {
    imageFront: map.front,
    imageProfile: map.profile,
    imageFull: map.full,
  };
}

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

    // Create all characters in DB first (to get IDs)
    const dbChars = [];
    for (const c of data.characters) {
      const char = await prisma.character.create({
        data: {
          projectId,
          name: c.name,
          description: c.description,
          role: c.role,
          personality: c.personality,
          appearance: c.appearance,
          imageFront: "",
          imageProfile: "",
          imageFull: "",
        },
      });
      dbChars.push({ db: char, raw: c });
    }

    // Generate images for all characters in parallel
    const updated = await Promise.all(
      dbChars.map(async ({ db, raw }) => {
        try {
          const images = await generateCharacterImages(projectId, db.id, raw.name, raw.appearance);
          return prisma.character.update({
            where: { id: db.id },
            data: images,
          });
        } catch (imgErr) {
          console.error(`Image gen failed for ${raw.name}:`, imgErr);
          // Return character with empty images rather than failing entirely
          return db;
        }
      })
    );

    return NextResponse.json({ characters: updated });
  } catch (err: any) {
    console.error("Character generation error:", err);
    return NextResponse.json({ error: "Generation failed" }, { status: 500 });
  }
}
