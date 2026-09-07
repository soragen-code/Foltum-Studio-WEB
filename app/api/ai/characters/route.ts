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
- Roles should follow classical story structure

IMPORTANT LANGUAGE RULES:
- Write name, description, role, personality in the SAME LANGUAGE as the synopsis. If synopsis is in Russian — write those fields in Russian.
- EXCEPTION: The "appearance" field must ALWAYS be in English — it is used as a prompt for AI image generation and works best in English.`;

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

/** Helper: pause for ms */
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

const SHOTS = ["front", "profile", "full"] as const;
type Shot = (typeof SHOTS)[number];
const ASPECT_RATIOS: Record<Shot, string> = { front: "3:4", profile: "3:4", full: "9:16" };
const SHOT_LABELS: Record<Shot, string> = { front: "front portrait", profile: "side profile", full: "full-body shot" };
const SHOT_FIELDS: Record<Shot, "imageFront" | "imageProfile" | "imageFull"> = {
  front: "imageFront",
  profile: "imageProfile",
  full: "imageFull",
};

/** Generate a single character image and upload it to S3 */
async function generateSingleImage(
  projectId: string,
  characterId: string,
  name: string,
  appearance: string,
  shot: Shot
): Promise<string> {
  const prompt = imagePrompt(appearance, name, shot);
  console.log(`[FLUX] Generating ${shot} for ${name}...`);
  const replicateUrl = await generateImage({ prompt, aspect_ratio: ASPECT_RATIOS[shot] });
  const s3Key = `media/public/characters/${projectId}/${characterId}/${shot}.webp`;
  const s3Url = await uploadRemoteToS3(replicateUrl, s3Key, "image/webp");
  console.log(`[FLUX] ${shot} for ${name} done: ${s3Url.slice(0, 60)}...`);
  return s3Url;
}

/**
 * POST /api/ai/characters
 *
 * Streams progress as Server-Sent Events (text/event-stream). Event payloads (JSON in `data:`):
 *  - { type: "progress", step: "text" | "image", message, current, total }
 *  - { type: "characters_text", characters }   — text profiles ready, images still empty
 *  - { type: "image", characterId, field, url, current, total } — one image finished
 *  - { type: "done", characters }
 *  - { type: "error", message }
 */
export async function POST(request: Request) {
  // Validate auth/input before opening the stream so we can return proper HTTP status codes.
  const session = await auth();
  if (!session?.user?.email)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { projectId, synopsis } = body ?? {};
  if (!projectId)
    return NextResponse.json({ error: "Project ID required" }, { status: 400 });

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  const synopsisText = synopsis || project?.synopsis || "";
  if (!synopsisText)
    return NextResponse.json({ error: "No synopsis available" }, { status: 400 });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (payload: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch {}
      };

      // Keep-alive comments so proxies don't drop the idle connection during long image jobs.
      const keepAlive = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`: ping\n\n`)); } catch { closed = true; }
      }, 15000);

      try {
        // Step 0: text generation. Total is unknown until we know N, so send a provisional total.
        send({ type: "progress", step: "text", message: "Generating character profiles...", current: 0, total: 1 });

        // Delete existing characters
        await prisma.character.deleteMany({ where: { projectId } });

        const data = await chatJSON<{ characters: any[] }>(
          SYSTEM,
          `Extract and design characters from this synopsis:\n\n${synopsisText}`,
          { temperature: 0.85, maxTokens: 3000 }
        );

        const rawChars: any[] = Array.isArray(data?.characters) ? data.characters : [];
        if (rawChars.length === 0) {
          send({ type: "error", message: "AI returned no characters" });
          return;
        }

        // Create all characters in DB first (to get IDs)
        const dbChars: { db: any; raw: any }[] = [];
        for (const c of rawChars) {
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

        const total = 1 + dbChars.length * SHOTS.length;
        let current = 1; // text step complete

        send({ type: "progress", step: "text", message: "Character profiles ready", current, total });
        send({ type: "characters_text", characters: dbChars.map((d) => d.db), current, total });

        // Generate images SEQUENTIALLY (rate-limit safe), streaming each result as it lands.
        for (const { db, raw } of dbChars) {
          const images: Partial<Record<"imageFront" | "imageProfile" | "imageFull", string>> = {};
          for (const shot of SHOTS) {
            send({
              type: "progress",
              step: "image",
              message: `Generating ${SHOT_LABELS[shot]} for ${raw.name}...`,
              current,
              total,
              characterId: db.id,
            });
            try {
              const url = await generateSingleImage(projectId, db.id, raw.name, raw.appearance, shot);
              images[SHOT_FIELDS[shot]] = url;
              current += 1;
              send({ type: "image", characterId: db.id, field: SHOT_FIELDS[shot], url, current, total });
            } catch (imgErr) {
              console.error(`Image gen failed (${shot}) for ${raw.name}:`, imgErr);
              current += 1;
              send({
                type: "progress",
                step: "image",
                message: `Failed to generate ${SHOT_LABELS[shot]} for ${raw.name}, skipping`,
                current,
                total,
                characterId: db.id,
              });
            }
            // Small delay between requests to respect rate limits
            await sleep(2000);
          }
          if (Object.keys(images).length > 0) {
            try {
              await prisma.character.update({ where: { id: db.id }, data: images });
            } catch (dbErr) {
              console.error(`DB update failed for ${raw.name}:`, dbErr);
            }
          }
        }

        const finalChars = await prisma.character.findMany({
          where: { projectId },
          orderBy: { createdAt: "asc" },
        });
        send({ type: "done", characters: finalChars, current: total, total });
      } catch (err: any) {
        console.error("Character generation error:", err);
        send({ type: "error", message: "Generation failed" });
      } finally {
        clearInterval(keepAlive);
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
