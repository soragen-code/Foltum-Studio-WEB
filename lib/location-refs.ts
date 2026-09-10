import { prisma } from "@/lib/db";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runLocationImagesJob } from "@/lib/workers/location-image-job";
import { runLocationExtraImagesJob } from "@/lib/workers/location-extra-image-job";
import { parseLocationExtra } from "@/lib/visual-style";
import { LOCATION_TOTAL_TARGET, LOCATION_BASE_FRAMES } from "@/lib/location-scale";
import { CHARACTER_REFERENCE_COST } from "@/lib/power-tier";

/** Stage 16: max extra angles one request may generate — the full top-up to 15 frames (12 extra). */
const MAX_EXTRA_PER_REQUEST = LOCATION_TOTAL_TARGET - LOCATION_BASE_FRAMES;

export const LOCATION_JOB_TYPE = "location_image";
export const LOCATION_EXTRA_JOB_TYPE = "location_extra_image";
/** How many extra angle shots one «Добавить ещё ракурсы» request generates (base set stays 3). */
export const EXTRA_ANGLES_PER_REQUEST = 3;

/**
 * Charge + start a background job that renders reference PNGs for the given locations.
 * Same price as a character reference (CHARACTER_REFERENCE_COST per location); refunds the ones that failed.
 */
export async function startLocationImageJob(opts: { user: { id: string; credits: number | null }; projectId: string; locationIds: string[] }) {
  const { user, projectId } = opts;
  await failStaleJobs({ projectId, type: LOCATION_JOB_TYPE });
  const active = await prisma.generationJob.findFirst({ where: { projectId, type: LOCATION_JOB_TYPE, status: { in: ["pending", "processing"] } }, orderBy: { createdAt: "desc" } });
  if (active) {
    let rd: { locationIds?: string[] } = {};
    try { rd = active.resultData ? JSON.parse(active.resultData) : {}; } catch { rd = {}; }
    if (!rd.locationIds || opts.locationIds.some((l) => rd.locationIds!.includes(l))) return { jobId: active.id, resumed: true, count: 0, cost: 0 };
  }
  const locationIds = Array.from(new Set(opts.locationIds));
  const cost = locationIds.length * CHARACTER_REFERENCE_COST;
  if ((user.credits ?? 0) < cost)
    return { error: `Недостаточно кредитов: нужно ${cost}, на балансе ${user.credits ?? 0}`, status: 402 as const };
  const names = await prisma.location.findMany({ where: { id: { in: locationIds } }, select: { id: true, name: true, imageUrl: true } });
  const before = new Map(names.map((n) => [n.id, n.imageUrl]));
  await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: cost } } });
  await prisma.creditTransaction.create({ data: { userId: user.id, amount: -cost, description: `Референс локации: ${names.map((n) => n.name).join(", ")}` } });
  const job = await prisma.generationJob.create({
    data: { type: LOCATION_JOB_TYPE, status: "processing", progress: 5, message: `Генерация референсов локаций (${locationIds.length})…`, projectId, resultData: JSON.stringify({ locationIds }) },
  });
  runInBackground(async () => {
    await runLocationImagesJob({ jobId: job.id, projectId, locationIds });
    try {
      const after = await prisma.location.findMany({ where: { id: { in: locationIds } }, select: { id: true, name: true, imageUrl: true } });
      const failed = after.filter((l) => !l.imageUrl || l.imageUrl === before.get(l.id));
      if (failed.length) {
        const refund = failed.length * CHARACTER_REFERENCE_COST;
        await prisma.user.update({ where: { id: user.id }, data: { credits: { increment: refund } } });
        await prisma.creditTransaction.create({ data: { userId: user.id, amount: refund, description: `Возврат: референс локации не сгенерирован (${failed.map((l) => l.name).join(", ")})` } });
      }
    } catch (e) { console.error("[location-refs] refund check failed:", e); }
  });
  return { jobId: job.id, count: locationIds.length, cost, creditsRemaining: (user.credits ?? 0) - cost };
}

/**
 * Charge + start a background job that renders N EXTRA angle shots for ONE location (beyond the base 3).
 * Price: CHARACTER_REFERENCE_COST per extra shot; refunds any shots that failed to generate.
 */
export async function startLocationExtraImageJob(opts: { user: { id: string; credits: number | null }; projectId: string; locationId: string; count?: number }) {
  const { user, projectId, locationId } = opts;
  const count = Math.max(1, Math.min(opts.count ?? EXTRA_ANGLES_PER_REQUEST, MAX_EXTRA_PER_REQUEST));
  await failStaleJobs({ projectId, type: LOCATION_EXTRA_JOB_TYPE });

  const loc = await prisma.location.findFirst({ where: { id: locationId, projectId }, select: { id: true, name: true, imageUrl: true, imageExtra: true } });
  if (!loc) return { error: "Локация не найдена", status: 404 as const };
  if (!loc.imageUrl) return { error: "Сначала сгенерируйте базовые референсы локации", status: 409 as const };

  // Don't start a duplicate for the same location while one is running.
  const active = await prisma.generationJob.findFirst({ where: { projectId, type: LOCATION_EXTRA_JOB_TYPE, status: { in: ["pending", "processing"] } }, orderBy: { createdAt: "desc" } });
  if (active) {
    let rd: { locationId?: string } = {};
    try { rd = active.resultData ? JSON.parse(active.resultData) : {}; } catch { rd = {}; }
    if (rd.locationId === locationId) return { jobId: active.id, resumed: true, count: 0, cost: 0 };
  }

  const cost = count * CHARACTER_REFERENCE_COST;
  if ((user.credits ?? 0) < cost)
    return { error: `Недостаточно кредитов: нужно ${cost}, на балансе ${user.credits ?? 0}`, status: 402 as const };

  const beforeCount = parseLocationExtra(loc.imageExtra).length;
  await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: cost } } });
  await prisma.creditTransaction.create({ data: { userId: user.id, amount: -cost, description: `Доп. ракурсы локации: ${loc.name} (${count})` } });
  const job = await prisma.generationJob.create({
    data: { type: LOCATION_EXTRA_JOB_TYPE, status: "processing", progress: 5, message: `Дополнительные ракурсы локации «${loc.name}» (${count})…`, projectId, resultData: JSON.stringify({ locationId, count }) },
  });
  runInBackground(async () => {
    await runLocationExtraImagesJob({ jobId: job.id, projectId, locationId, count });
    try {
      const after = await prisma.location.findFirst({ where: { id: locationId }, select: { imageExtra: true } });
      const added = Math.max(0, parseLocationExtra(after?.imageExtra).length - beforeCount);
      const missing = count - added;
      if (missing > 0) {
        const refund = missing * CHARACTER_REFERENCE_COST;
        await prisma.user.update({ where: { id: user.id }, data: { credits: { increment: refund } } });
        await prisma.creditTransaction.create({ data: { userId: user.id, amount: refund, description: `Возврат: доп. ракурсы локации не сгенерированы (${loc.name}, ${missing})` } });
      }
    } catch (e) { console.error("[location-refs] extra refund check failed:", e); }
  });
  return { jobId: job.id, count, cost, creditsRemaining: (user.credits ?? 0) - cost };
}
