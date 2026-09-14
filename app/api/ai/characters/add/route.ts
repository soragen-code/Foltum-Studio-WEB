export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, charactersAddSchema } from "@/lib/validations";
import { chatJSON } from "@/lib/ai";
import { castExpansionSystemPrompt, castExpansionUserPrompt, normalizeCastExpansion, characterCardToData, toCharacterCard, normalizeLanguage } from "@/lib/idea";

/**
 * POST /api/ai/characters/add  { projectId, hint? }
 * "Add more characters": the LLM adds cast members (family, supporting, minor, crowd groups)
 * grounded in the synopsis; with a hint it follows the producer's request. Existing cast is kept.
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:characters-add", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const parsed = await parseBody(request, charactersAddSchema);
    if (!parsed.ok) return parsed.response;
    const { projectId, hint } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id }, include: { characters: { orderBy: { createdAt: "asc" } } } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (!project.synopsis) return NextResponse.json({ error: "Generate a synopsis first" }, { status: 400 });
    if (project.charactersLocked) return NextResponse.json({ error: "Characters are locked" }, { status: 409 });

    const language = normalizeLanguage(project.language, project.synopsis);
    const existing = project.characters.map(toCharacterCard);
    const names = existing.map((c) => c.name);
    let added: ReturnType<typeof normalizeCastExpansion> = [];
    let lastError = "";
    for (let attempt = 0; attempt < 2 && added.length === 0; attempt++) {
      try {
        const raw = await chatJSON(
          castExpansionSystemPrompt(language, hint ? { hint, countHint: "1-12" } : undefined),
          castExpansionUserPrompt(project.synopsis, existing, hint),
          { temperature: 0.8, maxTokens: 6000 }
        );
        added = normalizeCastExpansion(raw, names);
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        console.warn(`[characters/add] attempt ${attempt + 1} failed:`, lastError);
      }
    }
    if (added.length === 0) return NextResponse.json({ error: "AI returned an invalid result: " + lastError }, { status: 502 });

    const status = project.charactersApproved ? "approved" : "draft";
    await prisma.$transaction(
      added.map((c) => prisma.character.create({ data: { projectId, ...characterCardToData(c), status, imageFront: "", imageProfile: "", imageFull: "" } }))
    );
    const characters = await prisma.character.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
    return NextResponse.json({ added: added.length, characters });
  } catch (err: any) {
    console.error("Characters add error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
