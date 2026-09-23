/**
 * Stage 127 — STORYBOARD-mode background workers.
 *
 * Four jobs, all guarded by Episode.mode === "STORYBOARD" (they never touch a SCENES episode):
 *   1. storyboard_boards   — split the episode story into 12–15 Board rows (LLM, pure split logic reused).
 *   2. board_image         — render one board's 9:16 keyframe still (Seedream) → Board.imageUrl (clip start frame).
 *   3. board_video         — animate one board via IMAGE-TO-VIDEO (Seedance i2v, start frame = the board still)
 *                            → Board.videoUrl. The Stage 104 keyframe/i2v ban is LIFTED here (STORYBOARD only).
 *   4. storyboard_assemble — stitch every board clip into one ~90s cut (assembleStoryboardVideo).
 *
 * SCENES is untouched: video-job.ts still uses text-to-video with the keyframe ban intact.
 */
import { prisma } from "@/lib/db";
import { chatJSON } from "@/lib/ai";
import { generateImage, GenerationCanceledError } from "@/lib/providers/image-provider";
import { startImageToVideoGeneration, getVideoGenerationState, cancelVideoGeneration } from "@/lib/providers/video-provider";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { updateJob, completeJob, failJob, isCancelRequested, markCanceled } from "@/lib/jobs";
import { assembleStoryboardVideo } from "@/lib/assemble";
import { VISUAL_STYLE_ID, REFERENCE_ASPECT_RATIO } from "@/lib/visual-style";
import { DEFAULT_ASSEMBLE_FPS, DEFAULT_ASSEMBLE_QUALITY } from "@/lib/assemble-options";
import {
  dialogueRepairSystemPrompt,
  dialogueRepairUserPrompt,
} from "@/lib/storyboard";
import { buildBoardFramePrompt, type BoardCharacterLink } from "@/lib/storyboard-prompt";
import { deriveSetAnchors } from "@/lib/set-anchors";
import { readBoardDirection } from "@/lib/storyboard-direction";
import { resolveVisibleCast, type BoardCoverage, type ShotSize } from "@/lib/board-coverage";
import { pickBoardGeometryAuthority } from "@/lib/board-plate";
import { boardSceneKey, pickSceneAnchor, renderingLowerSiblings, composeBoardImageInput, boardFramePrecondition } from "@/lib/board-anchor";
import { WAVESPEED_IMAGE_MAX_REFS } from "@/lib/providers/image-provider";
import {
  extractSpokenLinesResilient,
  estimatedSpeechSeconds,
  chunkLinesByBudget,
  type DialogueRepairFn,
  type SpokenLine,
} from "@/lib/storyboard-dialogue";
import {
  scenePlanSystemPrompt,
  scenePlanUserPrompt,
  normalizeScenePlan,
  type ScenePlanInput,
} from "@/lib/storyboard-scenes";
import { buildStoryboardVideoRequest, storyboardCameraMode } from "@/lib/storyboard-animation";
import { detectSpokenLanguage, translateDialogue } from "@/lib/voiceover";

export const STORYBOARD_BOARDS_JOB_TYPE = "storyboard_boards";
export const BOARD_IMAGE_JOB_TYPE = "board_image";
export const BOARD_VIDEO_JOB_TYPE = "board_video";
export const STORYBOARD_ASSEMBLE_JOB_TYPE = "storyboard_assemble";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const validUrl = (u?: string | null) => typeof u === "string" && u.startsWith("http") && u.length > 10;

/**
 * Deterministic 31-bit seed derived from a board id (FNV-1a). Re-rendering the SAME board reuses the SAME seed,
 * so with an unchanged prompt/refs the frame stays stable (best-effort — Seedream may honor `seed` loosely).
 */
function boardFrameSeed(boardId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < boardId.length; i++) {
    h ^= boardId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 2_147_483_647; // keep inside a positive signed 32-bit int
}

/** A single reference image passed to the model, with a Russian, user-facing role label for the UI. */
type BoardRefEntry = { index: number; url: string; kind: string; label: string };

/** Stage 142 — sequential render inside a scene: poll interval / max wait for a lower-index sibling still rendering. */
const ANCHOR_WAIT_POLL_MS = Number(process.env.BOARD_ANCHOR_WAIT_POLL_MS ?? 4000);
const ANCHOR_WAIT_MAX_POLLS = Number(process.env.BOARD_ANCHOR_WAIT_MAX_POLLS ?? 90); // ~6 min at 4s

/**
 * Stage 230 — HARD 5s cap per scene clip and the per-clip speech budget used to PRE-CALCULATE the scene count.
 * Each shot is a short 4–5s clip (image-to-video hard cap; speech is never accelerated or cut to fit — an
 * over-long scene is split into continuation shots instead). Dialogue is packed into chunks of at most
 * SCENE_SPEECH_BUDGET_SEC seconds of estimated speech, leaving ~1s of headroom under the cap for delivery/pauses
 * so a full chunk still fits a ≤5s clip. A ~90s episode therefore expands into roughly 18–22 short shots: the
 * shot count is DERIVED from the dialogue length + the 4–5s/shot cap, never a fixed number.
 */
const SCENE_CLIP_MAX_SEC = 5;
const SCENE_SPEECH_BUDGET_SEC = 4;

/** Minimal sibling projection shared by the Stage 140 set-anchors and the Stage 142 scene anchor. */
const SIBLING_SELECT = { id: true, index: true, imageUrl: true, status: true, directionJson: true, motionEn: true, actionOrDialogue: true, region: true, sceneId: true, boardRole: true } as const;

/**
 * Load the episode's cast (identity + sex source of truth) for a board frame prompt.
 * Stage 143 — `refs` is ALIGNED with `links` (null when a character has no usable reference image) so the
 * board_image job can keep only the references of the characters that are actually IN FRAME.
 */
export async function loadEpisodeCharacters(episodeId: string): Promise<{ links: BoardCharacterLink[]; refs: (string | null)[] }> {
  const rows = await prisma.episodeCharacter.findMany({
    where: { episodeId },
    include: { character: true },
    orderBy: { createdAt: "asc" },
  });
  const links: BoardCharacterLink[] = [];
  const refs: (string | null)[] = [];
  for (const { character: c } of rows) {
    links.push({
      name: c.name,
      appearance: c.appearance,
      age: c.age,
      gender: c.gender, // Stage 125 gender-lock source of truth
      role: c.role,
      tier: c.tier,
    });
    const ref = c.imageFull || c.imageFront;
    refs.push(validUrl(ref) ? (ref as string) : null);
  }
  return { links, refs };
}

/** Stage 220 — the per-scene shot plan persisted on BOTH boards of a scene (Board.castInFrame JSON). */
export type CastInFrame = {
  onScreen: string[];
  entering: string[];
  exiting: string[];
  startFrame: string;
  endFrame: string;
  motion: string;
  durationSec: number;
  dialogue: SpokenLine[];
  // Localization — a natural Russian translation of `startFrame`, produced once here (see the batched
  // translateStartFramesRu call) and stored inside this JSON. NO DB column. UI display text ONLY; the
  // English `startFrame`/`actionOrDialogue` is left untouched so generation prompts stay English.
  // Optional: absent when the (best-effort) translation is skipped or fails.
  startFrameRu?: string;
};

/** Build a deterministic BoardCoverage from an explicit in-frame name list (cast order), for the frame prompt. */
export function coverageFromNames(inFrame: string[], fullCast: string[]): BoardCoverage {
  const visible = fullCast.filter((c) => inFrame.includes(c));
  const vis = visible.length ? visible : fullCast;
  const shotSize: ShotSize = vis.length <= 1 ? "MEDIUM" : vis.length === 2 ? "TWO-SHOT" : "WIDE ESTABLISHING";
  return { shotSize, visible: vis, offScreen: fullCast.filter((c) => !vis.includes(c)), focus: "" };
}

/**
 * Localization — batch-translate every board's English `startFrame` sentence into natural Russian for UI
 * DISPLAY only (this is NOT a generation prompt, so translating it is allowed). Returns an array aligned 1:1
 * with `texts`, or null when the result is unavailable/untrustworthy (LLM error, wrong count, or a blank
 * entry) so the caller can safely skip `startFrameRu` and let the UI fall back to the English text. One
 * batched call for the whole episode. Never throws.
 */
async function translateStartFramesRu(texts: string[]): Promise<string[] | null> {
  if (texts.length === 0) return [];
  try {
    const res = await chatJSON<{ translations?: unknown }>(
      "You are a professional Russian localizer for a filmmaking app. Translate each English cinematic frame " +
        "description into natural, fluent Russian. Preserve the meaning and tone; do NOT add, merge, or drop " +
        "entries. Keep proper names as they are. Return STRICT JSON of the shape " +
        '{"translations": string[]} with EXACTLY one Russian string per input, in the same order.',
      JSON.stringify({ frames: texts }),
      { maxTokens: 4000, temperature: 0 },
    );
    const arr = (res as { translations?: unknown } | null)?.translations;
    if (!Array.isArray(arr) || arr.length !== texts.length) return null;
    const out = arr.map((v) => (typeof v === "string" ? v.trim() : ""));
    if (out.some((s) => !s)) return null;
    return out;
  } catch {
    return null;
  }
}

/* ───────────── 1) storyboard_boards — per planned Scene → EXACTLY 1 board (single keyframe) ─────────────
 * Single-frame model: every planned scene yields ONE board — a single 9:16 keyframe still that is animated on
 * its OWN into a 4–6s image-to-video clip (one frame = one shot plan; NO start→end two-frame morph). A single
 * LLM call plans, for every scene, who is on screen / enters / exits plus the keyframe (startFrame) and motion
 * descriptions; the dialogue itself is restored verbatim from the scene (never rewritten) and voiced in the clip.
 */
export async function runStoryboardBoardsJob(jobId: string, projectId: string, episodeId: string): Promise<void> {
  try {
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    const episode = await prisma.episode.findUnique({ where: { id: episodeId } });
    if (!episode) { await failJob(jobId, "Episode not found"); return; }
    if (episode.mode !== "STORYBOARD") { await failJob(jobId, "Episode is not in STORYBOARD mode"); return; }

    await updateJob(jobId, { status: "processing", progress: 10, message: "Building the storyboard..." });

    const { links } = await loadEpisodeCharacters(episodeId);
    const characters = links.map((l) => l.name);
    const location = episode.locationName ?? null;

    const rawScenes = await prisma.scene.findMany({
      where: { episodeId }, orderBy: { number: "asc" },
      select: {
        id: true, number: true, action: true, dialogue: true, dialogueEn: true,
        startState: true, endState: true, presence: true, entrances: true,
        sceneKind: true, voiceover: true, durationSec: true,
      },
    });
    if (rawScenes.length === 0) { await failJob(jobId, "The episode has no scenes yet"); return; }

    // Stage 141/220 — all Storyboard dialogue is voiced in ENGLISH. Prefer an already-English translated line
    // (dialogueEn); otherwise translate the source dialogue. The English text is what the planner sees (context
    // only) and what is restored VERBATIM (attributed, never paraphrased) into the per-scene i2v clip.
    const scenesEn = await Promise.all(
      rawScenes.map(async (s) => {
        let english = (s.dialogueEn ?? "").trim();
        if (!english || detectSpokenLanguage(english) !== "English") {
          const src = (s.dialogue ?? "").trim();
          english =
            src && detectSpokenLanguage(src) !== "English"
              ? await translateDialogue(src, "English")
              : src || english;
        }
        return { ...s, dialogueEnResolved: english };
      }),
    );

    // Attribution honours gender-lock (a pronoun reporter resolves to the sole cast member of that sex).
    const attributionCast = links.map((l) => ({ name: l.name, gender: l.gender ?? null }));
    // Stage 135 — RESOLVING attribution: when the deterministic parser cannot attribute a quoted line, make
    // ONE LLM repair round that forces an explicit canonical speaker (+delivery/addressee) so lines resolve
    // instead of hard-blocking. The spoken TEXT/order is never changed — only the speaker is filled in.
    const dialogueRepair: DialogueRepairFn = async ({ cast, lines }) => {
      const res = await chatJSON<{ assignments?: Array<{ id: number; speaker: string; delivery?: string; addressee?: string }> }>(
        dialogueRepairSystemPrompt(),
        dialogueRepairUserPrompt(cast, lines),
        { maxTokens: 2000, temperature: 0 },
      );
      return res?.assignments ?? [];
    };

    // Stage 230 — PRE-CALCULATE the scene count from dialogue length. Extract every scene's verbatim, attributed
    // spoken lines FIRST, then pack them into chunks that each fit one ≤5s clip's speech budget. A scene whose
    // dialogue overflows one clip becomes a first scene + sequential CONTINUATION scene(s) (same location, same
    // characters, action carried forward). Nothing is ever accelerated, truncated or dropped — the story simply
    // gets more scenes. A narration / no-dialogue scene yields exactly one part (one clip, no spoken lines).
    await updateJob(jobId, { progress: 30, message: "Splitting dialogue into scene clips..." });
    type PlannedScene = {
      source: (typeof scenesEn)[number];
      sceneId: string;
      dialogue: SpokenLine[];
      partIndex: number;
      partCount: number;
    };
    const planned: PlannedScene[] = [];
    for (const s of scenesEn) {
      const isNarration = (s.sceneKind ?? "").trim().toLowerCase() === "narration";
      const lines: SpokenLine[] = isNarration || !s.dialogueEnResolved.trim()
        ? []
        : await extractSpokenLinesResilient(s.dialogueEnResolved, attributionCast, { repair: dialogueRepair });
      const chunks = chunkLinesByBudget(lines, SCENE_SPEECH_BUDGET_SEC);
      const partCount = chunks.length;
      chunks.forEach((chunk, partIndex) => {
        planned.push({
          source: s,
          // Part 0 keeps the source scene id; continuation parts get a synthetic, unique per-scene id so they
          // are distinct boards/scenes (Board.sceneId is a plain string, never an FK, so this is safe).
          sceneId: partIndex === 0 ? s.id : `${s.id}#p${partIndex + 1}`,
          dialogue: chunk,
          partIndex,
          partCount,
        });
      });
    }
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }

    // ONE planner call over the PLANNED scenes (parts included): per scene → onScreen / entering / exiting +
    // start/end/motion (English). Continuation parts are flagged so the planner keeps their location/cast/action.
    await updateJob(jobId, { progress: 40, message: "Planning start & end frames for each scene..." });
    const planInputs: ScenePlanInput[] = planned.map((p, seq) => ({
      number: seq + 1, // unique sequential id for the planner (a source scene may split into several parts)
      action: p.source.action,
      // Context only: a split scene passes just THIS part's lines so its frames reflect that part; a single-part
      // scene passes the whole (English) dialogue text unchanged.
      dialogue: p.partCount > 1
        ? (p.dialogue.map((l) => `${l.speaker}: ${l.text}`).join("\n") || null)
        : (p.source.dialogueEnResolved || null),
      startState: p.source.startState,
      endState: p.source.endState,
      presence: p.source.presence,
      entrances: p.source.entrances,
      sceneKind: p.source.sceneKind,
      voiceover: p.source.voiceover,
      continues: p.partCount > 1,
      partIndex: p.partIndex,
      partCount: p.partCount,
    }));
    const rawPlan = await chatJSON<{ scenes?: unknown[] }>(
      scenePlanSystemPrompt(),
      scenePlanUserPrompt(planInputs, { characters, location }),
      { maxTokens: 8000, temperature: 0.4 },
    );
    const plans = normalizeScenePlan(rawPlan as any, planInputs, characters);
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }

    await updateJob(jobId, { progress: 70, message: "Restoring dialogue & building boards..." });
    // Build the two board rows per PLANNED scene. Dialogue is the pre-computed verbatim chunk for that part.
    type BoardRow = {
      episodeId: string; sceneId: string; index: number; boardRole: string;
      actionOrDialogue: string; motionEn: string | null; durationSec: number;
      castInFrame: object; imagePrompt: string; status: string;
    };
    const rows: BoardRow[] = [];
    for (let i = 0; i < planned.length; i++) {
      const p = planned[i];
      const plan = plans[i];
      const dialogue = p.dialogue;
      // Duration = enough to fit THIS part's speech (never truncated/accelerated), floored at 4s and clamped to
      // the HARD 5s clip cap. The scripted scene length is NOT used as a floor — a shot is always a short 4–5s
      // clip regardless of how long the source scene was written; longer dialogue splits into more shots instead.
      const speechSec = dialogue.reduce((sum, l) => sum + estimatedSpeechSeconds(l), 0);
      const durationSec = Math.min(SCENE_CLIP_MAX_SEC, Math.max(Math.ceil(speechSec) + 1, 4));

      // Single-frame model: each planned scene yields ONE board — a keyframe still that is animated on its OWN
      // into a 4–5s clip (no start→end morph). WHO is in frame is everyone present at the scene start
      // (onScreen ∪ exiting, minus those still entering).
      const startVisible = characters.filter(
        (c) => (plan.onScreen.includes(c) || plan.exiting.includes(c)) && !plan.entering.includes(c),
      );
      const startCoverage = coverageFromNames(startVisible.length ? startVisible : plan.onScreen, characters);

      const castInFrame: CastInFrame = {
        onScreen: plan.onScreen,
        entering: plan.entering,
        exiting: plan.exiting,
        startFrame: plan.startFrame,
        endFrame: plan.endFrame,
        motion: plan.motion,
        durationSec,
        // Strip undefined so the JSON column is clean; keep addressee explicit (null when unknown).
        dialogue: dialogue.map((l) => ({
          speaker: l.speaker, text: l.text, delivery: l.delivery,
          addressee: l.addressee ?? undefined, scene: l.scene,
        })),
      };
      const castJson = JSON.parse(JSON.stringify(castInFrame));

      // A PLANNED English frame prompt for each still (overwritten with the fully composed prompt at render time).
      const framePrompt = (index: number, text: string, coverage: BoardCoverage) =>
        buildBoardFramePrompt({
          board: { index, actionOrDialogue: text, motion: null, directionJson: null },
          characters: links.filter((l) => coverage.visible.includes(l.name)).length
            ? links.filter((l) => coverage.visible.includes(l.name))
            : links,
          coverage,
          locationName: episode.locationName,
          locationDesc: episode.locationDesc,
        }).prompt;

      rows.push({
        episodeId, sceneId: p.sceneId, index: i, boardRole: "start",
        actionOrDialogue: plan.startFrame, motionEn: plan.motion, durationSec,
        castInFrame: castJson, imagePrompt: framePrompt(i, plan.startFrame, startCoverage), status: "pending",
      });
    }
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }

    // Localization (best-effort) — translate all English startFrame sentences into Russian in ONE batched call
    // and store each translation inside its board's castInFrame JSON as `startFrameRu` (no DB column). This is
    // UI display text only; the English startFrame/actionOrDialogue is left untouched for generation. On any
    // failure or count mismatch the field is simply left undefined and the UI falls back to the English text —
    // board creation is never blocked.
    try {
      const ru = await translateStartFramesRu(
        rows.map((r) => ((r.castInFrame as { startFrame?: string })?.startFrame ?? "")),
      );
      if (ru) {
        for (let i = 0; i < rows.length; i++) {
          const cif = rows[i].castInFrame as { startFrameRu?: string };
          if (cif && ru[i]) cif.startFrameRu = ru[i];
        }
      }
    } catch { /* leave startFrameRu undefined — the UI falls back to the English sentence */ }

    await updateJob(jobId, { progress: 90, message: "Saving boards..." });
    // Validate/build BEFORE replacing old boards; a dialogue conflict throws above and leaves them intact.
    // Replacement is atomic (delete + recreate) so the episode never has a half-old / half-new board set.
    await prisma.$transaction(async (tx) => {
      await tx.board.deleteMany({ where: { episodeId } });
      await tx.board.createMany({
        data: rows.map((r) => ({
          episodeId: r.episodeId, sceneId: r.sceneId, index: r.index, boardRole: r.boardRole,
          actionOrDialogue: r.actionOrDialogue, motionEn: r.motionEn, durationSec: r.durationSec,
          castInFrame: r.castInFrame as unknown as object, imagePrompt: r.imagePrompt, status: r.status,
        })),
      });
    });

    const totalSec = rows.reduce((sum, r) => sum + r.durationSec, 0);
    // Stage 230 — the scene count is now DERIVED from dialogue length (source scenes may split into continuation
    // scenes), so report the PLANNED scene count and how many source scenes it expanded from.
    await completeJob(
      jobId,
      { episodeId, boardCount: rows.length, sceneCount: planned.length, sourceSceneCount: scenesEn.length, totalSec },
      `Storyboard ready — ${planned.length} scenes (${rows.length} boards)`,
    );
  } catch (err: any) {
    console.error("[storyboard-boards] failed:", err);
    await failJob(jobId, err?.message ?? "Storyboard generation failed");
  }
}

/* ───────────── 2) board_image — render one board's 9:16 keyframe still ───────────── */
export async function runBoardImageJob(jobId: string, projectId: string, boardId: string): Promise<void> {
  const canceled = () => isCancelRequested(jobId);
  try {
    if (await canceled()) { await markCanceled(jobId); return; }
    const board = await prisma.board.findUnique({ where: { id: boardId }, include: { episode: true } });
    if (!board) { await failJob(jobId, "Board not found"); return; }
    if (board.episode.mode !== "STORYBOARD") { await failJob(jobId, "Episode is not in STORYBOARD mode"); return; }

    await updateJob(jobId, { status: "processing", progress: 15, message: `Board ${board.index + 1}: composing frame...` });
    await prisma.board.update({ where: { id: boardId }, data: { status: "frame_generating", error: null } });

    const { links, refs } = await loadEpisodeCharacters(board.episodeId);
    const cast = links.map((l) => l.name);
    // Single-frame board: WHO is in frame is DETERMINED by the scene shot plan (castInFrame) — everyone present
    // at the scene start (onScreen ∪ exiting, minus those still entering). Legacy boards (null castInFrame) keep
    // the Stage 143 direction-derived coverage. Only the visible characters' identity references are attached;
    // off-screen cast is only NAMED.
    const isPerScene = !!board.boardRole;
    const cif = (board.castInFrame ?? null) as unknown as CastInFrame | null;
    let coverage: BoardCoverage;
    if (cif && Array.isArray(cif.onScreen)) {
      const onScreen = cif.onScreen ?? [];
      const entering = cif.entering ?? [];
      const exiting = cif.exiting ?? [];
      const inFrame = cast.filter((c) => (onScreen.includes(c) || exiting.includes(c)) && !entering.includes(c));
      coverage = coverageFromNames(inFrame.length ? inFrame : onScreen, cast);
    } else {
      // Stage 143 — EXACTLY who is in frame for a legacy board (direction + position in scene + action text).
      const direction = readBoardDirection(board.directionJson);
      coverage = resolveVisibleCast(direction, board.index, cast, board.actionOrDialogue);
    }
    const visibleLinks = links.filter((l) => coverage.visible.includes(l.name));
    const refImages = links.flatMap((l, i) => (coverage.visible.includes(l.name) && refs[i] ? [refs[i] as string] : []));
    // Parallel to refImages: the character name behind each identity reference, for the UI "references passed" list.
    const refImageNames = links.flatMap((l, i) => (coverage.visible.includes(l.name) && refs[i] ? [l.name] : []));

    // Stage 131 — resolve the board's GEOMETRY AUTHORITY from the episode's bound Location. The whole episode
    // plays in ONE location; every board of the same zone shares the same plate (region plate when a cached one
    // exists for the board's zone, otherwise the location master plates), so the room stays identical across
    // consecutive boards. Reuses only already-generated plates — never triggers a new plate generation here.
    let authority = pickBoardGeometryAuthority(null, board.region);
    if (board.episode.locationId) {
      const location = await prisma.location.findUnique({
        where: { id: board.episode.locationId },
        select: { id: true, name: true, imageUrl: true, imageReverse: true, regionPlates: true },
      });
      authority = pickBoardGeometryAuthority(location, board.region);
    }

    // Stage 140 — derive the location's PERSISTENT SET PIECES (large furniture + its contents) from the
    // episode locationDesc plus EVERY board's action text, so the same set objects are pinned into every
    // board's prompt and cannot vanish between adjacent boards / on a reverse angle. Deterministic, no LLM.
    const loadSiblings = () => prisma.board.findMany({ where: { episodeId: board.episodeId }, select: SIBLING_SELECT });
    let siblingBoards = await loadSiblings();
    const boardActions = siblingBoards
      .map((b) => readBoardDirection(b.directionJson)?.actionEnglish || b.motionEn || b.actionOrDialogue || "")
      .filter((s) => s.trim().length > 0);
    const setAnchors = deriveSetAnchors(board.episode.locationDesc ?? "", boardActions);

    // Stage 142/220 — SCENE ANCHOR FRAME. A board's SCENE KEY is its own Scene (per-scene boards) so the anchor/continuity are scoped to
    // the SAME scene (the END frame anchors off the START frame of its scene), falling back to the episode-wide
    // key for legacy boards (unchanged behaviour: one episode = one location = one scene key).
    const keyOf = (sid: string | null | undefined) =>
      sid ?? boardSceneKey({ episodeId: board.episodeId, locationId: board.episode.locationId });
    const sceneKey = keyOf(board.sceneId);
    const self = { id: board.id, index: board.index, sceneKey };
    const toSiblings = (rows: typeof siblingBoards) =>
      rows.map((b) => ({ id: b.id, index: b.index, imageUrl: b.imageUrl, status: b.status, sceneKey: keyOf(b.sceneId) }));
    // Stage 220 — per-scene start/end frames render in PARALLEL, so the frame job never WAITS for a lower sibling.
    // The END frame simply picks the START frame as its anchor if it is already rendered (non-blocking); if not,
    // it renders independently. Legacy boards keep the Stage 142 strict sequential wait.
    if (!isPerScene) {
      for (let poll = 0; poll < ANCHOR_WAIT_MAX_POLLS; poll++) {
        const rendering = renderingLowerSiblings(self, toSiblings(siblingBoards));
        if (rendering.length === 0) break;
        if (await canceled()) throw new GenerationCanceledError();
        const waitingFor = Math.min(...rendering.map((r) => r.index)) + 1;
        await updateJob(jobId, { progress: 20, message: `Board ${board.index + 1}: waiting for board ${waitingFor} (scene anchor)...` });
        await sleep(ANCHOR_WAIT_POLL_MS);
        siblingBoards = await loadSiblings();
      }
    } else {
      // Stage 230 — STRICTLY SEQUENTIAL SCENES: this scene's frames may only render once the immediately
      // previous scene's frames are ALL rendered. The two frames of the SAME scene render in parallel (they
      // never gate one another). Poll boardFramePrecondition against the live siblings until it allows this
      // frame (or the wait budget elapses, after which we proceed rather than stall the job forever).
      for (let poll = 0; poll < ANCHOR_WAIT_MAX_POLLS; poll++) {
        const gate = boardFramePrecondition(
          { index: board.index, imageUrl: board.imageUrl, boardRole: board.boardRole, sceneId: board.sceneId },
          siblingBoards.map((b) => ({ index: b.index, imageUrl: b.imageUrl, sceneId: b.sceneId })),
        );
        if (gate.allowed) break;
        if (await canceled()) throw new GenerationCanceledError();
        await updateJob(jobId, { progress: 20, message: `Board ${board.index + 1}: waiting for the previous scene to finish...` });
        await sleep(ANCHOR_WAIT_POLL_MS);
        siblingBoards = await loadSiblings();
      }
    }
    const anchor = pickSceneAnchor(self, toSiblings(siblingBoards));

    // Stage 144 — ACTION / POSE CONTINUITY. The immediately previous rendered board (by index) is the source of
    // the ongoing action: its still is attached as the CONTINUITY reference and its action text is passed so this
    // board CONTINUES the exact moment (poses / body contact / props carry over; only the camera changes). The
    // first board has no earlier sibling and establishes the action.
    const prevRow = siblingBoards
      .filter((b) => b.id !== board.id && b.index < board.index && validUrl(b.imageUrl))
      .sort((a, b) => b.index - a.index)[0];
    const continuityUrl = prevRow ? (prevRow.imageUrl as string) : null;
    const previousActionText = prevRow
      ? (readBoardDirection(prevRow.directionJson)?.actionEnglish || prevRow.motionEn || prevRow.actionOrDialogue || "").trim()
      : "";

    // Character reference images first (identity), then the CONTINUITY frame (previous board's poses/contact),
    // then the SCENE ANCHOR FRAME (set), then the environment plate(s). Capped at WAVESPEED_IMAGE_MAX_REFS: plates
    // are cut first; the continuity frame, the anchor and the characters are never dropped. When the previous board
    // IS the scene anchor, the shared still is attached once and both roles point at it.
    const composed = composeBoardImageInput({
      characterRefs: refImages,
      continuityUrl,
      anchorUrl: anchor?.anchorUrl ?? null,
      plateUrls: authority.plateUrls,
      hasRegionPlate: authority.hasRegionPlate,
      maxRefs: WAVESPEED_IMAGE_MAX_REFS,
    });
    const imageInput = composed.imageInput;
    console.info(
      `[board-image] board ${board.index + 1}: anchor=${anchor ? `board ${anchor.anchorIndex + 1} (ref #${composed.anchorRefIndex})` : "none (becomes anchor)"}, continuity=${prevRow ? `board ${prevRow.index + 1} (ref #${composed.continuityRefIndex})` : "none (establishes action)"}, shot=${coverage.shotSize}, visible=[${coverage.visible.join(", ")}], offScreen=[${coverage.offScreen.join(", ")}], charRefs=${refImages.length}/${links.length}, plates=${composed.platesAttached.length}/${authority.plateUrls.length}, refs=${imageInput.length}`,
    );

    // B3 — record the ACTUAL ordered references passed to the frame model, each with a Russian role label, so the
    // UI can show exactly which images backed this board (character identity / previous-scene frame / scene anchor /
    // location plate). Indices are 1-based and match the "reference image N" callouts inside the English prompt.
    const charUrlToName = new Map<string, string>();
    refImages.forEach((u, i) => { if (!charUrlToName.has(u)) charUrlToName.set(u, refImageNames[i]); });
    const plateStartIndex = composed.imageInput.length - composed.platesAttached.length; // 0-based
    const frameRefs: BoardRefEntry[] = composed.imageInput.map((url, i) => {
      const index = i + 1;
      const isContinuity = composed.continuityRefIndex === index;
      const isAnchor = composed.anchorRefIndex === index;
      if (isContinuity && isAnchor) return { index, url, kind: "anchor+continuity", label: "Опорный + предыдущий кадр сцены" };
      if (isContinuity) return { index, url, kind: "continuity", label: "Предыдущий кадр сцены" };
      if (isAnchor) return { index, url, kind: "anchor", label: "Опорный кадр сцены" };
      if (i >= plateStartIndex) {
        const isRegion = composed.regionPlateAttached && i === plateStartIndex;
        return { index, url, kind: isRegion ? "region_plate" : "plate", label: isRegion ? "Плита подлокации" : "Плита локации" };
      }
      const name = charUrlToName.get(url);
      return { index, url, kind: "character", label: name ? `Персонаж: ${name}` : "Персонаж" };
    });

    // B1 — a fixed, board-stable seed so a re-render of THIS board reproduces the frame as closely as the provider
    // allows (best-effort; Seedream v5.0 Pro may honor `seed` loosely). Persisted for transparency in the UI.
    const frameSeed = boardFrameSeed(boardId);

    const built = buildBoardFramePrompt({
      board: { index: board.index, actionOrDialogue: board.actionOrDialogue, motion: board.motionEn, directionJson: board.directionJson },
      characters: visibleLinks.length ? visibleLinks : links,
      coverage,
      locationName: board.episode.locationName,
      locationDesc: board.episode.locationDesc,
      hasPlate: composed.platesAttached.length > 0,
      hasRegionPlate: composed.regionPlateAttached,
      setAnchors,
      anchorRefIndex: composed.anchorRefIndex,
      ...(previousActionText ? { continuity: { previousActionText, continuityRefIndex: composed.continuityRefIndex } } : {}),
    });
    const prompt = built.prompt;

    await updateJob(jobId, { progress: 45, message: `Board ${board.index + 1}: rendering frame...` });
    const remote = await generateImage(
      { prompt, aspect_ratio: REFERENCE_ASPECT_RATIO, seed: frameSeed, ...(imageInput.length ? { image_input: imageInput } : {}) },
      { jobId, shouldCancel: canceled },
    );
    if (await canceled()) throw new GenerationCanceledError();

    const imageUrl = await uploadRemoteToS3(remote, `media/public/boards/${projectId}/${boardId}/${VISUAL_STYLE_ID}/frame-${Date.now()}.png`, "image/png");
    await prisma.board.update({ where: { id: boardId }, data: { imageUrl, imagePrompt: prompt, frameRefs: frameRefs as unknown as object, frameSeed, plateUrl: authority.primaryUrl, anchorUrl: anchor?.anchorUrl ?? null, anchorBoardId: anchor?.anchorBoardId ?? null, status: "frame_ready", error: null } });
    await completeJob(jobId, { boardId, imageUrl }, `Board ${board.index + 1} frame ready`);
  } catch (err: any) {
    if (err instanceof GenerationCanceledError) { await markCanceled(jobId); return; }
    console.error("[board-image] failed:", err);
    await prisma.board.update({ where: { id: boardId }, data: { status: "error", error: err?.message ?? "Frame failed" } }).catch(() => {});
    await failJob(jobId, err?.message ?? "Board frame generation failed");
  }
}

/* ───────────── 3) board_video — animate one board via image-to-video ───────────── */
export async function runBoardVideoJob(jobId: string, projectId: string, boardId: string): Promise<void> {
  const canceled = () => isCancelRequested(jobId);
  let predictionId: string | null = null;
  try {
    if (await canceled()) { await markCanceled(jobId); return; }
    const board = await prisma.board.findUnique({ where: { id: boardId }, include: { episode: true } });
    if (!board) { await failJob(jobId, "Board not found"); return; }
    if (board.episode.mode !== "STORYBOARD") { await failJob(jobId, "Episode is not in STORYBOARD mode"); return; }
    if (!validUrl(board.imageUrl)) { await failJob(jobId, "Generate the board frame before animating it"); return; }

    await updateJob(jobId, { status: "processing", progress: 10, message: `Board ${board.index + 1}: starting animation...` });
    await prisma.board.update({ where: { id: boardId }, data: { status: "animating", error: null } });

    // Single-frame model: the board still is the ONLY frame of the image-to-video clip — it is animated on its own
    // (no last_image / end-frame morph), voicing the scene's verbatim dialogue over its motion.
    const { links } = await loadEpisodeCharacters(board.episodeId);
    const cif = (board.castInFrame ?? null) as unknown as CastInFrame | null;
    // Stage 144 — the board's opening frame already continues the previous board's ongoing action, so the motion
    // must CONTINUE from that inherited pose rather than start neutral. Resolve the immediately previous board (by
    // index, with a rendered frame); i2v still gets NO extra image refs.
    const videoSiblings = await prisma.board.findMany({ where: { episodeId: board.episodeId }, select: SIBLING_SELECT });
    const prevVideoRow = videoSiblings
      .filter((b) => b.id !== board.id && b.index < board.index && validUrl(b.imageUrl))
      .sort((a, b) => b.index - a.index)[0];
    const previousActionText = prevVideoRow
      ? (readBoardDirection(prevVideoRow.directionJson)?.actionEnglish || prevVideoRow.motionEn || prevVideoRow.actionOrDialogue || "").trim()
      : "";
    // Cast in the clip = everyone on-screen at the scene (onScreen ∪ entering ∪ exiting).
    const inFrameCast = cif ? Array.from(new Set([...(cif.onScreen ?? []), ...(cif.entering ?? []), ...(cif.exiting ?? [])])) : [];
    const animationBoard = {
      actionOrDialogue: board.actionOrDialogue, motion: board.motionEn,
      directionJson: board.directionJson,
      characters: inFrameCast.length ? inFrameCast : links.map(c => c.name),
      boardIndex: board.index,
      // Defensive clamp to the HARD per-shot cap: even a board persisted under an older, longer model animates
      // as a short 4–5s clip (a full rebuild via "Перестроить кадры" re-splits the dialogue to fit properly).
      durationSec: Math.min(SCENE_CLIP_MAX_SEC, Math.max(4, (cif?.durationSec ?? board.durationSec) ?? SCENE_CLIP_MAX_SEC)),
      imageUrl: board.imageUrl as string,
      ...(cif ? { spokenLines: cif?.dialogue ?? null, actionText: cif?.motion ?? null } : {}),
      ...(previousActionText ? { previousActionText } : {}),
    };
    const request = buildStoryboardVideoRequest(animationBoard);
    // B2/B3 — the ACTUAL composed animate prompt and the ACTUAL references the i2v receives. This provider takes the
    // board still as its ONLY image input (start frame); extra identity refs are unsupported, so the reference list
    // is exactly that single frame. Both are persisted so the UI can show what drove the animation.
    const motionPromptEn = request.prompt;
    const animateRefs: BoardRefEntry[] = [{ index: 1, url: board.imageUrl as string, kind: "frame", label: "Стартовый кадр (это изображение)" }];
    // No URLs, names, speech text or secrets in diagnostics. Extra identity refs are unsupported by this i2v API.
    console.info("[storyboard-animation]", { cameraMode: storyboardCameraMode(animationBoard), extraCharacterRefs: "unsupported", resolution: request.resolution, duration: request.duration });
    // Persist the animate prompt/refs up front so they are visible even while the clip is still rendering.
    await prisma.board.update({ where: { id: boardId }, data: { motionPromptEn, animateRefs: animateRefs as unknown as object } }).catch(() => {});
    predictionId = await startImageToVideoGeneration(request);

    // Poll until the clip is ready (best-effort cancel on user stop).
    const startedAt = Date.now();
    while (true) {
      if (await canceled()) { await cancelVideoGeneration(predictionId).catch(() => {}); await markCanceled(jobId); return; }
      const st = await getVideoGenerationState(predictionId);
      if (st.status === "succeeded" && validUrl(st.url)) {
        const videoUrl = await uploadRemoteToS3(st.url as string, `media/public/boards/${projectId}/${boardId}/clip-${Date.now()}.mp4`, "video/mp4");
        await prisma.board.update({ where: { id: boardId }, data: { videoUrl, status: "done", error: null } });
        await completeJob(jobId, { boardId, videoUrl }, `Board ${board.index + 1} animated`);
        return;
      }
      if (st.status === "failed" || st.status === "canceled") throw new Error(st.error || "Image-to-video failed");
      const pct = 15 + Math.min(70, Math.round((Date.now() - startedAt) / 1500));
      await updateJob(jobId, { progress: pct, message: `Board ${board.index + 1}: animating...` });
      await sleep(4000);
    }
  } catch (err: any) {
    if (err instanceof GenerationCanceledError) { await markCanceled(jobId); return; }
    console.error("[board-video] failed:", err);
    await prisma.board.update({ where: { id: boardId }, data: { status: "error", error: err?.message ?? "Animation failed" } }).catch(() => {});
    await failJob(jobId, err?.message ?? "Board animation failed");
  }
}

/* ───────────── 4) storyboard_assemble — stitch every board clip into one ~90s cut ───────────── */
export async function runStoryboardAssembleJob(jobId: string, episodeId: string, opts?: { quality?: string; fps?: number }): Promise<void> {
  try {
    const result = await assembleStoryboardVideo(episodeId, {
      quality: (opts?.quality as any) ?? DEFAULT_ASSEMBLE_QUALITY,
      fps: (opts?.fps as any) ?? DEFAULT_ASSEMBLE_FPS,
      onProgress: (progress, message) => updateJob(jobId, { progress, message }),
    });
    await completeJob(
      jobId,
      { episodeId, videoUrl: result.videoUrl, boardCount: result.sceneCount, mood: result.mood, musicApplied: result.musicApplied, musicSummary: result.musicSummary, musicError: result.musicError, note: result.note },
      result.note ?? "Storyboard cut assembled",
    );
  } catch (err: any) {
    console.error("[storyboard-assemble] failed:", err);
    await failJob(jobId, err?.message ?? "Storyboard assembly failed");
  }
}
