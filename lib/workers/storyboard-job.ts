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
  detailedEpisodeStory,
  storyboardBoardsSystemPrompt,
  storyboardBoardsUserPrompt,
  dialogueRepairSystemPrompt,
  dialogueRepairUserPrompt,
} from "@/lib/storyboard";
import { buildBoardFramePrompt, type BoardCharacterLink } from "@/lib/storyboard-prompt";
import { deriveSetAnchors } from "@/lib/set-anchors";
import { readBoardDirection } from "@/lib/storyboard-direction";
import { resolveVisibleCast } from "@/lib/board-coverage";
import { pickBoardGeometryAuthority } from "@/lib/board-plate";
import { boardSceneKey, pickSceneAnchor, renderingLowerSiblings, composeBoardImageInput } from "@/lib/board-anchor";
import { WAVESPEED_IMAGE_MAX_REFS } from "@/lib/providers/image-provider";
import { storyboardSourceResilient, type DialogueRepairFn } from "@/lib/storyboard-dialogue";
import { balanceBoardCount, finalizeDirectedBoards, type RawDirectedBoard } from "@/lib/storyboard-direction";
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
const SIBLING_SELECT = { id: true, index: true, imageUrl: true, status: true, directionJson: true, motionEn: true, actionOrDialogue: true, region: true } as const;

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

/* ───────────── 1) storyboard_boards — split the story into 12–15 boards ───────────── */
export async function runStoryboardBoardsJob(jobId: string, projectId: string, episodeId: string): Promise<void> {
  try {
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    const episode = await prisma.episode.findUnique({ where: { id: episodeId } });
    if (!episode) { await failJob(jobId, "Episode not found"); return; }
    if (episode.mode !== "STORYBOARD") { await failJob(jobId, "Episode is not in STORYBOARD mode"); return; }

    await updateJob(jobId, { status: "processing", progress: 10, message: "Building the storyboard..." });
    // Single flowing through-line (no first-30 / last-30 split) derived from the shared episode description.
    const story = detailedEpisodeStory(episode.description);
    if (!story) { await failJob(jobId, "The episode has no story yet"); return; }

    const { links } = await loadEpisodeCharacters(episodeId);
    const characters = links.map((l) => l.name);
    const location = episode.locationName ?? null;

    // Stage 141 — all Storyboard dialogue is voiced in ENGLISH. Read the source lines and translate any
    // non-English dialogue to English BEFORE building the immutable speech ledger, so the verbatim per-line
    // text restored into every board (and fed to the i2v payload / voicing / board display) is English.
    // This overrides the earlier "verbatim in the source/original language" rule. Attribution, source order
    // and the exact-once ledger integrity are unchanged — only the LANGUAGE of the spoken words is normalized.
    const rawScenes = await prisma.scene.findMany({
      where: { episodeId }, orderBy: { number: "asc" },
      select: { number: true, action: true, dialogue: true, dialogueEn: true },
    });
    const scenes = await Promise.all(
      rawScenes.map(async (s) => {
        // Prefer an already-English translated line (dialogueEn); otherwise translate the source dialogue.
        let english = (s.dialogueEn ?? "").trim();
        if (!english || detectSpokenLanguage(english) !== "English") {
          const src = (s.dialogue ?? "").trim();
          english =
            src && detectSpokenLanguage(src) !== "English"
              ? await translateDialogue(src, "English")
              : src || english;
        }
        return { number: s.number, action: s.action, dialogue: english };
      }),
    );
    // Attribution honours gender-lock (a pronoun reporter resolves to the sole cast member of that sex).
    const attributionCast = links.map((l) => ({ name: l.name, gender: l.gender ?? null }));
    // Stage 135 — RESOLVING attribution: when the deterministic parser cannot attribute a quoted line, make
    // ONE LLM repair round that forces an explicit canonical speaker (+delivery/addressee) so boards rebuild
    // in the required NAME (delivery): "line" format instead of hard-blocking. Same model as the board split.
    const dialogueRepair: DialogueRepairFn = async ({ cast, lines }) => {
      const res = await chatJSON<{ assignments?: Array<{ id: number; speaker: string; delivery?: string; addressee?: string }> }>(
        dialogueRepairSystemPrompt(),
        dialogueRepairUserPrompt(cast, lines),
        { maxTokens: 2000, temperature: 0 },
      );
      return res?.assignments ?? [];
    };
    const source = await storyboardSourceResilient(episode, scenes, attributionCast, { repair: dialogueRepair });
    await updateJob(jobId, { progress: 35, message: "Splitting the story into boards..." });
    let boards: ReturnType<typeof finalizeDirectedBoards> | null = null;
    let conflict = "";
    for (let attempt = 0; attempt < 2 && !boards; attempt++) {
      const user = storyboardBoardsUserPrompt(story, { characters, location }) +
        `\n\nSOURCE SCRIPT (original language; authoritative action and speech):\n${source.source}` +
        `\n\nSOURCE ACTION (literal travel evidence only):\n${source.actionSource}` +
        `\n\nIMMUTABLE SOURCE SPEECH SEGMENTS (use IDs, preserve order):\n${JSON.stringify(source.segments)}` +
        (conflict ? `\n\nPLANNING CONFLICT: ${conflict}. Fix the allocation without changing source speech; keep each board 4–6s and use as many boards as the content needs.` : "");
      const res = await chatJSON<{ boards?: RawDirectedBoard[] }>(storyboardBoardsSystemPrompt(), user, { maxTokens: 6000, temperature: 0.7 });
      try {
        // Stage 148 — balance per-board budget with a CONTENT-DERIVED board count (no fixed 12–15 window):
        // distribute overflow, guard against pathological over-split, never truncating speech, then finalize.
        const balanced = balanceBoardCount(res?.boards ?? [], source.segments);
        boards = finalizeDirectedBoards(balanced, source.segments, characters, source.actionSource);
      } catch (err) { conflict = err instanceof Error ? err.message : "Invalid board plan"; }
    }
    if (!boards) { await failJob(jobId, `Storyboard planning conflict: ${conflict}`); return; }
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }

    await updateJob(jobId, { progress: 80, message: "Saving boards..." });
    // Validate BEFORE replacing old boards; failed allocation leaves them intact. Replacement is atomic.
    // Transparency: persist a PLANNED English frame prompt for every board at split time (symmetric to
    // motionEn, which already lets the UI show the animate prompt before rendering). The exact final prompt
    // depends on render-time context (attached plates, the scene-anchor / continuity reference frames and
    // their 1-based indices), which does not exist yet — so this is the plan derived purely from the board's
    // action, cast and location. When the frame is rendered, runBoardImageJob overwrites imagePrompt with the
    // fully composed prompt (storyboard-job.ts ~336). Building it is a pure, side-effect-free string assembly.
    const plannedFramePrompt = (b: (typeof boards)[number]) =>
      buildBoardFramePrompt({
        board: { index: b.index, actionOrDialogue: b.actionOrDialogue, motion: b.motion, directionJson: b.directionJson },
        characters: links,
        locationName: episode.locationName,
        locationDesc: episode.locationDesc,
      }).prompt;
    await prisma.$transaction(async tx => {
      await tx.board.deleteMany({ where: { episodeId } });
      await tx.board.createMany({
        data: boards!.map((b) => ({
          episodeId, index: b.index, actionOrDialogue: b.actionOrDialogue,
          motionEn: b.motion, durationSec: b.durationSec,
          region: b.region, regionKey: b.regionKey,
          directionJson: b.directionJson, imagePrompt: plannedFramePrompt(b), status: "pending",
        })),
      });
    });

    await completeJob(jobId, { episodeId, boardCount: boards.length, totalSec: boards.reduce((s, b) => s + b.durationSec, 0) }, `Storyboard ready — ${boards.length} boards`);
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
    // Stage 143 — EXACTLY who is in frame for THIS board (deterministic: direction + position in scene + action
    // text). Only the visible characters' identity references are attached; off-screen cast is only NAMED in the
    // prompt, so the model can no longer copy the whole cast into every board.
    const direction = readBoardDirection(board.directionJson);
    const coverage = resolveVisibleCast(direction, board.index, links.map((l) => l.name), board.actionOrDialogue);
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

    // Stage 142 — SCENE ANCHOR FRAME. Boards of one scene (episode × location) render strictly IN ORDER: while a
    // lower-index sibling of the same scene is still rendering, wait for it (bounded), so the earliest successful
    // board becomes this board's anchor. A failed/never-rendered lower sibling is not waited for — the next
    // successful board takes over as anchor. The first board of a scene has no anchor and BECOMES the anchor.
    const sceneKey = boardSceneKey({ episodeId: board.episodeId, locationId: board.episode.locationId });
    const self = { id: board.id, index: board.index, sceneKey };
    const toSiblings = (rows: typeof siblingBoards) =>
      rows.map((b) => ({ id: b.id, index: b.index, imageUrl: b.imageUrl, status: b.status, sceneKey }));
    for (let poll = 0; poll < ANCHOR_WAIT_MAX_POLLS; poll++) {
      const rendering = renderingLowerSiblings(self, toSiblings(siblingBoards));
      if (rendering.length === 0) break;
      if (await canceled()) throw new GenerationCanceledError();
      const waitingFor = Math.min(...rendering.map((r) => r.index)) + 1;
      await updateJob(jobId, { progress: 20, message: `Board ${board.index + 1}: waiting for board ${waitingFor} (scene anchor)...` });
      await sleep(ANCHOR_WAIT_POLL_MS);
      siblingBoards = await loadSiblings();
    }
    const anchor = pickSceneAnchor(self, toSiblings(siblingBoards));

    // Stage 144 — ACTION / POSE CONTINUITY. The immediately previous board of the SAME scene AND SAME region (a
    // rendered frame with the highest index below this board) is the source of the ongoing action: its still is
    // attached as the CONTINUITY reference and its action text is passed so this board CONTINUES the exact moment
    // (poses / body contact / props carry over; only the camera changes). Inheritance resets at a region boundary
    // (a different corner of the set) and at the first board of the scene, which establishes the action instead.
    const prevRow = siblingBoards
      .filter((b) => b.id !== board.id && b.index < board.index && (b.region ?? null) === (board.region ?? null) && validUrl(b.imageUrl))
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
    if (!validUrl(board.imageUrl)) { await failJob(jobId, "Generate the board frame before animating it"); return; }

    await updateJob(jobId, { status: "processing", progress: 10, message: `Board ${board.index + 1}: starting animation...` });
    await prisma.board.update({ where: { id: boardId }, data: { status: "animating", error: null } });

    // The board still is the START frame of the image-to-video clip (keyframe ban lifted for STORYBOARD).
    const { links } = await loadEpisodeCharacters(board.episodeId);
    // Stage 144 — the board's opening frame already continues the previous board's ongoing action, so the motion
    // must CONTINUE from that inherited pose rather than start neutral. Resolve the previous board of the same
    // scene AND same region (highest index below, with a rendered frame); i2v still gets NO extra image refs.
    const videoSiblings = await prisma.board.findMany({ where: { episodeId: board.episodeId }, select: SIBLING_SELECT });
    const prevVideoRow = videoSiblings
      .filter((b) => b.id !== board.id && b.index < board.index && (b.region ?? null) === (board.region ?? null) && validUrl(b.imageUrl))
      .sort((a, b) => b.index - a.index)[0];
    const previousActionText = prevVideoRow
      ? (readBoardDirection(prevVideoRow.directionJson)?.actionEnglish || prevVideoRow.motionEn || prevVideoRow.actionOrDialogue || "").trim()
      : "";
    const animationBoard = {
      actionOrDialogue: board.actionOrDialogue, motion: board.motionEn,
      directionJson: board.directionJson, characters: links.map(c => c.name), boardIndex: board.index,
      durationSec: board.durationSec ?? 6, imageUrl: board.imageUrl as string,
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
