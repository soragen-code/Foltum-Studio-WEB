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
  normalizeBoards,
  validateBoards,
  storyboardBoardsSystemPrompt,
  storyboardBoardsUserPrompt,
  STORYBOARD_MIN_BOARDS,
  STORYBOARD_MIN_BOARD_SEC,
  STORYBOARD_MAX_BOARD_SEC,
  type RawBoard,
} from "@/lib/storyboard";
import { buildBoardFramePrompt, buildBoardMotionPrompt, type BoardCharacterLink } from "@/lib/storyboard-prompt";

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

    await updateJob(jobId, { progress: 35, message: "Splitting the story into boards..." });
    let raw: RawBoard[] = [];
    for (let attempt = 0; attempt < 2 && raw.length < STORYBOARD_MIN_BOARDS; attempt++) {
      const user = storyboardBoardsUserPrompt(story, { characters, location }) +
        (attempt > 0 ? `\n\nYour previous answer had too few boards — return at least ${STORYBOARD_MIN_BOARDS} boards.` : "");
      const res = await chatJSON<{ boards?: RawBoard[] }>(storyboardBoardsSystemPrompt(), user, { maxTokens: 4000, temperature: 0.7 });
      raw = Array.isArray(res?.boards) ? res.boards : [];
    }

    const boards = normalizeBoards(raw);
    const problems = validateBoards(boards);
    if (problems.length) { await failJob(jobId, `Storyboard split failed: ${problems.join("; ")}`); return; }

    await updateJob(jobId, { progress: 80, message: "Saving boards..." });
    // Replace any previous boards for this episode (idempotent re-split).
    await prisma.board.deleteMany({ where: { episodeId } });
    await prisma.board.createMany({
      data: boards.map((b) => ({
        episodeId,
        index: b.index,
        actionOrDialogue: b.actionOrDialogue,
        motionEn: b.motion,
        durationSec: b.durationSec,
        status: "pending",
      })),
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
    const { prompt } = buildBoardFramePrompt({
      board: { index: board.index, actionOrDialogue: board.actionOrDialogue, motion: board.motionEn },
      characters: links,
      locationName: board.episode.locationName,
      locationDesc: board.episode.locationDesc,
    });

    await updateJob(jobId, { progress: 45, message: `Board ${board.index + 1}: rendering frame...` });
    const remote = await generateImage(
      { prompt, aspect_ratio: REFERENCE_ASPECT_RATIO, ...(refImages.length ? { image_input: refImages } : {}) },
      { jobId, shouldCancel: canceled },
    );
    if (await canceled()) throw new GenerationCanceledError();

    const imageUrl = await uploadRemoteToS3(remote, `media/public/boards/${projectId}/${boardId}/${VISUAL_STYLE_ID}/frame-${Date.now()}.png`, "image/png");
    await prisma.board.update({ where: { id: boardId }, data: { imageUrl, imagePrompt: prompt, status: "frame_ready", error: null } });
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
    const duration = Math.max(STORYBOARD_MIN_BOARD_SEC, Math.min(STORYBOARD_MAX_BOARD_SEC, board.durationSec ?? STORYBOARD_MAX_BOARD_SEC));
    const motion = buildBoardMotionPrompt({ actionOrDialogue: board.actionOrDialogue, motion: board.motionEn });
    predictionId = await startImageToVideoGeneration({
      prompt: motion,
      image: board.imageUrl as string,
      resolution: "720p",
      duration,
      generate_audio: true,
    });

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
