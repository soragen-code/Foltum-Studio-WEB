export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, ideaSchema } from "@/lib/validations";
import { chatJSON } from "@/lib/ai";
import { ideaSystemPrompt, ideaUserPrompt, ideaAutoSystemPrompt, ideaAutoUserPrompt, ideaFromStorySystemPrompt, ideaFromStoryUserPrompt, genresToEnglish, normalizeIdeaResult, castExpansionSystemPrompt, castExpansionUserPrompt, normalizeCastExpansion, characterCardToData, locationsFromSynopsisSystemPrompt, locationsResultSchema, dedupeCast, sanitizeLocationCard, detectLanguage, type CharacterCard, type IdeaLanguage } from "@/lib/idea";
import { resolveProjectName } from "@/lib/project-name";

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
    const { projectId, idea, auto, genres, extras, fromStory, story, episodeCount } = parsed.data;
    // Stage 14 (B): the producer sets how many episodes the season has (manual/auto). Story-upload
    // mode lets the story dictate, so we only persist the count when it was actually chosen.
    const episodeCountToStore = !fromStory && typeof episodeCount === "number" ? episodeCount : undefined;

    // STORY mode: the producer uploaded a finished story (parsed to text on the server). Language is
    // auto-detected from the story. AUTO mode: the AI invents the story from the chosen genre(s).
    // MANUAL mode: language is detected from the idea text inside normalizeIdeaResult.
    const storyText = (story ?? "").trim();
    const storyLanguage: IdeaLanguage = storyText ? detectLanguage(storyText) : "ru";
    const autoLanguage: IdeaLanguage = (extras && extras.trim() ? detectLanguage(extras) : "ru");
    // What we persist as the project's "idea" so the producer can see what drove the generation.
    const ideaForStore = fromStory
      ? `[Файл-сюжет] ${storyText.slice(0, 280)}${storyText.length > 280 ? "…" : ""}`
      : auto
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
        const raw = fromStory
          ? await chatJSON(ideaFromStorySystemPrompt(storyLanguage), ideaFromStoryUserPrompt(storyText), { temperature: 0.6, maxTokens: 4200 })
          : auto
          ? await chatJSON(ideaAutoSystemPrompt(autoLanguage), ideaAutoUserPrompt(genres, extras), { temperature: 0.95, maxTokens: 3800 })
          : await chatJSON(ideaSystemPrompt(), ideaUserPrompt(idea ?? ""), { temperature: 0.8, maxTokens: 3500 });
        // Fallback language source: STORY → the uploaded story; AUTO → chosen/extras; MANUAL → idea text.
        result = normalizeIdeaResult(raw, fromStory ? storyText : auto ? (extras && extras.trim() ? extras : (autoLanguage === "ru" ? "русская история" : "story")) : (idea ?? ""));
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        console.warn(`[idea] attempt ${attempt + 1} failed:`, lastError);
      }
    }
    if (!result) return NextResponse.json({ error: "AI returned an invalid result: " + lastError }, { status: 502 });

    // Stage 59 (step 1 «Идея»): this step ONLY produces the synopsis. The full season cast and
    // locations are generated later, from the APPROVED synopsis, inside the season-script job — so
    // we intentionally do NOT create any character/location rows here, and advance the project to
    // the synopsis step so the wizard auto-renders the synopsis screen next.
    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: projectId },
        data: {
          idea: ideaForStore, synopsis: result!.synopsis, language: result!.language, synopsisApproved: false,
          stage: "synopsis",
          // Stage 40: the project is named automatically from the plot (model title → first words of the idea/synopsis).
          name: resolveProjectName(result!.title, fromStory ? storyText : (idea && idea.trim()) ? idea : result!.synopsis),
          ...(episodeCountToStore !== undefined ? { episodeCount: episodeCountToStore } : {}),
        },
      });
    }, { timeout: 30_000 });

    const renamed = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    return NextResponse.json({ synopsis: result.synopsis, language: result.language, projectName: renamed?.name ?? null });
  } catch (err: any) {
    console.error("Idea generation error:", err);
    return NextResponse.json({ error: "Generation failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
