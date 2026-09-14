import { LegalPage, MerchantDetails } from '@/components/legal-page'

export const metadata = {
  title: 'Contacts & Legal Details — Foltum Studio',
  description: 'Contact information and full legal details of the Foltum Studio merchant.',
}

export default function ContactsPage() {
  return (
    <LegalPage title="Contacts & Legal Details" updated="September 2026">
      <section className="space-y-3">
        <p>
          Foltum Studio is operated by the individual entrepreneur listed below. For any question
          about the service, your account, a payment, or a refund, please contact us — we respond by
          email as quickly as possible.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Company / merchant information</h2>
        <MerchantDetails />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Support</h2>
        <p>
          Email:{' '}
          <a href="mailto:support@foltum-studio.com" className="text-primary hover:underline">
            support@foltum-studio.com
          </a>
        </p>
        <p>
          Please include your account email and, for payment questions, the transaction date and
          amount so we can help you faster.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Related documents</h2>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            <a href="/terms" className="text-primary hover:underline">
              Terms &amp; Conditions
            </a>
          </li>
          <li>
            <a href="/refund-policy" className="text-primary hover:underline">
              Refund Policy
            </a>
          </li>
        </ul>
      </section>
    </LegalPage>
  )
}
