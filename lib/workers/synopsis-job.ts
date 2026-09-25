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
import { makeJobStreamWriter, flushStreamedText } from "@/lib/stream-progress";
import { streamChatText, streamChatJSON, SCRIPT_MODEL } from "@/lib/ai";
// Stage 1 (dramaBible) — structured story bible, persisted on the Project. Approach "A": it now runs AFTER the
// synopsis is saved and the job completed (best-effort, off the critical path) — never before the synopsis.
import { generateDramaBible, type DramaBible, type GenerateDramaBibleResult } from "@/lib/drama-bible";
import { dramaBibleBrief, DRAMA_BIBLE_PROMPT_VERSION } from "@/lib/prompts/drama-bible";
// Stage 172 (Stage 7) — critic-driven generation: best-of-N variants → critique → targeted improve.
import { generateBestOfN, critiqueCandidate, buildGenerationLog, CRITIC_PROMPT_VERSION } from "@/lib/critic";
import {
  synopsisProseSystemPrompt,
  synopsisProseUserPrompt,
  synopsisProseAutoSystemPrompt,
  synopsisProseAutoUserPrompt,
  synopsisProseFromStorySystemPrompt,
  synopsisProseFromStoryUserPrompt,
  synopsisMetaSchema,
  synopsisMetaSystemPrompt,
  synopsisMetaUserPrompt,
  genresToEnglish,
  normalizeLanguage,
  stripMarkup,
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

/** Fallback title when the metadata call fails: the first line of the prose, capped to a few words. */
function titleFromFirstLine(prose: string): string {
  const line = prose.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const words = line.replace(/^[\s"'«»“”\-—–*#]+/, "").split(/\s+/).filter(Boolean).slice(0, 5);
  return words.join(" ").replace(/[\s,;:.!?…"'«»“”\-—–]+$/g, "");
}

/**
 * Approach "A" — the synopsis prose is the FIRST and only LLM action before the producer sees text:
 *   1. streamChatText(prose prompt) with onDelta → GenerationJob.streamedText (partial committed to the DB
 *      from the very first chunk, so the frontend prints it live from the first seconds);
 *   2. a short streamChatJSON for {title, language} on the finished prose (failure → fallbacks, never fatal);
 *   3. save the project (stage="synopsis") and completeJob;
 *   4. ONLY THEN the drama-bible best-of-3 (minutes of LLM work) runs best-effort in the tail of this same
 *      background invocation — the job is already completed, so nothing waits on it.
 */
export async function runSynopsisJob(jobId: string, projectId: string, params: SynopsisJobParams): Promise<void> {
  // Keep the job's updatedAt fresh so GET polling's failStaleJobs (STALE_JOB_MS = 3 min) never reaps a live job.
  let hb: ReturnType<typeof setInterval> | null = null;
  let synopsisForBible: string | null = null;
  try {
    const { idea, auto, genres = [], extras, fromStory, story, episodeCount } = params;
    // Stage 14 (B): only persist a producer-chosen episode count outside story-upload mode.
    const episodeCountToStore = !fromStory && typeof episodeCount === "number" ? episodeCount : undefined;

    // STORY mode: language auto-detected from the uploaded story. AUTO: from extras (default ru).
    // MANUAL: language is detected from the idea text (metadata call + normalizeLanguage fallback).
    const storyText = (story ?? "").trim();
    const storyLanguage: IdeaLanguage = storyText ? detectLanguage(storyText) : "ru";
    const autoLanguage: IdeaLanguage = extras && extras.trim() ? detectLanguage(extras) : "ru";
    const ideaForStore = fromStory
      ? `[Plot file] ${storyText.slice(0, 280)}${storyText.length > 280 ? "…" : ""}`
      : auto
      ? `[Auto] Genre: ${genresToEnglish(genres).join(", ") || "—"}${extras && extras.trim() ? `\nRequests: ${extras.trim()}` : ""}`
      : idea ?? "";
    // Text used for the language fallback heuristic (same as the old normalizeIdeaResult call).
    const languageHintText = fromStory
      ? storyText
      : auto
      ? (extras && extras.trim() ? extras : "")
      : idea ?? "";

    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { status: "processing", progress: 15, message: "Writing synopsis…" });
    hb = setInterval(() => { heartbeatJob(jobId).catch(() => {}); }, 60_000);

    // ── 1. FIRST LLM ACTION: stream the synopsis PROSE (plain text, no JSON) straight into streamedText. ──
    // makeJobStreamWriter starts with lastWriteAt=0 / lastLen=0, so the very first chunk (≥ 12 chars) is
    // committed to the DB immediately; later chunks are throttled to ~4 writes/s.
    let synopsis = "";
    let lastError = "";
    for (let attempt = 0; attempt < 2 && !synopsis; attempt++) {
      if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
      try {
        const onDelta = makeJobStreamWriter(jobId);
        const raw = fromStory
          ? await streamChatText(synopsisProseFromStorySystemPrompt(storyLanguage), synopsisProseFromStoryUserPrompt(storyText), { temperature: 0.6, maxTokens: 6000, onDelta })
          : auto
          ? await streamChatText(synopsisProseAutoSystemPrompt(autoLanguage), synopsisProseAutoUserPrompt(genres, extras), { temperature: 0.95, maxTokens: 6000, onDelta })
          : await streamChatText(synopsisProseSystemPrompt(), synopsisProseUserPrompt(idea ?? ""), { temperature: 0.8, maxTokens: 6000, onDelta });
        const cleaned = stripMarkup(raw ?? "").trim();
        if (cleaned.length < 80) throw new Error("synopsis prose too short / empty");
        synopsis = cleaned;
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        console.warn(`[synopsis] prose attempt ${attempt + 1} failed:`, lastError);
      }
    }
    if (!synopsis) { await failJob(jobId, "AI returned an invalid result: " + lastError); return; }
    // Ensure the last poll sees the FULL final prose even if the throttle skipped the last delta.
    await flushStreamedText(jobId, synopsis);

    // ── 2. Short metadata call on the finished prose: {title, language}. Never fatal. ──
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { progress: 70, message: "Naming the series…" });
    let title = "";
    let language: IdeaLanguage | null = null;
    try {
      await heartbeatJob(jobId);
      const metaRaw = await streamChatJSON(synopsisMetaSystemPrompt(), synopsisMetaUserPrompt(synopsis), { temperature: 0.4, maxTokens: 2000 });
      const meta = synopsisMetaSchema.parse(metaRaw);
      title = stripMarkup(meta.title ?? "").replace(/\s+/g, " ").trim();
      if (meta.language) language = normalizeLanguage(meta.language, languageHintText || synopsis);
    } catch (e) {
      console.warn(`[synopsis] metadata call failed, using fallbacks: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!title) title = titleFromFirstLine(synopsis);
    // Language fallback: mode-specific known language, else script heuristic (Cyrillic → ru, otherwise en).
    if (!language) language = fromStory ? storyLanguage : auto ? autoLanguage : detectLanguage(languageHintText || synopsis);

    // ── 3. Save + complete (unchanged persistence contract). ──
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { progress: 80, message: "Saving synopsis…" });

    // Stage 59: this step ONLY produces the synopsis — no character/location rows here. Advancing the
    // project to stage="synopsis" makes the wizard auto-render the synopsis screen (step 2) on refresh.
    await prisma.$transaction(async (tx) => {
      await tx.project.update({
        where: { id: projectId },
        data: {
          idea: ideaForStore,
          synopsis,
          language,
          synopsisApproved: false,
          stage: "synopsis",
          // Stage 40: the project is named automatically from the plot.
          name: resolveProjectName(title, fromStory ? storyText : idea && idea.trim() ? idea : synopsis),
          ...(episodeCountToStore !== undefined ? { episodeCount: episodeCountToStore } : {}),
        },
      });
    }, { timeout: 30_000 });

    const renamed = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    await completeJob(
      jobId,
      { synopsis, language, projectName: renamed?.name ?? null },
      "Synopsis ready"
    );
    synopsisForBible = synopsis;
  } catch (err: any) {
    console.error("[synopsis] job error:", err);
    await failJob(jobId, "Generation failed: " + (err?.message ?? "Unknown error"));
  } finally {
    if (hb) clearInterval(hb);
  }

  // ── 4. AFTER completeJob: drama-bible best-of-3 in the background tail (best-effort, any failure = warn). ──
  // The job is already "completed" and the project saved, so the producer is never waiting on this. We await it
  // here (rather than a detached promise) only so the serverless invocation stays alive until it settles.
  if (synopsisForBible) {
    try {
      await generateDramaBibleInBackground(projectId, params, synopsisForBible);
    } catch (e) {
      console.warn(`[synopsis] background drama bible failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * Drama-bible best-of-3 (generate 3 parallel variants @0.9 → critique → targeted improve → fallback single
 * generation) built from the FINISHED synopsis. On success writes project.dramaBible/dramaBibleVersion and a
 * GenerationLog row, exactly as before; every failure is swallowed with console.warn. Never touches the job.
 */
async function generateDramaBibleInBackground(projectId: string, params: SynopsisJobParams, synopsis: string): Promise<void> {
  const { idea, auto, genres = [], extras, fromStory, story, episodeCount } = params;
  const storyText = (story ?? "").trim();
  const bibleGenres = auto ? genresToEnglish(genres) : null;
  const sourceText = fromStory
    ? storyText
    : auto
    ? [bibleGenres?.join(", ") ?? "", (extras ?? "").trim()].filter(Boolean).join("\n")
    : idea ?? "";
  // The bible is now derived FROM the approved-for-now synopsis so it stays consistent with what the producer read.
  const bibleIdeaText = `${sourceText}\n\nSEASON SYNOPSIS (the bible must be consistent with it):\n${synopsis}`;
  const bibleEpisodeCount = typeof episodeCount === "number" && episodeCount > 0 ? episodeCount : null;

  // streamChatJSON (not chatJSON): survives Claude's interleaved-thinking empty-content behaviour on WaveSpeed.
  const bibleGen = (ideaText: string, temperature: number): Promise<GenerateDramaBibleResult> =>
    generateDramaBible(
      { idea: ideaText, genres: bibleGenres, episodeCount: bibleEpisodeCount },
      (sys, usr, o) => streamChatJSON(sys, usr, { ...o, temperature, maxTokens: 8000 }),
      { model: SCRIPT_MODEL, maxRetries: 2 }
    );

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
      critique: (rendered) => critiqueCandidate(streamChatJSON, "dramaBible", rendered),
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

  const bibleRes = bibleOutcome?.best ?? (await bibleGen(bibleIdeaText, 0.7));
  if (bibleRes.valid) {
    const bibleToPersist: DramaBible = bibleRes.bible;
    try {
      await prisma.project.update({
        where: { id: projectId },
        data: { dramaBible: bibleToPersist as unknown as object, dramaBibleVersion: DRAMA_BIBLE_PROMPT_VERSION },
      });
    } catch (e) {
      console.warn(`[synopsis] drama bible persist failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    console.warn(`[synopsis] drama bible advisory after ${bibleRes.attempts} attempt(s); outstanding: ${bibleRes.errors.map((e) => e.field).join(", ")}`);
  }

  // Best-effort GenerationLog row (never throws out).
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
    await prisma.generationLog.create({ data: { ...logRec, notes: logRec.notes ?? undefined } });
  } catch (e) {
    console.warn(`[synopsis] GenerationLog skipped: ${e instanceof Error ? e.message : String(e)}`);
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
    // STREAMING (not chat()): Claude Opus 5 on WaveSpeed emits hidden interleaved "thinking" tokens that on a
    // non-streaming call consume the whole budget and return truncated/empty prose. Streaming keeps only the
    // visible content; a generous budget fits the thinking + the rewritten synopsis. The correction returns
    // PLAIN prose (no JSON), so relay the accumulated text straight to the job's streamedText preview.
    const synopsis = (await streamChatText(SYNOPSIS_SYSTEM, userMessage, { temperature: 0.9, maxTokens: 6000, onDelta: makeJobStreamWriter(jobId) })).trim();
    if (!synopsis || !synopsis.trim()) { await failJob(jobId, "AI returned an empty synopsis"); return; }
    await flushStreamedText(jobId, synopsis);

    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { progress: 80, message: "Saving synopsis…" });

    await prisma.project.update({ where: { id: projectId }, data: { synopsis } });
    await completeJob(jobId, { synopsis }, "Synopsis updated");
  } catch (err: any) {
    console.error("[synopsis-correction] job error:", err);
    await failJob(jobId, "Generation failed: " + (err?.message ?? "Unknown error"));
  }
}
