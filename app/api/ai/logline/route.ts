export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, loglineSchema } from "@/lib/validations";
import { chat } from "@/lib/ai";
import {
  loglineSystemPrompt,
  loglineUserPrompt,
  genresToEnglish,
  detectLanguage,
  normalizeLanguage,
  type IdeaLanguage,
} from "@/lib/idea";
import { resolveProjectName, isPlaceholderProjectName } from "@/lib/project-name";

/**
 * POST /api/ai/logline
 *   { projectId, idea | auto+genres | fromStory+story, extras?, episodeCount?, correction?, currentLogline? }
 *
 * STEP 1 of the 3-step approval flow. Generates a short "story idea" LOGLINE (2-3 sentences) BEFORE any
 * synopsis work. Cheap single `chat` call → runs synchronously and returns { logline } directly (no polling).
 *
 * Idempotent-ish: it never advances past the logline gate — it only (re)writes project.logline and sets
 * stage="logline". The synopsis is NOT generated here; that happens on approve-logline. When `correction`
 * is present it is applied VERBATIM (a re-gen instruction OR a direct text edit).
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:logline", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const parsed = await parseBody(request, loglineSchema);
    if (!parsed.ok) return parsed.response;
    const { projectId, idea, auto, genres, extras, fromStory, story, episodeCount, correction, currentLogline } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const project = await prisma.project.findFirst({ where: { id: projectId, userId: user.id } });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
    // Once the synopsis (or characters) is already approved, the logline gate is behind us.
    if (project.synopsisApproved || project.charactersApproved)
      return NextResponse.json({ error: "The story is already past the idea step" }, { status: 409 });

    // Assemble the source material + language. On a bare regenerate/correction (no source fields) fall back
    // to the source stored on the project (project.idea holds the real source text during STEP 1).
    const storyText = (story ?? "").trim();
    let sourceText = "";
    let language: IdeaLanguage;
    if (fromStory && storyText) {
      sourceText = storyText;
      language = detectLanguage(storyText);
    } else if (auto && genres && genres.length) {
      const gl = genresToEnglish(genres).join(", ");
      sourceText = `Genre(s): ${gl || "director's choice"}${extras && extras.trim() ? `\nProducer wishes: ${extras.trim()}` : ""}`;
      language = extras && extras.trim() ? detectLanguage(extras) : "ru";
    } else if (idea && idea.trim()) {
      sourceText = idea.trim();
      language = detectLanguage(idea);
    } else {
      // Regenerate / correction with no new source — reuse what the project already holds.
      sourceText = (project.idea ?? "").trim();
      language = normalizeLanguage(project.language, sourceText || currentLogline || project.logline || "");
    }

    const system = loglineSystemPrompt(language);
    const userMsg = loglineUserPrompt({
      sourceText,
      correction: correction ?? undefined,
      currentLogline: (currentLogline ?? project.logline) ?? undefined,
    });

    const logline = (await chat(system, userMsg, { temperature: 0.9, maxTokens: 400 })).trim();
    if (!logline) return NextResponse.json({ error: "AI returned an empty logline" }, { status: 502 });

    // Stage 14 (B): persist a producer-chosen episode count (not in story-upload mode).
    const episodeCountToStore = !fromStory && typeof episodeCount === "number" ? episodeCount : undefined;

    await prisma.project.update({
      where: { id: projectId },
      data: {
        logline,
        loglineApproved: false,
        // Keep the real source text on the project so a later regenerate reuses it (STEP 1 only; the
        // synopsis job overwrites project.idea with the approved logline afterwards).
        ...(sourceText ? { idea: sourceText } : {}),
        language,
        stage: "logline",
        ...(episodeCountToStore !== undefined ? { episodeCount: episodeCountToStore } : {}),
        // Give the project a real name early instead of "New project" while on the idea step.
        ...(isPlaceholderProjectName(project.name) ? { name: resolveProjectName(null, logline) } : {}),
      },
    });

    return NextResponse.json({ logline });
  } catch (err: any) {
    console.error("Logline generation error:", err);
    return NextResponse.json({ error: "Generation failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}

/**
 * GET /api/ai/logline?projectId=… → the current logline + approval flag, so the client can resume the
 * idea step after a reload.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const projectId = new URL(request.url).searchParams.get("projectId") ?? "";
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { email: session.user.email }, select: { id: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId: user.id },
    select: { logline: true, loglineApproved: true, stage: true },
  });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  return NextResponse.json(
    { logline: project.logline ?? null, loglineApproved: project.loglineApproved, stage: project.stage },
    { headers: { "Cache-Control": "no-store" } }
  );
}
