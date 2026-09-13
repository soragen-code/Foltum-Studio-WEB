/**
 * Background worker for Stage 1 «Идея» → synopsis generation.
 *
 * Mirrors the season-script job pattern (lib/workers/season-script-job.ts): the
 * user-facing route (app/api/ai/idea/route.ts) creates a GenerationJob, fires this
 * worker via runInBackground()/after(), and returns the jobId immediately. The
 * frontend polls GET /api/jobs/[id]; this worker updates the job row as it runs and
 * persists the synopsis to the Project when done.
 *
 * The prompt-building / language logic lives in lib/idea.ts and is NOT changed here —
 * this file only wraps the exact same generation in a resumable background job so the
 * client no longer holds an open fetch that breaks when the page is left.
 */
import { prisma } from "@/lib/db";
import { updateJob, completeJob, failJob, heartbeatJob, markCanceled, isCancelRequested } from "@/lib/jobs";
import { chatJSON } from "@/lib/ai";
import {
  ideaSystemPrompt,
  ideaUserPrompt,
  ideaAutoSystemPrompt,
  ideaAutoUserPrompt,
  ideaFromStorySystemPrompt,
  ideaFromStoryUserPrompt,
  genresToEnglish,
  normalizeIdeaResult,
  detectLanguage,
  type IdeaLanguage,
} from "@/lib/idea";
import { resolveProjectName } from "@/lib/project-name";

/** GenerationJob.type value for the idea→synopsis job (new string value, no schema change). */
export const SYNOPSIS_JOB_TYPE = "synopsis";

/** Roughly how long the synopsis step takes — drives the smooth 0→100 % client bar. */
export const SYNOPSIS_EXPECTED_SEC = 45;

export interface SynopsisJobParams {
  idea?: string | null;
  auto?: boolean;
  genres?: string[];
  extras?: string;
  fromStory?: boolean;
  story?: string;
  episodeCount?: number;
}

/**
 * Run the synopsis generation in the background of the calling serverless invocation.
 * Progress is coarse (a single LLM call): we mark the job "processing" at ~15 % and let the
 * client's SmoothProgress ease it toward 100 % on a time curve; on save we bump to 80 %.
 */
export async function runSynopsisJob(jobId: string, projectId: string, params: SynopsisJobParams): Promise<void> {
  try {
    const { idea, auto, genres = [], extras, fromStory, story, episodeCount } = params;
    // Stage 14 (B): only persist a producer-chosen episode count outside story-upload mode.
    const episodeCountToStore = !fromStory && typeof episodeCount === "number" ? episodeCount : undefined;

    // STORY mode: language auto-detected from the uploaded story. AUTO: from extras (default ru).
    // MANUAL: language is detected from the idea text inside normalizeIdeaResult.
    const storyText = (story ?? "").trim();
    const storyLanguage: IdeaLanguage = storyText ? detectLanguage(storyText) : "ru";
    const autoLanguage: IdeaLanguage = extras && extras.trim() ? detectLanguage(extras) : "ru";
    const ideaForStore = fromStory
      ? `[Файл-сюжет] ${storyText.slice(0, 280)}${storyText.length > 280 ? "…" : ""}`
      : auto
      ? `[Авто] Жанр: ${genresToEnglish(genres).join(", ") || "—"}${extras && extras.trim() ? `\nПожелания: ${extras.trim()}` : ""}`
      : idea ?? "";

    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { status: "processing", progress: 15, message: "Составляю синопсис сезона…" });

    // One retry if the model returns malformed JSON / schema violations (same as the old sync route).
    let result: ReturnType<typeof normalizeIdeaResult> | null = null;
    let lastError = "";
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
      try {
        await heartbeatJob(jobId);
        const raw = fromStory
          ? await chatJSON(ideaFromStorySystemPrompt(storyLanguage), ideaFromStoryUserPrompt(storyText), { temperature: 0.6, maxTokens: 4200 })
          : auto
          ? await chatJSON(ideaAutoSystemPrompt(autoLanguage), ideaAutoUserPrompt(genres, extras), { temperature: 0.95, maxTokens: 3800 })
          : await chatJSON(ideaSystemPrompt(), ideaUserPrompt(idea ?? ""), { temperature: 0.8, maxTokens: 3500 });
        result = normalizeIdeaResult(
          raw,
          fromStory ? storyText : auto ? (extras && extras.trim() ? extras : autoLanguage === "ru" ? "русская история" : "story") : idea ?? ""
        );
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        console.warn(`[synopsis] attempt ${attempt + 1} failed:`, lastError);
      }
    }
    if (!result) { await failJob(jobId, "AI returned an invalid result: " + lastError); return; }

    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { progress: 80, message: "Сохраняю синопсис…" });

    // Stage 59: this step ONLY produces the synopsis — no character/location rows here. Advancing the
    // project to stage="synopsis" makes the wizard auto-render the synopsis screen (step 2) on refresh.
    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: projectId },
        data: {
          idea: ideaForStore,
          synopsis: result!.synopsis,
          language: result!.language,
          synopsisApproved: false,
          stage: "synopsis",
          // Stage 40: the project is named automatically from the plot.
          name: resolveProjectName(result!.title, fromStory ? storyText : idea && idea.trim() ? idea : result!.synopsis),
          ...(episodeCountToStore !== undefined ? { episodeCount: episodeCountToStore } : {}),
        },
      });
    }, { timeout: 30_000 });

    const renamed = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    await completeJob(
      jobId,
      { synopsis: result.synopsis, language: result.language, projectName: renamed?.name ?? null },
      "Синопсис готов"
    );
  } catch (err: any) {
    console.error("[synopsis] job error:", err);
    await failJob(jobId, "Generation failed: " + (err?.message ?? "Unknown error"));
  }
}
