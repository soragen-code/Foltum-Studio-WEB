export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, ideaSchema } from "@/lib/validations";
import { chatJSON } from "@/lib/ai";
import { ideaSystemPrompt, ideaUserPrompt, ideaAutoSystemPrompt, ideaAutoUserPrompt, genresToEnglish, normalizeIdeaResult, castExpansionSystemPrompt, castExpansionUserPrompt, normalizeCastExpansion, characterCardToData, locationsFromSynopsisSystemPrompt, locationsResultSchema, dedupeCast, sanitizeLocationCard, detectLanguage, type CharacterCard, type IdeaLanguage } from "@/lib/idea";

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
    const { projectId, idea, auto, genres, extras } = parsed.data;

    // AUTO mode: the AI invents the story from the chosen genre(s). Language comes from the
    // producer's extra wishes if any, otherwise defaults to Russian. MANUAL mode: language is
    // detected from the idea text inside normalizeIdeaResult.
    const autoLanguage: IdeaLanguage = (extras && extras.trim() ? detectLanguage(extras) : "ru");
    // What we persist as the project's "idea" so the producer can see what drove the generation.
    const ideaForStore = auto
      ? `[Авто] Жанр: ${genresToEnglish(genres).join(", ") || "—"}${extras && extras.trim() ? `\nПожелания: ${extras.trim()}` : ""}`
      : (idea ?? "");

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
        const raw = auto
          ? await chatJSON(ideaAutoSystemPrompt(autoLanguage), ideaAutoUserPrompt(genres, extras), { temperature: 0.95, maxTokens: 3800 })
          : await chatJSON(ideaSystemPrompt(), ideaUserPrompt(idea ?? ""), { temperature: 0.8, maxTokens: 3500 });
        // In AUTO mode the fallback language is the chosen one (extras/ru); in manual it is the idea text.
        result = normalizeIdeaResult(raw, auto ? (extras && extras.trim() ? extras : (autoLanguage === "ru" ? "русская история" : "story")) : (idea ?? ""));
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        console.warn(`[idea] attempt ${attempt + 1} failed:`, lastError);
      }
    }
    if (!result) return NextResponse.json({ error: "AI returned an invalid result: " + lastError }, { status: 502 });

    // Second call: the extended cast (supporting incl. family, minor, crowd groups). Non-fatal —
    // the producer can always press «Добавить ещё персонажей».
    let extra: CharacterCard[] = [];
    let castWarning = "";
    for (let attempt = 0; attempt < 2 && extra.length === 0; attempt++) {
      try {
        const raw = await chatJSON(
          castExpansionSystemPrompt(result.language),
          castExpansionUserPrompt(result.synopsis, result.characters),
          { temperature: 0.8, maxTokens: 6000 }
        );
        extra = normalizeCastExpansion(raw, result.characters.map((c) => c.name));
      } catch (e: any) {
        castWarning = e?.message ?? String(e);
        console.warn(`[idea] cast expansion attempt ${attempt + 1} failed:`, castWarning);
      }
    }
    const cast = [...result.characters, ...extra];

    // Fallback: the model sometimes drops "locations" — extract them from the synopsis (non-fatal).
    if (result.locations.length === 0) {
      try {
        const raw = await chatJSON(
          locationsFromSynopsisSystemPrompt(result.language),
          `SYNOPSIS:\n${result.synopsis}\n\nCAST:\n${cast.map((c) => `- ${c.name} — ${c.role}`).join("\n")}`,
          { temperature: 0.7, maxTokens: 3000 }
        );
        result.locations = dedupeCast(locationsResultSchema.parse(raw).locations).map(sanitizeLocationCard);
      } catch (e: any) {
        console.warn("[idea] locations fallback failed:", e?.message ?? e);
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.character.deleteMany({ where: { projectId } });
      for (const c of cast) {
        await tx.character.create({ data: { projectId, ...characterCardToData(c), status: "draft", imageFront: "", imageProfile: "", imageFull: "" } });
      }
      await tx.location.deleteMany({ where: { projectId } });
      for (const l of result!.locations) {
        await tx.location.create({ data: { projectId, name: l.name, description: l.description, visualPrompt: l.visualPrompt } });
      }
      await tx.project.update({
        where: { id: projectId },
        data: { idea: ideaForStore, synopsis: result!.synopsis, language: result!.language, synopsisApproved: false },
      });
    }, { timeout: 30_000 });

    const characters = await prisma.character.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
    const locations = await prisma.location.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
    return NextResponse.json({ synopsis: result.synopsis, language: result.language, characters, locations, castWarning: extra.length ? "" : castWarning });
  } catch (err: any) {
    console.error("Idea generation error:", err);
    return NextResponse.json({ error: "Generation failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
