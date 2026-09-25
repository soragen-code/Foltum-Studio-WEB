/**
 * Stage 240 — GRID STORYBOARD background workers.
 *
 * Two jobs, both additive and inert for episodes that never use the grid:
 *   1. storyboard_grid       — render ONE 5×5 storyboard sheet (25 panels) with GPT Image 2.0 from a
 *                              producer-editable English prompt. References passed to the model: each character's
 *                              neutral-background portrait (up to GRID_MAX_CHAR_REFS) + the single location master
 *                              plate. Result → Episode.gridUrl + Episode.gridPrompt (the exact prompt used).
 *   2. storyboard_grid_slice — after the sheet is approved, cut it strictly along the 5×5 grid (sharp), upload each and
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
  GRID_RESOLUTION,
  GRID_COLS,
  GRID_ROWS,
  GRID_PANELS,
  type GridCharacter,
  type GridLocation,
  type GridSceneBeat,
} from "@/lib/storyboard-grid";
import { parseBeatMeta } from "@/lib/simple-pipeline";
import { softenPromptForModeration, isModerationError } from "@/lib/moderation-soften";

export const STORYBOARD_GRID_JOB_TYPE = "storyboard_grid";
export const STORYBOARD_GRID_SLICE_JOB_TYPE = "storyboard_grid_slice";
/** Poll budget for the single big sheet render (see runStoryboardGridJob). */
const GRID_IMAGE_TIMEOUT_MS = 600_000;
/** Every sliced start frame is normalised to this exact 9:16 size. */
const PANEL_OUT_W = 1080;
const PANEL_OUT_H = 1920;

/**
 * Strict 5×5 grid cut (the template asks for NO margins / NO labels, thin black borders): pw = W/5, ph = H/5 and
 * an inset proportional to the panel width (≈ 6 px on a 432 px panel) eats the black border on every side.
 */
function gridPanelRect(totalW: number, totalH: number, row: number, col: number) {
  const pw = totalW / GRID_COLS;
  const ph = totalH / GRID_ROWS;
  const inset = Math.max(4, Math.round(pw * 0.014));
  const left = Math.round(col * pw + inset);
  const top = Math.round(row * ph + inset);
  const right = Math.round((col + 1) * pw - inset);
  const bottom = Math.round((row + 1) * ph - inset);
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** Shrink a panel rectangle to an exact 9:16 box centred inside it. */
function fitNineSixteen(r: { left: number; top: number; width: number; height: number }) {
  const target = PANEL_OUT_W / PANEL_OUT_H;
  let { left, top, width, height } = r;
  if (width / height > target) {
    const w = Math.max(1, Math.floor(height * target));
    left += Math.floor((width - w) / 2);
    width = w;
  } else {
    const h = Math.max(1, Math.floor(width / target));
    top += Math.floor((height - h) / 2);
    height = h;
  }
  return { left, top, width, height };
}

const validUrl = (u?: string | null): u is string =>
  typeof u === "string" && u.startsWith("http") && u.length > 10;

/**
 * Gather everything the grid prompt needs from an episode: its cast (with a neutral-background portrait each),
 * the single bound location (master plate + key objects) and the ordered scene beats.
 */
export async function loadGridInputs(episodeId: string): Promise<{
  characters: GridCharacter[];
  location: GridLocation | null;
  /** Per-scene bound locations grouped by grid row (several locations → one block line each). */
  locations: GridLocation[];
  scenes: GridSceneBeat[];
  keyElement: string | null;
}> {
  const episode = await prisma.episode.findUnique({
    where: { id: episodeId },
    include: {
      location: true,
      characters: { include: { character: true }, orderBy: { createdAt: "asc" } },
      scenes: { orderBy: { number: "asc" }, include: { location: true } },
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

  // Scene-bound locations (Scene.locationId) grouped by grid row: a row = 5 consecutive scenes. Rows whose
  // scenes carry no own location fall back to the episode location. One entry per distinct location.
  const byLocation = new Map<string, GridLocation>();
  episode.scenes.slice(0, GRID_PANELS).forEach((s, i) => {
    const row = Math.floor(i / GRID_COLS) + 1;
    const l = s.location ?? loc;
    const key = l ? l.id : location?.id ?? "";
    if (!key) return;
    const entry = byLocation.get(key) ?? (l
      ? { id: l.id, name: l.name || episode.locationName || "Location", imageUrl: validUrl(l.imageUrl) ? l.imageUrl : null, keyObjects: l.setInventory || l.visualPrompt || l.description || null, rows: [] as number[] }
      : { ...(location as GridLocation), rows: [] as number[] });
    if (!entry.rows!.includes(row)) entry.rows!.push(row);
    byLocation.set(key, entry);
  });
  const locations = Array.from(byLocation.values());

  // Simplified pipeline: beat scenes (Scene.beatMeta) describe each panel with the beat's shot + action
  // ("[Who] [position] [verb] [object]; [second] [position] [what]. Looks at [target]." — ONE verb per panel).
  const scenes: GridSceneBeat[] = episode.scenes.map((s) => {
    const beat = parseBeatMeta(s.beatMeta);
    if (beat) {
      return { number: s.number, title: `${beat.sceneTitle} — ${s.title}`, action: beat.action || s.action || s.title || null, shotType: beat.shot || s.shotType };
    }
    return {
      number: s.number,
      title: s.title,
      action: s.action || s.startState || s.title || null,
      shotType: s.shotType,
    };
  });

  return { characters, location, locations, scenes, keyElement: null };
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

    const { characters, location, locations, scenes, keyElement } = await loadGridInputs(episodeId);
    if (scenes.length === 0) { await failJob(jobId, "У эпизода ещё нет сцен для сториборда"); return; }

    // Template priority: an explicit per-request override (edited in the modal just now) → the saved episode
    // prompt (a previously edited template) → the built-in DEFAULT (handled inside buildGridPrompt when absent).
    const template = (promptOverride && promptOverride.trim()) || episode.gridPrompt || null;
    const { prompt, refs } = buildGridPrompt({ characters, location, locations, scenes, keyElement, template });

    await updateJob(jobId, { progress: 40, message: "Рисуем лист 5×5 (25 панелей) в GPT Image 2.0..." });
    const imageInput = refs.map((r) => r.url).filter(validUrl);
    const locationInput = refs.filter((r) => r.kind === "location").map((r) => r.url).filter(validUrl);

    // Moderation ladder: the provider rejects the whole request with a generic "Content flagged as potentially
    // sensitive" error (typical triggers in a drama: explicit minor ages, violence/captivity words, or a character
    // reference photo). Attempt 1 = the producer's prompt as-is; attempt 2 = softened wording + safety note, same
    // refs; attempt 3 = softened prompt with the character portraits dropped (location plate only). Any other
    // failure (timeout, overload) is NOT retried — no paid resubmission for non-moderation errors.
    const attempts: Array<{ prompt: string; image_input: string[]; label: string }> = [
      { prompt, image_input: imageInput, label: "" },
      { prompt: softenPromptForModeration(prompt), image_input: imageInput, label: "Модерация отклонила промпт — смягчаем формулировки и повторяем (2/3)..." },
      { prompt: softenPromptForModeration(prompt), image_input: locationInput, label: "Снова отклонено — повторяем без портретов персонажей (3/3)..." },
    ];
    let remote = "";
    let promptUsed = prompt;
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i];
      if (a.label) await updateJob(jobId, { progress: 40 + i * 5, message: a.label });
      try {
        remote = await generateImage(
          {
            prompt: a.prompt,
            aspect_ratio: GRID_ASPECT_RATIO,
            resolution: GRID_RESOLUTION,
            ...(a.image_input.length ? { image_input: a.image_input } : {}),
          },
          // A 2K 5×5 sheet with up to 9 reference images regularly takes GPT Image 2.0 longer than the default
          // 180 s poll budget (observed ~4+ min); the route's maxDuration (800 s) leaves room for 8 min + upload.
          { jobId, shouldCancel: canceled, timeoutMs: GRID_IMAGE_TIMEOUT_MS },
        );
        promptUsed = a.prompt;
        break;
      } catch (err: any) {
        if (err instanceof GenerationCanceledError) throw err;
        if (!isModerationError(err) || i === attempts.length - 1) {
          if (isModerationError(err)) {
            throw new Error(
              `Модерация модели отклонила запрос даже после смягчения промпта и удаления портретов (${err?.message ?? "flagged"}). ` +
                "Отредактируйте промпт («View prompt»: уберите упоминания возраста детей, насилия, оружия, цепей) и повторите.",
            );
          }
          throw err;
        }
        console.warn(`[storyboard-grid] moderation rejection on attempt ${i + 1}, retrying softened:`, err?.message);
      }
    }
    if (await canceled()) throw new GenerationCanceledError();

    const gridUrl = await uploadRemoteToS3(
      remote,
      `media/public/grid/${projectId}/${episodeId}/sheet-${Date.now()}.png`,
      "image/png",
    );
    // Persist the sheet. The prompt is stored ONLY when the producer actually edited it (explicit override or a
    // previously saved one): a run with the built-in DEFAULT template keeps gridPrompt = null, otherwise the
    // auto-built (or moderation-softened) text would freeze as a stale "override" and later template/data
    // changes would never reach the grid. Any new render resets approval — the sheet has not been sliced yet.
    const hadOverride = Boolean((promptOverride && promptOverride.trim()) || episode.gridPrompt);
    await prisma.episode.update({
      where: { id: episodeId },
      data: { gridUrl, gridPrompt: hadOverride ? promptUsed : null, gridApproved: false },
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
    // Panel geometry: strict 5×5 grid cut (see gridPanelRect) — the sheet has no margins and no labels, so the
    // borders sit exactly on the fifths; the inset eats the thin black border. Then a centred 9:16 crop → 1080×1920.
    const scenes = episode.scenes;
    const ts = Date.now();
    let assigned = 0;

    for (let i = 0; i < GRID_PANELS; i++) {
      if (await canceled()) throw new GenerationCanceledError();
      const row = Math.floor(i / GRID_COLS);
      const col = i % GRID_COLS;
      // Each panel is trimmed to an exact 9:16 box (center-crop) and normalised to 1080×1920 so every start frame is uniform.
      const rect = fitNineSixteen(gridPanelRect(totalW, totalH, row, col));

      const scene = scenes[i];
      if (!scene) break; // fewer than 25 scenes — only slice what maps to a scene

      const panelBuf = await sharp(sheet)
        .extract(rect)
        .resize(PANEL_OUT_W, PANEL_OUT_H, { fit: "fill" })
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
    await completeJob(jobId, { episodeId, panelsAssigned: assigned }, `Sliced ${assigned} start frames from the grid (grid cut)`);
  } catch (err: any) {
    if (err instanceof GenerationCanceledError) { await markCanceled(jobId); return; }
    console.error("[storyboard-grid-slice] failed:", err);
    await failJob(jobId, err?.message ?? "Storyboard grid slicing failed");
  }
}
