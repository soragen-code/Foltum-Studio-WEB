import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { DRAFT_V2_STAGES } from "@/lib/idea-v2";

/**
 * /admin/dramas — список ВСЕХ проектов (драм) всех пользователей, отсортированный по числу
 * готовых эпизодов (episodeFinalV2[n].status === "done" — финальное видео собрано), затем по updatedAt.
 * Подсчёт делается в SQL (jsonb_each), чтобы пагинация работала поверх правильной сортировки,
 * а не грузила все проекты в память. Показываются ТОЛЬКО драмы с хотя бы одной собранной серией
 * (readyEpisodes >= 1); черновики v2 отсекаются автоматически (у них нет финалов), но фильтр оставлен явно.
 */

export const DRAMAS_PAGE_SIZES = [20, 50, 100] as const;
export type DramasPageSize = (typeof DRAMAS_PAGE_SIZES)[number];
export const DRAMAS_DEFAULT_PAGE_SIZE: DramasPageSize = 20;

export type AdminDramaRow = {
  id: string;
  name: string;
  stage: string;
  isTest: boolean;
  ownerEmail: string;
  ownerName: string | null;
  episodeCount: number | null;
  readyEpisodes: number;
  createdAt: Date;
  updatedAt: Date;
  episodeRefsV2: unknown;
};

export type AdminDramasPage = {
  rows: AdminDramaRow[];
  total: number;
  page: number; // 1-based, уже зажата в [1, pages]
  pages: number; // >= 1
  per: DramasPageSize;
};

export function parsePageSize(raw: string | string[] | undefined): DramasPageSize {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return (DRAMAS_PAGE_SIZES as readonly number[]).includes(n) ? (n as DramasPageSize) : DRAMAS_DEFAULT_PAGE_SIZE;
}

export function parsePage(raw: string | string[] | undefined): number {
  const n = Math.floor(Number(Array.isArray(raw) ? raw[0] : raw));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

type RawRow = {
  id: string;
  name: string;
  stage: string;
  isTest: boolean;
  ownerEmail: string;
  ownerName: string | null;
  episodeCount: number | null;
  readyEpisodes: number;
  createdAt: Date;
  updatedAt: Date;
  episodeRefsV2: unknown;
};

export async function getAdminDramas(opts: { page: number; per: DramasPageSize }): Promise<AdminDramasPage> {
  const per = opts.per;
  // Черновики: newFlow && stage ∈ DRAFT_V2_STAGES — исключаем (как в /api/projects: NOT draftWhere).
  const notDraft = Prisma.sql`NOT (p."newFlow" = true AND p.stage IN (${Prisma.join([...DRAFT_V2_STAGES])}))`;

  // Готовый эпизод = episodeFinalV2[n].status === 'done' (финальное видео собрано).
  const readyExpr = Prisma.sql`(
        SELECT count(*)::int
        FROM jsonb_each(COALESCE(p."episodeFinalV2", '{}'::jsonb)) e
        WHERE e.value->>'status' = 'done'
      )`;
  // Показываем ТОЛЬКО драмы, где собрана хотя бы одна серия.
  const where = Prisma.sql`${notDraft} AND ${readyExpr} >= 1`;

  const totalRows = await prisma.$queryRaw<{ total: number }[]>`
    SELECT count(*)::int AS total FROM "Project" p WHERE ${where}
  `;
  const total = totalRows[0]?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / per));
  const page = Math.min(Math.max(1, opts.page), pages);
  const offset = (page - 1) * per;

  const rows = await prisma.$queryRaw<RawRow[]>`
    SELECT
      p.id,
      p.name,
      p.stage,
      p."isTest",
      u.email AS "ownerEmail",
      u.name AS "ownerName",
      p."episodeCount",
      ${readyExpr} AS "readyEpisodes",
      p."createdAt",
      p."updatedAt",
      p."episodeRefsV2"
    FROM "Project" p
    JOIN "User" u ON u.id = p."userId"
    WHERE ${where}
    ORDER BY "readyEpisodes" DESC, p."updatedAt" DESC
    LIMIT ${per} OFFSET ${offset}
  `;

  return {
    rows: rows.map((r) => ({ ...r, readyEpisodes: Number(r.readyEpisodes ?? 0) })),
    total,
    page,
    pages,
    per,
  };
}
