/**
 * Stage 2 — season script background job (resumable, poll-driven state machine).
 *
 * gpt-6-astra spends 5–10 minutes on the season structure (Stage 108: the episode script itself is
 * written by gpt-4o — EPISODE_SCRIPT_MODEL — usually 1–3 minutes) — far beyond what a single serverless
 * request can wait for (Node's ~300 s headers timeout, Vercel's 800 s function kill). So every
 * model call runs in OpenAI *background mode*: we store the response id in GenerationJob.resultData
 * (`SeasonJobState`) and `advanceSeasonJob()` — called from the GET polling routes — polls it,
 * persists the finished step and starts the next one. Nothing long-running lives inside a request.
 *
 * Steps:  structure → fullStory → episode (ONLY for the revise/generate queue, Stage 107) → done.
 *   structure: season structure (episodeCount episodes) → Season + Episode rows (script = null).
 *   fullStory: Stage 106 — built deterministically from the structure (buildFullStoryFromStructure), no LLM call.
 *   episode:   full shooting script → Episode.script + Scene rows (+ cast links) for every episode in the
 *              `revise.episodeIds` queue (author instruction = rewrite; empty = write from the structure).
 * Progress is persisted per episode, so a re-run only fills in what is missing.
 */
import { prisma } from "@/lib/db";
import type { GenerationJob } from "@prisma/client";
import { z } from "zod";
import { chatJSON, streamChatJSON, streamChatText, SCRIPT_MODEL, EPISODE_SCRIPT_MODEL, EPISODE_SCRIPT_MAX_TOKENS, EPISODE_SCRIPT_TEMPERATURE, startBackgroundJSON, pollBackgroundJSON, cancelBackgroundResponse, type BackgroundPollResult } from "@/lib/ai";
import { maxDetailLevel, isLocationDetailLevel } from "@/lib/location-scale";
import { completeJob, failJob, isCancelRequested, markCanceled, updateJob, heartbeatJob } from "@/lib/jobs";
import { makeJobStreamWriter, stripJsonForPreview, extractProseField } from "@/lib/stream-progress";
import { toCharacterCard, normalizeLanguage, seasonCastSystemPrompt, seasonCastUserPrompt, characterCardSchema, MAX_CAST, characterCardToData, sanitizeCharacterCard, sanitizeLocationCard, dedupeCast, hasFullSetInventory, setInventoryRetryNote, serializeSetInventory, parseSetInventory, locationsFromSynopsisSystemPrompt, locationsResultSchema, type CharacterCard, type IdeaLanguage } from "@/lib/idea";
import { parseStoredShortSynopsis, renderShortSynopsis } from "@/lib/short-synopsis";
import { episodeScreenplaySystemPrompt, episodeScreenplayUserPrompt, SCREENPLAY_MAX_TOKENS } from "@/lib/simple-pipeline";

/** Stage 46A: the stored short synopsis (JSON) rendered as the outline block of the structure prompt. */
function shortSynopsisOutline(stored: string | null | undefined): string | null {
  const s = parseStoredShortSynopsis(stored);
  return s ? renderShortSynopsis(s) : null;
}
import {
  seasonStructureSchema,
  validateEpisodeSynopses,
  EPISODE_SYNOPSIS_RETRY_NOTE,
} from "../season";
import { repairEpisodeSynopses } from "../footage-repair";
import {
  seasonFullStorySchema,
  buildFullStoryFromStructure,
  episodeScriptSchema,
  seasonStructureSystemPrompt,
  seasonStructureUserPrompt,
  episodeScriptSystemPrompt,
  episodeScriptUserPrompt,
  checkSceneSetInventory,
  validateEpisodeScript,
  hardProblems,
  ensureEnglishDialogue,
  attachMovementRu,
  nonEnglishScenes,
  isEnglishDialogue,
  isSilent,
  normalizeEpisodeScript,
  renderEpisodeScriptText,
  episodeTotalSeconds,
  // Stage 166 — dialogue-polish pass, frame-state checklist critic, peak-scene resolution and prompt version.
  polishEpisodeDialogue,
  judgeStateChecklist,
  stateChecklistRetryNote,
  resolvePeakSceneIndex,
  EPISODE_SCRIPT_PROMPT_VERSION,
  EPISODE_MAX_TOTAL_SECONDS,
  EPISODE_TOTAL_LABEL,
  SEASON_DEFAULT_EPISODES,
  type EpisodeOutline,
  type EpisodeScript,
  type SeasonStructure,
  matchCharacter,
  matchLocation,
  planEpisodeLocations,
  planManualEpisodeLocations,
} from "@/lib/season";
import { anchorSceneLocation } from "@/lib/location-anchor";
import { startLocationImageJob } from "@/lib/location-refs";
import { selectPlotSource } from "@/lib/plot-import";
import { deriveRegionKey } from "@/lib/region-plate";
import { normalizeSubLocation } from "@/lib/sub-location";
import { parseManualScriptScenes } from "@/lib/manual-script";
import { translateDialogue } from "@/lib/voiceover";
import { episodeCastFromScenes } from "@/lib/episode-cast";
// Stage 3 (seasonMap) — validated per-episode season map: the generate→validate→retry loop (season-map.ts)
// and the shared cell shape + per-episode outline brief (prompts/season-map.ts).
import { generateSeasonMap } from "@/lib/season-map";
import { seasonMapCellBrief, SEASON_MAP_PROMPT_VERSION, type SeasonMapCell } from "@/lib/prompts/season-map";
// Stage 1 (dramaBible) — the persisted story bible (Project.dramaBible) is mapped into the season-map slice
// and rendered into a compact brief threaded into each episode's script prompt (both read defensively).
import { toDramaBibleForMap, type DramaBible } from "@/lib/drama-bible";
import { renderSeasonStateBlock, normalizeSeasonState } from "@/lib/season-state";
import { getDialogueLanguage } from "@/lib/dialogue-language";
import { dramaBibleBrief } from "@/lib/prompts/drama-bible";

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
  // Stage 158 — `userScript` carries the author's pasted full episode script (manual-script choice); when
  // present the episode step feeds it as the AUTHORITATIVE source to episodeScriptUserPrompt.
  revise?: { episodeIds: string[]; instruction: string; force?: boolean; userScript?: string };
  /** Stage 210 — when set, the structure step generates ONLY episodes [from..to] of a `total`-episode
   * season (batched story generation) and APPENDS them, instead of (re)generating all episodes at once.
   * Cleared after the batch is applied. Absent = legacy all-at-once behaviour (unchanged). */
  storyBatch?: { from: number; to: number; total: number };
  /** Stage 45 — advisory notes shown with the final job message (e.g. an episode over the 1:30 budget). */
  warnings?: string[];
  /** Stage 105 — why the previous attempt of the current step failed (appended to the retry prompt; cleared on success). */
  lastFailure?: string;
};

/**
 * Two pollers must not advance the same job at once; a stuck lock expires after this long.
 * Since WaveSpeed has no Responses-API background mode, startBackgroundJSON now runs the whole
 * script/plot generation SYNCHRONOUSLY inside one advance (streaming, several minutes). The lock must
 * outlive that blocking call, or a second poller would win the CAS after 60 s and kick off a DUPLICATE
 * expensive generation. It is set just over Vercel's 800 s function cap so that when a function is
 * actually killed the lock still frees shortly after (the killed run cannot be holding it any longer).
 */
export const ADVANCE_LOCK_MS = 840_000;
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
  | { step: "episode"; episodeId: string; instruction?: string; userScript?: string }
  | { step: "done" };

/** Decide the next step from what is in the DB (pure). */
export function planNextStep(
  season: { fullStory: string | null; episodes: PlannerEpisode[] } | null,
  state: Pick<SeasonJobState, "revise" | "skipFullStory" | "storyBatch">
): PlannedStep {
  // Stage 210 — a pending storyBatch that is not yet fully written forces another structure step so the
  // batch's episodes get appended (even when earlier episodes already exist).
  if (state.storyBatch && (!season || season.episodes.length < state.storyBatch.to)) return { step: "structure" };
  if (!season || season.episodes.length === 0) return { step: "structure" };
  if (!season.fullStory && !state.skipFullStory) return { step: "fullStory" };
  const queue = state.revise?.episodeIds ?? [];
  for (const id of queue) {
    if (season.episodes.some((e) => e.id === id)) return { step: "episode", episodeId: id, instruction: state.revise!.instruction || undefined, userScript: state.revise!.userScript || undefined };
  }
  // Stage 107 — the season job writes ONLY the structure + season plot. Episode scripts are written on demand
  // from the episode page (POST /api/ai/episodes/[id]/script → a job with a one-episode queue); the old
  // "first episode without a script" fallback is gone, so episodes stay script=null after the season job.
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
  /**
   * Approach A (Step 3 cast): STREAMING JSON chat with `onDelta`, used for the cast so the visible tokens are
   * relayed into `streamedText` while the model writes. Optional so existing unit tests (which inject only
   * chatJSON) keep working — when absent the worker falls back to `chatJSON` (no live preview).
   */
  streamJSON?: typeof streamChatJSON;
  /**
   * SIMPLIFIED PIPELINE (step 4): streaming PLAIN-TEXT chat for the episode screenplay (no JSON, no scene
   * schema). Optional so tests injecting only chatJSON keep working — absent ⇒ `streamChatText`.
   */
  streamText?: typeof streamChatText;
};
const defaultDeps: SeasonJobDeps = { start: startBackgroundJSON, poll: pollBackgroundJSON, cancel: cancelBackgroundResponse, chatJSON, streamJSON: streamChatJSON, streamText: streamChatText };

/** Heartbeat interval while a long LLM call is running (STALE_JOB_MS is 3 min — keep updatedAt fresh). */
const HEARTBEAT_MS = 20_000;

/**
 * Run a long LLM call with a periodic heartbeat so `failStaleJobs` never kills the job while the model is
 * thinking (Claude Opus 5 can stay silent for 10–30 s before the first token, and a non-streaming call can
 * run for minutes). The interval is always cleared in `finally`.
 */
async function withHeartbeat<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => { void heartbeatJob(jobId); }, HEARTBEAT_MS);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/** Reset the live preview at a step boundary so the next step starts with a clean pane. Best-effort. */
async function clearStreamedText(jobId: string): Promise<void> {
  await updateJob(jobId, { streamedText: null });
}

/**
 * Live preview transform for the cast stream: renders "Name (age) — role" + the appearance/personality text
 * written so far for every character block present in the (possibly unclosed) JSON, instead of raw braces.
 * Falls back to the generic value-only preview until the first "name" appears.
 */
export function castPreview(accumulated: string): string {
  if (!accumulated) return "";
  const parts = accumulated.split(/(?="name"\s*:)/);
  const out: string[] = [];
  for (const p of parts) {
    if (!/^"name"\s*:/.test(p)) continue;
    const name = extractProseField(p, "name").trim();
    if (!name) continue;
    const age = extractProseField(p, "age").trim();
    const role = extractProseField(p, "role").trim();
    const head = [name, age ? `(${age})` : "", role ? `— ${role}` : ""].filter(Boolean).join(" ");
    const body = [extractProseField(p, "appearance"), extractProseField(p, "personality")].map((s) => s.trim()).filter(Boolean).join(" ");
    out.push(body ? `${head}\n${body}` : head);
  }
  return out.length ? out.join("\n\n").slice(-60000) : stripJsonForPreview(accumulated);
}

const asText = (v: unknown, fallback: string, max: number): string => {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
  return (s || fallback).slice(0, max);
};

/**
 * Tolerant pre-sanitizer for the cast LLM output: the model regularly omits `role` (and sometimes other
 * string fields) on extras, which used to make `seasonCastResultSchema.parse` throw and fail the whole
 * step. Here every likely-missing string field gets a sensible default instead; characters without a
 * name are dropped; `locations` is optional (ignored for persistence anyway).
 */
export function sanitizeRawCast(raw: unknown): { characters: Record<string, unknown>[]; locations: unknown[] } {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(obj.characters) ? obj.characters : Array.isArray(obj.cast) ? obj.cast : [];
  const characters = list
    .filter((c) => c && typeof c === "object" && typeof (c as Record<string, unknown>).name === "string" && ((c as Record<string, unknown>).name as string).trim())
    .map((c) => {
      const ch = c as Record<string, unknown>;
      const tier = typeof ch.tier === "string" ? ch.tier.toUpperCase() : "";
      const roleFallback = tier === "CROWD" || tier === "MINOR" ? "extra" : "supporting";
      return {
        ...ch,
        name: asText(ch.name, "Unnamed", 120),
        age: asText(ch.age, "adult", 40),
        role: asText(ch.role ?? ch.description ?? ch.function, roleFallback, 200),
        appearance: asText(ch.appearance ?? ch.look, "Unremarkable appearance; details as written in the script.", 2500),
        personality: asText(ch.personality ?? ch.character, "Reserved, practical.", 2000),
        firstAppearance: asText(ch.firstAppearance ?? ch.firstScene ?? ch.introduction, "Episode 1", 1500),
      };
    });
  return { characters, locations: Array.isArray(obj.locations) ? obj.locations : [] };
}

/** Tolerant cast schema (see sanitizeRawCast). Still requires ≥2 named characters. */
export const seasonCastTolerantSchema = z.preprocess(
  sanitizeRawCast,
  z.object({ characters: z.array(characterCardSchema).min(2).max(MAX_CAST), locations: z.array(z.unknown()).optional().default([]) }),
);

// ---------------------------------------------------------------------------
// Step result validation (pure — schema + business rules)
// ---------------------------------------------------------------------------

export function validateStructure(raw: unknown, episodeCount: number, attempt = 0, startNumber = 1): SeasonStructure {
  const parsed = seasonStructureSchema.parse(raw);
  // Stage 14 (B2): the producer sets the episode count — enforce it exactly (retry if the model drifts).
  // Stage 210: for a batch, episodeCount is the batch size and startNumber is the first episode number, so
  // the appended episodes are renumbered startNumber..startNumber+count-1 (not always from 1).
  if (parsed.episodes.length !== episodeCount) throw new Error(`structure returned ${parsed.episodes.length} episodes, expected exactly ${episodeCount}`);
  const structure = { ...parsed, episodes: parsed.episodes.map((e, i) => ({ ...e, number: startNumber + i })) };
  // Stage 128 — every description is ONE detailed continuous synopsis + a closing CLIFFHANGER line (no shot split).
  // Problems on the FIRST attempt → throw (one cheap retry with EPISODE_SYNOPSIS_RETRY_NOTE); on the retry the
  // caller repairs the failing episodes (repairEpisodeSynopses) instead of failing the job.
  if (attempt === 0) {
    const problems = validateEpisodeSynopses(structure.episodes);
    if (problems.length) throw new Error(`episode descriptions need repair: ${problems.slice(0, 4).join("; ")}`);
  }
  return structure;
}

export function validateFullStory(raw: unknown): string {
  const text = seasonFullStorySchema.parse(raw).fullStory.trim();
  if (text.length < 200) throw new Error("full story too short");
  return text;
}

/** Schema + normalization + hard-problem gate; soft problems are logged. Dialogue translation is done by the caller. */
export function validateEpisode(raw: unknown, episodeNumber: number, characters: CharacterCard[], opts: { finalAttempt?: boolean; manual?: boolean } = {}): EpisodeScript {
  // Stage 161 — a MANUAL script may carry an extra silent establishing scene in front of the author's beats, so
  // normalize keeps every authored scene for the manual path instead of truncating to EPISODE_SCENE_COUNT.
  const script = normalizeEpisodeScript(episodeScriptSchema.parse(raw), characters, { manual: !!opts.manual });
  // Stage 110 — dialogue must be English with the cast's English speaker names. First attempt: a violation is
  // HARD (→ retry with a correction note). Final attempt: language problems are soft — the caller repairs
  // the text itself (ensureEnglishDialogue / translateDialogue) instead of failing the job. A silent scene is
  // ALWAYS hard for the AUTO path (we cannot invent lines).
  // Stage 159 — a MANUAL (author-provided) script is treated as soft-language from the FIRST attempt: the
  // author legitimately pastes non-English dialogue and speaker names outside the project cast, and those must
  // never HARD-reject the job (otherwise it exhausts its retries and "does not regenerate"). The spoken track
  // is still forced to English downstream (ensureEnglishDialogue / forceEnglishDialogue), and the author's
  // original text is preserved in dialogueLocal — so the author's script is accepted as written.
  // Stage 161 — a MANUAL script also allows ONE silent establishing/atmospheric scene the author wrote (e.g.
  // an opening skyline shot "без диалогов"): the silent problem becomes soft: for the manual path only, so the
  // author's intended silent scene is kept instead of being HARD-rejected. The AUTO path stays HARD on silence.
  const problems = validateEpisodeScript(script, { characterNames: characters.map((c) => c.name), languageIsSoft: !!opts.finalAttempt || !!opts.manual, allowSilent: !!opts.manual });
  // Word-count drift is tolerated (logged); hard problems (count, missing prompt lines, silent scene) fail → retry.
  const hard = hardProblems(problems);
  if (hard.length) throw new Error(`episode ${episodeNumber} script invalid: ${hard.slice(0, 3).join("; ")}`);
  if (problems.length) console.warn(`[season] ep ${episodeNumber} soft issues:`, problems);
  return script;
}

/** Stage 110 — targeted correction appended to the episode brief on a retry after a rejected script. */
export function episodeRetryNote(state: { attempt: number; lastFailure?: string }): string {
  if (state.attempt <= 0) return "";
  return `\n\nCORRECTION (your previous script was REJECTED${state.lastFailure ? `: ${state.lastFailure}` : ""}). Fix it now: EVERY scene has on-camera dialogue — no "[NO DIALOGUE]", no narrator, no voice-over-only or "previously on" scene; "dialogue" is STRICTLY ENGLISH (Latin letters only) with the project's ENGLISH character names exactly as given in the cast (or in the episode outline when there are no cast cards) as speaker labels; each scene has 3–6 lines NAME (cue): "line" (an action scene 3–4 short lines in the pauses); every videoPrompt has all 9 tags with a timed 0–10s / 10–20s / 20–30s choreography in [ACTION].`;
}

/** Stage 110 — translate any remaining non-English scene dialogue with the voiceover translator; never throws. */
export async function forceEnglishDialogue(script: EpisodeScript, translate: (dialogue: string, target: "en") => Promise<string> = translateDialogue): Promise<EpisodeScript> {
  const bad = nonEnglishScenes(script);
  if (!bad.length) return script;
  const scenes = await Promise.all(script.scenes.map(async (s) => {
    if (!bad.includes(s.number)) return s;
    try {
      const en = (await translate(s.dialogue, "en")).trim();
      if (!en || !isEnglishDialogue(en)) return s;
      return { ...s, dialogue: en, dialogueLocal: s.dialogueLocal && isEnglishDialogue(s.dialogueLocal) ? s.dialogue : (s.dialogueLocal ?? s.dialogue) };
    } catch (err) {
      console.error(`[season] forceEnglishDialogue scene ${s.number} failed:`, err);
      return s;
    }
  }));
  return { ...script, scenes };
}

/** Replace an episode's Scene rows with the given script (keeps the episode row / id). */
export async function persistEpisodeScript(
  episodeId: string,
  outline: EpisodeOutline,
  script: EpisodeScript,
  characters: { id: string; name: string }[],
  language: string,
  // Stage 160 — for a MANUAL (author-provided) script keep the author's OWN per-scene location instead of
  // anchoring every scene to the episode's single canonical location (auto scripts stay anchored as before).
  opts: { preserveSceneLocations?: boolean } = {}
) {
  const idOf = (n: string) => matchCharacter(characters, n)?.id;
  // Stage 222 (Variant B) — translate the readable-script movement/camera labels to Russian (names stay Latin)
  // BEFORE rendering the human-readable text. Only the rendered `Episode.script` text uses the Russian staging;
  // the DB Scene rows below are still written from the ORIGINAL `script` (English presence/entrances/videoPrompt
  // feed the video prompt, untouched). attachMovementRu never throws — on failure the reader falls back to English.
  const scriptForText = await attachMovementRu(script, chatJSON);
  const text = renderEpisodeScriptText(outline, scriptForText);
  // Stage 20 (D1): the accurate episode cast is the UNION of characters that actually appear in the
  // generated scenes — collected here per scene, deduped below (not the declared outline.characters).
  const sceneCastIds: string[][] = [];
  await prisma.$transaction(async (tx) => {
    await tx.scene.deleteMany({ where: { episodeId } });
    for (const s of script.scenes) {
      // Stage 161 — a silent establishing/atmospheric scene (author-provided) carries NO spoken speech: keep the
      // "[NO DIALOGUE]" sentinel in `dialogue` (UI shows nothing to voice) and store an EMPTY
      // `dialogueEn` so the video track has no lines to speak — only the ambient/room-tone audio.
      const silent = isSilent(s.dialogue);
      const scene = await tx.scene.create({
        data: {
          episodeId,
          number: s.number,
          // Short human-readable scene title (2–6 words) for the readable script heading. Additive & nullable:
          // legacy / manual scripts that carry no title store null and the UI falls back to "Scene N".
          title: (s.title ?? "").trim() || null,
          // `dialogue` = story-language text (UI display only; subtitles removed); `dialogueEn` = the English lines the model voices.
          dialogue: silent ? "[NO DIALOGUE]" : (s.dialogueLocal ?? s.dialogue),
          dialogueEn: silent ? "" : s.dialogue,
          // Stage 20 (A2): lock every non-location-change scene to the episode's single canonical location
          // (Episode.locationDesc) so the place never drifts scene-to-scene and frame-chaining stays reliable.
          // Stage 160: a MANUAL author script keeps the author's own per-scene location (anchor only when empty).
          locationDesc: opts.preserveSceneLocations
            ? ((s.locationDesc ?? "").trim() || anchorSceneLocation(s.locationDesc, outline.locationDesc, s.continuesFrom))
            : anchorSceneLocation(s.locationDesc, outline.locationDesc, s.continuesFrom),
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
          // Stage 122 — the scripted region (which part of the constant location this scene occupies) and its
          // normalized cache key. The region plate itself is pre-generated later; a freshly scripted scene has none yet.
          regionDesc: (s.region ?? "").trim() || null,
          regionKey: deriveRegionKey(s.region) || null,
          regionPlateUrl: null,
          // Sub-location: the scripted machine-readable SPOT key within the location (season.ts S16). The
          // unique sub-locations per location are extracted and their 9:16 angle references pre-generated later;
          // a freshly scripted scene stores just the normalized key here (null when the model left it empty).
          subLocation: normalizeSubLocation(s.subLocation) || null,
          // 4-ANGLE REFERENCES — the scripted accent camera angle (English) for this scene inside the
          // constant location. The distinct accent angles across a location's scenes drive its extra
          // reference plates (up to 4 angles per location). Null when the model left it empty / legacy scripts.
          cameraAngle: (s.cameraAngle ?? "").trim() || null,
          // Stage 12 (Commit D) — off-screen narration: `voiceover` = English narration voiced by the model,
          // `voiceoverLocal` = the same narration translated for the UI. `sceneKind` distinguishes narration from dialogue.
          sceneKind: s.sceneKind ?? "dialogue",
          voiceover: s.voiceover ?? null,
          voiceoverLocal: s.voiceoverLocal ?? s.voiceover ?? null,
          language: "en", // speech is always English (Stage 4)
          // NOTE: `Scene.subtitled` is DEPRECATED/inactive (subtitles removed); no longer written here —
          // the column keeps its schema default (false) for historical rows.
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
      // Stage 166 — record the single emotional-peak scene index and the prompt version this script was generated with.
      data: { script: text, description: outline.description ?? outline.logline, logline: outline.logline, cliffhanger: outline.cliffhanger, locationName: outline.locationName, locationDesc: outline.locationDesc, arcRole: outline.arcRole, status: "script_ready", title: outline.title, videoUrl: null, peakSceneIndex: resolvePeakSceneIndex(script), promptVersion: EPISODE_SCRIPT_PROMPT_VERSION },
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
  return prisma.project.findUnique({ where: { id: projectId }, include: { characters: true, locations: { orderBy: { createdAt: "asc" } }, user: { select: { id: true, credits: true } } } });
}

async function loadSeason(projectId: string) {
  return prisma.season.findFirst({ where: { projectId, number: 1 }, include: seasonInclude });
}

/**
 * Stage 1 (dramaBible) — read the persisted story bible off the Project defensively. Project.dramaBible is a
 * Json column; old projects have NULL (returned as null here) so every downstream use degrades to its
 * bible-less fallback. Returns the object as-is (validated at generation time), or null when absent/not an object.
 */
function readDramaBible(project: { dramaBible?: unknown }): DramaBible | null {
  const raw = project.dramaBible;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as DramaBible;
  return null;
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
export async function advanceSeasonJob(job: GenerationJob, deps: SeasonJobDeps = defaultDeps, init?: { episodeCount?: number; storyBatch?: SeasonJobState["storyBatch"] }): Promise<GenerationJob | null> {
  if (job.type !== SEASON_JOB_TYPE || !ACTIVE_STATUSES.includes(job.status)) return job;
  const prevRaw = job.resultData;
  const state = parseSeasonState(prevRaw, init?.episodeCount);
  if (init?.episodeCount) { state.episodeCount = init.episodeCount; if (state.step === "structure" && !state.responseId) { state.total = init.episodeCount; state.remaining = init.episodeCount; } }
  // Stage 210 — a fresh "generate next N" request carries the batch bounds; apply them before the structure
  // step starts so tick() generates and appends only that slice.
  if (init?.storyBatch && state.step === "structure" && !state.responseId) { state.storyBatch = init.storyBatch; }
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
 * (all tiers) from the approved synopsis and persist it. Idempotent: if characters already exist (retry /
 * classic flow) it is a no-op.
 *
 * Approach A: the call is STREAMING (visible tokens → `streamedText` via castPreview) and runs under a
 * 20 s heartbeat, so the 3-min stale watchdog can never kill the job mid-call and the producer watches the
 * cast appear live. The output is parsed with the tolerant schema (missing `role` etc. → defaults); a
 * parse failure gets ONE retry, then the step fails with a clear message.
 */
/**
 * @deprecated NOT called by the season flow any more (characters are created on the References step from the
 * finished scripts — see `lib/workers/characters-from-script-job.ts`). Kept as an export for tooling/tests only.
 */
export async function generateSeasonCast(jobId: string, projectId: string, synopsis: string, language: IdeaLanguage, deps: SeasonJobDeps): Promise<void> {
  await clearStreamedText(jobId);
  await updateJob(jobId, { status: "processing", progress: 2, message: "Creating the cast…" });
  const callModel = async (): Promise<unknown> => {
    const opts = { temperature: 0.85, maxTokens: 12000 };
    if (deps.streamJSON) {
      return deps.streamJSON(seasonCastSystemPrompt(language), seasonCastUserPrompt(synopsis), { ...opts, onDelta: makeJobStreamWriter(jobId, { transform: castPreview }) });
    }
    return deps.chatJSON(seasonCastSystemPrompt(language), seasonCastUserPrompt(synopsis), opts);
  };
  let parsed: z.infer<typeof seasonCastTolerantSchema> | null = null;
  let lastError = "";
  for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
    const raw = await withHeartbeat(jobId, callModel);
    const res = seasonCastTolerantSchema.safeParse(raw);
    if (res.success) { parsed = res.data; break; }
    lastError = res.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    console.warn(`[season] cast attempt ${attempt}/2 rejected: ${lastError}`);
    if (attempt < 2) await updateJob(jobId, { message: "Cast draft was incomplete — retrying…" });
  }
  if (!parsed) throw new Error(`The cast could not be generated (invalid model output: ${lastError}). Restart generation to try again.`);
  const names = parsed.characters.map((c) => c.name);
  const characters = dedupeCast(parsed.characters).map((c) => sanitizeCharacterCard(c, names));
  // Stage 162: create CHARACTERS ONLY here. Locations are no longer generated up front from the synopsis —
  // they are derived PER EPISODE from that episode's finished shooting script (see applyStepResult's episode
  // branch). The cast LLM may still return a "locations" array; we intentionally ignore it for persistence.
  await prisma.$transaction(async (tx) => {
    // Idempotency guard: another poller (or a retry) may have already created the cast.
    if ((await tx.character.count({ where: { projectId } })) > 0) return;
    for (const c of characters) {
      await tx.character.create({ data: { projectId, ...characterCardToData(c), status: "draft", imageFront: "", imageProfile: "", imageFull: "" } });
    }
  }, { timeout: 30_000 });
  await updateJob(jobId, { message: `Cast ready: ${characters.length} characters. Building the season structure…` });
}

async function tick(jobId: string, projectId: string, state: SeasonJobState, deps: SeasonJobDeps): Promise<void> {
  const project = await loadProject(projectId);
  if (!project?.synopsis) throw new Error("Project synopsis missing");
  const language = normalizeLanguage(project.language, project.synopsis);
  // Steps 3/4 are TEXT ONLY: the season structure and the episode scripts are written from the synopsis and
  // name the characters themselves. No Character rows are created here any more — the cast is extracted
  // from the finished scripts on the References step (POST /api/ai/characters → characters-from-script-job).
  // When the project already has characters (legacy projects / manual cast) their cards are still passed
  // to the prompts so names stay consistent; otherwise `cards` is simply empty.
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
          ? { step: "episode", episodeId: state.episodeId, instruction: state.revise?.episodeIds.includes(state.episodeId) ? state.revise.instruction : undefined, userScript: state.revise?.episodeIds.includes(state.episodeId) ? state.revise.userScript : undefined }
          : { step: state.step as "structure" | "fullStory" };
        state = { ...state, attempt: state.attempt + 1, lastFailure: failure };
      }
    } else {
      state = { ...state, attempt: 0, lastFailure: undefined };
      // Stage 210 — a batch's structure step succeeded: the slice is written, clear the batch so planNextStep
      // moves on (rebuild fullStory over all episodes, then done).
      if (state.step === "structure" && state.storyBatch) state = { ...state, storyBatch: undefined };
      if (state.step === "episode" && state.episodeId && state.revise?.episodeIds.includes(state.episodeId)) {
        state = { ...state, revise: { ...state.revise, episodeIds: state.revise.episodeIds.filter((id) => id !== state.episodeId) } };
      }
    }
    state = { ...state, responseId: undefined, episodeId: undefined, stepStartedAt: undefined };
  }

  // (c) Start the next step (or retry the failed one).
  let planned = retryStep ?? planNextStep(season, state);
  let seasonStruct: SeasonStructure | null = season ? { title: season.title ?? "", logline: season.logline ?? "", episodes: season.episodes.map(outlineFromEpisode) } : null;
  if (planned.step === "fullStory" && season && seasonStruct) {
    // Stage 106 — the season plot is NOT written by the LLM any more: it is built deterministically from the
    // validated structure (season logline + every episode's 3-line footage) and saved at once, then the job
    // proceeds straight to the episode scripts. No prompt, no attempts, no "too short" failures.
    const fullStory = buildFullStoryFromStructure(seasonStruct, language, project.synopsis);
    await prisma.season.update({ where: { id: season.id }, data: { fullStory } });
    season = await loadSeason(projectId);
    state = { ...state, attempt: 0, lastFailure: undefined };
    planned = planNextStep(season, state);
    seasonStruct = season ? { title: season.title ?? "", logline: season.logline ?? "", episodes: season.episodes.map(outlineFromEpisode) } : null;
  }
  const done = countDone();
  const curTotal = season && season.episodes.length ? season.episodes.length : state.episodeCount;
  const remaining = season ? season.episodes.filter((e) => !e.script).length + (state.revise?.episodeIds.length ?? 0) : state.episodeCount;

  if (planned.step === "done") {
    if (season) await prisma.season.update({ where: { id: season.id }, data: { status: "script_ready" } });
    await saveState(jobId, { ...state, step: "done", remaining: 0, total: curTotal, done: true });
    const note = state.warnings?.length ? ` · ${state.warnings.join("; ")}` : "";
    await completeJob(jobId, { ...state, step: "done", remaining: 0, total: curTotal, done: true, lockedAt: undefined }, `Season plot ready${note}`);
    return;
  }

  let responseId: string;
  let message: string;
  let progress: number;
  if (planned.step === "structure") {
    // Stage 105 — the single retry after a rejected structure gets an explicit format instruction (plus the exact problems).
    const retryNote = state.attempt > 0 ? `\n\n${EPISODE_SYNOPSIS_RETRY_NOTE}${state.lastFailure ? ` Problems found: ${state.lastFailure}` : ""}` : "";
    // Stage 210 — batched story generation: when a storyBatch is pending, generate ONLY that slice and pass
    // the already-written episodes as continuity context so the new batch continues the same story.
    const batch = state.storyBatch;
    const prevEpisodes = batch && season
      ? season.episodes.map((e) => ({ number: e.number, title: e.title, description: e.description ?? null, cliffhanger: e.cliffhanger ?? null }))
      : undefined;
    const batchTokens = batch ? batch.to - batch.from + 1 : state.episodeCount;
    message = batch ? `Writing episodes ${batch.from}–${batch.to}...` : "Building the season structure..."; progress = 3;
    // Approach A: `deps.start` BLOCKS for the whole (multi-minute) structure generation — publish the step
    // message BEFORE the call, start from a clean preview pane and heartbeat every 20 s while the model
    // thinks (the streamed episode titles/synopses land in streamedText via the onDelta transform).
    await clearStreamedText(jobId);
    await updateJob(jobId, { status: "processing", progress, message });
    responseId = await withHeartbeat(jobId, () => deps.start(seasonStructureSystemPrompt(language, state.episodeCount, batch), seasonStructureUserPrompt(project.synopsis ?? "", cards, project.locations, shortSynopsisOutline(project.shortSynopsis), prevEpisodes) + retryNote, { model: SCRIPT_MODEL, maxTokens: Math.min(64000, 4000 + 800 * batchTokens), onDelta: makeJobStreamWriter(jobId, { transform: stripJsonForPreview }) }));
  } else if (planned.step === "fullStory") {
    // Unreachable since Stage 106 (handled deterministically above); kept so the state machine stays exhaustive.
    throw new Error("fullStory step is built from the structure, not generated");
  } else {
    // SIMPLIFIED PIPELINE (step 4) — the episode script is a PLAIN-TEXT screenplay written by Claude Opus 5
    // in ONE streaming call (no JSON scenes, no zod per-scene schema, no background response id). The step runs
    // fully inline here: stream → persist Episode.script → drop the derived Scene rows (the 5×5 shot list is
    // built separately, POST /api/ai/episodes/[id]/shot-list) → pop the episode from the revise queue → plan
    // the next step. Previous episodes are passed with their FULL scripts for continuity.
    const ep = season!.episodes.find((e) => e.id === planned.episodeId)!;
    const next = season!.episodes.find((e) => e.number === ep.number + 1);
    const seasonMapCells = Array.isArray(season!.seasonMap) ? (season!.seasonMap as unknown as SeasonMapCell[]) : null;
    const seasonMapCell = seasonMapCells?.find((c) => c && c.episode === ep.number) ?? null;
    const seasonMapCellBlock = seasonMapCellBrief(seasonMapCell);
    const dramaBibleBlock = dramaBibleBrief(readDramaBible(project));
    let seasonStateBlock = "";
    try {
      const row = await prisma.seasonState.findFirst({ where: { seasonId: season!.id }, orderBy: { updatedAt: "desc" } });
      if (row?.state) seasonStateBlock = renderSeasonStateBlock(normalizeSeasonState(row.state), ep.number);
    } catch {
      seasonStateBlock = "";
    }
    message = planned.userScript
      ? `Saving your script...`
      : planned.instruction
      ? `Rewriting the script for episode ${ep.number}... (usually 1-3 minutes)`
      : `Writing the episode script... (usually 1-3 minutes)`;
    progress = episodeProgress(done, curTotal);
    await clearStreamedText(jobId);
    // NOTE: updateJob (not saveState) — the CAS advance lock in resultData must stay held during the blocking call.
    await updateJob(jobId, { status: "processing", progress, message });
    let text: string;
    if (planned.userScript?.trim()) {
      text = planned.userScript.trim();
    } else {
      const streamText = deps.streamText ?? streamChatText;
      const retryNote = state.attempt > 0 && state.lastFailure ? `\n\nThe previous attempt failed: ${state.lastFailure}. Write the complete screenplay (all 5 scenes) this time.` : "";
      const raw = await withHeartbeat(jobId, () => streamText(
        episodeScreenplaySystemPrompt(language, ep.number),
        episodeScreenplayUserPrompt({
          season: { title: season!.title ?? "", logline: season!.logline ?? "" },
          synopsis: project.synopsis ?? "",
          episode: {
            number: ep.number, title: ep.title, logline: ep.logline ?? null, cliffhanger: ep.cliffhanger ?? null, description: ep.description ?? null,
            locationName: ep.locationName ?? null, locationDesc: ep.locationDesc ?? null,
            characters: ep.characters.map((c) => c.character.name),
          },
          previousEpisodes: season!.episodes.filter((p) => p.number < ep.number).map((p) => ({ number: p.number, title: p.title, logline: p.logline ?? null, cliffhanger: p.cliffhanger ?? null, script: p.script ?? null })),
          characterNames: project.characters.map((c) => c.name),
          instruction: planned.instruction ? reviseInstruction(planned.instruction, next) : null,
          extraBlocks: [seasonMapCellBlock, dramaBibleBlock, seasonStateBlock],
        }) + retryNote,
        { model: EPISODE_SCRIPT_MODEL, maxTokens: SCREENPLAY_MAX_TOKENS, temperature: EPISODE_SCRIPT_TEMPERATURE, timeoutMs: 780_000, onDelta: makeJobStreamWriter(jobId) }
      ));
      text = (raw ?? "").replace(/^```[a-z]*\s*/i, "").replace(/\s*```\s*$/, "").trim();
    }
    if (text.length < 200) {
      // Too short to be a screenplay — count as a failed attempt (the state machine retries via the poll route).
      const failure = `The screenplay came back empty or too short (${text.length} chars).`;
      const decision = retryDecision({ step: "episode", attempt: state.attempt });
      if (decision === "fail") {
        await saveState(jobId, { ...state, responseId: undefined, episodeId: undefined, stepStartedAt: undefined });
        await failJob(jobId, `${failure} Restart generation to try again.`);
        return;
      }
      await saveState(jobId, { ...state, attempt: state.attempt + 1, lastFailure: failure, responseId: undefined, episodeId: undefined, stepStartedAt: undefined }, { status: "processing", progress, message: "Script draft was incomplete — retrying…" });
      return;
    }
    await prisma.$transaction(async (tx) => {
      await tx.scene.deleteMany({ where: { episodeId: ep.id } });
      await tx.episode.update({ where: { id: ep.id }, data: { script: text, status: "script_ready", videoUrl: null, gridUrl: null, gridApproved: false } });
    }, { timeout: 30_000 });
    await updateJob(jobId, { streamedText: text.slice(0, 60000) });
    state = {
      ...state,
      attempt: 0, lastFailure: undefined, responseId: undefined, episodeId: undefined, stepStartedAt: undefined,
      ...(state.revise ? { revise: { ...state.revise, episodeIds: state.revise.episodeIds.filter((id) => id !== ep.id) } } : {}),
    };
    season = await loadSeason(projectId);
    const after = planNextStep(season, state);
    if (after.step === "done") {
      if (season) await prisma.season.update({ where: { id: season.id }, data: { status: "script_ready" } });
      await saveState(jobId, { ...state, step: "done", remaining: 0, total: curTotal, done: true });
      await completeJob(jobId, { ...state, step: "done", remaining: 0, total: curTotal, done: true, lockedAt: undefined }, `Episode ${ep.number} script ready`);
      return;
    }
    // Another episode is queued (multi-episode revise) — release the lock; the next poll starts it.
    await saveState(jobId, { ...state, step: "episode", responseId: undefined, total: curTotal, remaining: Math.max(0, remaining - 1), done: false }, { status: "processing", progress: episodeProgress(done + 1, curTotal), message: `Episode ${ep.number} script ready. Next episode…` });
    return;
  }
  await saveState(
    jobId,
    { ...state, step: planned.step, episodeId: undefined, responseId, stepStartedAt: new Date().toISOString(), total: curTotal, remaining, done: false },
    { status: "processing", progress, message }
  );
}

type LoadedSeason = NonNullable<Awaited<ReturnType<typeof loadSeason>>>;
type LoadedProject = NonNullable<Awaited<ReturnType<typeof loadProject>>>;

/** Validate a completed step's JSON and persist it. Throws on invalid output (→ retry). Returns the refreshed season. */
async function applyStepResult(project: LoadedProject, season: LoadedSeason | null, state: SeasonJobState, raw: unknown, language: IdeaLanguage, cards: CharacterCard[], deps: SeasonJobDeps): Promise<LoadedSeason | null> {
  const projectId = project.id;
  if (state.step === "structure") {
    // Stage 210 — batched story generation: a storyBatch means we produced only episodes [from..to] of a
    // `total`-episode season and must APPEND them; without a batch it is the legacy all-at-once structure.
    const batch = state.storyBatch;
    const expectedCount = batch ? batch.to - batch.from + 1 : state.episodeCount;
    const startNumber = batch ? batch.from : 1;
    const isAppend = Boolean(batch && season); // appending onto an existing season (2nd+ batch)
    const isFinalBatch = !batch || batch.to >= batch.total;
    const validated = validateStructure(raw, expectedCount, state.attempt, startNumber);
    // Stage 128 — never fail on synopsis format: targeted repair passes + deterministic clamp (always valid).
    const fixed = await repairEpisodeSynopses(validated.episodes, language, (sys, usr) => deps.chatJSON(sys, usr, { temperature: 0.3, maxTokens: 6000 }));
    if (fixed.repaired.length || fixed.clamped.length) console.warn(`[season-job] synopsis repaired for episodes ${fixed.repaired.join(", ") || "-"}; clamped ${fixed.clamped.join(", ") || "-"}`);
    const structure: SeasonStructure = { ...validated, episodes: fixed.episodes };
    const byName = new Map(project.characters.map((c) => [c.name.toLowerCase(), c.id]));
    await prisma.$transaction(async (tx) => {
      // On append keep the season's existing title/logline (only the first batch / legacy call sets them);
      // creating the season records the producer-chosen total episode count so the UI can show progress.
      const s = season
        ? isAppend
          ? season
          : await tx.season.update({ where: { id: season.id }, data: { title: structure.title, logline: structure.logline } })
        : await tx.season.create({ data: { projectId, number: 1, title: structure.title, logline: structure.logline, episodeCount: batch ? batch.total : state.episodeCount } });
      for (const e of structure.episodes) {
        // Stage 162: keep the structure's location NAME/DESCRIPTION text on the episode, but do NOT create a
        // Location card here (locationId stays null). Location rows are created PER EPISODE later, from that
        // episode's finished shooting script — this is what stops "all locations up front".
        const ep = await tx.episode.create({ data: { seasonId: s.id, number: e.number, title: e.title, description: e.description ?? e.logline, logline: e.logline, cliffhanger: e.cliffhanger, locationName: e.locationName, locationDesc: e.locationDesc, locationId: null, arcRole: e.arcRole, status: "draft" } });
        const ids = Array.from(new Set(e.characters.map((n) => byName.get(n.toLowerCase())).filter((x): x is string => !!x)));
        if (ids.length) await tx.episodeCharacter.createMany({ data: ids.map((characterId) => ({ episodeId: ep.id, characterId })) });
      }
      // Appending new episodes invalidates the deterministic season plot — clear it so planNextStep rebuilds
      // fullStory over ALL episodes once this batch's episodes exist.
      if (isAppend) await tx.season.update({ where: { id: s.id }, data: { fullStory: null } });
    }, { timeout: 30_000 });
    // Track batch progress so "generate next N" knows where to continue (legacy flow leaves it untouched).
    await prisma.project.update({ where: { id: projectId }, data: { stage: "structure", ...(batch ? { storyEpisodesGenerated: batch.to } : {}) } });
    const reloaded = await loadSeason(projectId);
    // Stage 210 — the season map is designed once, over the WHOLE season, only after the final batch lands.
    if (!isFinalBatch) return reloaded;
    // Stage 3 (seasonMap) — once the episodes exist, design a validated per-episode SEASON MAP that will
    // constrain each episode's outline (beat variety, cliffhanger spacing, escalation, secrets, finale).
    // Best-effort: any failure (LLM/transport/validation) is swallowed and the season simply carries no map
    // (old behavior). When the project has a Stage 1 dramaBible, its real escalation ladder / scheduled
    // secrets / finale question drive the map; without one the generator/validators degrade to the documented
    // structural fallbacks (escalationStep from episode position; no scheduled secrets).
    if (reloaded) {
      // Stage 210 — build the map over the WHOLE season (all episodes now in the DB), not just this batch's
      // slice, so batched and all-at-once flows produce the same full-season map.
      const mapEpisodes = reloaded.episodes.map((e) => ({ number: e.number, title: e.title, logline: e.logline, locationName: e.locationName }));
      try {
        const result = await generateSeasonMap(
          {
            episodes: mapEpisodes,
            episodeCount: mapEpisodes.length,
            seasonLogline: reloaded.logline ?? structure.logline,
            locations: project.locations.map((l) => l.name).filter(Boolean),
            // Stage 1 (dramaBible) — pass the REAL escalation ladder / scheduled secrets / finale question when
            // the project has a bible; toDramaBibleForMap returns null when absent → structural fallback (old behavior).
            bible: toDramaBibleForMap(readDramaBible(project)),
          },
          (sys, usr, o) => deps.chatJSON(sys, usr, { ...o, maxTokens: Math.min(16000, 2000 + 500 * mapEpisodes.length) }),
          { model: SCRIPT_MODEL, maxRetries: 3 }
        );
        if (!result.valid) console.warn(`[season-job] season map persisted as advisory after ${result.attempts} attempt(s); outstanding: ${result.errors.map((e) => e.rule).join(", ")}`);
        await prisma.season.update({
          where: { id: reloaded.id },
          data: { seasonMap: result.seasonMap as unknown as object, seasonMapVersion: SEASON_MAP_PROMPT_VERSION },
        });
        return loadSeason(projectId);
      } catch (err) {
        console.warn(`[season-job] season map generation skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return reloaded;
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
    const finalAttempt = state.attempt >= MAX_ATTEMPTS - 1;
    // Stage 159 — this is a MANUAL (author-provided) script when the current episode is in the manual queue
    // (revise.userScript set). Then language / cast-name checks are soft from the first attempt so the author's
    // pasted dialogue and speaker names are never HARD-rejected (still forced to English downstream).
    const manual = !!(state.revise?.userScript && state.episodeId && state.revise.episodeIds.includes(state.episodeId));
    let script = await ensureEnglishDialogue(validateEpisode(raw, ep.number, cards, { finalAttempt, manual }), deps.chatJSON);
    // Stage 110 — last line of defence on the final attempt: any scene still not English after the swap /
    // batch translation is translated line-by-line (lib/voiceover translateDialogue); the original stays in dialogueLocal.
    script = await forceEnglishDialogue(script);
    // Stage 166 (Rule 6) — SEPARATE dialogue-polish pass: removes motive-explaining lines, keeps the average line
    // ≤12 words, favours subtext and applies per-character voice profiles when present (Stage 2 — read DEFENSIVELY,
    // absent for now). Fully best-effort: any failure returns the original dialogue untouched, and it never
    // turns a spoken scene silent.
    script = await polishEpisodeDialogue(script, deps.chatJSON, { voiceProfiles: undefined });
    // Stage 166 (Rule 8) — verify every scene's start/end frame-state CHECKLIST with an LLM critic (NOT regex /
    // sentence counting). On the FIRST attempt a failure triggers ONE targeted retry naming the missing item (via
    // the standard retry loop + episodeRetryNote, which echoes state.lastFailure); from the second attempt on, and
    // for manual author scripts, it is only recorded as a warning and never blocks the job. A critic outage = pass.
    let checklistMiss = "";
    try {
      outer: for (const sc of script.scenes) {
        for (const [label, stateText] of [["startState", sc.startState], ["endState", sc.endState]] as const) {
          const verdict = await judgeStateChecklist((stateText ?? "").trim(), deps.chatJSON);
          if (!verdict.pass && verdict.missingItem) {
            checklistMiss = `${label} — ${stateChecklistRetryNote(verdict.missingItem, sc.number)}`;
            break outer; // one concrete missing item is enough to drive the targeted retry
          }
        }
      }
    } catch (err) {
      console.warn(`[season-job] episode ${ep.number} checklist critic skipped:`, err);
      checklistMiss = "";
    }
    if (checklistMiss && state.attempt <= 0 && !finalAttempt && !manual) {
      throw new Error(`episode ${ep.number} frame-state checklist incomplete: ${checklistMiss}`);
    }
    // Stage 45/103 — the episode budget (EPISODE_TOTAL_LABEL) is enforced by normalize where speech allows;
    // what is left over is shown to the author instead of failing the job (no line of dialogue is ever cut to make it fit).
    const total = episodeTotalSeconds(script.scenes);
    const overNote = `episode ${ep.number} is longer than ${EPISODE_TOTAL_LABEL} (${total} s) - shorten the scenes`;
    state.warnings = (state.warnings ?? []).filter((w) => !w.startsWith(`episode ${ep.number} `));
    if (total > EPISODE_MAX_TOTAL_SECONDS) state.warnings.push(overNote);
    // Stage 166 — surface an incomplete frame-state checklist as a diagnostic warning (kept after the filter above).
    if (checklistMiss) state.warnings.push(`episode ${ep.number} frame-state: ${checklistMiss}`);
    // Stage 113 — soft set-inventory check: objects mentioned in a scene's "set" line that are not in the location
    // inventory are only logged (diagnostics), never retried.
    const epLoc = ep.locationId ? project.locations.find((l) => l.id === ep.locationId) : matchLocation(project.locations, ep.locationName ?? "");
    const invWarnings = checkSceneSetInventory(script.scenes, epLoc?.setInventory);
    if (invWarnings.length) console.warn(`[season-job] episode ${ep.number} set inventory: ${invWarnings.join(" | ")}`);
    // NOTE: no Character rows are created here (the former Stage 168 auto-create block is gone). The scenes are
    // linked to characters ONLY when the project already has them (persistEpisodeScript matches by name and
    // silently skips unknown names); the cast itself is extracted later on the References step from the scripts.
    // Stage 169 — DETERMINISTIC per-scene header for a MANUAL (author-provided) script. The LLM structuring step
    // was unreliable at carrying each authored scene's OWN sub-location into `title`/`subLocation`: it kept anchoring
    // every scene to the episode's single top-level LOCATION, so the Script stage rendered an identical
    // "<place>" / "<place> — <sub>" header on EVERY scene even though the author gave each scene a distinct spot.
    // We do NOT trust the model for this. We parse the author's ORIGINAL pasted text (which explicitly marks each
    // scene's LOCATION — SUB-LOCATION) and, aligned by author scene order, force each generated scene's `title` and
    // `subLocation` from it. The prompt already emits EXACTLY ONE JSON scene per authored marker (no merge/drop), so
    // index alignment is 1:1; if the model ever produced a different count we only override the scenes that line up
    // and leave the rest as written. Applies ONLY to the manual path — auto (LLM-invented) scripts are untouched.
    if (manual && state.revise?.userScript) {
      const authored = parseManualScriptScenes(state.revise.userScript);
      if (authored.length) {
        script = {
          ...script,
          scenes: script.scenes.map((s, i) => {
            const a = authored[i];
            if (!a) return s;
            const loc = (a.location ?? "").trim();
            const sub = (a.subLocation ?? "").trim();
            if (!loc && !sub) return s;
            const title = sub ? `${loc} — ${sub}` : loc;
            return { ...s, title: title || s.title, subLocation: sub || s.subLocation };
          }),
        };
      }
    }
    await persistEpisodeScript(ep.id, outline, script, project.characters.map((c) => ({ id: c.id, name: c.name })), language, { preserveSceneLocations: manual });
    // Stage 162 — derive this episode's Location rows FROM the finished, persisted script (not all up front).
    // Reload the scenes with their final locationDesc, plan create/reuse against the project's existing locations,
    // create the new rows, bind every scene to its location, set the episode's primary location, and (best-effort)
    // enqueue reference images for the NEW locations only. A location problem is logged, never thrown — it must
    // never fail the episode job.
    try {
      const persisted = await prisma.scene.findMany({ where: { episodeId: ep.id }, orderBy: { number: "asc" }, select: { id: true, locationDesc: true, title: true, subLocation: true } });
      const existing = project.locations.map((l) => ({ id: l.id, name: l.name }));
      // Stage 170 — for a MANUAL (author) script, plan one Location PER distinct authored spot
      // ("<location> — <sub-location>", taken from the deterministic scene.title set by the Stage 169
      // override, persisted above), so each sub-location gets its own reference card. The persisted Scene
      // rows already carry `title` + `subLocation`, so we read straight from the DB (no in-memory fallback
      // needed). Auto (LLM) scripts keep the single-key `planEpisodeLocations` (one location per episode).
      const plan = manual
        ? planManualEpisodeLocations(persisted, existing)
        : planEpisodeLocations(persisted, existing);
      const idByName = new Map(existing.map((l) => [l.name.toLowerCase(), l.id]));
      const newLocationIds: string[] = [];
      for (const c of plan.create) {
        const created = await prisma.location.create({ data: { projectId, name: c.name, description: c.name, visualPrompt: c.visualPrompt, visualPromptAuto: c.visualPrompt } });
        idByName.set(created.name.toLowerCase(), created.id);
        newLocationIds.push(created.id);
        project.locations.push(created); // keep the in-memory project in step so LATER episodes reuse this row
      }
      // Bind scenes to their locations (grouped by location id → one updateMany per location).
      const sceneIdsByLoc = new Map<string, string[]>();
      for (const b of plan.bindings) {
        const locId = idByName.get(b.locationName.toLowerCase());
        if (!locId) continue;
        const arr = sceneIdsByLoc.get(locId) ?? [];
        arr.push(b.sceneId);
        sceneIdsByLoc.set(locId, arr);
      }
      for (const [locId, sceneIds] of sceneIdsByLoc) {
        await prisma.scene.updateMany({ where: { id: { in: sceneIds } }, data: { locationId: locId } });
      }
      // Episode's primary location = the first distinct location in the script.
      const primaryId = plan.primaryName ? idByName.get(plan.primaryName.toLowerCase()) ?? null : null;
      if (primaryId) await prisma.episode.update({ where: { id: ep.id }, data: { locationId: primaryId } });
      // Best-effort: start reference images for the NEW locations only (they have no image yet; a reused location
      // keeps its existing image). startLocationImageJob does its own credit guard — an insufficient balance or any
      // error here is logged and swallowed, never fails the episode job.
      if (newLocationIds.length && project.user) {
        try {
          const res = await startLocationImageJob({ user: { id: project.user.id, credits: project.user.credits }, projectId, locationIds: newLocationIds });
          if ("error" in res) console.warn(`[season-job] episode ${ep.number} location images not started: ${res.error}`);
        } catch (err) {
          console.warn(`[season-job] episode ${ep.number} location image job failed to start:`, err instanceof Error ? err.message : String(err));
        }
      }
    } catch (err) {
      console.warn(`[season-job] episode ${ep.number} per-episode location derivation failed:`, err instanceof Error ? err.message : String(err));
    }
    return loadSeason(projectId);
  }
  return season;
}

/** Entry point used by the routes that create a job: records the episode count and performs the first advance. */
export async function runSeasonScriptJob(jobId: string, projectId: string, episodeCount = SEASON_DEFAULT_EPISODES, storyBatch?: SeasonJobState["storyBatch"]): Promise<void> {
  const job = await prisma.generationJob.findUnique({ where: { id: jobId } });
  if (!job) return;
  await advanceSeasonJob(job, defaultDeps, { episodeCount, storyBatch });
}
