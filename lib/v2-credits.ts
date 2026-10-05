/**
 * Списание кредитов за шаги потока v2 (серверная часть; ставки — lib/v2-costs.ts).
 *   chargeV2Credits  — атомарно (updateMany where credits >= cost) снимает cost с пользователя и пишет CreditTransaction
 *                      с описанием "v2:<step> job <jobId>"; при нехватке → { ok:false, status:402, body } для ответа роута.
 *   refundV2JobCredits — возврат по упавшей job: ищет списание с этим jobId и, если возврата ещё не было,
 *                      начисляет сумму обратно (вызывается из failJob в lib/jobs.ts; идемпотентно).
 * Бесплатные шаги (cost 0) ничего не пишут.
 */
import { prisma } from "@/lib/db";
import { translate } from "@/lib/i18n/dictionary";
import { localeOf } from "@/lib/i18n/server";

export type V2ChargeResult =
  | { ok: true; cost: number; creditsRemaining: number }
  | { ok: false; status: 402; body: { error: string; code: "INSUFFICIENT_CREDITS"; cost: number; balance: number } };

export function v2ChargeDescription(step: string, jobId: string): string {
  return `v2:${step} job ${jobId}`;
}

export async function chargeV2Credits(userId: string, cost: number, step: string, jobId: string): Promise<V2ChargeResult> {
  const amount = Math.max(0, Math.round(cost));
  if (amount === 0) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { credits: true } });
    return { ok: true, cost: 0, creditsRemaining: u?.credits ?? 0 };
  }
  const res = await prisma.user.updateMany({ where: { id: userId, credits: { gte: amount } }, data: { credits: { decrement: amount } } });
  if (res.count === 0) {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { credits: true, locale: true } });
    const balance = u?.credits ?? 0;
    const error = translate(localeOf(u?.locale), "api.insufficientCredits", { cost: amount, balance });
    return { ok: false, status: 402, body: { error, code: "INSUFFICIENT_CREDITS", cost: amount, balance } };
  }
  await prisma.creditTransaction.create({ data: { userId, amount: -amount, description: v2ChargeDescription(step, jobId) } });
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { credits: true } });
  return { ok: true, cost: amount, creditsRemaining: u?.credits ?? 0 };
}

/** Вернуть кредиты за job, если за неё списывали и возврата ещё не было. Никогда не бросает. */
export async function refundV2JobCredits(jobId: string): Promise<number> {
  try {
    const charge = await prisma.creditTransaction.findFirst({
      where: { description: { endsWith: ` job ${jobId}` }, amount: { lt: 0 } },
      select: { userId: true, amount: true, description: true },
    });
    if (!charge) return 0;
    const refundDesc = `refund ${charge.description}`;
    const done = await prisma.creditTransaction.findFirst({ where: { userId: charge.userId, description: refundDesc }, select: { id: true } });
    if (done) return 0;
    const amount = -charge.amount;
    await prisma.$transaction([
      prisma.user.update({ where: { id: charge.userId }, data: { credits: { increment: amount } } }),
      prisma.creditTransaction.create({ data: { userId: charge.userId, amount, description: refundDesc } }),
    ]);
    return amount;
  } catch (e) {
    console.error("refundV2JobCredits failed:", e);
    return 0;
  }
}
