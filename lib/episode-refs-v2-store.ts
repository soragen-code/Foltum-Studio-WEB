/**
 * Поток v2 · рефы серий: атомарные записи в Project.episodeRefsV2 (JSONB, { "<n>": { items, updatedAt } }).
 * Все записи — одним UPDATE на строку проекта, чтобы параллельные серии/рефы не затирали друг друга.
 */
import { prisma } from "@/lib/db";
import type { EpisodeRefV2 } from "@/lib/idea-v2";

/** Записать весь список рефов серии n (остальные серии не трогаются). */
export async function setEpisodeRefsV2(projectId: string, n: number, items: EpisodeRefV2[]): Promise<void> {
  const entry = JSON.stringify({ items, updatedAt: new Date().toISOString() });
  await prisma.$executeRaw`UPDATE "Project" SET "episodeRefsV2" = COALESCE("episodeRefsV2", '{}'::jsonb) || jsonb_build_object(${String(n)}::text, ${entry}::jsonb) WHERE "id" = ${projectId}`;
}

/** Слить patch в один реф (по id) серии n; прочие рефы и серии не трогаются. Возвращает число обновлённых строк. */
export async function patchEpisodeRefV2(projectId: string, n: number, id: string, patch: Partial<EpisodeRefV2>): Promise<number> {
  const key = String(n);
  const p = JSON.stringify(patch);
  return prisma.$executeRaw`
    UPDATE "Project" SET "episodeRefsV2" = jsonb_set("episodeRefsV2", ARRAY[${key}::text, 'items'],
      (SELECT COALESCE(jsonb_agg(CASE WHEN e->>'id' = ${id} THEN e || ${p}::jsonb ELSE e END ORDER BY ord), '[]'::jsonb)
         FROM jsonb_array_elements("episodeRefsV2"->${key}::text->'items') WITH ORDINALITY AS t(e, ord)))
    WHERE "id" = ${projectId} AND jsonb_typeof("episodeRefsV2"->${key}::text->'items') = 'array'`;
}

/** Номер серии задачи (resultData.episode), либо null. */
export function episodeOfJob(job: { resultData?: string | null }): number | null {
  try { const n = Number(JSON.parse(job.resultData ?? "null")?.episode); return Number.isInteger(n) ? n : null } catch { return null }
}

/** Активная задача данного типа для серии n. */
export async function activeEpisodeJob(projectId: string, type: string, n: number) {
  const active = await prisma.generationJob.findMany({ where: { projectId, type, status: { in: ["pending", "processing"] } }, orderBy: { createdAt: "desc" } });
  return active.find((j) => episodeOfJob(j) === n) ?? null;
}

/** Последняя задача данного типа для серии n (для возобновления поллинга). */
export async function latestEpisodeJob(projectId: string, type: string, n: number) {
  const recent = await prisma.generationJob.findMany({ where: { projectId, type }, orderBy: { createdAt: "desc" }, take: 50 });
  const latest = recent.find((j) => episodeOfJob(j) === n) ?? null;
  let result: any = null;
  if (latest?.resultData) { try { result = JSON.parse(latest.resultData); } catch {} }
  return latest ? { ...latest, result } : null;
}
