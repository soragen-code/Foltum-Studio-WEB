'use client'

import Link from 'next/link'
import { ArrowLeft, Lock } from 'lucide-react'
import { Header } from '@/components/header'
import { useTranslation } from '@/lib/i18n/context'

/** /manual for users below Pro: locked stub («Доступно с тарифа Pro») with a link to /pricing. */
export function ManualLocked() {
  const { t } = useTranslation()
  return (
    <div className="min-h-screen bg-background">
      <Header />
      <main className="mx-auto max-w-[720px] px-4 py-16">
        <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground" data-testid="manual-locked-back">
          <ArrowLeft className="h-4 w-4" /> {t('common.back')}
        </Link>
        <div className="mt-6 rounded-2xl border border-border bg-card p-10 text-center" data-testid="manual-locked">
          <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            <Lock className="h-6 w-6 text-muted-foreground" />
          </div>
          <h1 className="font-display text-2xl font-bold tracking-tight">{t('ent.manualLockedTitle')}</h1>
          <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">{t('ent.manualLockedText')}</p>
          <Link href="/pricing" className="mt-6 inline-flex items-center justify-center rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90" data-testid="manual-locked-pricing">
            {t('ent.goPricing')}
          </Link>
        </div>
      </main>
    </div>
  )
}
