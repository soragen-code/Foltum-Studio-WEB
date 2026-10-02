/**
 * Поток v2 · сториборд серий: атомарные записи в Project.episodeStoryboardV2 (JSONB, { "<n>": { imageUrl?, prompt?, status?, error?, updatedAt } }).
 * Одна запись на серию (единый лист, не массив). Пишется одним UPDATE на строку проекта, чтобы параллельные серии не затирали друг друга.
 * Общие хелперы задач (episodeOfJob / activeEpisodeJob / latestEpisodeJob) переиспользуются из refs-store.
 */
import { prisma } from "@/lib/db";
import type { EpisodeStoryboardV2 } from "@/lib/idea-v2";

export { episodeOfJob, activeEpisodeJob, latestEpisodeJob } from "@/lib/episode-refs-v2-store";

/** Слить patch в сториборд серии n (остальные серии не трогаются); updatedAt проставляется автоматически. */
export async function setEpisodeStoryboardV2(projectId: string, n: number, patch: Partial<EpisodeStoryboardV2>): Promise<void> {
  const entry = JSON.stringify({ ...patch, updatedAt: new Date().toISOString() });
  await prisma.$executeRaw`UPDATE "Project" SET "episodeStoryboardV2" = COALESCE("episodeStoryboardV2", '{}'::jsonb) || jsonb_build_object(${String(n)}::text, COALESCE("episodeStoryboardV2"->${String(n)}::text, '{}'::jsonb) || ${entry}::jsonb) WHERE "id" = ${projectId}`;
}
