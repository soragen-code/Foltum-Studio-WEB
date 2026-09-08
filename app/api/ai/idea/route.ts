export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, ideaSchema } from "@/lib/validations";
import { chatJSON } from "@/lib/ai";
import { ideaSystemPrompt, ideaUserPrompt, normalizeIdeaResult } from "@/lib/idea";

/**
 * POST /api/ai/idea  { projectId, idea }
 *
 * Stage 1 of the new flow: idea → synopsis (in the idea's language) + character
 * cards. Replaces the project's draft characters (only while they are not yet
 * approved) and stores idea/synopsis/language on the project.
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:idea", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const parsed = await parseBody(request, ideaSchema);
    if (!parsed.ok) return parsed.response;
    const { projectId, idea } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (project.charactersApproved)
      return NextResponse.json({ error: "Synopsis and characters are already confirmed" }, { status: 409 });

    // One retry if the model returns malformed JSON / schema violations.
    let result: ReturnType<typeof normalizeIdeaResult> | null = null;
    let lastError = "";
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try {
        const raw = await chatJSON(ideaSystemPrompt(), ideaUserPrompt(idea), { temperature: 0.8, maxTokens: 3500 });
        result = normalizeIdeaResult(raw, idea);
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        console.warn(`[idea] attempt ${attempt + 1} failed:`, lastError);
      }
    }
    if (!result) return NextResponse.json({ error: "AI returned an invalid result: " + lastError }, { status: 502 });

    await prisma.$transaction(async (tx) => {
      await tx.character.deleteMany({ where: { projectId } });
      for (const c of result!.characters) {
        await tx.character.create({
          data: {
            projectId,
            name: c.name,
            age: c.age,
            role: c.role,
            appearance: c.appearance,
            personality: c.personality,
            firstAppearance: c.firstAppearance,
            description: c.firstAppearance,
            status: "draft",
            imageFront: "",
            imageProfile: "",
            imageFull: "",
          },
        });
      }
      await tx.project.update({
        where: { id: projectId },
        data: { idea, synopsis: result!.synopsis, language: result!.language, synopsisApproved: false },
      });
    });

    const characters = await prisma.character.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
    return NextResponse.json({ synopsis: result.synopsis, language: result.language, characters });
  } catch (err: any) {
    console.error("Idea generation error:", err);
    return NextResponse.json({ error: "Generation failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
