import { prisma } from "@/lib/db";
import { runInBackground, failStaleJobs } from "@/lib/jobs";
import { runLocationImagesJob } from "@/lib/workers/location-image-job";
import { CHARACTER_REFERENCE_COST } from "@/lib/power-tier";

export const LOCATION_JOB_TYPE = "location_image";

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
