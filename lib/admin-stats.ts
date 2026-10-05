/**
 * Admin statistics (server-only) for /admin — aggregated straight from Prisma.
 *
 * "Today" is the calendar day in Europe/Kyiv (the owner's timezone); the other periods are rolling
 * windows ending now (7 / 30 / 365 days). Revenue counts only payments with status "approved"
 * (WayForPay callback) — refunded / declined / pending are excluded.
 */
import { prisma } from "@/lib/db";

export const ADMIN_TZ = "Europe/Kyiv";

export type PeriodKey = "today" | "week" | "month" | "year" | "all";
export const PERIODS: readonly PeriodKey[] = ["today", "week", "month", "year", "all"];
export const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: "Сегодня",
  week: "7 дней",
  month: "30 дней",
  year: "Год",
  all: "Всего",
};

function tzOffsetMinutes(tz: string, date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUTC - date.getTime()) / 60000);
}

/** Start of the current calendar day in `tz` as an absolute Date. */
export function startOfTodayIn(tz: string, now = new Date()): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  return new Date(guess.getTime() - tzOffsetMinutes(tz, guess) * 60000);
}

export function periodStarts(now = new Date()): Record<PeriodKey, Date | null> {
  const day = 24 * 60 * 60 * 1000;
  return {
    today: startOfTodayIn(ADMIN_TZ, now),
    week: new Date(now.getTime() - 7 * day),
    month: new Date(now.getTime() - 30 * day),
    year: new Date(now.getTime() - 365 * day),
    all: null,
  };
}

export type MoneyByCurrency = Record<string, number>; // currency → amount

export type RevenueCell = {
  total: MoneyByCurrency;
  subscriptions: MoneyByCurrency;
  credits: MoneyByCurrency;
  count: number;
};

export type AdminStats = {
  generatedAt: Date;
  periodStarts: Record<PeriodKey, Date | null>;
  newUsers: Record<PeriodKey, number>;
  totalUsers: number;
  activeSubscriptions: { tier: string; count: number }[];
  activeSubscriptionsTotal: number;
  subscriptionsToday: { tier: string; count: number; amount: MoneyByCurrency }[];
  paymentsToday: {
    id: string;
    createdAt: Date;
    email: string;
    kind: string;
    tier: string | null;
    productName: string;
    amount: number;
    currency: string;
    credits: number;
  }[];
  creditsTotal: number;
  usersWithCredits: number;
  revenue: Record<PeriodKey, RevenueCell>;
};

function addMoney(target: MoneyByCurrency, currency: string, amount: number) {
  const cur = (currency || "USD").toUpperCase();
  target[cur] = Math.round(((target[cur] ?? 0) + amount) * 100) / 100;
}

export async function getAdminStats(now = new Date()): Promise<AdminStats> {
  const starts = periodStarts(now);
  const approved = { status: "approved" as const };

  const [totalUsers, newUserCounts, activeByTier, subsToday, paymentsTodayRaw, creditsAgg, usersWithCredits, revenueRows] =
    await Promise.all([
      prisma.user.count(),
      Promise.all(
        PERIODS.map((p) => {
          const gte = starts[p];
          return gte ? prisma.user.count({ where: { createdAt: { gte } } }) : prisma.user.count();
        })
      ),
      prisma.user.groupBy({
        by: ["subscriptionTier"],
        where: { subscriptionTier: { not: null, notIn: ["free"] }, subscriptionExpiresAt: { gt: now } },
        _count: { _all: true },
      }),
      prisma.payment.findMany({
        where: { ...approved, kind: "subscription", createdAt: { gte: starts.today! } },
        select: { tier: true, productName: true, amount: true, currency: true },
      }),
      prisma.payment.findMany({
        where: { ...approved, createdAt: { gte: starts.today! } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          createdAt: true,
          kind: true,
          tier: true,
          productName: true,
          amount: true,
          currency: true,
          credits: true,
          user: { select: { email: true } },
        },
      }),
      prisma.user.aggregate({ _sum: { credits: true } }),
      prisma.user.count({ where: { credits: { gt: 0 } } }),
      prisma.payment.findMany({
        where: { ...approved, ...(starts.year ? { createdAt: { gte: starts.year } } : {}) },
        select: { createdAt: true, kind: true, amount: true, currency: true },
      }),
    ]);

  // Revenue older than a year is only needed for the "all" column — fetch it as grouped sums.
  const olderRows = await prisma.payment.groupBy({
    by: ["kind", "currency"],
    where: { ...approved, createdAt: { lt: starts.year! } },
    _sum: { amount: true },
    _count: { _all: true },
  });

  const newUsers = Object.fromEntries(PERIODS.map((p, i) => [p, newUserCounts[i]])) as Record<PeriodKey, number>;

  const activeSubscriptions = activeByTier
    .map((r) => ({ tier: r.subscriptionTier ?? "unknown", count: r._count._all }))
    .sort((a, b) => b.count - a.count);

  const subsTodayMap = new Map<string, { tier: string; count: number; amount: MoneyByCurrency }>();
  for (const s of subsToday) {
    const tier = s.tier ?? s.productName ?? "unknown";
    const row = subsTodayMap.get(tier) ?? { tier, count: 0, amount: {} };
    row.count += 1;
    addMoney(row.amount, s.currency, s.amount);
    subsTodayMap.set(tier, row);
  }

  const emptyCell = (): RevenueCell => ({ total: {}, subscriptions: {}, credits: {}, count: 0 });
  const revenue = Object.fromEntries(PERIODS.map((p) => [p, emptyCell()])) as Record<PeriodKey, RevenueCell>;
  const addRow = (cell: RevenueCell, kind: string, currency: string, amount: number, count = 1) => {
    addMoney(cell.total, currency, amount);
    addMoney(kind === "subscription" ? cell.subscriptions : cell.credits, currency, amount);
    cell.count += count;
  };
  for (const r of revenueRows) {
    for (const p of PERIODS) {
      const gte = starts[p];
      if (!gte || r.createdAt >= gte) addRow(revenue[p], r.kind, r.currency, r.amount);
    }
  }
  for (const r of olderRows) addRow(revenue.all, r.kind, r.currency, r._sum.amount ?? 0, r._count._all);

  return {
    generatedAt: now,
    periodStarts: starts,
    newUsers,
    totalUsers,
    activeSubscriptions,
    activeSubscriptionsTotal: activeSubscriptions.reduce((a, r) => a + r.count, 0),
    subscriptionsToday: [...subsTodayMap.values()].sort((a, b) => b.count - a.count),
    paymentsToday: paymentsTodayRaw.map((p) => ({
      id: p.id,
      createdAt: p.createdAt,
      email: p.user?.email ?? "—",
      kind: p.kind,
      tier: p.tier,
      productName: p.productName,
      amount: p.amount,
      currency: p.currency,
      credits: p.credits,
    })),
    creditsTotal: creditsAgg._sum.credits ?? 0,
    usersWithCredits,
    revenue,
  };
}

/** "$399.00" / "1 200.00 UAH" / several currencies joined with " + "; "—" when empty. */
export function formatMoney(m: MoneyByCurrency): string {
  const entries = Object.entries(m).filter(([, v]) => v !== 0);
  if (!entries.length) return "—";
  return entries
    .map(([cur, v]) => {
      const num = v.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return cur === "USD" ? `$${num}` : `${num} ${cur}`;
    })
    .join(" + ");
}
