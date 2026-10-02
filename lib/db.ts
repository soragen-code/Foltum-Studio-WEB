import { PrismaClient } from '@prisma/client'

/**
 * Prod использует пулер Neon (pgbouncer). Внутри одной долгой serverless-инвокации (maxDuration 800)
 * фоновые воркеры с конкурентностью (нарезка кадров/видео сцен, read-modify-write patch'и) конкурируют
 * с хендлерами запросов за слоты внутреннего пула Prisma. Дефолтный пул мал (≈num_cpu*2+1), из-за чего
 * `findUnique()` падает с «Timed out fetching a new connection from the connection pool».
 * pgbouncer мультиплексирует реальные соединения Postgres, поэтому можно безопасно поднять лимит пула
 * Prisma и его таймаут. Дополняем URL параметрами, только если они ещё не заданы в окружении.
 */
const POOL_LIMIT = 15
const POOL_TIMEOUT = 30

function withPoolParams(raw: string | undefined): string | undefined {
  if (!raw) return raw
  try {
    const u = new URL(raw)
    if (!u.searchParams.has('connection_limit')) u.searchParams.set('connection_limit', String(POOL_LIMIT))
    if (!u.searchParams.has('pool_timeout')) u.searchParams.set('pool_timeout', String(POOL_TIMEOUT))
    return u.toString()
  } catch {
    return raw
  }
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

const datasourceUrl = withPoolParams(process.env.DATABASE_URL)

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : undefined)

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
