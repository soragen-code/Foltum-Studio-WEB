/**
 * v2 «Сцены»: общий бюджет времени и метаданные job для возобновляемых воркеров
 * (episode_scene_frames_v2 / episode_scene_video_v2 / episode_assemble_v2).
 *
 * Воркер крутится в after() инвокации с maxDuration=800с. Чтобы не быть убитым посреди работы, он сам уступает
 * до лимита: перестаёт брать новые сцены после SOFT, а ожидание провайдера прерывает после HARD — оставляя
 * незавершённые сцены в pending/running (с id задачи провайдера). Замолчавшую job подхватывает cron
 * (resumeEpisodeScenesV2Jobs) и перезапускает воркер, который продолжает с того же места.
 */
import { prisma } from "@/lib/db";
import { updateJob } from "@/lib/jobs";

/** После этого времени от старта воркер не начинает новые сцены. */
export const V2_SOFT_BUDGET_MS = 520_000;
/** После этого времени воркер прерывает ожидание провайдера и уступает (запас до maxDuration 800с). */
export const V2_HARD_BUDGET_MS = 720_000;

/** Выброс «уступить по бюджету»: сцена остаётся в pending/running, job — в processing до подхвата cron. */
export class V2BudgetYield extends Error {
  constructor() { super("v2 worker yielded (time budget)"); }
}

export interface V2JobMeta {
  episode: number;
  /** Подготовка (список сцен / выбор сцен) уже выполнена — возобновление её не повторяет. */
  prepared?: boolean;
  /** id сцен, которые обрабатывает эта job (video). */
  sceneIds?: string[];
  /** Сколько раз cron переподхватывал job. */
  resumes?: number;
  [k: string]: unknown;
}

export async function readV2JobMeta(jobId: string): Promise<V2JobMeta | null> {
  const job = await prisma.generationJob.findUnique({ where: { id: jobId }, select: { resultData: true } });
  try { return JSON.parse(job?.resultData ?? "null"); } catch { return null; }
}

/** Слить patch в resultData job (поле episode сохраняется — по нему activeEpisodeJob/latestEpisodeJob ищут job). */
export async function patchV2JobMeta(jobId: string, patch: Partial<V2JobMeta>): Promise<V2JobMeta> {
  const cur = (await readV2JobMeta(jobId)) ?? ({} as V2JobMeta);
  const next = { ...cur, ...patch } as V2JobMeta;
  await updateJob(jobId, { resultData: JSON.stringify(next) });
  return next;
}

/** Таймер бюджета от старта текущей инвокации воркера. */
export function v2Budget(startedAt = Date.now()) {
  return {
    soft: () => Date.now() - startedAt > V2_SOFT_BUDGET_MS,
    hard: () => Date.now() - startedAt > V2_HARD_BUDGET_MS,
  };
}
