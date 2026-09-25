/**
 * Stage 240 — GRID STORYBOARD background workers.
 *
 * Two jobs, both additive and inert for episodes that never use the grid:
 *   1. storyboard_grid       — render ONE 5×5 storyboard sheet (25 panels) with GPT Image 2.0 from a
 *                              producer-editable English prompt. References passed to the model: each character's
 *                              neutral-background portrait (up to GRID_MAX_CHAR_REFS) + the single location master
 *                              plate. Result → Episode.gridUrl + Episode.gridPrompt (the exact prompt used).
 *   2. storyboard_grid_slice — after the sheet is approved, slice it into 25 equal panels (sharp), upload each and
 *                              assign it to the matching scene as its START FRAME (Scene.startFrameUrl +
 *                              Scene.gridPanelIndex). Sets Episode.gridApproved = true.
 *
 * Nothing here touches the classic SCENES pipeline or the per-board STORYBOARD pipeline — a scene without a
 * startFrameUrl behaves exactly as before.
 */
import sharp from "sharp";
import { prisma } from "@/lib/db";
import { generateImage, GenerationCanceledError } from "@/lib/providers/image-provider";
import { uploadRemoteToS3, uploadBufferToS3 } from "@/lib/s3-upload";
import { updateJob, completeJob, failJob, isCancelRequested, markCanceled } from "@/lib/jobs";
import {
  buildGridPrompt,
  GRID_ASPECT_RATIO,
  GRID_COLS,
  GRID_ROWS,
  GRID_PANELS,
  type GridCharacter,
  type GridLocation,
  type GridSceneBeat,
} from "@/lib/storyboard-grid";

export const STORYBOARD_GRID_JOB_TYPE = "storyboard_grid";
export const STORYBOARD_GRID_SLICE_JOB_TYPE = "storyboard_grid_slice";

const validUrl = (u?: string | null): u is string =>
  typeof u === "string" && u.startsWith("http") && u.length > 10;

/**
 * Gather everything the grid prompt needs from an episode: its cast (with a neutral-background portrait each),
 * the single bound location (master plate + key objects) and the ordered scene beats.
 */
export async function loadGridInputs(episodeId: string): Promise<{
  characters: GridCharacter[];
  location: GridLocation | null;
  scenes: GridSceneBeat[];
  keyElement: string | null;
}> {
  const episode = await prisma.episode.findUnique({
    where: { id: episodeId },
    include: {
      location: true,
      characters: { include: { character: true }, orderBy: { createdAt: "asc" } },
      scenes: { orderBy: { number: "asc" } },
    },
  });
  if (!episode) throw new Error("Episode not found");

  const characters: GridCharacter[] = episode.characters.map(({ character: c }) => ({
    id: c.id,
    name: c.name,
    appearance: c.appearance,
    role: c.role,
    // Neutral-background reference: the front portrait is the cleanest identity frame; fall back to the full body.
    refUrl: validUrl(c.imageFront) ? c.imageFront : validUrl(c.imageFull) ? c.imageFull : null,
  }));

  const loc = episode.location;
  const location: GridLocation | null = loc
    ? {
        id: loc.id,
        name: loc.name || episode.locationName || "Location",
        imageUrl: validUrl(loc.imageUrl) ? loc.imageUrl : null,
        keyObjects: loc.setInventory || loc.visualPrompt || loc.description || null,
      }
    : episode.locationName
    ? { id: "episode-location", name: episode.locationName, imageUrl: null, keyObjects: episode.locationDesc || null }
    : null;

  const scenes: GridSceneBeat[] = episode.scenes.map((s) => ({
    number: s.number,
    title: s.title,
    action: s.action || s.startState || s.title || null,
    shotType: s.shotType,
  }));

  return { characters, location, scenes, keyElement: null };
}

/* ───────────── 1) storyboard_grid — render the 5×5 sheet ───────────── */
export async function runStoryboardGridJob(
  jobId: string,
  projectId: string,
  episodeId: string,
  promptOverride?: string | null,
): Promise<void> {
  const canceled = () => isCancelRequested(jobId);
  try {
    if (await canceled()) { await markCanceled(jobId); return; }
    await updateJob(jobId, { status: "processing", progress: 10, message: "Собираем данные эпизода для сториборда..." });

    const episode = await prisma.episode.findUnique({ where: { id: episodeId }, select: { id: true, gridPrompt: true } });
    if (!episode) { await failJob(jobId, "Episode not found"); return; }

    const { characters, location, scenes, keyElement } = await loadGridInputs(episodeId);
    if (scenes.length === 0) { await failJob(jobId, "У эпизода ещё нет сцен для сториборда"); return; }

    // Template priority: an explicit per-request override (edited in the modal just now) → the saved episode
    // prompt (a previously edited template) → the built-in DEFAULT (handled inside buildGridPrompt when absent).
    const template = (promptOverride && promptOverride.trim()) || episode.gridPrompt || null;
    const { prompt, refs } = buildGridPrompt({ characters, location, scenes, keyElement, template });

    await updateJob(jobId, { progress: 40, message: "Рисуем лист 5×5 (25 панелей) в GPT Image 2.0..." });
    const imageInput = refs.map((r) => r.url).filter(validUrl);
    const remote = await generateImage(
      { prompt, aspect_ratio: GRID_ASPECT_RATIO, ...(imageInput.length ? { image_input: imageInput } : {}) },
      { jobId, shouldCancel: canceled },
    );
    if (await canceled()) throw new GenerationCanceledError();

    const gridUrl = await uploadRemoteToS3(
      remote,
      `media/public/grid/${projectId}/${episodeId}/sheet-${Date.now()}.png`,
      "image/png",
    );
    // Persist the sheet + the EXACT prompt used (so the modal shows what produced this render). Any new render
    // resets approval — the freshly rendered sheet has not been sliced yet.
    await prisma.episode.update({
      where: { id: episodeId },
      data: { gridUrl, gridPrompt: prompt, gridApproved: false },
    });
    await completeJob(jobId, { episodeId, gridUrl }, "Storyboard grid ready");
  } catch (err: any) {
    if (err instanceof GenerationCanceledError) { await markCanceled(jobId); return; }
    console.error("[storyboard-grid] failed:", err);
    await failJob(jobId, err?.message ?? "Storyboard grid generation failed");
  }
}

/* ───────────── 2) storyboard_grid_slice — cut the sheet into 25 scene start frames ───────────── */
export async function runStoryboardGridSliceJob(
  jobId: string,
  projectId: string,
  episodeId: string,
): Promise<void> {
  const canceled = () => isCancelRequested(jobId);
  try {
    if (await canceled()) { await markCanceled(jobId); return; }
    await updateJob(jobId, { status: "processing", progress: 10, message: "Готовим нарезку листа сториборда..." });

    const episode = await prisma.episode.findUnique({
      where: { id: episodeId },
      include: { scenes: { orderBy: { number: "asc" } } },
    });
    if (!episode) { await failJob(jobId, "Episode not found"); return; }
    if (!validUrl(episode.gridUrl)) { await failJob(jobId, "Сначала сгенерируйте лист сториборда"); return; }

    const res = await fetch(episode.gridUrl);
    if (!res.ok) { await failJob(jobId, `Не удалось загрузить лист: ${res.status}`); return; }
    const sheet = Buffer.from(await res.arrayBuffer());

    const meta = await sharp(sheet).metadata();
    const totalW = meta.width ?? 0;
    const totalH = meta.height ?? 0;
    if (totalW < GRID_COLS || totalH < GRID_ROWS) { await failJob(jobId, "Лист сториборда повреждён"); return; }
    // Integer panel geometry; the last row/column absorbs any rounding remainder so no strip is lost.
    const panelW = Math.floor(totalW / GRID_COLS);
    const panelH = Math.floor(totalH / GRID_ROWS);

    const scenes = episode.scenes;
    const ts = Date.now();
    let assigned = 0;

    for (let i = 0; i < GRID_PANELS; i++) {
      if (await canceled()) throw new GenerationCanceledError();
      const row = Math.floor(i / GRID_COLS);
      const col = i % GRID_COLS;
      const left = col * panelW;
      const top = row * panelH;
      const width = col === GRID_COLS - 1 ? totalW - left : panelW;
      const height = row === GRID_ROWS - 1 ? totalH - top : panelH;

      const scene = scenes[i];
      if (!scene) break; // fewer than 25 scenes — only slice what maps to a scene

      const panelBuf = await sharp(sheet)
        .extract({ left, top, width, height })
        .png()
        .toBuffer();
      const panelUrl = await uploadBufferToS3(
        panelBuf,
        `media/public/grid/${projectId}/${episodeId}/panel-${i + 1}-${ts}.png`,
        "image/png",
      );
      await prisma.scene.update({
        where: { id: scene.id },
        data: { startFrameUrl: panelUrl, gridPanelIndex: i + 1 },
      });
      assigned += 1;
      await updateJob(jobId, {
        progress: 15 + Math.round((70 * (i + 1)) / GRID_PANELS),
        message: `Нарезаем панель ${i + 1}/${GRID_PANELS}...`,
      });
    }

    await prisma.episode.update({ where: { id: episodeId }, data: { gridApproved: true } });
    await completeJob(jobId, { episodeId, panelsAssigned: assigned }, `Sliced ${assigned} start frames from the grid`);
  } catch (err: any) {
    if (err instanceof GenerationCanceledError) { await markCanceled(jobId); return; }
    console.error("[storyboard-grid-slice] failed:", err);
    await failJob(jobId, err?.message ?? "Storyboard grid slicing failed");
  }
}
