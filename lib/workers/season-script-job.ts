/**
 * Stage 2 — season script background job (resumable, poll-driven state machine).
 *
 * gpt-6-astra spends 5–10 minutes on one episode script — far beyond what a single serverless
 * request can wait for (Node's ~300 s headers timeout, Vercel's 800 s function kill). So every
 * model call runs in OpenAI *background mode*: we store the response id in GenerationJob.resultData
 * (`SeasonJobState`) and `advanceSeasonJob()` — called from the GET polling routes — polls it,
 * persists the finished step and starts the next one. Nothing long-running lives inside a request.
 *
 * Steps:  structure → fullStory → episode (× N, plus the revise queue) → done.
 *   structure: season structure (episodeCount episodes) → Season + Episode rows (script = null).
 *   fullStory: whole-season prose story (non-fatal — skipped after 2 failed attempts).
 *   episode:   full shooting script → Episode.script + Scene rows (+ cast links) for every episode
 *              without a script, and for every episode in `revise.episodeIds` (author instruction).
 * Progress is persisted per episode, so a re-run only fills in what is missing.
 */
import { prisma } from "@/lib/db";
import type { GenerationJob } from "@prisma/client";
import { chatJSON, SCRIPT_MODEL, startBackgroundJSON, pollBackgroundJSON, cancelBackgroundResponse, type BackgroundPollResult } from "@/lib/ai";
import { maxDetailLevel, isLocationDetailLevel } from "@/lib/location-scale";
import { completeJob, failJob, isCancelRequested, markCanceled } from "@/lib/jobs";
import { toCharacterCard, normalizeLanguage, seasonCastSystemPrompt, seasonCastUserPrompt, seasonCastResultSchema, characterCardToData, sanitizeCharacterCard, sanitizeLocationCard, dedupeCast, type CharacterCard, type IdeaLanguage } from "@/lib/idea";
import { parseStoredShortSynopsis, renderShortSynopsis } from "@/lib/short-synopsis";

/** Stage 46A: the stored short synopsis (JSON) rendered as the outline block of the structure prompt. */
function shortSynopsisOutline(stored: string | null | undefined): string | null {
  const s = parseStoredShortSynopsis(stored);
  return s ? renderShortSynopsis(s) : null;
}
import {
  seasonStructureSchema,
  validateEpisodeDescriptions,
  EPISODE_FOOTAGE_RETRY_NOTE,
  seasonFullStorySchema,
  seasonFullStorySystemPrompt,
  seasonFullStoryUserPrompt,
  episodeScriptSchema,
  seasonStructureSystemPrompt,
  seasonStructureUserPrompt,
  episodeScriptSystemPrompt,
  episodeScriptUserPrompt,
  validateEpisodeScript,
  hardProblems,
  ensureEnglishDialogue,
  normalizeEpisodeScript,
  renderEpisodeScriptText,
  episodeTotalSeconds,
  EPISODE_MAX_TOTAL_SECONDS,
  EPISODE_TOTAL_LABEL,
  SEASON_DEFAULT_EPISODES,
  type EpisodeOutline,
  type EpisodeScript,
  type SeasonStructure,
  matchCharacter,
  matchLocation,
} from "@/lib/season";
import { anchorSceneLocation } from "@/lib/location-anchor";
import { episodeCastFromScenes } from "@/lib/episode-cast";

export const SEASON_JOB_TYPE = "season_script";

// ---------------------------------------------------------------------------
// State (GenerationJob.resultData)
// ---------------------------------------------------------------------------

export type SeasonJobStep = "structure" | "fullStory" | "episode" | "done";

export type SeasonJobState = {
  v: 2;
  step: SeasonJobStep;
  /** Episode being written (step === "episode"). */
  episodeId?: string;
  /** OpenAI background response currently running for this step (absent between steps). */
  responseId?: string;
  /** 0-based attempt counter of the current step (a step is retried once). */
  attempt: number;
  /** ISO time the current step's response was started. */
  stepStartedAt?: string;
  /** ISO time a poller took the advance lock (released when the advance finishes). */
  lockedAt?: string;
  total: number;
  remaining: number;
  done: boolean;
  episodeCount: number;
  /** Full story failed twice — do not block the episode scripts on it. */
  skipFullStory?: boolean;
  /** Author-requested rewrite of specific (already written) episodes. */
  revise?: { episodeIds: string[]; instruction: string; force?: boolean };
  /** Stage 45 — advisory notes shown with the final job message (e.g. an episode over the 1:00 budget). */
  warnings?: string[];
  /** Stage 105 — why the previous attempt of the current step failed (appended to the retry prompt; cleared on success). */
  lastFailure?: string;
};

/** Two pollers must not advance the same job at once; a stuck lock expires after this long. */
export const ADVANCE_LOCK_MS = 60_000;
/** A background response older than this is treated as failed (the step is retried / the job fails). */
export const STEP_TIMEOUT_MS = 45 * 60_000;
const MAX_ATTEMPTS = 2;
const ACTIVE_STATUSES = ["pending", "processing"];

export function initialSeasonState(episodeCount = SEASON_DEFAULT_EPISODES, revise?: SeasonJobState["revise"]): SeasonJobState {
  return { v: 2, step: "structure", attempt: 0, total: episodeCount, remaining: episodeCount, done: false, episodeCount, ...(revise ? { revise } : {}) };
}

/** Parse resultData; anything that is not a v2 state (legacy `{revise:true, affected}`, null) → fresh state. */
export function parseSeasonState(raw: string | null | undefined, episodeCount = SEASON_DEFAULT_EPISODES): SeasonJobState {
  if (raw) {
    try {
      const j = JSON.parse(raw);
      if (j && j.v === 2 && typeof j.step === "string") return { ...initialSeasonState(j.episodeCount ?? episodeCount), ...j };
    } catch {}
  }
  return initialSeasonState(episodeCount);
}

/** Is another poller currently advancing this job (lock younger than ADVANCE_LOCK_MS)? */
export function isAdvanceLocked(state: SeasonJobState, now = Date.now()): boolean {
  if (!state.lockedAt) return false;
  const t = Date.parse(state.lockedAt);
  return Number.isFinite(t) && now - t < ADVANCE_LOCK_MS;
}

/** Has the running step exceeded STEP_TIMEOUT_MS? */
export function isStepTimedOut(state: SeasonJobState, now = Date.now()): boolean {
  if (!state.stepStartedAt) return false;
  const t = Date.parse(state.stepStartedAt);
  return Number.isFinite(t) && now - t > STEP_TIMEOUT_MS;
}

/** Minimal episode shape the planner needs. */
export type PlannerEpisode = { id: string; number: number; script: string | null };

export type PlannedStep =
  | { step: "structure" }
  | { step: "fullStory" }
  | { step: "episode"; episodeId: string; instruction?: string }
  | { step: "done" };

/** Decide the next step from what is in the DB (pure). */
export function planNextStep(
  season: { fullStory: string | null; episodes: PlannerEpisode[] } | null,
  state: Pick<SeasonJobState, "revise" | "skipFullStory">
): PlannedStep {
  if (!season || season.episodes.length === 0) return { step: "structure" };
  if (!season.fullStory && !state.skipFullStory) return { step: "fullStory" };
  const queue = state.revise?.episodeIds ?? [];
  for (const id of queue) {
    if (season.episodes.some((e) => e.id === id)) return { step: "episode", episodeId: id, instruction: state.revise!.instruction };
  }
  const missing = season.episodes.find((e) => !e.script);
  if (missing) return { step: "episode", episodeId: missing.id };
  return { step: "done" };
}

/** After a step failed: retry the same step or give up? (pure) */
export function retryDecision(state: Pick<SeasonJobState, "step" | "attempt">): "retry" | "skip" | "fail" {
  if (state.attempt + 1 < MAX_ATTEMPTS) return "retry";
  return state.step === "fullStory" ? "skip" : "fail";
}

/** The revise hint appended to the author's instruction so the rewritten ending still leads into the next episode. */
export function reviseInstruction(instruction: string, next?: { number: number; title: string; logline: string | null } | null): string {
  return `${instruction}${next ? `\n(The NEXT episode ${next.number} «${next.title}» starts from: ${next.logline ?? ""} — keep this episode's ending compatible with it.)` : ""}`;
}

export function episodeProgress(done: number, total: number): number {
  return 5 + Math.round((done / Math.max(1, total)) * 90);
}

/** Injectable model calls (unit tests replace them). */
export type SeasonJobDeps = {
  start: typeof startBackgroundJSON;
  poll: typeof pollBackgroundJSON;
  cancel: typeof cancelBackgroundResponse;
  /** Synchronous JSON chat used for the short gpt-4o dialogue translation pass. */
  chatJSON: typeof chatJSON;
};
const defaultDeps: SeasonJobDeps = { start: startBackgroundJSON, poll: pollBackgroundJSON, cancel: cancelBackgroundResponse, chatJSON };

// ---------------------------------------------------------------------------
// Step result validation (pure — schema + business rules)
// ---------------------------------------------------------------------------

export function validateStructure(raw: unknown, episodeCount: number): SeasonStructure {
  const parsed = seasonStructureSchema.parse(raw);
  // Stage 14 (B2): the producer sets the episode count — enforce it exactly (retry if the model drifts).
  if (parsed.episodes.length !== episodeCount) throw new Error(`structure returned ${parsed.episodes.length} episodes, expected exactly ${episodeCount}`);
  const structure = { ...parsed, episodes: parsed.episodes.map((e, i) => ({ ...e, number: i + 1 })) };
  // Stage 105 — every description is 60-second footage (SHOT 1 / SHOT 2 / CLIFFHANGER, ≤ 120 words, OPENS ON chain). Invalid → retry (never truncate).
  const problems = validateEpisodeDescriptions(structure.episodes);
  if (problems.length) throw new Error(`episode descriptions invalid: ${problems.slice(0, 4).join("; ")}`);
  return structure;
}

export function validateFullStory(raw: unknown): string {
  const text = seasonFullStorySchema.parse(raw).fullStory.trim();
  if (text.length < 200) throw new Error("full story too short");
  return text;
}

/** Schema + normalization + hard-problem gate; soft problems are logged. Dialogue translation is done by the caller. */
export function validateEpisode(raw: unknown, episodeNumber: number, characters: CharacterCard[]): EpisodeScript {
  const script = normalizeEpisodeScript(episodeScriptSchema.parse(raw), characters);
  const problems = validateEpisodeScript(script);
  // Word-count drift is tolerated (logged); hard problems (count, missing prompt lines, no dialogue) fail → retry.
  const hard = hardProblems(problems);
  if (hard.length) throw new Error(`episode ${episodeNumber} script invalid: ${hard.slice(0, 3).join("; ")}`);
  if (problems.length) console.warn(`[season] ep ${episodeNumber} soft issues:`, problems);
  return script;
}

/** Replace an episode's Scene rows with the given script (keeps the episode row / id). */
export async function persistEpisodeScript(
  episodeId: string,
  outline: EpisodeOutline,
  script: EpisodeScript,
  characters: { id: string; name: string }[],
  language: string
) {
  const idOf = (n: string) => matchCharacter(characters, n)?.id;
  const text = renderEpisodeScriptText(outline, script);
  // Stage 20 (D1): the accurate episode cast is the UNION of characters that actually appear in the
  // generated scenes — collected here per scene, deduped below (not the declared outline.characters).
  const sceneCastIds: string[][] = [];
  await prisma.$transaction(async (tx) => {
    await tx.scene.deleteMany({ where: { episodeId } });
    for (const s of script.scenes) {
      const scene = await tx.scene.create({
        data: {
          episodeId,
          number: s.number,
          // `dialogue` = story-language text (UI + burned-in subtitles); `dialogueEn` = the English lines the model voices.
          dialogue: s.dialogueLocal ?? s.dialogue,
          dialogueEn: s.dialogue,
          // Stage 20 (A2): lock every non-location-change scene to the episode's single canonical location
          // (Episode.locationDesc) so the place never drifts scene-to-scene and frame-chaining stays reliable.
          locationDesc: anchorSceneLocation(s.locationDesc, outline.locationDesc, s.continuesFrom),
          videoPrompt: s.videoPrompt,
          shotType: s.shotType,
          action: s.action,
          durationSec: s.durationSec,
          // Stage 11 — scene-to-scene continuity metadata (who is present, entrances/exits, link to prev scene).
          presence: s.presence ?? null,
          entrances: s.entrances ?? null,
          continuesFrom: s.continuesFrom ?? null,
          // Stage 40 — scripted end state of the final frame (next scene's OPENING STATE in parallel mode).
          endState: (s.endState ?? "").trim() || null,
          // Stage 41 — scripted start state of the first frame (this scene's OPENING STATE).
          startState: (s.startState ?? "").trim() || null,
          endStateActual: null,
          // Stage 104 — a freshly scripted scene has no keyframe yet.
          keyframeUrl: null, keyframePrompt: null, keyframeStatus: null, keyframeError: null,
          // Stage 12 (Commit D) — off-screen narration: `voiceover` = English narration voiced by the model,
          // `voiceoverLocal` = the same narration translated for the UI. `sceneKind` distinguishes narration from dialogue.
          sceneKind: s.sceneKind ?? "dialogue",
          voiceover: s.voiceover ?? null,
          voiceoverLocal: s.voiceoverLocal ?? s.voiceover ?? null,
          language: "en", // speech is always English (Stage 4)
          subtitled: false,
          status: "pending",
        },
      });
      const ids = Array.from(new Set(s.characters.map(idOf).filter((x): x is string => !!x)));
      sceneCastIds.push(ids);
      if (ids.length) await tx.sceneCharacter.createMany({ data: ids.map((characterId) => ({ sceneId: scene.id, characterId })), skipDuplicates: true });
    }
    // Stage 20 (D1/D2): EpisodeCharacter = the UNION of characters actually used across the scenes
    // (so the References tab + readiness gate only require characters that really appear). If somehow
    // no scene names any character, fall back to the declared outline cast so the episode is never empty.
    const declaredIds = Array.from(new Set(outline.characters.map(idOf).filter((x): x is string => !!x)));
    const epIds = episodeCastFromScenes(sceneCastIds, declaredIds);
    await tx.episodeCharacter.deleteMany({ where: { episodeId } });
    if (epIds.length) await tx.episodeCharacter.createMany({ data: epIds.map((characterId) => ({ episodeId, characterId })), skipDuplicates: true });
    await tx.episode.update({
      where: { id: episodeId },
      // Stage 105 — a new script replaces the old scenes (deleted above, keyframes/videos go with the rows) → the stitched episode video is stale too.
      data: { script: text, description: outline.description ?? outline.logline, logline: outline.logline, cliffhanger: outline.cliffhanger, locationName: outline.locationName, locationDesc: outline.locationDesc, arcRole: outline.arcRole, status: "script_ready", title: outline.title, videoUrl: null },
    });
  }, { timeout: 60_000, maxWait: 15_000 }); // 15 scenes × (create + characters) over Neon exceed Prisma's default 5 s interactive-transaction timeout (seen on prod: "Transaction not found")
}

export function outlineFromEpisode(e: { number: number; title: string; logline: string | null; description: string | null; locationName: string | null; locationDesc: string | null; cliffhanger: string | null; arcRole: string | null; characters: { character: { name: string } }[]; location?: { detailLevel?: string | null } | null }): EpisodeOutline {
  const role = (["завязка", "развитие", "поворот", "финал"] as const).find((r) => r === e.arcRole) ?? "развитие";
  return {
    number: e.number,
    title: e.title,
    logline: e.logline ?? e.description ?? "",
    locationName: e.locationName ?? "",
    locationDesc: e.locationDesc ?? "",
    // Current stored detail level of the bound location (so a revise round-trip does not lose it); "medium" when unknown.
    locationDetail: isLocationDetailLevel(e.location?.detailLevel) ? e.location.detailLevel : "medium",
    characters: e.characters.map((c) => c.character.name),
    arcRole: role,
    cliffhanger: e.cliffhanger ?? "",
    // Stage 105 — the stored 60-second footage (legacy rows hold the old logline copy; parseEpisodeFootage then returns null).
    ...(e.description ? { description: e.description } : {}),
  };
}


// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

const seasonInclude = { episodes: { orderBy: { number: "asc" as const }, include: { characters: { include: { character: true } }, location: { select: { detailLevel: true } } } } };

async function loadProject(projectId: string) {
  return prisma.project.findUnique({ where: { id: projectId }, include: { characters: true, locations: { orderBy: { createdAt: "asc" } } } });
}

async function loadSeason(projectId: string) {
  return prisma.season.findFirst({ where: { projectId, number: 1 }, include: seasonInclude });
}

/**
 * Stage 88 — the concrete ENDING context of the immediately-preceding episode, so the next episode is
 * written as a direct continuation. Reads the previous episode's LAST scene's scripted end state
 * (endStateActual wins over endState when present) plus a short tail of its closing scenes (action +
 * dialogue/voiceover). Returns null for episode 1 or when the previous episode has no scenes yet.
 */
export async function loadPreviousEnding(
  seasonId: string,
  previous: { id: string; number: number; title: string; cliffhanger: string | null } | undefined | null
): Promise<{ number: number; title: string; cliffhanger: string; endState: string | null; tail: string | null } | null> {
  if (!previous) return null;
  const scenes = await prisma.scene.findMany({
    where: { episodeId: previous.id },
    orderBy: { number: "asc" },
    select: { number: true, action: true, dialogue: true, dialogueEn: true, voiceover: true, sceneKind: true, endState: true, endStateActual: true },
  });
  if (!scenes.length) return null;
  const last = scenes[scenes.length - 1];
  const endState = ((last.endStateActual ?? "").trim() || (last.endState ?? "").trim()) || null;
  const tailScenes = scenes.slice(Math.max(0, scenes.length - 2));
  const tail = tailScenes
    .map((s) => {
      const line = s.sceneKind === "narration" ? (s.voiceover ?? "").trim() : (s.dialogueEn ?? s.dialogue ?? "").trim();
      const act = (s.action ?? "").replace(/\s+/g, " ").trim();
      return `- Scene ${s.number}: ${act}${line ? ` [${s.sceneKind === "narration" ? "voiceover" : "dialogue"}: ${line.replace(/\s+/g, " ")}]` : ""}`;
    })
    .join("\n")
    .slice(0, 1200) || null;
  return { number: previous.number, title: previous.title, cliffhanger: previous.cliffhanger ?? "", endState, tail };
}

/** Persist the state (+ optional job fields). Always bumps updatedAt so the job is never "stale" while it is being advanced. */
async function saveState(jobId: string, state: SeasonJobState, extra: { status?: string; progress?: number; message?: string } = {}): Promise<void> {
  const { lockedAt: _drop, ...clean } = state;
  await prisma.generationJob.update({
    where: { id: jobId },
    data: { resultData: JSON.stringify(clean), updatedAt: new Date(), ...(extra.progress !== undefined ? { progress: Math.max(0, Math.min(100, Math.round(extra.progress))) } : {}), ...(extra.message !== undefined ? { message: extra.message } : {}), ...(extra.status !== undefined ? { status: extra.status } : {}) },
  });
}

/**
 * Advance a season job by one tick: poll the running background response (persist its result when
 * done) and/or start the next step. Safe to call from every poll request — a CAS lock on resultData
 * makes concurrent pollers no-ops. Returns the refreshed job (or the same job when nothing was done).
 */
export async function advanceSeasonJob(job: GenerationJob, deps: SeasonJobDeps = defaultDeps, init?: { episodeCount?: number }): Promise<GenerationJob | null> {
  if (job.type !== SEASON_JOB_TYPE || !ACTIVE_STATUSES.includes(job.status)) return job;
  const prevRaw = job.resultData;
  const state = parseSeasonState(prevRaw, init?.episodeCount);
  if (init?.episodeCount) { state.episodeCount = init.episodeCount; if (state.step === "structure" && !state.responseId) { state.total = init.episodeCount; state.remaining = init.episodeCount; } }
  if (isAdvanceLocked(state)) return job;
  // CAS lock: only the poller that sees exactly the previous resultData wins.
  const lock = await prisma.generationJob.updateMany({ where: { id: job.id, resultData: prevRaw }, data: { resultData: JSON.stringify({ ...state, lockedAt: new Date().toISOString() }) } });
  if (lock.count !== 1) return job;
  try {
    await tick(job.id, job.projectId, state, deps);
  } catch (err) {
    console.error(`[season] advance failed for job ${job.id}:`, err);
    await failJob(job.id, err instanceof Error ? err.message : String(err));
  }
  return prisma.generationJob.findUnique({ where: { id: job.id } });
}

/**
 * Stage 59 (step 3 "Season plot"): in the new 4-step flow the idea step writes ONLY the synopsis, so a
 * fresh project has no characters/locations when the season job starts. Here we generate the COMPLETE cast
 * (all tiers) and the season's locations in ONE fast synchronous call from the approved synopsis, then
 * persist them. Idempotent: if characters already exist (retry / classic flow) it is a no-op. A single
 * ~30 s chatJSON call comfortably fits inside the job's 60 s advance lock, so it is concurrency-safe.
 */
async function generateSeasonCast(projectId: string, synopsis: string, language: IdeaLanguage, deps: SeasonJobDeps): Promise<void> {
  const raw = await deps.chatJSON(seasonCastSystemPrompt(language), seasonCastUserPrompt(synopsis), { temperature: 0.85, maxTokens: 8000 });
  const parsed = seasonCastResultSchema.parse(raw);
  const names = parsed.characters.map((c) => c.name);
  const characters = dedupeCast(parsed.characters).map((c) => sanitizeCharacterCard(c, names));
  const locations = dedupeCast(parsed.locations).map(sanitizeLocationCard);
  await prisma.$transaction(async (tx) => {
    // Idempotency guard: another poller (or a retry) may have already created the cast.
    if ((await tx.character.count({ where: { projectId } })) > 0) return;
    for (const c of characters) {
      await tx.character.create({ data: { projectId, ...characterCardToData(c), status: "draft", imageFront: "", imageProfile: "", imageFull: "" } });
    }
    for (const l of locations) {
      await tx.location.create({ data: { projectId, name: l.name, description: l.description, visualPrompt: l.visualPrompt, visualPromptAuto: l.visualPrompt } });
    }
  }, { timeout: 30_000 });
}

async function tick(jobId: string, projectId: string, state: SeasonJobState, deps: SeasonJobDeps): Promise<void> {
  let project = await loadProject(projectId);
  if (!project?.synopsis) throw new Error("Project synopsis missing");
  const language = normalizeLanguage(project.language, project.synopsis);
  // Stage 59: generate the season cast + locations from the approved synopsis before the structure step,
  // when the project has none yet (new 4-step flow). Reload so the freshly-created rows are in scope.
  if (project.characters.length === 0) {
    await generateSeasonCast(projectId, project.synopsis, language, deps);
    const reloaded = await loadProject(projectId);
    if (!reloaded) throw new Error("Project disappeared after cast generation");
    project = reloaded;
  }
  const cards = project.characters.map(toCharacterCard);
  let season = await loadSeason(projectId);
  const countDone = () => season ? season.episodes.filter((e) => e.script).length : 0;
  const total = season && season.episodes.length ? season.episodes.length : state.episodeCount;

  // (a) Cancellation — stop the running response, keep everything already written.
  if (await isCancelRequested(jobId)) {
    if (state.responseId) await deps.cancel(state.responseId);
    await saveState(jobId, { ...state, responseId: undefined });
    await markCanceled(jobId, `Generation canceled. Episodes done: ${countDone()} of ${total}.`);
    return;
  }

  // (b) A background response is running for the current step → poll it.
  let retryStep: PlannedStep | null = null;
  if (state.responseId) {
    let poll: BackgroundPollResult<unknown>;
    try {
      poll = await deps.poll(state.responseId);
    } catch (err) {
      // Transient retrieve error: keep waiting (heartbeat), the next poll retries.
      console.warn(`[season] poll error for ${state.responseId}:`, err);
      poll = { status: "running" };
    }
    if (poll.status === "running" && isStepTimedOut(state)) {
      await deps.cancel(state.responseId);
      poll = { status: "failed", error: `step ${state.step} timed out after ${Math.round(STEP_TIMEOUT_MS / 60000)} min` };
    }
    if (poll.status === "running") {
      await saveState(jobId, state); // heartbeat (keeps message/progress, releases the lock)
      return;
    }
    let failure: string | null = null;
    if (poll.status === "completed") {
      try {
        season = await applyStepResult(project, season, state, poll.json, language, cards, deps);
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
    } else {
      failure = poll.error;
    }
    if (failure) {
      console.warn(`[season] attempt ${state.attempt + 1}/${MAX_ATTEMPTS} of step ${state.step} failed: ${failure}`);
      const decision = retryDecision(state);
      if (decision === "fail") {
        await saveState(jobId, { ...state, responseId: undefined });
        await failJob(jobId, failure);
        return;
      }
      if (decision === "skip") {
        // Never block episode scripts on the prose story — the author can regenerate it from the story screen.
        state = { ...state, skipFullStory: true, attempt: 0 };
      } else {
        retryStep = state.step === "episode" && state.episodeId
          ? { step: "episode", episodeId: state.episodeId, instruction: state.revise?.episodeIds.includes(state.episodeId) ? state.revise.instruction : undefined }
          : { step: state.step as "structure" | "fullStory" };
        state = { ...state, attempt: state.attempt + 1, lastFailure: failure };
      }
    } else {
      state = { ...state, attempt: 0, lastFailure: undefined };
      if (state.step === "episode" && state.episodeId && state.revise?.episodeIds.includes(state.episodeId)) {
        state = { ...state, revise: { ...state.revise, episodeIds: state.revise.episodeIds.filter((id) => id !== state.episodeId) } };
      }
    }
    state = { ...state, responseId: undefined, episodeId: undefined, stepStartedAt: undefined };
  }

  // (c) Start the next step (or retry the failed one).
  const planned = retryStep ?? planNextStep(season, state);
  const seasonStruct: SeasonStructure | null = season ? { title: season.title ?? "", logline: season.logline ?? "", episodes: season.episodes.map(outlineFromEpisode) } : null;
  const done = countDone();
  const curTotal = season && season.episodes.length ? season.episodes.length : state.episodeCount;
  const remaining = season ? season.episodes.filter((e) => !e.script).length + (state.revise?.episodeIds.length ?? 0) : state.episodeCount;

  if (planned.step === "done") {
    if (season) await prisma.season.update({ where: { id: season.id }, data: { status: "script_ready" } });
    await saveState(jobId, { ...state, step: "done", remaining: 0, total: curTotal, done: true });
    const note = state.warnings?.length ? ` · ${state.warnings.join("; ")}` : "";
    await completeJob(jobId, { ...state, step: "done", remaining: 0, total: curTotal, done: true, lockedAt: undefined }, `Season script ready${note}`);
    return;
  }

  let responseId: string;
  let message: string;
  let progress: number;
  if (planned.step === "structure") {
    // Stage 105 — the single retry after a rejected structure gets an explicit format instruction (plus the exact problems).
    const retryNote = state.attempt > 0 ? `\n\n${EPISODE_FOOTAGE_RETRY_NOTE}${state.lastFailure ? ` Problems found: ${state.lastFailure}` : ""}` : "";
    responseId = await deps.start(seasonStructureSystemPrompt(language, state.episodeCount), seasonStructureUserPrompt(project.synopsis, cards, project.locations, shortSynopsisOutline(project.shortSynopsis)) + retryNote, { model: SCRIPT_MODEL, maxTokens: Math.min(64000, 4000 + 800 * state.episodeCount) });
    message = "Building the season structure..."; progress = 3;
  } else if (planned.step === "fullStory") {
    responseId = await deps.start(
      seasonFullStorySystemPrompt(language, seasonStruct!.episodes.length),
      seasonFullStoryUserPrompt({ synopsis: project.synopsis, structure: seasonStruct!, characters: cards, locations: project.locations }),
      { model: SCRIPT_MODEL, maxTokens: 32000 }
    );
    message = "Writing the season plot..."; progress = 4;
  } else {
    const ep = season!.episodes.find((e) => e.id === planned.episodeId)!;
    const next = season!.episodes.find((e) => e.number === ep.number + 1);
    // Stage 88: cross-episode continuity — thread the immediately-preceding episode's concrete ENDING
    // (its last scene's end state + closing beats) into this episode's brief, so it is written as a
    // direct continuation rather than a fresh start.
    const prevEp = season!.episodes.find((e) => e.number === ep.number - 1);
    const previousEnding = await loadPreviousEnding(season!.id, prevEp ? { id: prevEp.id, number: prevEp.number, title: prevEp.title, cliffhanger: prevEp.cliffhanger ?? null } : null);
    responseId = await deps.start(
      episodeScriptSystemPrompt(language, ep.number),
      episodeScriptUserPrompt({
        synopsis: project.synopsis, season: seasonStruct!, episode: outlineFromEpisode(ep), characters: cards,
        previous: season!.episodes.filter((p) => p.number < ep.number).map((p) => ({ number: p.number, title: p.title, logline: p.logline ?? "", cliffhanger: p.cliffhanger ?? "" })),
        previousEnding,
        ...(planned.instruction ? { instruction: reviseInstruction(planned.instruction, next) } : {}),
      }),
      { model: SCRIPT_MODEL, maxTokens: 32000 }
    );
    message = planned.instruction
      ? `Rewriting the script for episode ${ep.number}... (the model is reasoning, usually 5-10 minutes)`
      : `Writing the script for episode ${ep.number} of ${curTotal}... (the model is reasoning, usually 5-10 minutes)`;
    progress = episodeProgress(done, curTotal);
  }
  await saveState(
    jobId,
    { ...state, step: planned.step, episodeId: planned.step === "episode" ? planned.episodeId : undefined, responseId, stepStartedAt: new Date().toISOString(), total: curTotal, remaining, done: false },
    { status: "processing", progress, message }
  );
}

type LoadedSeason = NonNullable<Awaited<ReturnType<typeof loadSeason>>>;
type LoadedProject = NonNullable<Awaited<ReturnType<typeof loadProject>>>;

/** Validate a completed step's JSON and persist it. Throws on invalid output (→ retry). Returns the refreshed season. */
async function applyStepResult(project: LoadedProject, season: LoadedSeason | null, state: SeasonJobState, raw: unknown, language: IdeaLanguage, cards: CharacterCard[], deps: SeasonJobDeps): Promise<LoadedSeason | null> {
  const projectId = project.id;
  if (state.step === "structure") {
    const structure = validateStructure(raw, state.episodeCount);
    const byName = new Map(project.characters.map((c) => [c.name.toLowerCase(), c.id]));
    await prisma.$transaction(async (tx) => {
      const s = season
        ? await tx.season.update({ where: { id: season.id }, data: { title: structure.title, logline: structure.logline } })
        : await tx.season.create({ data: { projectId, number: 1, title: structure.title, logline: structure.logline } });
      const locs: { id: string; name: string; detailLevel: string | null }[] = project.locations.map((l) => ({ id: l.id, name: l.name, detailLevel: l.detailLevel }));
      for (const e of structure.episodes) {
        // Bind the episode to an existing project Location (reference image); unknown names become new Locations without an image.
        let loc = matchLocation(locs, e.locationName);
        if (!loc) {
          const created = await tx.location.create({ data: { projectId, name: e.locationName, description: e.locationName, visualPrompt: e.locationDesc, visualPromptAuto: e.locationDesc, detailLevel: e.locationDetail } });
          loc = { id: created.id, name: created.name, detailLevel: created.detailLevel };
          locs.push(loc);
        } else {
          // Reused location: raise its required detail level if the new structure needs more (never downgrade).
          const level = maxDetailLevel(loc.detailLevel, e.locationDetail);
          if (level && level !== loc.detailLevel) { await tx.location.update({ where: { id: loc.id }, data: { detailLevel: level } }); loc.detailLevel = level; }
        }
        const ep = await tx.episode.create({ data: { seasonId: s.id, number: e.number, title: e.title, description: e.description ?? e.logline, logline: e.logline, cliffhanger: e.cliffhanger, locationName: loc.name, locationDesc: e.locationDesc, locationId: loc.id, arcRole: e.arcRole, status: "draft" } });
        const ids = Array.from(new Set(e.characters.map((n) => byName.get(n.toLowerCase())).filter((x): x is string => !!x)));
        if (ids.length) await tx.episodeCharacter.createMany({ data: ids.map((characterId) => ({ episodeId: ep.id, characterId })) });
      }
    }, { timeout: 30_000 });
    await prisma.project.update({ where: { id: projectId }, data: { stage: "structure" } });
    return loadSeason(projectId);
  }
  if (!season) throw new Error("season missing");
  if (state.step === "fullStory") {
    const fullStory = validateFullStory(raw);
    await prisma.season.update({ where: { id: season.id }, data: { fullStory } });
    return loadSeason(projectId);
  }
  if (state.step === "episode") {
    const ep = season.episodes.find((e) => e.id === state.episodeId);
    if (!ep) throw new Error("episode missing");
    const outline = outlineFromEpisode(ep);
    // Seedance voices `dialogue` → it must be English; swap swapped fields / translate leftovers (short gpt-4o pass).
    const script = await ensureEnglishDialogue(validateEpisode(raw, ep.number, cards), deps.chatJSON);
    // Stage 45/103 — the episode budget (EPISODE_TOTAL_LABEL) is enforced by normalize where speech allows;
    // what is left over is shown to the author instead of failing the job (no line of dialogue is ever cut to make it fit).
    const total = episodeTotalSeconds(script.scenes);
    const overNote = `episode ${ep.number} is longer than ${EPISODE_TOTAL_LABEL} (${total} s) - shorten the scenes`;
    state.warnings = (state.warnings ?? []).filter((w) => !w.startsWith(`episode ${ep.number} `));
    if (total > EPISODE_MAX_TOTAL_SECONDS) state.warnings.push(overNote);
    await persistEpisodeScript(ep.id, outline, script, project.characters.map((c) => ({ id: c.id, name: c.name })), language);
    return loadSeason(projectId);
  }
  return season;
}

/** Entry point used by the routes that create a job: records the episode count and performs the first advance. */
export async function runSeasonScriptJob(jobId: string, projectId: string, episodeCount = SEASON_DEFAULT_EPISODES): Promise<void> {
  const job = await prisma.generationJob.findUnique({ where: { id: jobId } });
  if (!job) return;
  await advanceSeasonJob(job, defaultDeps, { episodeCount });
}
