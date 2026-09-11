/**
 * Stage 46B — stage-based progress for a scene video job (pure, unit-testable).
 *
 * The bar no longer creeps with a timer: every value maps to a REAL stage of the job.
 *   queued     «В очереди»                         5 %
 *   rendering  «Рендер видео (Seedance)… mm:ss»   40 % (or the model's own percent, if its logs report one)
 *   uploading  «Загрузка видео»                   85 %
 *   verifying  «Проверка»                          95 %
 *   done       «Видео готово»                     100 %
 */

export type SceneStage = "queued" | "rendering" | "uploading" | "verifying" | "done";

export const SCENE_STAGE_PROGRESS: Record<SceneStage, number> = {
  queued: 5,
  rendering: 40,
  uploading: 85,
  verifying: 95,
  done: 100,
};

export const SCENE_STAGE_MESSAGE: Record<SceneStage, string> = {
  queued: "В очереди",
  rendering: "Рендер видео (Seedance)…",
  uploading: "Загрузка видео",
  verifying: "Проверка",
  done: "Видео готово",
};

/** `mm:ss` for an elapsed duration (never negative). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Best-effort percent from provider logs (e.g. `  42%|████` tqdm lines, or `progress: 0.42`).
 * Returns null when the logs carry no usable percent (Seedance today reports none).
 */
export function parseLogPercent(logs?: string | null): number | null {
  if (!logs) return null;
  const pct = [...logs.matchAll(/(\d{1,3})%/g)].map((m) => Number(m[1])).filter((n) => n >= 0 && n <= 100);
  if (pct.length) return pct[pct.length - 1];
  const frac = [...logs.matchAll(/progress[^0-9]{0,4}(0?\.\d+|1(?:\.0+)?)\b/gi)].map((m) => Number(m[1]));
  if (frac.length) return Math.round(frac[frac.length - 1] * 100);
  return null;
}

/**
 * Map the provider prediction status (+ elapsed render time and optional logs) to the bar state
 * while the job waits for the model. Terminal / upload stages are set by the worker directly.
 */
export function sceneProgressStage(
  status: "starting" | "processing" | string,
  elapsedMs: number,
  logs?: string | null
): { stage: SceneStage; progress: number; message: string } {
  if (status === "starting") {
    return { stage: "queued", progress: SCENE_STAGE_PROGRESS.queued, message: SCENE_STAGE_MESSAGE.queued };
  }
  const logPct = parseLogPercent(logs);
  // Rendering spans 5 → 85 %; without a model percent the bar holds at 40 % and the timer text moves.
  const progress =
    logPct === null
      ? SCENE_STAGE_PROGRESS.rendering
      : Math.max(SCENE_STAGE_PROGRESS.queued, Math.min(SCENE_STAGE_PROGRESS.uploading - 1, Math.round(5 + (logPct / 100) * 79)));
  const suffix = logPct === null ? "" : ` · ${logPct}%`;
  return { stage: "rendering", progress, message: `${SCENE_STAGE_MESSAGE.rendering} ${formatElapsed(elapsedMs)}${suffix}` };
}
