export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { chatJSON } from "@/lib/ai";
import { generateImage } from "@/lib/providers/image-provider";
import { uploadRemoteToS3 } from "@/lib/s3-upload";

import { characterImagePrompt, VISUAL_STYLE_ID, REFERENCE_ASPECT_RATIO } from "@/lib/visual-style";
// Stage 75: user-uploaded photo references — transport only (fed as image_input, existing chained path).
// combineFaceAndUserRefs also prepends the optional single "face photo" (Character.faceImageUrl) FIRST.
import { combineFaceAndUserRefs, mergeImageInput } from "@/lib/character-user-refs";

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
    // Stage 124 — every character reference shot is vertical 9:16.
    const aspectRatios = { front: REFERENCE_ASPECT_RATIO, profile: REFERENCE_ASPECT_RATIO, full: REFERENCE_ASPECT_RATIO };
    const pid = existing.projectId;

    const userRefs = combineFaceAndUserRefs((existing as any).faceImageUrl, existing.userRefs); // face photo + user photos
    const userInput = mergeImageInput(userRefs, [], 10);
    const imgResults = await Promise.all(
      shots.map(async (shot) => {
        const prompt = characterImagePrompt(data.appearance, shot, existing.name, undefined, undefined, userInput.length > 0, "face");
        const providerUrl = await generateImage({
          prompt,
          aspect_ratio: aspectRatios[shot],
          ...(userInput.length ? { image_input: userInput } : {}),
        }, { characterId: existing.id});
        const s3Key = `media/public/characters/${pid}/${existing.id}/${VISUAL_STYLE_ID}/${shot}_${Date.now()}.png`;
        const s3Url = await uploadRemoteToS3(providerUrl, s3Key, "image/png");
        return { shot, url: s3Url };
      })
    );

    const imgMap = Object.fromEntries(imgResults.map((r) => [r.shot, r.url]));

    // Stage 60: one-step undo — snapshot the fields this edit overwrites.
    const prevSnapshot = {
      kind: "character",
      personality: existing.personality,
      appearance: existing.appearance,
      imageFront: existing.imageFront,
      imageProfile: existing.imageProfile,
      imageFull: existing.imageFull,
    };

    const character = await prisma.character.update({
      where: { id: characterId },
      data: {
        personality: data.personality,
        appearance: data.appearance,
        imageFront: imgMap.front,
        imageProfile: imgMap.profile,
        imageFull: imgMap.full,
        prevSnapshot,
      },
    });

    // Stage 46B-1: rendered scenes with this character now show a stale look.
    await prisma.scene.updateMany({
      where: { characters: { some: { characterId } }, videoUrl: { not: null } },
      data: { lookStale: true },
    }).catch(() => {});

    return NextResponse.json({ character });
  } catch (err: any) {
    console.error("Character regen error:", err);
    return NextResponse.json({ error: "Regeneration failed" }, { status: 500 });
  }
}
