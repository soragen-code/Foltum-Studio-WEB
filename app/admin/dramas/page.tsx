import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react'
import { Header } from '@/components/header'
import { isAdminEmail } from '@/lib/admin'
import { ADMIN_TZ } from '@/lib/admin-stats'
import { DRAMAS_PAGE_SIZES, getAdminDramas, parsePage, parsePageSize } from '@/lib/admin-dramas'
import { pickProjectCoverV2 } from '@/lib/project-cover'
import { serverT, sessionLocale } from '@/lib/i18n/server'
import { DATE_LOCALES } from '@/lib/i18n/dictionary'
import { AdminTabs } from '../_components/admin-tabs'

export const dynamic = 'force-dynamic'

/**
 * /admin/dramas — все драмы всех пользователей, сортировка по числу готовых эпизодов (desc).
 * Пагинация классическая: ?page=N&per=20|50|100 (ссылки, без клиентского JS). Только для админа.
 */
export default async function AdminDramasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const session = await auth()
  if (!session?.user) redirect('/login')
  if (!isAdminEmail(session.user.email)) redirect('/dashboard')

  const sp = await searchParams
  const per = parsePageSize(sp.per)
  const requestedPage = parsePage(sp.page)
  const data = await getAdminDramas({ page: requestedPage, per })

  const locale = sessionLocale(session)
  const t = serverT(locale)
  const dateLocale = DATE_LOCALES[locale]
  const fmtDate = (d: Date) => d.toLocaleString(dateLocale, { timeZone: ADMIN_TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  const fmtInt = (n: number) => n.toLocaleString(dateLocale)
  const href = (page: number, size: number = per) => `/admin/dramas?page=${page}&per=${size}`
  const startIndex = (data.page - 1) * data.per

  const pager = (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm" data-testid="admin-dramas-pager">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span>{t('admin.dramas.perPage')}:</span>
        <div className="inline-flex overflow-hidden rounded-lg border border-border">
          {DRAMAS_PAGE_SIZES.map((size) => (
            <Link
              key={size}
              href={href(1, size)}
              data-testid={`admin-dramas-per-${size}`}
              className={
                'px-3 py-1.5 font-mono text-xs transition ' +
                (size === data.per ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')
              }
            >
              {size}
            </Link>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <PagerLink href={href(data.page - 1)} disabled={data.page <= 1} testId="admin-dramas-prev">
          <ChevronLeft className="h-4 w-4" /> {t('admin.dramas.prev')}
        </PagerLink>
        <span className="px-2 font-mono text-xs text-muted-foreground" data-testid="admin-dramas-page">
          {t('admin.dramas.page', { page: data.page, pages: data.pages })}
        </span>
        <PagerLink href={href(data.page + 1)} disabled={data.page >= data.pages} testId="admin-dramas-next">
          {t('admin.dramas.next')} <ChevronRight className="h-4 w-4" />
        </PagerLink>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-[1100px] px-4 py-8">
        <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground" data-testid="admin-back">
          <ArrowLeft className="h-4 w-4" /> {t('common.back')}
        </Link>
        <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
          <h1 className="font-display text-3xl font-bold tracking-tight">{t('admin.dramas.title')}</h1>
          <p className="text-xs text-muted-foreground">{t('admin.dramas.total', { n: fmtInt(data.total) })}</p>
        </div>

        <AdminTabs active="dramas" labels={{ stats: t('admin.tab.stats'), dramas: t('admin.tab.dramas') }} />

        <div className="mt-6">{pager}</div>

        <section className="mt-4 overflow-x-auto rounded-2xl border border-border bg-card" data-testid="admin-dramas-table">
          {data.rows.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-medium">#</th>
                  <th className="px-4 py-3 font-medium">{t('admin.dramas.col.name')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.dramas.col.owner')}</th>
                  <th className="px-4 py-3 font-medium text-right">{t('admin.dramas.col.ready')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.dramas.col.stage')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.dramas.col.created')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.dramas.col.updated')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, i) => {
                  const cover = pickProjectCoverV2(row.episodeRefsV2)
                  return (
                    <tr key={row.id} className="border-b border-border last:border-0" data-testid="admin-drama-row">
                      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{startIndex + i + 1}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-3">
                          {cover ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={cover} alt="" className="h-10 w-7 shrink-0 rounded object-cover" loading="lazy" />
                          ) : (
                            <div className="h-10 w-7 shrink-0 rounded bg-muted" />
                          )}
                          <div className="min-w-0">
                            <div className="truncate font-medium" title={row.name}>{row.name}</div>
                            <div className="truncate font-mono text-[11px] text-muted-foreground">
                              {row.id}
                              {row.isTest ? <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-sans text-[10px] uppercase">{t('admin.dramas.test')}</span> : null}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <div className="truncate" title={row.ownerEmail}>{row.ownerEmail}</div>
                        {row.ownerName ? <div className="truncate text-xs text-muted-foreground">{row.ownerName}</div> : null}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">
                        <span className={row.readyEpisodes > 0 ? 'font-semibold text-primary' : ''}>{fmtInt(row.readyEpisodes)}</span>
                        <span className="text-muted-foreground"> / {row.episodeCount != null ? fmtInt(row.episodeCount) : '—'}</span>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{row.stage}</td>
                      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{fmtDate(row.createdAt)}</td>
                      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{fmtDate(row.updatedAt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <p className="px-5 py-6 text-sm text-muted-foreground">{t('admin.dramas.empty')}</p>
          )}
          <p className="px-4 py-2 text-[11px] text-muted-foreground">{t('admin.dramas.note', { tz: ADMIN_TZ })}</p>
        </section>

        <div className="mt-4">{pager}</div>
      </main>
    </div>
  )
}

function PagerLink({ href, disabled, testId, children }: { href: string; disabled: boolean; testId: string; children: React.ReactNode }) {
  const cls = 'inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm transition'
  if (disabled) {
    return <span className={cls + ' cursor-not-allowed opacity-40'} aria-disabled="true" data-testid={testId}>{children}</span>
  }
  return <Link href={href} className={cls + ' hover:bg-muted'} data-testid={testId}>{children}</Link>
}
