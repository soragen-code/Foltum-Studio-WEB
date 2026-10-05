import { auth } from '@/auth'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Header } from '@/components/header'
import { isAdminEmail } from '@/lib/admin'
import { getAdminDramaDetail } from '@/lib/admin-dramas'
import { serverT, sessionLocale } from '@/lib/i18n/server'
import { DramaPlayer } from '../_components/drama-player'

export const dynamic = 'force-dynamic'

/**
 * /admin/dramas/[id] — список собранных серий драмы + плеер (стрелки ←/→ переключают серию, в т.ч. на весь экран).
 * Только для админа (владелец проекта не проверяется — это просмотр чужих драм владельцем сервиса).
 */
export default async function AdminDramaPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) redirect('/login')
  if (!isAdminEmail(session.user.email)) redirect('/dashboard')

  const { id } = await params
  const drama = await getAdminDramaDetail(id)
  if (!drama) notFound()

  const locale = sessionLocale(session)
  const t = serverT(locale)

  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-[1100px] px-4 py-8">
        <Link href="/admin/dramas" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground" data-testid="admin-drama-back">
          <ArrowLeft className="h-4 w-4" /> {t('admin.dramas.backToList')}
        </Link>
        <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate font-display text-3xl font-bold tracking-tight" title={drama.name}>{drama.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {drama.ownerEmail}{drama.ownerName ? ` · ${drama.ownerName}` : ''} · <span className="font-mono text-xs">{drama.id}</span>
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('admin.dramas.readyOf', { ready: drama.episodes.length, total: drama.episodeCount != null ? String(drama.episodeCount) : '—' })}
          </p>
        </div>

        <div className="mt-6">
          <DramaPlayer episodes={drama.episodes} cover={drama.cover} />
        </div>
      </main>
    </div>
  )
}
