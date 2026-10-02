/**
 * Поток v2 · шот-лист серий: атомарные записи в Project.episodeShotsV2 (JSONB, { "<n>": { items, updatedAt } }).
 * Все записи — одним UPDATE на строку проекта, чтобы параллельные серии не затирали друг друга.
 * Общие хелперы задач (episodeOfJob / activeEpisodeJob / latestEpisodeJob) переиспользуются из refs-store.
 */
import { prisma } from "@/lib/db";
import type { EpisodeShotV2 } from "@/lib/idea-v2";

export { episodeOfJob, activeEpisodeJob, latestEpisodeJob } from "@/lib/episode-refs-v2-store";

/** Записать весь список шотов серии n (остальные серии не трогаются). */
export async function setEpisodeShotsV2(projectId: string, n: number, items: EpisodeShotV2[]): Promise<void> {
  const entry = JSON.stringify({ items, updatedAt: new Date().toISOString() });
  await prisma.$executeRaw`UPDATE "Project" SET "episodeShotsV2" = COALESCE("episodeShotsV2", '{}'::jsonb) || jsonb_build_object(${String(n)}::text, ${entry}::jsonb) WHERE "id" = ${projectId}`;
}

/** Слить patch в один шот (по id) серии n; прочие шоты и серии не трогаются. Возвращает число обновлённых строк. */
export async function patchEpisodeShotV2(projectId: string, n: number, id: string, patch: Partial<EpisodeShotV2>): Promise<number> {
  const key = String(n);
  const p = JSON.stringify(patch);
  return prisma.$executeRaw`
    UPDATE "Project" SET "episodeShotsV2" = jsonb_set("episodeShotsV2", ARRAY[${key}::text, 'items'],
      (SELECT COALESCE(jsonb_agg(CASE WHEN e->>'id' = ${id} THEN e || ${p}::jsonb ELSE e END ORDER BY ord), '[]'::jsonb)
         FROM jsonb_array_elements("episodeShotsV2"->${key}::text->'items') WITH ORDINALITY AS t(e, ord)))
    WHERE "id" = ${projectId} AND jsonb_typeof("episodeShotsV2"->${key}::text->'items') = 'array'`;
}
