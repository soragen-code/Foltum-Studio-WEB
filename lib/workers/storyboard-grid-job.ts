/**
 * Stage 240 — GRID STORYBOARD background workers.
 *
 * Two jobs, both additive and inert for episodes that never use the grid:
 *   1. storyboard_grid       — render ONE storyboard sheet (a single composition, a grid of panels) with GPT Image 2.0
 *                              from a producer-editable English prompt. References passed to the model: each character's
 *                              neutral-background portrait (up to GRID_MAX_CHAR_REFS) + the single location master
 *                              plate. Result → Episode.gridUrl + Episode.gridPrompt (the exact prompt used).
 *   2. storyboard_grid_slice — after the sheet is approved, cut it along the WHITE separator lines between panels
 *                              (sharp). The grid dimensions are DETECTED from those lines (the model does not honour a
 *                              fixed count), each panel is uploaded and assigned to the matching scene as its START
 *                              FRAME (Scene.startFrameUrl + Scene.gridPanelIndex). Sets Episode.gridApproved = true.
 *
 * Nothing here touches the classic SCENES pipeline or the per-board STORYBOARD pipeline — a scene without a
 * startFrameUrl behaves exactly as before.
 */
import sharp from "sharp";
import { prisma } from "@/lib/db";
import { generateImage, GenerationCanceledError } from "@/lib/providers/image-provider";
import { uploadRemoteToS3, uploadBufferToS3 } from "@/lib/s3-upload";
import { updateJob, completeJob, failJob, isCancelRequested, markCanceled, runInBackground, getBaseUrl, getWorkerSecret, WORKER_SECRET_HEADER } from "@/lib/jobs";
import { REDRAW_START_FRAME_JOB_TYPE, runRedrawStartFramesJob } from "@/lib/workers/redraw-start-frame-job";
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
 * Cut on the WHITE separator lines between panels. The sheet is ONE composition (a grid of frames) and the model does
 * NOT honour any fixed panel count — real sheets come out 4 columns × 6 rows, not 5×5. So we DETECT the grid instead of
 * assuming it:
 *   1. build the per-column / per-row mean-brightness profile,
 *   2. find the bright INTERNAL local maxima of each profile — those are the white lines dividing the frames,
 *   3. columns = vertical lines + 1, rows = horizontal lines + 1; bounds run edge-to-edge (0 … W / 0 … H),
 *   4. reject the sheet (return null → the job asks for a clean re-gen) only if the detected grid is out of a sane
 *      range or the bands are wildly non-uniform.
 * Returns full-resolution boundary arrays of DETECTED length: colBounds has (cols+1) entries, rowBounds (rows+1).
 */
async function analyzeGridBounds(
  sheet: Buffer,
  totalW: number,
  totalH: number,
): Promise<{ colBounds: number[]; rowBounds: number[] } | null> {
  const SW = Math.min(800, totalW);
  const { data, info } = await sharp(sheet).greyscale().resize(SW, null).raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const sx = totalW / w;
  const sy = totalH / h;

  const colMean = new Float64Array(w);
  const rowMean = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    const base = y * w;
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      const v = data[base + x];
      colMean[x] += v;
      rowSum += v;
    }
    rowMean[y] = rowSum / w;
  }
  for (let x = 0; x < w; x++) colMean[x] /= h;

  // Find the bright internal separator lines: local maxima of the brightness profile above (min + 50% of range),
  // ignoring the outer 6% (the sheet frame), then merge maxima that sit within 6% of the axis length.
  const detectBrightLines = (arr: Float64Array): number[] => {
    const N = arr.length;
    let mn = Infinity;
    let mx = -Infinity;
    for (const v of arr) {
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const range = mx - mn;
    if (range < 5) return [];
    const thr = mn + range * 0.5;
    const win = 5;
    const edge = Math.round(N * 0.06);
    const raw: number[] = [];
    for (let i = edge; i < N - edge; i++) {
      const v = arr[i];
      if (v < thr) continue;
      let isMax = true;
      for (let k = -win; k <= win; k++) {
        if (k === 0) continue;
        const j = i + k;
        if (j < 0 || j >= N) continue;
        if (arr[j] > v) { isMax = false; break; }
      }
      if (isMax) raw.push(i);
    }
    const mergeDist = Math.max(3, Math.round(N * 0.06));
    raw.sort((a, b) => a - b);
    const merged: { pos: number; val: number }[] = [];
    for (const p of raw) {
      const last = merged[merged.length - 1];
      if (last && p - last.pos <= mergeDist) {
        if (arr[p] > last.val) { last.pos = p; last.val = arr[p]; }
      } else {
        merged.push({ pos: p, val: arr[p] });
      }
    }
    return merged.map((m) => m.pos);
  };

  const colLines = detectBrightLines(colMean);
  const rowLines = detectBrightLines(rowMean);
  const nCols = colLines.length + 1;
  const nRows = rowLines.length + 1;
  // Sane-range guard: real sheets are 3–6 columns and 4–7 rows. Anything else means the lines were not found.
  if (nCols < 3 || nCols > 6 || nRows < 4 || nRows > 7) return null;

  const colBounds = [0, ...colLines.map((c) => Math.round(c * sx)), totalW];
  const rowBounds = [0, ...rowLines.map((r) => Math.round(r * sy)), totalH];

  // Uniformity guard (lenient — real grids drift): reject only if a band is < 0.5× or > 2.0× the median band.
  const uniform = (bounds: number[]): boolean => {
    const bands = bounds.slice(1).map((c, i) => c - bounds[i]);
    const sorted = [...bands].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    if (med <= 0) return false;
    return bands.every((b) => b >= med * 0.5 && b <= med * 2.0);
  };
  if (!uniform(colBounds) || !uniform(rowBounds)) return null;

  return { colBounds, rowBounds };
}

/** Panel rect from detected boundaries, pulled 3–5 px inward to drop the white separator line. */
function panelRectFromBounds(colBounds: number[], rowBounds: number[], row: number, col: number) {
  const left0 = colBounds[col];
  const right0 = colBounds[col + 1];
  const top0 = rowBounds[row];
  const bottom0 = rowBounds[row + 1];
  const inset = Math.max(3, Math.min(5, Math.round((right0 - left0) * 0.01)));
  const left = left0 + inset;
  const top = top0 + inset;
  const width = Math.max(1, right0 - left0 - inset * 2);
  const height = Math.max(1, bottom0 - top0 - inset * 2);
  return { left, top, width, height };
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

  // Shot-list episode blocks live on the beats (Scene.beatMeta): LAYOUT (same on every beat), CHARACTER SHEETs
  // (per row's cast — merged here) and ROW tags. No Episode column is needed.
  const beatMetas = episode.scenes.map((s) => parseBeatMeta(s.beatMeta));
  const shotListLayout = beatMetas.find((b) => b?.layout)?.layout ?? null;
  const castSheets = new Map<string, string>();
  for (const b of beatMetas) for (const [n, sheet] of Object.entries(b?.castSheets ?? {})) if (sheet && !castSheets.has(n.toLowerCase())) castSheets.set(n.toLowerCase(), sheet);

  const characters: GridCharacter[] = episode.characters.map(({ character: c }) => ({
    id: c.id,
    name: c.name,
    appearance: c.appearance,
    role: c.role,
    sheet: castSheets.get(c.name.trim().toLowerCase()) ?? null,
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
        layout: shotListLayout,
      }
    : episode.locationName
    ? { id: "episode-location", name: episode.locationName, imageUrl: null, keyObjects: episode.locationDesc || null, layout: shotListLayout }
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
      ? { id: l.id, name: l.name || episode.locationName || "Location", imageUrl: validUrl(l.imageUrl) ? l.imageUrl : null, keyObjects: l.setInventory || l.visualPrompt || l.description || null, layout: shotListLayout, rows: [] as number[] }
      : { ...(location as GridLocation), rows: [] as number[] });
    if (!entry.rows!.includes(row)) entry.rows!.push(row);
    byLocation.set(key, entry);
  });
  const locations = Array.from(byLocation.values());

  // Simplified pipeline: beat scenes (Scene.beatMeta) describe each panel with the beat's shot size + freeze-frame
  // text (one picture, 0–1 verbs) and carry the row's theme tag ("ROW N TAG:").
  const scenes: GridSceneBeat[] = episode.scenes.map((s, i) => {
    const beat = beatMetas[i];
    if (beat) {
      return { number: s.number, title: `${beat.sceneTitle} — ${s.title}`, action: beat.action || s.action || s.title || null, shotType: beat.shot || s.shotType, rowTag: beat.rowTag ?? null };
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

    // Detect the grid from the WHITE separator lines between panels and cut on them (never a blind /N). null ⇒ the
    // separator lines were not found (margins/labels, or the sheet is not a clean grid) → ask for a clean re-gen
    // instead of hand-cutting garbage panels.
    const bounds = await analyzeGridBounds(sheet, totalW, totalH);
    if (!bounds) {
      await failJob(
        jobId,
        "Не удалось найти белые линии между кадрами. Перегенерируйте лист сториборда одной композицией с NO margins / NO labels (кадры вплотную, разделённые тонкими белыми линиями) — руками не режем.",
      );
      return;
    }
    const { colBounds, rowBounds } = bounds;
    const cols = colBounds.length - 1;
    const rows = rowBounds.length - 1;
    const detectedPanels = cols * rows;

    const scenes = episode.scenes;
    const ts = Date.now();
    let assigned = 0;
    const sliced: string[] = [];
    const toAssign = Math.min(detectedPanels, scenes.length);

    for (let i = 0; i < detectedPanels; i++) {
      if (await canceled()) throw new GenerationCanceledError();
      const row = Math.floor(i / cols);
      const col = i % cols;
      // Detected panel box → centred exact-9:16 sub-rect → 1080×1920, so every panel is uniform and undistorted.
      const rect = fitNineSixteen(panelRectFromBounds(colBounds, rowBounds, row, col));

      const scene = scenes[i];
      if (!scene) break; // fewer scenes than detected panels — only slice what maps to a scene

      const panelBuf = await sharp(sheet)
        .extract(rect)
        .resize(PANEL_OUT_W, PANEL_OUT_H, { fit: "fill" })
        .png()
        .toBuffer();
      // Row.Col naming (panel_R.C) so the sheet position is obvious in storage.
      const panelUrl = await uploadBufferToS3(
        panelBuf,
        `media/public/grid/${projectId}/${episodeId}/panel_${row + 1}.${col + 1}-${ts}.png`,
        "image/png",
      );
      // The panel is a COMPOSITION REFERENCE, not the final start frame. Keep it in beatMeta.gridPanelUrl; also seed
      // startFrameUrl so the redraw step (below) and the UI have something, but the redraw OVERWRITES it with a
      // freshly rendered full 9:16 frame. Never upscale the panel into the video.
      const prevBeat = parseBeatMeta(scene.beatMeta);
      await prisma.scene.update({
        where: { id: scene.id },
        data: {
          startFrameUrl: panelUrl,
          gridPanelIndex: i + 1,
          beatMeta: { ...(prevBeat ?? {}), gridPanelUrl: panelUrl },
        },
      });
      sliced.push(scene.id);
      assigned += 1;
      await updateJob(jobId, {
        progress: 15 + Math.round((60 * (i + 1)) / Math.max(1, toAssign)),
        message: `Размечаем кадр ${i + 1}/${toAssign} (сетка ${cols}×${rows})...`,
      });
    }

    // Validation: every scene that has a panel above it must have been assigned one. Panel EXTRACT sizes vary with the
    // detected grid (that is expected) — the OUTPUT is always 1080×1920 — so we check coverage, not extract size.
    if (assigned !== toAssign) {
      await failJob(
        jobId,
        `Нарезка не сошлась (размечено ${assigned}/${toAssign} кадров, сетка ${cols}×${rows}). Перегенерируйте лист одной композицией с NO margins / NO labels — руками не режем.`,
      );
      return;
    }

    await prisma.episode.update({ where: { id: episodeId }, data: { gridApproved: true } });

    // Panel ≠ start frame: hand the sliced scenes to the start-frame redraw, which regenerates each panel as a full
    // 9:16 frame (panel = composition ref image 1, plate = image 2, character height refs = image 3..N). If the
    // hand-off can't fire we still complete — the user can press «Полноразмерные старт-кадры» manually.
    let redrawStarted = false;
    if (sliced.length > 0) {
      try {
        const redrawJob = await prisma.generationJob.create({
          data: {
            type: REDRAW_START_FRAME_JOB_TYPE, status: "pending", progress: 0,
            message: `Полноразмерные старт-кадры: 0/${sliced.length}`, projectId,
            resultData: JSON.stringify({ episodeId, sceneIds: sliced, single: false }),
          },
        });
        const secret = getWorkerSecret();
        if (secret) {
          const r = await fetch(`${getBaseUrl()}/api/ai/workers/start-frame-redraw`, {
            method: "POST",
            headers: { "Content-Type": "application/json", [WORKER_SECRET_HEADER]: secret },
            body: JSON.stringify({ jobId: redrawJob.id, projectId, episodeId, sceneIds: sliced }),
          });
          redrawStarted = r.ok;
        }
        if (!redrawStarted) runInBackground(() => runRedrawStartFramesJob(redrawJob.id, projectId, episodeId, sliced));
        redrawStarted = true;
      } catch (e: any) {
        console.warn("[storyboard-grid-slice] auto start-frame redraw failed to start:", e?.message ?? e);
      }
    }

    await completeJob(
      jobId,
      { episodeId, panelsAssigned: assigned, redrawStarted },
      redrawStarted
        ? `Размечено ${assigned} панелей; генерирую полноразмерные старт-кадры`
        : `Размечено ${assigned} панелей (нажмите «Полноразмерные старт-кадры»)`,
    );
  } catch (err: any) {
    if (err instanceof GenerationCanceledError) { await markCanceled(jobId); return; }
    console.error("[storyboard-grid-slice] failed:", err);
    await failJob(jobId, err?.message ?? "Storyboard grid slicing failed");
  }
}
