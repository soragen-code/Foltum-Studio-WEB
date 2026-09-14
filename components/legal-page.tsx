import Link from 'next/link'
import { Film } from 'lucide-react'
import { SiteFooter } from '@/components/site-footer'

/**
 * Shared shell for the public legal / informational pages (Terms, Refund Policy,
 * Contacts). These pages do NOT require authentication — they must be reachable
 * while logged out so the payment provider (WayForPay) can review them.
 */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string
  updated?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <Link href="/" className="inline-flex items-center gap-2">
            <Film className="h-6 w-6 text-primary" />
            <span className="font-display text-lg font-bold tracking-tight">
              <span className="text-primary">Foltum</span> Studio
            </span>
          </Link>
          <Link href="/login" className="text-sm font-medium text-primary hover:underline">
            Sign In
          </Link>
        </div>
      </header>

      <main className="flex-1">
        <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 lg:px-8">
          <h1 className="font-display text-3xl font-bold tracking-tight">{title}</h1>
          {updated && (
            <p className="mt-2 text-sm text-muted-foreground">Last updated: {updated}</p>
          )}
          <div className="legal-content mt-8 space-y-6 text-sm leading-relaxed text-muted-foreground">
            {children}
          </div>
        </div>
      </main>

      <SiteFooter />
    </div>
  )
}

/** The full merchant identity block, reused across the legal pages. */
export function MerchantDetails() {
  return (
    <div className="rounded-xl border border-border bg-card p-5 text-sm text-foreground">
      <h2 className="mb-3 font-display text-lg font-semibold">Merchant details</h2>
      <dl className="space-y-2">
        <div>
          <dt className="text-muted-foreground">Legal entity</dt>
          <dd className="font-medium">Individual Entrepreneur Moshkivskyi Vitalii (ФОП / FOP)</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Tax ID</dt>
          <dd className="font-medium">[IPN / EDRPOU: ____________]</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Legal address</dt>
          <dd className="font-medium">Kharkiv, vul. Svitla 6, Ukraine</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Actual address</dt>
          <dd className="font-medium">Kharkiv, vul. Svitla 6, Ukraine</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Phone</dt>
          <dd className="font-medium">[Phone: +380 __ ___ __ __]</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Email</dt>
          <dd className="font-medium">
            <a href="mailto:support@foltum-studio.com" className="text-primary hover:underline">
              support@foltum-studio.com
            </a>
          </dd>
        </div>
      </dl>
    </div>
  )
}
