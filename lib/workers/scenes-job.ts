/**
 * Background worker for Stage 4 "Scenes" — the DRAMATIC blueprint of one episode.
 *
 * Stage 167 integration (commit 2/3): this worker no longer writes a fixed 9-shot CAMERA breakdown
 * (the old Stage 92/115 SYSTEM asked the model for exactly 9 "scenes" where each scene was a camera
 * shot with a 9-line videoPrompt). An episode is now 5–8 CONTENT-DRIVEN dramatic SCENES, each a UNIT
 * OF DRAMA (a place + an event + an escalation), NOT a camera angle. For every scene this worker emits
 * the dramaturgical fields the SHOT PLANNER reads — action, dialogue, keyProp, escalationBeats — and
 * NO camera directives at all. The CAMERA lives one level below, in the shot planner
 * (lib/prompts/shot-plan.ts + lib/workers/shot-plan-persist.ts), which breaks each scene into 15–30
 * shots at the approval transition. Scene.videoPrompt is therefore left null here.
 *
 * The scene-drama prompt reuses the Stage 166 numeric constants (lib/season.ts) and rule strings
 * (lib/prompts/episode-script.ts) as the single source of truth for scene count, durations, the
 * escalation ladder, the scene-1 hook, the single emotional peak and the last-scene cliffhanger.
 *
 * gpt-6-astra (SCRIPT_MODEL) completions of the whole episode take several minutes and a SYNCHRONOUS
 * call would die at ~300 s (Node undici headers timeout — see lib/ai.ts), so this step runs as a
 * resumable GenerationJob (type "scenes"): the route creates the job and returns its id; this worker
 * starts an OpenAI BACKGROUND response and polls it from short requests until it completes, then
 * normalizes + persists the scenes. The client polls GET /api/jobs/[id] and renders a 0→100 % bar.
 */
import { prisma } from "@/lib/db";
import {
  SCRIPT_MODEL,
  startBackgroundJSON,
  pollBackgroundJSON,
  cancelBackgroundResponse,
  chatJSON,
} from "@/lib/ai";
// Stage 167 — shot-plan persistence at the approval transition (see below).
import { persistShotPlanForApprovedEpisode } from "@/lib/workers/shot-plan-persist";
import {
  generateSeasonStateUpdate,
  seedSeasonState,
  normalizeSeasonState,
  SEASON_STATE_PROMPT_VERSION,
  type SeasonStateData,
  type SeedCastMember,
} from "@/lib/season-state";
import { normalizeDramaBible } from "@/lib/drama-bible";
import { updateJob, completeJob, failJob, heartbeatJob, markCanceled, isCancelRequested } from "@/lib/jobs";
import { anchorSceneLocation } from "@/lib/location-anchor";
import {
  EPISODE_MIN_SCENES,
  EPISODE_MAX_SCENES,
  EPISODE_MAX_TOTAL_SECONDS,
  EPISODE_MIN_TOTAL_SECONDS,
  EPISODE_TOTAL_LABEL,
  SCENE_MIN_SECONDS,
  SCENE_CLIP_MAX_SECONDS,
  SCENE_ESCALATION_MIN_BEATS,
  SCENE_ESCALATION_MAX_BEATS,
  ESCALATION_LADDER,
  clampSceneDuration,
  applyFixedSceneDurations,
  episodeFootageGivens,
  parseEpisodeFootage,
  parseEpisodeSynopsis,
} from "@/lib/season";
// Stage 166 rule strings reused verbatim so the scene-drama layer shares ONE source of truth with the
// episode-script contract (scene count / durations, the scene-1 hook, the single peak, the cliffhanger).
import {
  SCENE_COUNT_DURATION_RULE,
  SCENE_HOOK_RULE,
  EMOTIONAL_PEAK_RULE,
  LAST_SCENE_CLIFFHANGER_RULE,
} from "@/lib/prompts/episode-script";

/** GenerationJob.type value for the episode scene-breakdown job. */
export const SCENES_JOB_TYPE = "scenes";

/** Roughly how long the scene breakdown takes with gpt-6-astra — drives the smooth 0→100 % client bar. */
export const SCENES_EXPECTED_SEC = 240;

// Stage 167 integration (commit 2/3) — an episode is 5–8 CONTENT-DRIVEN dramatic SCENES, not a fixed
// number of camera shots. Each scene is a UNIT OF DRAMA (a place + an event + an escalation), NOT a camera
// angle: the CAMERA layer lives one level below, in the shot planner (lib/prompts/shot-plan.ts), which reads
// each scene's action / dialogue / keyProp / escalationBeats and breaks it into 15–30 shots. This worker
// emits ONLY those dramaturgical fields and NO camera directives (no shot types, no wide→medium→close-up,
// no establishing shot, no 9-line videoPrompt). Every label below is DERIVED from the Stage 166 constants
// in lib/season.ts — nothing is hardcoded.
const MIN_SCENES = EPISODE_MIN_SCENES;
const MAX_SCENES = EPISODE_MAX_SCENES;
/** The escalation-ladder rungs, in order, as a readable arrow string for the prompt. */
const ESCALATION_LADDER_TEXT = ESCALATION_LADDER.join(" → ");

const SYSTEM = `You are a showrunner + dramatist writing the DRAMATIC BLUEPRINT of ONE episode of a short-form vertical drama series (9:16). You do NOT direct the camera: you write the DRAMA — who is where, what happens between the characters, and how the tension escalates. A separate shot planner turns your scenes into camera shots later, so write NO camera directions of any kind (no shot types, no wide / medium / close-up, no camera angles or movements, no "establishing shot", no lighting directions, no video prompts).

A "scene" here is a UNIT OF DRAMA, NOT a camera shot: one continuous beat of the story in ONE place, built around an event that ESCALATES. Write ${MIN_SCENES}–${MAX_SCENES} scenes — as many as the story needs, never a fixed count. Dramatize ONLY this episode's description; do not borrow, foreshadow in detail or resolve events that belong to the other episodes.

Given the project synopsis, this episode's description, the previous episode's cliffhanger and the characters, return ONLY valid JSON in this exact shape:

{
  "scenes": [
    {
      "number": 1,
      "durationSec": 12,
      "location": "A SHORT LOCATION NAME ONLY (e.g. \\"Kitchen, night\\" or \\"Rooftop, dawn\\") — the NAME of the place, NOT a description of how it looks or how the light falls.",
      "action": "2–4 sentences of PROSE describing the DRAMA of this scene: what the characters DO, the event that happens between them, and how it turns. Concrete, filmable, present tense. Describe the EVENTS fully here. Contains NO camera language whatsoever — no shot sizes, angles, cuts or lighting directions — only what happens.",
      "keyProp": "ONE meaningful physical object that carries this scene's tension (a phone, a knife, a wedding ring, a letter) — a single prop the escalation can act on.",
      "escalationBeats": [
        "verbal: <the opening verbal jab / accusation>",
        "physicalLight: <a small physical move — a step closer, a light snapped on>",
        "symbolic: <a symbolic act on the keyProp — it is picked up, turned, revealed>",
        "physicalHeavy: <a heavy physical act — a grab, a strike, a door slammed>",
        "statusReveal: <a reveal that flips who holds power>"
      ],
      "dialogue": "a real back-and-forth EXCHANGE in ENGLISH, each line on its OWN row as SPEAKER (tone cue): \\"line\\" — the characters ANSWER each other:\\nYARA (low, guarded): \\"You shouldn't be here.\\"\\nDANE (a tired sigh): \\"Neither should you.\\""
    }
  ]
}

============ HOW TO WRITE EACH FIELD ============

- "action": the heart of the scene — full PROSE of the event and how it escalates. NO camera terms of any kind.
- "keyProp": exactly ONE physical object per scene that the drama turns on; the escalation acts on it.
- "escalationBeats": ${SCENE_ESCALATION_MIN_BEATS}–${SCENE_ESCALATION_MAX_BEATS} steps that climb ONE fixed ladder, in order, never sliding back down. Pick that many CONSECUTIVE rungs from this exact order and PREFIX each beat with its rung name: ${ESCALATION_LADDER_TEXT}. The "symbolic" rung is a symbolic act on THIS scene's keyProp.
- "dialogue": a genuine two-way exchange between the named characters, STRICTLY ENGLISH, one line per row in the format SPEAKER (tone cue): "line". Give every line a short delivery cue in parentheses (HOW it is said). Tone cues are performance notes only — never spoken aloud, never shown as subtitles. Real story beats, subtext-rich — never a weak throwaway line.
- "location": the NAME of the place only. Put what HAPPENS there in "action", not here.
- "number": 1-based, consecutive, in story order. "durationSec": an integer ${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS} — how long the scene's drama really takes.

ALL fields are written in ENGLISH — they feed the downstream shot planner and AI video model. Never mention real people, brands, logos or existing films / characters. No on-screen text, no subtitles, no music. Use the character names from the list below.

============ STORY & PACING RULES ============
- ${SCENE_COUNT_DURATION_RULE}
- ${SCENE_HOOK_RULE}
- ${EMOTIONAL_PEAK_RULE}
- ${LAST_SCENE_CLIFFHANGER_RULE}`;

export interface ScenesJobResult {
  scenes: any[];
}

/**
 * Stage 128 — the episode brief inside the user message. New format: the description is ONE detailed continuous
 * synopsis; the scenes expand it in order and the LAST FRAME of the final scene = the cliffhanger image. Legacy
 * episodes still saved as episode footage (BEAT 1 / BEAT 2 / CLIFFHANGER) keep the old HARD BEATS brief.
 */
export function episodeBriefBlock(episode: { number: number; title: string; description: string | null; cliffhanger: string | null }): string {
  const head = `Episode ${episode.number}: "${episode.title}"`;
  const beats = episodeFootageGivens(episode.description);
  if (beats) {
    const f = parseEpisodeFootage(episode.description)!;
    return `${head}${beats}\nThis episode's ending cliffhanger (the LAST FRAME of the final scene IS this image): ${f.cliffhanger}${episode.cliffhanger && episode.cliffhanger.trim() !== f.cliffhanger ? ` (${episode.cliffhanger})` : ""}`;
  }
  // New format (or plain prose): use the continuous synopsis as the brief; the cliffhanger is the last-frame target.
  const { synopsis, cliffhanger } = parseEpisodeSynopsis(episode.description);
  const cliff = (episode.cliffhanger?.trim() || cliffhanger || "").trim();
  return `${head}\nDescription (a continuous synopsis — break it into the scenes in order, do NOT invent events beyond it): ${synopsis || episode.description || ""}\nThis episode's ending cliffhanger (the LAST FRAME of the final scene builds toward this image): ${cliff || "N/A"}`;
}

/**
 * Build the exact user message the synchronous route used to send (unchanged content).
 */
async function buildUserMessage(projectId: string | undefined, episodeId: string): Promise<{ userMsg: string } | { error: string }> {
  const episode = await prisma.episode.findUnique({
    where: { id: episodeId },
    include: { season: { include: { project: true } } },
  });
  if (!episode) return { error: "Episode not found" };

  const pid = projectId || episode.season?.projectId;
  const synopsis = episode.season?.project?.synopsis ?? "";

  const seasonEpisodes = episode.seasonId
    ? await prisma.episode.findMany({
        where: { seasonId: episode.seasonId },
        orderBy: { number: "asc" },
        select: { number: true, title: true, description: true, cliffhanger: true },
      })
    : [];

  const episodeListText = seasonEpisodes
    .map(
      (e) =>
        `  Episode ${e.number}: "${e.title}" — ${e.description ?? "(no description)"}${
          e.number === episode.number ? "   <<< THIS EPISODE — dramatize ONLY this" : ""
        }`
    )
    .join("\n");

  const prevEpisode = seasonEpisodes
    .filter((e) => e.number < episode.number)
    .sort((a, b) => b.number - a.number)[0];
  const prevContext = prevEpisode
    ? `Previous Episode ${prevEpisode.number} ("${prevEpisode.title}") ended on this cliffhanger — continue naturally from it:\n"${prevEpisode.cliffhanger ?? prevEpisode.description ?? "N/A"}"`
    : "This is the FIRST episode — open the story from the beginning.";

  const characters = await prisma.character.findMany({
    where: { projectId: pid },
    select: { name: true, role: true, description: true, appearance: true, personality: true, age: true, firstAppearance: true },
  });

  const charSummary = characters
    .map((c) => {
      const extra = [
        c.age ? `Age: ${c.age}` : "",
        c.personality ? `Personality: ${c.personality}` : "",
        c.firstAppearance && c.firstAppearance !== c.description ? `First appears: ${c.firstAppearance}` : "",
      ].filter(Boolean);
      return `- ${c.name} (${c.role}): ${c.description ?? ""}. Appearance: ${c.appearance}${extra.length ? ". " + extra.join(". ") : ""}`;
    })
    .join("\n");

  const projectLanguage = episode.season?.project?.language;
  // The scene-drama fields feed the downstream shot planner and the AI video model, so they are ALWAYS
  // English regardless of the project language (the project language is context only).
  const languageHint = projectLanguage
    ? `\nProject language: "${projectLanguage}" (context only) — but write ALL scene fields, including "dialogue" and "action", in ENGLISH.`
    : `\nWrite ALL scene fields, including "dialogue" and "action", in ENGLISH.`;

  const userMsg = `Project synopsis: ${synopsis}${languageHint}

Characters:
${charSummary || "No characters defined yet."}

Full episode list for this season (for scope only — each episode is told in its OWN episode, do NOT borrow their events):
${episodeListText || "  (single episode)"}

${prevContext}

>>> GENERATE SCENES ONLY FOR THIS EPISODE <<<
${episodeBriefBlock(episode)}

Write this episode as ${MIN_SCENES}–${MAX_SCENES} dramatic scenes (as many as the story needs, never a fixed count). For EACH scene fill: "action" (the PROSE drama of the event and how it escalates — NO camera terms), "keyProp" (one meaningful physical object the tension turns on), "escalationBeats" (${SCENE_ESCALATION_MIN_BEATS}–${SCENE_ESCALATION_MAX_BEATS} CONSECUTIVE rungs of the ladder ${ESCALATION_LADDER_TEXT}, each beat PREFIXED with its rung name, the "symbolic" rung acting on the keyProp), a real two-way ENGLISH "dialogue" exchange (SPEAKER (tone): "line" rows, the characters answering each other — never a weak throwaway line), a "location" NAME only, and an integer "durationSec" (${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS} s; the whole-episode total lands in ${EPISODE_MIN_TOTAL_SECONDS}–${EPISODE_MAX_TOTAL_SECONDS} s). Scene 1 opens on a HOOK — a conflict / threat / burning question in the first ~3 s (NO exposition, NO character merely arriving); the FINAL scene ends on this episode's cliffhanger as a concrete unresolved image. Dramatize ONLY this episode's description, opening by continuing naturally from the previous episode's cliffhanger. Write NO camera directions anywhere — the camera is planned later, one level below.`;

  return { userMsg };
}

/** Normalize the model's escalationBeats into a clean string array (trimmed, non-empty, capped at the
 *  ladder ceiling). Accepts an array of strings/objects; anything unusable becomes an empty array — the
 *  shot planner then derives a ladder itself, but a well-formed scene always carries real beats. */
function normalizeEscalationBeats(raw: unknown): string[] {
  const arr = Array.isArray(raw) ? raw : [];
  const beats = arr
    .map((b) => (typeof b === "string" ? b : b == null ? "" : String(b)))
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  // Keep the model's ordered rungs, but never store more than the ladder allows.
  return beats.slice(0, SCENE_ESCALATION_MAX_BEATS);
}

/**
 * Persist the model output into dramatic SCENE rows (Stage 167 integration, commit 2/3). Each scene now
 * carries the dramaturgical fields the shot planner reads — action, dialogue, keyProp, escalationBeats —
 * plus a location NAME and a content-driven durationSec. NO camera directives are stored: Scene.videoPrompt
 * is left null (the shot planner builds camera prompts from the Shot rows at the approval transition).
 * The scene count is CONTENT-DRIVEN (5–8): fewer than MAX_SCENES is allowed; extras are trimmed.
 */
async function persistScenes(episodeId: string, data: { scenes?: any[] }): Promise<ScenesJobResult> {
  const episode = await prisma.episode.findUnique({ where: { id: episodeId } });
  if (!episode) throw new Error("Episode not found");

  const rawScenes = Array.isArray(data?.scenes) ? data.scenes : [];
  if (rawScenes.length === 0) throw new Error("Model returned no scenes");

  // Content-driven count: keep as many scenes as the model wrote, capped at the Stage 166 ceiling.
  const trimmed = rawScenes.slice(0, MAX_SCENES);
  // Variable-length clips: take each scene's OWN durationSec, clamp into [SCENE_MIN_SECONDS,
  // SCENE_CLIP_MAX_SECONDS], and trim the longest clips only if the whole episode exceeds the ceiling.
  const durationHolders = trimmed.map((s) => ({ durationSec: clampSceneDuration(Number(s?.durationSec)) }));
  applyFixedSceneDurations(durationHolders);
  const durations = durationHolders.map((h) => h.durationSec ?? SCENE_MIN_SECONDS);
  const scenesOut = trimmed.map((s, i) => {
    // Accept "location" (new NAME-only field) with a legacy "locationDesc" fallback.
    const location = String(s?.location ?? s?.locationDesc ?? "").trim();
    return {
      number: i + 1,
      durationSec: durations[i],
      action: String(s?.action ?? "").trim(),
      dialogue: String(s?.dialogue ?? "").trim(),
      keyProp: String(s?.keyProp ?? "").trim(),
      escalationBeats: normalizeEscalationBeats(s?.escalationBeats),
      location,
    };
  });

  const missingDrama = scenesOut.filter((s) => !s.action || !s.dialogue || !s.keyProp || s.escalationBeats.length < SCENE_ESCALATION_MIN_BEATS).length;
  console.log(
    `[scenes] ${episodeId}: ${scenesOut.length} dramatic scenes (target ${MIN_SCENES}–${MAX_SCENES}), ` +
      `incomplete-drama=${missingDrama}, ` +
      `beats=[${scenesOut.map((s) => s.escalationBeats.length).join(",")}], ` +
      `props=[${scenesOut.map((s) => s.keyProp.slice(0, 18)).join(" | ")}]`
  );

  // Stage 105 — a rewritten script replaces ALL scenes of the episode (their videos, keyframes and last
  // frames go with the rows; S3 objects are left alone) and the stitched episode video becomes stale →
  // Episode.videoUrl = null. One transaction so a failure never leaves a half-replaced episode.
  const created = await prisma.$transaction(async (tx) => {
    await tx.scene.deleteMany({ where: { episodeId } });
    await tx.episode.update({ where: { id: episodeId }, data: { videoUrl: null } });
    const rows = [];
    for (const s of scenesOut) {
      const scene = await tx.scene.create({
        data: {
          episodeId,
          number: s.number,
          durationSec: s.durationSec,
          action: s.action,
          dialogue: s.dialogue,
          keyProp: s.keyProp,
          escalationBeats: s.escalationBeats,
          // Stage 20 (A2): lock scenes to the episode's single canonical location so the place never drifts.
          locationDesc: anchorSceneLocation(s.location, episode.locationDesc, undefined),
          // Stage 167 integration — the camera lives in the shot planner; the scene stores no videoPrompt.
          videoPrompt: null,
          status: "pending",
        },
      });
      rows.push(scene);
    }
    return rows;
  }, { timeout: 30_000 });

  return { scenes: created };
}

/**
 * Run the episode scene-breakdown in the background of the calling serverless invocation.
 * Starts a gpt-6-astra BACKGROUND response and polls it with heartbeats until it completes,
 * then normalizes + persists the dramatic scenes and completes the job with { scenes }.
 */
export async function runScenesJob(jobId: string, projectId: string | undefined, episodeId: string): Promise<void> {
  try {
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { status: "processing", progress: 8, message: "Writing the episode's dramatic scenes…" });

    const built = await buildUserMessage(projectId, episodeId);
    if ("error" in built) { await failJob(jobId, built.error); return; }

    // Start the gpt-6-astra background response. reasoningEffort "low": writing the dramatic scenes is
    // largely a craft task, and reasoning tokens count toward the output budget — keeping the effort low
    // leaves ample room for the full scene JSON (action + dialogue + escalation ladders) without truncation.
    let responseId: string;
    try {
      responseId = await startBackgroundJSON(SYSTEM, built.userMsg, {
        model: SCRIPT_MODEL,
        maxTokens: 28000,
        reasoningEffort: "low",
      });
    } catch (err: any) {
      console.error("[scenes] failed to start background response:", err);
      await failJob(jobId, "Failed to start scene generation: " + (err?.message ?? "Unknown error"));
      return;
    }

    // Poll from short requests (each avoids the ~300 s synchronous undici timeout).
    let data: { scenes?: any[] } | null = null;
    while (!data) {
      if (await isCancelRequested(jobId)) {
        await cancelBackgroundResponse(responseId);
        await markCanceled(jobId);
        return;
      }
      await new Promise((r) => setTimeout(r, 5000));
      await heartbeatJob(jobId);
      const res = await pollBackgroundJSON<{ scenes?: any[] }>(responseId);
      if (res.status === "running") continue;
      if (res.status === "failed") { await failJob(jobId, "Scene generation failed: " + res.error); return; }
      data = res.json;
    }

    await updateJob(jobId, { progress: 85, message: "Saving scenes…" });
    let result: ScenesJobResult;
    try {
      result = await persistScenes(episodeId, data);
    } catch (err: any) {
      console.error("[scenes] persist failed:", err);
      await failJob(jobId, "Scene generation failed: " + (err?.message ?? "Unknown error"));
      return;
    }

    // Stage 4 (task Stage 4) — moving an episode into the scene breakdown is the practical APPROVAL of its
    // script. Refresh the season's live WORLD-STATE from the approved script (separate gpt-6-astra call,
    // generate→validate→targeted-retry) so the NEXT episode is written from the updated state. Fully
    // non-blocking + defensive: any failure is swallowed so it can never break scene generation.
    try {
      await updateSeasonStateForApprovedEpisode(episodeId);
    } catch (err: any) {
      console.error("[scenes] season-state update skipped:", err?.message ?? err);
    }

    // Stage 167 — at the SAME approval transition, plan and persist this episode's SHOT rows (the atomic
    // units of generation, one level below the scene) so the per-shot chain (video-job → assembly-job)
    // has something to iterate. Idempotent (re-approving rebuilds the shot list). There is NO silent
    // legacy scene fallback: on failure `persistShotPlanForApprovedEpisode` marks the episode
    // `status = "shot_plan_failed"` with a UI-visible note, and the generate-all route refuses to start
    // video generation until a valid plan exists. This call stays non-blocking for the scenes job itself
    // (scene text is already saved); the loud failure lives on the episode record.
    try {
      const shotPlan = await persistShotPlanForApprovedEpisode(episodeId);
      console.log(`[scenes] shot plan for episode ${episodeId}:`, shotPlan);
      if (!shotPlan.ok) {
        console.error(`[scenes] shot plan FAILED for episode ${episodeId} — episode marked shot_plan_failed, video generation blocked`);
      }
    } catch (err: any) {
      console.error("[scenes] shot-plan persist threw unexpectedly:", err?.message ?? err);
    }

    // Keep episodeId in resultData so the idempotency / resume lookups (which match on episodeId)
    // still find this job after it completes.
    await completeJob(jobId, { ...result, episodeId }, "Scenes ready");
  } catch (err: any) {
    console.error("[scenes] job error:", err);
    await failJob(jobId, "Generation failed: " + (err?.message ?? "Unknown error"));
  }
}

/**
 * Stage 4 (task Stage 4) — refresh the season's live WORLD-STATE after an episode's script is approved
 * (moved into the scene breakdown). Loads the season's newest SeasonState (or seeds an initial one from the
 * project cast + drama bible when none exists), asks gpt-6-astra to fold the approved script into it (with the
 * contradiction validator + targeted retry), and appends the updated state as a new SeasonState row
 * (append-only; the newest row wins in the next-episode prompt). NEVER throws to the caller — the caller
 * already wraps it, and every failure mode degrades to "keep the previous state".
 */
export async function updateSeasonStateForApprovedEpisode(episodeId: string): Promise<void> {
  const episode = await prisma.episode.findUnique({
    where: { id: episodeId },
    include: {
      season: { include: { project: { include: { characters: { orderBy: { createdAt: "asc" } } } } } },
    },
  });
  if (!episode || !episode.season) return;
  const season = episode.season;
  const scriptText = (episode.script ?? "").trim();
  if (!scriptText) return; // nothing to fold in — keep the previous state

  // Current state: the newest persisted SeasonState row, else a freshly seeded initial state.
  const existing = await prisma.seasonState.findFirst({ where: { seasonId: season.id }, orderBy: { updatedAt: "desc" } });
  let currentState: SeasonStateData;
  if (existing?.state) {
    currentState = normalizeSeasonState(existing.state);
  } else {
    const cast: SeedCastMember[] = (season.project?.characters ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      appearance: c.appearance ?? null,
    }));
    const bible = season.project?.dramaBible ? normalizeDramaBible(season.project.dramaBible) : null;
    currentState = seedSeasonState(cast, bible);
  }

  // Fold the approved script into the state on gpt-6-astra (SCRIPT_MODEL). chatJSON returns parsed JSON.
  const result = await generateSeasonStateUpdate(
    {
      currentState,
      episodeScript: scriptText,
      seasonTitle: season.title ?? null,
      episodeNumber: episode.number,
      episodeTitle: episode.title ?? null,
    },
    (system, user, opts) => chatJSON<unknown>(system, user, { model: opts?.model ?? SCRIPT_MODEL, maxTokens: 8000 }),
    { model: SCRIPT_MODEL },
  );

  // Persist regardless of valid flag: an invalid-but-normalized state is still better continuity than the old
  // text tail, and the version records which prompt family produced it. Append-only (newest row wins).
  await prisma.seasonState.create({
    data: {
      seasonId: season.id,
      reflectsEpisodeNumber: episode.number,
      state: result.state as unknown as object,
      version: result.version ?? SEASON_STATE_PROMPT_VERSION,
    },
  });
}
