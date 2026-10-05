import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Users, Crown, Coins, Wallet, ShoppingBag } from 'lucide-react'
import { Header } from '@/components/header'
import { isAdminEmail } from '@/lib/admin'
import { ADMIN_TZ, PERIODS, PERIOD_LABELS, formatMoney, getAdminStats, type PeriodKey } from '@/lib/admin-stats'
import { TIER_NAMES } from '@/lib/entitlements'

export const dynamic = 'force-dynamic'

/**
 * /admin — статистика для владельца. Доступно ТОЛЬКО админ/тестовому аккаунту (lib/admin.ts);
 * остальные уходят на /dashboard. Страница владельца — тексты по-русски, без локализации.
 */
export default async function AdminPage() {
  const session = await auth()
  if (!session?.user) redirect('/login')
  if (!isAdminEmail(session.user.email)) redirect('/dashboard')

  const s = await getAdminStats()

  const fmtDateTime = (d: Date) =>
    d.toLocaleString('ru-RU', { timeZone: ADMIN_TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  const fmtTime = (d: Date) => d.toLocaleString('ru-RU', { timeZone: ADMIN_TZ, hour: '2-digit', minute: '2-digit' })
  const tierName = (t: string | null) => (t && t in TIER_NAMES ? TIER_NAMES[t as keyof typeof TIER_NAMES] : t ?? '—')
  const fmtInt = (n: number) => n.toLocaleString('ru-RU')

  const periodHint: Record<PeriodKey, string> = {
    today: `с 00:00 (${ADMIN_TZ.replace('Europe/', '')})`,
    week: 'последние 7 дней',
    month: 'последние 30 дней',
    year: 'последние 365 дней',
    all: 'за всё время',
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-[1100px] px-4 py-8">
        <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground" data-testid="admin-back">
          <ArrowLeft className="h-4 w-4" /> Назад
        </Link>
        <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
          <h1 className="font-display text-3xl font-bold tracking-tight">Админ · статистика</h1>
          <p className="text-xs text-muted-foreground">Данные на {fmtDateTime(s.generatedAt)} ({ADMIN_TZ}). Обновляются при каждом открытии страницы.</p>
        </div>

        {/* ── Сводка ── */}
        <section className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4" data-testid="admin-summary">
          <Card icon={<Users className="h-4 w-4" />} label="Новых пользователей сегодня" value={fmtInt(s.newUsers.today)} sub={`всего ${fmtInt(s.totalUsers)}`} />
          <Card icon={<Crown className="h-4 w-4" />} label="Активных подписок" value={fmtInt(s.activeSubscriptionsTotal)} sub={s.activeSubscriptions.map((r) => `${tierName(r.tier)} ${r.count}`).join(' · ') || 'нет'} />
          <Card icon={<Coins className="h-4 w-4" />} label="Кредитов у пользователей" value={fmtInt(s.creditsTotal)} sub={`у ${fmtInt(s.usersWithCredits)} польз. баланс > 0`} />
          <Card icon={<Wallet className="h-4 w-4" />} label="Заработано сегодня" value={formatMoney(s.revenue.today.total)} sub={`${s.revenue.today.count} платеж.`} />
        </section>

        {/* ── Пользователи и доход по периодам ── */}
        <section className="mt-8 overflow-x-auto rounded-2xl border border-border bg-card" data-testid="admin-periods">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3 font-medium">Показатель</th>
                {PERIODS.map((p) => (
                  <th key={p} className="px-4 py-3 font-medium" title={periodHint[p]}>{PERIOD_LABELS[p]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border">
                <td className="px-4 py-3 font-medium">Новые пользователи</td>
                {PERIODS.map((p) => <td key={p} className="px-4 py-3 font-mono">{fmtInt(s.newUsers[p])}</td>)}
              </tr>
              <tr className="border-b border-border bg-primary/5">
                <td className="px-4 py-3 font-semibold">Доход (approved)</td>
                {PERIODS.map((p) => <td key={p} className="px-4 py-3 font-mono font-semibold text-primary">{formatMoney(s.revenue[p].total)}</td>)}
              </tr>
              <tr className="border-b border-border">
                <td className="px-4 py-3 pl-8 text-muted-foreground">— подписки</td>
                {PERIODS.map((p) => <td key={p} className="px-4 py-3 font-mono">{formatMoney(s.revenue[p].subscriptions)}</td>)}
              </tr>
              <tr className="border-b border-border">
                <td className="px-4 py-3 pl-8 text-muted-foreground">— пакеты кредитов</td>
                {PERIODS.map((p) => <td key={p} className="px-4 py-3 font-mono">{formatMoney(s.revenue[p].credits)}</td>)}
              </tr>
              <tr>
                <td className="px-4 py-3 text-muted-foreground">Платежей</td>
                {PERIODS.map((p) => <td key={p} className="px-4 py-3 font-mono">{fmtInt(s.revenue[p].count)}</td>)}
              </tr>
            </tbody>
          </table>
          <p className="px-4 py-2 text-[11px] text-muted-foreground">«Сегодня» — календарный день по Киеву; неделя/месяц/год — скользящие окна (7/30/365 дней). Учитываются только успешные платежи WayForPay (status approved); возвраты и отклонённые не считаются.</p>
        </section>

        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {/* ── Активные подписки по тарифам ── */}
          <section className="rounded-2xl border border-border bg-card p-5" data-testid="admin-active-subs">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><Crown className="h-4 w-4 text-primary" /> Активные подписки</h2>
            {s.activeSubscriptions.length ? (
              <ul className="mt-3 divide-y divide-border">
                {s.activeSubscriptions.map((r) => (
                  <li key={r.tier} className="flex items-center justify-between py-2 text-sm">
                    <span>{tierName(r.tier)}</span>
                    <span className="font-mono">{fmtInt(r.count)}</span>
                  </li>
                ))}
                <li className="flex items-center justify-between py-2 text-sm font-semibold">
                  <span>Итого</span>
                  <span className="font-mono">{fmtInt(s.activeSubscriptionsTotal)}</span>
                </li>
              </ul>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">Активных подписок нет.</p>
            )}
            <p className="mt-2 text-[11px] text-muted-foreground">Активная = тариф не Free и срок действия ещё не истёк.</p>
          </section>

          {/* ── Куплено подписок сегодня ── */}
          <section className="rounded-2xl border border-border bg-card p-5" data-testid="admin-subs-today">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><ShoppingBag className="h-4 w-4 text-primary" /> Подписки куплены сегодня</h2>
            {s.subscriptionsToday.length ? (
              <ul className="mt-3 divide-y divide-border">
                {s.subscriptionsToday.map((r) => (
                  <li key={r.tier} className="flex items-center justify-between py-2 text-sm">
                    <span>{tierName(r.tier)}</span>
                    <span className="font-mono">{fmtInt(r.count)} · {formatMoney(r.amount)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">Сегодня подписок ещё не покупали.</p>
            )}
          </section>
        </div>

        {/* ── Все платежи за сегодня ── */}
        <section className="mt-6 overflow-x-auto rounded-2xl border border-border bg-card" data-testid="admin-payments-today">
          <h2 className="px-5 pt-5 font-display text-lg font-semibold">Платежи за сегодня</h2>
          {s.paymentsToday.length ? (
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-2 font-medium">Время</th>
                  <th className="px-5 py-2 font-medium">Пользователь</th>
                  <th className="px-5 py-2 font-medium">Покупка</th>
                  <th className="px-5 py-2 font-medium">Кредиты</th>
                  <th className="px-5 py-2 font-medium text-right">Сумма</th>
                </tr>
              </thead>
              <tbody>
                {s.paymentsToday.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0">
                    <td className="px-5 py-2 font-mono text-muted-foreground">{fmtTime(p.createdAt)}</td>
                    <td className="px-5 py-2">{p.email}</td>
                    <td className="px-5 py-2">{p.kind === 'subscription' ? `Подписка ${tierName(p.tier)}` : `Пакет кредитов · ${p.productName}`}</td>
                    <td className="px-5 py-2 font-mono">{p.credits ? `+${fmtInt(p.credits)}` : '—'}</td>
                    <td className="px-5 py-2 text-right font-mono">{formatMoney({ [p.currency]: p.amount })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="px-5 pb-5 pt-3 text-sm text-muted-foreground">Сегодня успешных платежей нет.</p>
          )}
        </section>
      </main>
    </div>
  )
}

function Card({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">{icon} {label}</div>
      <div className="mt-2 font-display text-2xl font-bold tracking-tight">{value}</div>
      {sub ? <div className="mt-1 truncate text-xs text-muted-foreground" title={sub}>{sub}</div> : null}
    </div>
  )
}
