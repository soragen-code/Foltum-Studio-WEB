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
import { pickBoardGeometryAuthority } from "@/lib/board-plate";
import { storyboardSourceResilient, type DialogueRepairFn } from "@/lib/storyboard-dialogue";
import { balanceBoardCount, finalizeDirectedBoards, type RawDirectedBoard } from "@/lib/storyboard-direction";
import { buildStoryboardVideoRequest, storyboardCameraMode } from "@/lib/storyboard-animation";

export const STORYBOARD_BOARDS_JOB_TYPE = "storyboard_boards";
export const BOARD_IMAGE_JOB_TYPE = "board_image";
export const BOARD_VIDEO_JOB_TYPE = "board_video";
export const STORYBOARD_ASSEMBLE_JOB_TYPE = "storyboard_assemble";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const validUrl = (u?: string | null) => typeof u === "string" && u.startsWith("http") && u.length > 10;

/** Load the episode's cast (identity + sex source of truth) for a board frame prompt. */
async function loadEpisodeCharacters(episodeId: string): Promise<{ links: BoardCharacterLink[]; refImages: string[] }> {
  const rows = await prisma.episodeCharacter.findMany({
    where: { episodeId },
    include: { character: true },
    orderBy: { createdAt: "asc" },
  });
  const links: BoardCharacterLink[] = [];
  const refImages: string[] = [];
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
    if (validUrl(ref)) refImages.push(ref as string);
  }
  return { links, refImages };
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

    // Read original-language source dialogue; do not feed translated dialogueEn to Storyboard.
    const scenes = await prisma.scene.findMany({
      where: { episodeId }, orderBy: { number: "asc" },
      select: { number: true, action: true, dialogue: true },
    });
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
        (conflict ? `\n\nPLANNING CONFLICT: ${conflict}. Fix the allocation without changing source speech or the 12–15 / 4–6s limits.` : "");
      const res = await chatJSON<{ boards?: RawDirectedBoard[] }>(storyboardBoardsSystemPrompt(), user, { maxTokens: 6000, temperature: 0.7 });
      try {
        // Stage 136 — converge on 12–15 boards (merge/split) before finalizing, never truncating speech.
        const balanced = balanceBoardCount(res?.boards ?? [], source.segments);
        boards = finalizeDirectedBoards(balanced, source.segments, characters, source.actionSource);
      } catch (err) { conflict = err instanceof Error ? err.message : "Invalid board plan"; }
    }
    if (!boards) { await failJob(jobId, `Storyboard planning conflict: ${conflict}`); return; }
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }

    await updateJob(jobId, { progress: 80, message: "Saving boards..." });
    // Validate BEFORE replacing old boards; failed allocation leaves them intact. Replacement is atomic.
    await prisma.$transaction(async tx => {
      await tx.board.deleteMany({ where: { episodeId } });
      await tx.board.createMany({
        data: boards!.map((b) => ({
          episodeId, index: b.index, actionOrDialogue: b.actionOrDialogue,
          motionEn: b.motion, durationSec: b.durationSec,
          region: b.region, regionKey: b.regionKey,
          directionJson: b.directionJson, status: "pending",
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

    const { links, refImages } = await loadEpisodeCharacters(board.episodeId);

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

    const { prompt } = buildBoardFramePrompt({
      board: { index: board.index, actionOrDialogue: board.actionOrDialogue, motion: board.motionEn, directionJson: board.directionJson },
      characters: links,
      locationName: board.episode.locationName,
      locationDesc: board.episode.locationDesc,
      hasPlate: authority.hasPlate,
      hasRegionPlate: authority.hasRegionPlate,
    });

    // Character reference images first (identity), then the environment plate(s) as geometry authority. The
    // provider caps the total at WAVESPEED_IMAGE_MAX_REFS; dedupe so a plate never repeats a character ref.
    const imageInput = Array.from(new Set([...refImages, ...authority.plateUrls]));

    await updateJob(jobId, { progress: 45, message: `Board ${board.index + 1}: rendering frame...` });
    const remote = await generateImage(
      { prompt, aspect_ratio: REFERENCE_ASPECT_RATIO, ...(imageInput.length ? { image_input: imageInput } : {}) },
      { jobId, shouldCancel: canceled },
    );
    if (await canceled()) throw new GenerationCanceledError();

    const imageUrl = await uploadRemoteToS3(remote, `media/public/boards/${projectId}/${boardId}/${VISUAL_STYLE_ID}/frame-${Date.now()}.png`, "image/png");
    await prisma.board.update({ where: { id: boardId }, data: { imageUrl, imagePrompt: prompt, plateUrl: authority.primaryUrl, status: "frame_ready", error: null } });
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
    const animationBoard = {
      actionOrDialogue: board.actionOrDialogue, motion: board.motionEn,
      directionJson: board.directionJson, characters: links.map(c => c.name),
      durationSec: board.durationSec ?? 6, imageUrl: board.imageUrl as string,
    };
    const request = buildStoryboardVideoRequest(animationBoard);
    // No URLs, names, speech text or secrets in diagnostics. Extra identity refs are unsupported by this i2v API.
    console.info("[storyboard-animation]", { cameraMode: storyboardCameraMode(animationBoard), extraCharacterRefs: "unsupported", resolution: request.resolution, duration: request.duration });
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
