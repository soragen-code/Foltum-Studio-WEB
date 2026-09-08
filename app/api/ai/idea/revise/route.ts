export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, ideaReviseSchema } from "@/lib/validations";
import { chatJSON } from "@/lib/ai";
import {
  reviseSynopsisSystemPrompt,
  reviseSynopsisUserPrompt,
  synopsisReviseResultSchema,
  stripMarkup,
  sanitizeCharacterCard,
  toCharacterCard,
  normalizeLanguage,
} from "@/lib/idea";

/**
 * POST /api/ai/idea/revise  { projectId, instruction }
 *
 * Rewrites the synopsis according to the instruction (same language/format).
 * When the instruction touches characters, the character list is synced and
 * `charactersChanged` + `changeSummary` are returned for a small UI warning.
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:idea-revise", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const parsed = await parseBody(request, ideaReviseSchema);
    if (!parsed.ok) return parsed.response;
    const { projectId, instruction } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: user.id },
      include: { characters: { orderBy: { createdAt: "asc" } } },
    });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    if (!project.synopsis) return NextResponse.json({ error: "Generate a synopsis first" }, { status: 400 });
    if (project.charactersApproved)
      return NextResponse.json({ error: "Synopsis and characters are already confirmed" }, { status: 409 });

    const language = normalizeLanguage(project.language, project.synopsis);
    const cards = project.characters.map(toCharacterCard);

    let result: ReturnType<typeof synopsisReviseResultSchema.parse> | null = null;
    let lastError = "";
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try {
        const raw = await chatJSON(
          reviseSynopsisSystemPrompt(language),
          reviseSynopsisUserPrompt(project.synopsis, cards, instruction),
          { temperature: 0.6, maxTokens: 3500 }
        );
        result = synopsisReviseResultSchema.parse(raw);
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        console.warn(`[idea/revise] attempt ${attempt + 1} failed:`, lastError);
      }
    }
    if (!result) return NextResponse.json({ error: "AI returned an invalid result: " + lastError }, { status: 502 });

    const synopsis = stripMarkup(result.synopsis);
    const charactersChanged = Boolean(result.charactersChanged && result.characters && result.characters.length > 0);

    await prisma.$transaction(async (tx) => {
      await tx.project.update({ where: { id: projectId }, data: { synopsis } });
      if (charactersChanged) {
        const names = result!.characters!.map((c) => c.name);
        await tx.character.deleteMany({ where: { projectId } });
        for (const raw of result!.characters!) {
          const c = sanitizeCharacterCard(raw, names);
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
      }
    });

    const characters = await prisma.character.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
    return NextResponse.json({
      synopsis,
      characters,
      charactersChanged,
      changeSummary: charactersChanged ? result.changeSummary ?? "" : "",
    });
  } catch (err: any) {
    console.error("Synopsis revise error:", err);
    return NextResponse.json({ error: "Revision failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
