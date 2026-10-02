/**
 * Поток v2 · сцены серий: атомарные записи в Project.episodeScenesV2 (JSONB, { "<n>": { items, updatedAt } }).
 * Все записи — одним UPDATE на строку проекта, чтобы параллельные сцены/серии не затирали друг друга.
 */
import { prisma } from "@/lib/db";
import type { EpisodeSceneV2 } from "@/lib/idea-v2";

export { episodeOfJob, activeEpisodeJob, latestEpisodeJob } from "@/lib/episode-refs-v2-store";

/** Записать весь список сцен серии n (остальные серии не трогаются). */
export async function setEpisodeScenesV2(projectId: string, n: number, items: EpisodeSceneV2[]): Promise<void> {
  const entry = JSON.stringify({ items, updatedAt: new Date().toISOString() });
  await prisma.$executeRaw`UPDATE "Project" SET "episodeScenesV2" = COALESCE("episodeScenesV2", '{}'::jsonb) || jsonb_build_object(${String(n)}::text, ${entry}::jsonb) WHERE "id" = ${projectId}`;
}

/** Слить patch в одну сцену (по id) серии n; прочие сцены и серии не трогаются. Возвращает число обновлённых строк. */
export async function patchEpisodeSceneV2(projectId: string, n: number, sceneId: string, patch: Partial<EpisodeSceneV2>): Promise<number> {
  const key = String(n);
  const p = JSON.stringify(patch);
  return prisma.$executeRaw`
    UPDATE "Project" SET "episodeScenesV2" = jsonb_set("episodeScenesV2", ARRAY[${key}::text, 'items'],
      (SELECT COALESCE(jsonb_agg(CASE WHEN e->>'id' = ${sceneId} THEN e || ${p}::jsonb ELSE e END ORDER BY ord), '[]'::jsonb)
         FROM jsonb_array_elements("episodeScenesV2"->${key}::text->'items') WITH ORDINALITY AS t(e, ord)))
    WHERE "id" = ${projectId} AND jsonb_typeof("episodeScenesV2"->${key}::text->'items') = 'array'`;
}
