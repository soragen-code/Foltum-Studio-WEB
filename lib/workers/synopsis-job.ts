/**
 * Background worker for Stage 1 "Idea" → synopsis generation.
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
import { chat, chatJSON, SCRIPT_MODEL } from "@/lib/ai";
// Stage 1 (dramaBible) — generate + validate the structured story bible FIRST, then derive the prose synopsis
// consistent with it; persist the bible on the Project. Best-effort: failure leaves the classic flow unchanged.
import { generateDramaBible, type DramaBible, type GenerateDramaBibleResult } from "@/lib/drama-bible";
import { dramaBibleBrief, DRAMA_BIBLE_PROMPT_VERSION } from "@/lib/prompts/drama-bible";
// Stage 172 (Stage 7) — critic-driven generation: best-of-N variants → critique → targeted improve.
import { generateBestOfN, critiqueCandidate, buildGenerationLog, CRITIC_PROMPT_VERSION } from "@/lib/critic";
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
  // Stage 175 — keep the job's updatedAt fresh throughout the whole generation. The drama-bible best-of-3
  // block (generateBestOfN → per-variant generate/critique/improve) runs 3–4.5 min of sequential LLM calls
  // with no per-step heartbeat, so GET polling's failStaleJobs (STALE_JOB_MS = 3 min) would reap this LIVE
  // job and surface a false "Generation timed out". A 60 s background ping (well under 3 min) prevents that;
  // it is cleared in finally on every path. heartbeatJob never throws.
  let hb: ReturnType<typeof setInterval> | null = null;
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
      ? `[Plot file] ${storyText.slice(0, 280)}${storyText.length > 280 ? "…" : ""}`
      : auto
      ? `[Auto] Genre: ${genresToEnglish(genres).join(", ") || "—"}${extras && extras.trim() ? `\nRequests: ${extras.trim()}` : ""}`
      : idea ?? "";

    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { status: "processing", progress: 15, message: "Drafting season synopsis…" });

    // Start the heartbeat now — everything below (drama-bible best-of-3 + synopsis attempt loop) is the slow part.
    hb = setInterval(() => { heartbeatJob(jobId).catch(() => {}); }, 60_000);

    // Stage 1 (dramaBible) — design the structured STORY BIBLE FIRST (generate → validate → targeted retry).
    // On success we (a) persist it on the Project and (b) thread a compact brief into the synopsis prompt so
    // the prose synopsis is DERIVED consistently from the bible. Best-effort: any failure (LLM / transport /
    // persistently-invalid) is swallowed and the classic idea→synopsis flow runs unchanged (backward compat).
    const bibleGenres = auto ? genresToEnglish(genres) : null;
    const bibleIdeaText = fromStory
      ? storyText
      : auto
      ? [bibleGenres?.join(", ") ?? "", (extras ?? "").trim()].filter(Boolean).join("\n")
      : idea ?? "";
    const bibleEpisodeCount = typeof episodeCount === "number" && episodeCount > 0 ? episodeCount : null;
    let bibleBriefNote = "";
    let bibleToPersist: DramaBible | null = null;
    try {
      await heartbeatJob(jobId);
      // A single bible generation at a given temperature; `note` is appended to the idea on the improve pass.
      const bibleGen = (ideaText: string, temperature: number): Promise<GenerateDramaBibleResult> =>
        generateDramaBible(
          { idea: ideaText, genres: bibleGenres, episodeCount: bibleEpisodeCount },
          (sys, usr, o) => chatJSON(sys, usr, { ...o, temperature, maxTokens: 3000 }),
          { model: SCRIPT_MODEL, maxRetries: 2 }
        );

      // Stage 172 (Stage 7) — critic-driven best-of-3: generate 3 parallel variants @0.9, critique each on
      // its brief, pick the best, then run ONE targeted-improve pass built from the winner's notes. Every
      // LLM call is the injected chatJSON, so no new transport. Fully defensive: any throw (e.g. every
      // variant invalid) falls back to a single classic generation below.
      let bibleOutcome: Awaited<ReturnType<typeof generateBestOfN<GenerateDramaBibleResult>>> | null = null;
      try {
        bibleOutcome = await generateBestOfN<GenerateDramaBibleResult>({
          variantCount: 3,
          kind: "dramaBible",
          generate: async () => {
            const r = await bibleGen(bibleIdeaText, 0.9);
            if (!r.valid) throw new Error("invalid drama bible variant");
            return r;
          },
          render: (r) => dramaBibleBrief(r.bible),
          critique: (rendered) => critiqueCandidate(chatJSON, "dramaBible", rendered),
          improve: async (_best, fix) => {
            const r = await bibleGen(`${bibleIdeaText}\n\n${fix}`, 0.7);
            if (!r.valid) throw new Error("invalid improved drama bible");
            return r;
          },
        });
      } catch (e) {
        console.warn(`[synopsis] critic best-of-3 skipped: ${e instanceof Error ? e.message : String(e)}`);
        bibleOutcome = null;
      }

      // Fallback to a single classic generation when the critic flow produced nothing valid.
      const bibleRes = bibleOutcome?.best ?? (await bibleGen(bibleIdeaText, 0.7));
      if (bibleRes.valid) {
        bibleToPersist = bibleRes.bible;
        bibleBriefNote = `\n\nSTORY BIBLE (make the synopsis consistent with it):\n${dramaBibleBrief(bibleRes.bible)}`;
      } else {
        console.warn(`[synopsis] drama bible advisory after ${bibleRes.attempts} attempt(s); outstanding: ${bibleRes.errors.map((e) => e.field).join(", ")}`);
      }

      // Stage 172 — best-effort GenerationLog row (never breaks the job). Logs the critic outcome (or the
      // fallback failure) so persistently-invalid / low-score generations are auditable.
      try {
        const logRec = buildGenerationLog({
          projectId,
          kind: "dramaBible",
          model: SCRIPT_MODEL,
          promptVersion: CRITIC_PROMPT_VERSION,
          attempts: bibleOutcome?.attempts ?? bibleRes.attempts ?? 1,
          finalScore: bibleOutcome?.critique.overall ?? null,
          accepted: !!bibleOutcome?.accepted && bibleRes.valid,
          notes: bibleOutcome?.notes ?? null,
          error: bibleRes.valid ? null : "drama bible invalid after critic loop",
        });
        await prisma.generationLog.create({
          // `notes` is a nullable Json column — omit it (undefined) rather than pass a bare null.
          data: { ...logRec, notes: logRec.notes ?? undefined },
        });
      } catch (e) {
        console.warn(`[synopsis] GenerationLog skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      console.warn(`[synopsis] drama bible generation skipped: ${e instanceof Error ? e.message : String(e)}`);
    }

    // One retry if the model returns malformed JSON / schema violations (same as the old sync route).
    let result: ReturnType<typeof normalizeIdeaResult> | null = null;
    let lastError = "";
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
      try {
        await heartbeatJob(jobId);
        const raw = fromStory
          ? await chatJSON(ideaFromStorySystemPrompt(storyLanguage), ideaFromStoryUserPrompt(storyText) + bibleBriefNote, { temperature: 0.6, maxTokens: 6000 })
          : auto
          ? await chatJSON(ideaAutoSystemPrompt(autoLanguage), ideaAutoUserPrompt(genres, extras) + bibleBriefNote, { temperature: 0.95, maxTokens: 6000 })
          : await chatJSON(ideaSystemPrompt(), ideaUserPrompt(idea ?? "") + bibleBriefNote, { temperature: 0.8, maxTokens: 6000 });
        result = normalizeIdeaResult(
          raw,
          fromStory ? storyText : auto ? (extras && extras.trim() ? extras : autoLanguage === "ru" ? "Russian history" : "story") : idea ?? ""
        );
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        console.warn(`[synopsis] attempt ${attempt + 1} failed:`, lastError);
      }
    }
    if (!result) { await failJob(jobId, "AI returned an invalid result: " + lastError); return; }

    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { progress: 80, message: "Saving synopsis…" });

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
          // Stage 1 (dramaBible) — persist the validated bible + its prompt version alongside the synopsis.
          // Only written when a VALID bible was produced; otherwise the column stays NULL (classic flow).
          ...(bibleToPersist ? { dramaBible: bibleToPersist as unknown as object, dramaBibleVersion: DRAMA_BIBLE_PROMPT_VERSION } : {}),
        },
      });
    }, { timeout: 30_000 });

    const renamed = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    await completeJob(
      jobId,
      { synopsis: result.synopsis, language: result.language, projectName: renamed?.name ?? null },
      "Synopsis ready"
    );
  } catch (err: any) {
    console.error("[synopsis] job error:", err);
    await failJob(jobId, "Generation failed: " + (err?.message ?? "Unknown error"));
  } finally {
    if (hb) clearInterval(hb);
  }
}

// ---------------------------------------------------------------------------
// Stage 69 — synopsis REWRITE ("Rewrite synopsis" on step 2 "Synopsis")
// ---------------------------------------------------------------------------

/** GenerationJob.type value for the step-2 synopsis rewrite (separate from the idea→synopsis job). */
export const SYNOPSIS_CORRECTION_JOB_TYPE = "synopsis_correction";

/** Roughly how long the rewrite takes — drives the smooth 0→100 % client bar. */
export const SYNOPSIS_CORRECTION_EXPECTED_SEC = 30;

/** System prompt copied verbatim from the old synchronous app/api/ai/synopsis route. */
const SYNOPSIS_SYSTEM = `You are a professional screenwriter and showrunner. You write compelling, cinematic synopses for short-form vertical drama series (think TikTok / Reels format, episodes 1-3 minutes).

When given an idea, produce a rich synopsis (300-600 words) that covers:
- Core premise and hook
- Main characters (brief intro)
- Central conflict and stakes
- Tone & genre
- Target format (number of seasons, episodes per season)

Write in vivid, engaging prose. Be specific — avoid generic descriptions.
If a correction/revision is requested, rewrite the synopsis incorporating the feedback while keeping what works.

IMPORTANT: Write the synopsis in the SAME LANGUAGE as the user's input. If they write in Russian — respond in Russian. If in English — respond in English. Match their language exactly.`;

export interface SynopsisCorrectionParams {
  prompt?: string | null;
  correction?: string | null;
  currentSynopsis?: string | null;
}

/**
 * Rewrite (or create) the project synopsis in the background. Mirrors the old sync route's userMessage
 * logic exactly: with a correction + current synopsis it revises the existing text; otherwise it writes
 * a fresh synopsis from `prompt`. Updates ONLY project.synopsis and completes with { synopsis }.
 */
export async function runSynopsisCorrectionJob(jobId: string, projectId: string, params: SynopsisCorrectionParams): Promise<void> {
  try {
    const prompt = (params.prompt ?? "").trim();
    const correction = (params.correction ?? "").trim();
    const currentSynopsis = (params.currentSynopsis ?? "").trim();

    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { status: "processing", progress: 15, message: "Rewriting synopsis…" });

    const userMessage = correction && currentSynopsis
      ? `Here is the current synopsis:\n\n${currentSynopsis}\n\nPlease revise it based on this feedback: ${correction}`
      : `Create a synopsis for this idea: ${prompt}`;

    await heartbeatJob(jobId);
    const synopsis = await chat(SYNOPSIS_SYSTEM, userMessage, { temperature: 0.9, maxTokens: 2048 });
    if (!synopsis || !synopsis.trim()) { await failJob(jobId, "AI returned an empty synopsis"); return; }

    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { progress: 80, message: "Saving synopsis…" });

    await prisma.project.update({ where: { id: projectId }, data: { synopsis } });
    await completeJob(jobId, { synopsis }, "Synopsis updated");
  } catch (err: any) {
    console.error("[synopsis-correction] job error:", err);
    await failJob(jobId, "Generation failed: " + (err?.message ?? "Unknown error"));
  }
}
