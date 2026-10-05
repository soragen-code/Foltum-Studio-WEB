import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { DRAFT_V2_STAGES, episodeFinalV2From, parseSeasonPlotV2, type EpisodeFinalV2 } from "@/lib/idea-v2";
import { pickProjectCoverV2 } from "@/lib/project-cover";

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

/* ───────────── /admin/dramas/[id] — список собранных серий драмы для плеера ───────────── */

export type AdminDramaEpisode = {
  n: number;
  videoUrl: string;
  musicUrl: string | null;
  updatedAt: string | null;
  /** Краткое описание серии из сюжета сезона (первые ~160 символов), если есть. */
  summary: string | null;
};

export type AdminDramaDetail = {
  id: string;
  name: string;
  ownerEmail: string;
  ownerName: string | null;
  episodeCount: number | null;
  cover: string | null;
  episodes: AdminDramaEpisode[]; // только status === 'done' с videoUrl, по возрастанию n
};

export async function getAdminDramaDetail(id: string): Promise<AdminDramaDetail | null> {
  const p = await prisma.project.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      episodeCount: true,
      episodeFinalV2: true,
      episodeRefsV2: true,
      seasonPlotV2: true,
      user: { select: { email: true, name: true } },
    },
  });
  if (!p) return null;

  const plot = parseSeasonPlotV2(p.seasonPlotV2);
  const summaryOf = (n: number): string | null => {
    const text = plot?.find((e) => e.n === n)?.text;
    if (!text) return null;
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length > 160 ? oneLine.slice(0, 157).trimEnd() + "…" : oneLine;
  };

  const map = p.episodeFinalV2 && typeof p.episodeFinalV2 === "object" && !Array.isArray(p.episodeFinalV2)
    ? (p.episodeFinalV2 as Record<string, unknown>)
    : {};
  const episodes: AdminDramaEpisode[] = Object.keys(map)
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b)
    .map((n) => ({ n, final: episodeFinalV2From(map, n) }))
    .filter((x): x is { n: number; final: EpisodeFinalV2 & { videoUrl: string } } => !!x.final && x.final.status === "done" && !!x.final.videoUrl)
    .map(({ n, final }) => ({ n, videoUrl: final.videoUrl, musicUrl: final.musicUrl ?? null, updatedAt: final.updatedAt ?? null, summary: summaryOf(n) }));

  return {
    id: p.id,
    name: p.name,
    ownerEmail: p.user.email,
    ownerName: p.user.name ?? null,
    episodeCount: p.episodeCount,
    cover: pickProjectCoverV2(p.episodeRefsV2),
    episodes,
  };
}
