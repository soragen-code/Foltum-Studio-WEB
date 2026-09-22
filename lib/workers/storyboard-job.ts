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
import { boardSceneKey, pickSceneAnchor, renderingLowerSiblings, composeBoardImageInput } from "@/lib/board-anchor";
import { WAVESPEED_IMAGE_MAX_REFS } from "@/lib/providers/image-provider";
import {
  extractSpokenLinesResilient,
  estimatedSpeechSeconds,
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

/** Minimal sibling projection shared by the Stage 140 set-anchors and the Stage 142 scene anchor. */
const SIBLING_SELECT = { id: true, index: true, imageUrl: true, status: true, directionJson: true, motionEn: true, actionOrDialogue: true, region: true, sceneId: true, boardRole: true } as const;

/**
 * Load the episode's cast (identity + sex source of truth) for a board frame prompt.
 * Stage 143 — `refs` is ALIGNED with `links` (null when a character has no usable reference image) so the
 * board_image job can keep only the references of the characters that are actually IN FRAME.
 */
async function loadEpisodeCharacters(episodeId: string): Promise<{ links: BoardCharacterLink[]; refs: (string | null)[] }> {
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
};

/** Build a deterministic BoardCoverage from an explicit in-frame name list (cast order), for the frame prompt. */
function coverageFromNames(inFrame: string[], fullCast: string[]): BoardCoverage {
  const visible = fullCast.filter((c) => inFrame.includes(c));
  const vis = visible.length ? visible : fullCast;
  const shotSize: ShotSize = vis.length <= 1 ? "MEDIUM" : vis.length === 2 ? "TWO-SHOT" : "WIDE ESTABLISHING";
  return { shotSize, visible: vis, offScreen: fullCast.filter((c) => !vis.includes(c)), focus: "" };
}

/* ───────────── 1) storyboard_boards — per Scene → EXACTLY 2 boards (start frame + end frame) ─────────────
 * Stage 220 — the episode is no longer split into ~50 discrete LLM beats. Every existing Scene now yields
 * EXACTLY two boards: a START frame (boardRole="start", index 2i) and an END frame (boardRole="end", index
 * 2i+1). ONE image-to-video clip animates the start frame INTO the end frame (last_image), carrying the whole
 * scene's verbatim dialogue. A single LLM call plans, for every scene, who is on screen / enters / exits and
 * the start/end/motion descriptions; the dialogue itself is restored verbatim from the scene (never rewritten).
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

    // ONE planner call for the whole episode: per scene → onScreen / entering / exiting + start/end/motion (English).
    await updateJob(jobId, { progress: 35, message: "Planning start & end frames for each scene..." });
    const planInputs: ScenePlanInput[] = scenesEn.map((s) => ({
      number: s.number,
      action: s.action,
      dialogue: s.dialogueEnResolved,
      startState: s.startState,
      endState: s.endState,
      presence: s.presence,
      entrances: s.entrances,
      sceneKind: s.sceneKind,
      voiceover: s.voiceover,
    }));
    const rawPlan = await chatJSON<{ scenes?: unknown[] }>(
      scenePlanSystemPrompt(),
      scenePlanUserPrompt(planInputs, { characters, location }),
      { maxTokens: 8000, temperature: 0.4 },
    );
    const plans = normalizeScenePlan(rawPlan as any, planInputs, characters);
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }

    await updateJob(jobId, { progress: 70, message: "Restoring dialogue & building boards..." });
    // Build the two board rows per scene. Dialogue is restored VERBATIM (attributed) from the scene's own
    // English lines; a dialogue-attribution conflict fails the whole job (old boards stay intact — see below).
    type BoardRow = {
      episodeId: string; sceneId: string; index: number; boardRole: string;
      actionOrDialogue: string; motionEn: string | null; durationSec: number;
      castInFrame: object; imagePrompt: string; status: string;
    };
    const rows: BoardRow[] = [];
    for (let i = 0; i < scenesEn.length; i++) {
      const s = scenesEn[i];
      const plan = plans[i];
      const isNarration = (s.sceneKind ?? "").trim().toLowerCase() === "narration";
      // Verbatim, attributed spoken lines (dialogue scenes only). Narration carries no on-screen dialogue.
      const dialogue: SpokenLine[] = isNarration || !s.dialogueEnResolved.trim()
        ? []
        : await extractSpokenLinesResilient(s.dialogueEnResolved, attributionCast, { repair: dialogueRepair });
      // Duration = enough to fit ALL speech (never truncated/accelerated), at least the scripted scene length,
      // clamped to the i2v-supported [4, 30]s window.
      const speechSec = dialogue.reduce((sum, l) => sum + estimatedSpeechSeconds(l), 0);
      const durationSec = Math.min(30, Math.max(Math.ceil(speechSec) + 1, s.durationSec ?? 6, 4));

      // The start frame shows everyone present at the START (onScreen + those about to exit, minus those still
      // entering); the end frame shows everyone present at the END (onScreen + those who entered, minus exiters).
      const startVisible = characters.filter(
        (c) => (plan.onScreen.includes(c) || plan.exiting.includes(c)) && !plan.entering.includes(c),
      );
      const endVisible = characters.filter(
        (c) => (plan.onScreen.includes(c) || plan.entering.includes(c)) && !plan.exiting.includes(c),
      );
      const startCoverage = coverageFromNames(startVisible.length ? startVisible : plan.onScreen, characters);
      const endCoverage = coverageFromNames(endVisible.length ? endVisible : plan.onScreen, characters);

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

      const startIdx = 2 * i;
      const endIdx = 2 * i + 1;
      rows.push({
        episodeId, sceneId: s.id, index: startIdx, boardRole: "start",
        actionOrDialogue: plan.startFrame, motionEn: plan.motion, durationSec,
        castInFrame: castJson, imagePrompt: framePrompt(startIdx, plan.startFrame, startCoverage), status: "pending",
      });
      rows.push({
        episodeId, sceneId: s.id, index: endIdx, boardRole: "end",
        actionOrDialogue: plan.endFrame, motionEn: null, durationSec,
        castInFrame: castJson, imagePrompt: framePrompt(endIdx, plan.endFrame, endCoverage), status: "pending",
      });
    }
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }

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

    const totalSec = rows.filter((r) => r.boardRole === "start").reduce((sum, r) => sum + r.durationSec, 0);
    await completeJob(
      jobId,
      { episodeId, boardCount: rows.length, sceneCount: scenesEn.length, totalSec },
      `Storyboard ready — ${scenesEn.length} scenes (${rows.length} boards)`,
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
    // Stage 220 — per-scene board: this is the START or END frame of a scene. WHO is in frame is DETERMINED by
    // the scene shot plan (castInFrame): the start frame shows everyone present at the START (onScreen + those
    // about to exit, minus those still entering); the end frame shows everyone present at the END (onScreen +
    // those who entered, minus exiters). Legacy boards (null castInFrame) keep the Stage 143 direction-derived
    // coverage. Only the visible characters' identity references are attached; off-screen cast is only NAMED.
    const isPerScene = !!board.boardRole;
    const cif = (board.castInFrame ?? null) as unknown as CastInFrame | null;
    let coverage: BoardCoverage;
    if (cif && Array.isArray(cif.onScreen)) {
      const onScreen = cif.onScreen ?? [];
      const entering = cif.entering ?? [];
      const exiting = cif.exiting ?? [];
      const inFrame = board.boardRole === "end"
        ? cast.filter((c) => (onScreen.includes(c) || entering.includes(c)) && !exiting.includes(c))
        : cast.filter((c) => (onScreen.includes(c) || exiting.includes(c)) && !entering.includes(c));
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
    }
    const anchor = pickSceneAnchor(self, toSiblings(siblingBoards));

    // Stage 144/220 — ACTION / POSE CONTINUITY. The immediately previous rendered board of the SAME scene (by
    // sceneId for per-scene boards, else same region) is the source of the ongoing action: its still is attached
    // as the CONTINUITY reference and its action text is passed so this board CONTINUES the exact moment (poses /
    // body contact / props carry over; only the camera changes). The scene's START frame has no earlier sibling
    // and establishes the action; the END frame continues from the START frame.
    const prevRow = siblingBoards
      .filter((b) => b.id !== board.id && b.index < board.index && validUrl(b.imageUrl) &&
        (isPerScene ? (b.sceneId ?? null) === (board.sceneId ?? null) : (b.region ?? null) === (board.region ?? null)))
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

    const { prompt } = buildBoardFramePrompt({
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
    // Stage 220 — per-scene model: only the START frame is animated (start→end i2v clip). The END frame is a still
    // keyframe consumed as the clip's last_image; it is never animated on its own.
    if (board.boardRole === "end") { await failJob(jobId, "The scene end frame is a keyframe, not an animated clip; animate the scene's start frame instead."); return; }
    if (!validUrl(board.imageUrl)) { await failJob(jobId, "Generate the board frame before animating it"); return; }

    await updateJob(jobId, { status: "processing", progress: 10, message: `Board ${board.index + 1}: starting animation...` });
    await prisma.board.update({ where: { id: boardId }, data: { status: "animating", error: null } });

    // The board still is the START frame of the image-to-video clip (keyframe ban lifted for STORYBOARD).
    const { links } = await loadEpisodeCharacters(board.episodeId);
    // Stage 220 — per-scene start board: fetch the scene's END frame to drive the i2v start→end transition
    // (Seedance last_image), and use the scene's verbatim dialogue + motion text as the clip authority.
    const cif = (board.castInFrame ?? null) as unknown as CastInFrame | null;
    const isPerScene = !!board.boardRole && !!board.sceneId;
    let lastImageUrl: string | null = null;
    if (isPerScene) {
      const endRow = await prisma.board.findFirst({ where: { episodeId: board.episodeId, sceneId: board.sceneId, boardRole: "end" }, select: { imageUrl: true } });
      if (endRow && validUrl(endRow.imageUrl)) lastImageUrl = endRow.imageUrl as string;
    }
    // Stage 144 — the board's opening frame already continues the previous board's ongoing action, so the motion
    // must CONTINUE from that inherited pose rather than start neutral. Resolve the previous board of the same
    // scene AND same region (highest index below, with a rendered frame); i2v still gets NO extra image refs.
    const videoSiblings = await prisma.board.findMany({ where: { episodeId: board.episodeId }, select: SIBLING_SELECT });
    // Legacy multi-board scenes chained continuity from the previous board; a per-scene start board is a
    // self-contained start→end clip, so it never inherits a previous pose.
    const prevVideoRow = isPerScene ? undefined : videoSiblings
      .filter((b) => b.id !== board.id && b.index < board.index && (b.region ?? null) === (board.region ?? null) && validUrl(b.imageUrl))
      .sort((a, b) => b.index - a.index)[0];
    const previousActionText = prevVideoRow
      ? (readBoardDirection(prevVideoRow.directionJson)?.actionEnglish || prevVideoRow.motionEn || prevVideoRow.actionOrDialogue || "").trim()
      : "";
    // Per-scene: cast in the clip = everyone on-screen at either end (onScreen ∪ entering ∪ exiting).
    const perSceneCast = cif ? Array.from(new Set([...(cif.onScreen ?? []), ...(cif.entering ?? []), ...(cif.exiting ?? [])])) : [];
    const animationBoard = {
      actionOrDialogue: board.actionOrDialogue, motion: board.motionEn,
      directionJson: board.directionJson,
      characters: isPerScene && perSceneCast.length ? perSceneCast : links.map(c => c.name),
      boardIndex: board.index,
      durationSec: (isPerScene ? (cif?.durationSec ?? board.durationSec) : board.durationSec) ?? 6,
      imageUrl: board.imageUrl as string,
      ...(isPerScene ? { lastImageUrl, spokenLines: cif?.dialogue ?? null, actionText: cif?.motion ?? null } : {}),
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
