export const dynamic = "force-dynamic";
export const maxDuration = 800; // Vercel Pro / Fluid compute max — background job runs inside this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { chatJSON } from "@/lib/ai";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runCharacterImagesJob } from "@/lib/workers/character-images-job";

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

/**
 * POST /api/ai/characters
 *
 * 1. Generates character text profiles via OpenAI (fast, synchronous)
 * 2. Creates a GenerationJob (type "characters") and triggers the background
 *    image worker (fire-and-forget)
 * 3. Returns { jobId, characters } immediately — characters have empty images,
 *    the frontend polls GET /api/jobs/[jobId] for progress.
 */
export async function POST(request: Request) {
  try {
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
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    const synopsisText = synopsis || project.synopsis || "";
    if (!synopsisText)
      return NextResponse.json({ error: "No synopsis available" }, { status: 400 });

    // Don't start a second run while one is still processing for this project
    await failStaleJobs({ projectId, type: "characters" });
    const active = await prisma.generationJob.findFirst({
      where: { projectId, type: "characters", status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    if (active) {
      const characters = await prisma.character.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
      return NextResponse.json({ jobId: active.id, characters, resumed: true });
    }

    // Step 1: text profiles (fast)
    await prisma.character.deleteMany({ where: { projectId } });

    const data = await chatJSON<{ characters: any[] }>(
      SYSTEM,
      `Extract and design characters from this synopsis:\n\n${synopsisText}`,
      { temperature: 0.85, maxTokens: 3000 }
    );
    const rawChars: any[] = Array.isArray(data?.characters) ? data.characters : [];
    if (rawChars.length === 0)
      return NextResponse.json({ error: "AI returned no characters" }, { status: 500 });

    const characters = [];
    for (const c of rawChars) {
      characters.push(
        await prisma.character.create({
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
        })
      );
    }

    // Step 2: background image job
    const job = await prisma.generationJob.create({
      data: {
        type: "characters",
        status: "processing",
        progress: 5,
        message: "Character profiles ready. Starting image generation...",
        projectId,
      },
    });

    // Runs after the response is flushed; Vercel keeps this invocation alive up to maxDuration
    runInBackground(() =>
      runCharacterImagesJob({
        jobId: job.id,
        projectId,
        characterIds: characters.map((c) => c.id),
      })
    );

    return NextResponse.json({ jobId: job.id, characters });
  } catch (err: any) {
    console.error("Character generation error:", err);
    return NextResponse.json({ error: "Generation failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
