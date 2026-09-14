import Link from 'next/link'
import { Film } from 'lucide-react'

/**
 * Public site footer. Linked from the public landing/login page so that the
 * legal / informational pages required by the payment provider (WayForPay) are
 * reachable by anyone — including reviewers — WITHOUT logging in.
 */
export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-background/60 py-8 text-sm text-muted-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col items-center gap-4 text-center sm:flex-row sm:justify-between sm:text-left">
          <Link href="/" className="inline-flex items-center gap-2">
            <Film className="h-5 w-5 text-primary" />
            <span className="font-display text-base font-bold tracking-tight text-foreground">
              <span className="text-primary">Foltum</span> Studio
            </span>
          </Link>
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <Link href="/terms" className="transition hover:text-foreground">
              Terms &amp; Conditions
            </Link>
            <Link href="/refund-policy" className="transition hover:text-foreground">
              Refund Policy
            </Link>
            <Link href="/contacts" className="transition hover:text-foreground">
              Contacts
            </Link>
          </nav>
        </div>
        <div className="flex flex-col gap-1 text-center text-xs text-muted-foreground sm:text-left">
          <p>Individual Entrepreneur Moshkivskyi Vitalii (ФОП / FOP)</p>
          <p>Kharkiv, vul. Svitla 6, Ukraine</p>
          <p>
            © {new Date().getFullYear()} Foltum Studio. Payments are securely processed by
            WayForPay.
          </p>
        </div>
      </div>
    </footer>
  )
}
