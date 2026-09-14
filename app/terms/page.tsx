import { LegalPage, MerchantDetails } from '@/components/legal-page'

export const metadata = {
  title: 'Terms & Conditions — Foltum Studio',
  description: 'Terms and conditions of using the Foltum Studio digital service.',
}

export default function TermsPage() {
  return (
    <LegalPage title="Terms & Conditions" updated="September 2026">
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">1. About the service</h2>
        <p>
          Foltum Studio (the &ldquo;Service&rdquo;) is a fully digital, online SaaS platform that
          lets users generate short-form vertical AI video (films and series) from a text prompt.
          The Service is provided electronically over the internet. It sells access on a
          subscription and/or prepaid credits basis. There are no physical goods and nothing is
          ever shipped — all products and features are delivered online.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">2. Orders and how the service is provided</h2>
        <p>
          To use paid features, a user selects a subscription plan or a credits package and
          completes the payment online. Access is granted immediately after a successful payment:
          the subscription is activated and/or the purchased credits are added to the user&rsquo;s
          account automatically, in real time. Credits are then spent to generate video content
          within the Service.
        </p>
        <p>
          By placing an order and completing payment, the user confirms that they understand the
          Service is a digital product delivered instantly and agree to these Terms &amp; Conditions.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">3. Payment methods</h2>
        <p>
          All payments are processed securely through our payment provider, WayForPay. The following
          payment methods are supported:
        </p>
        <ul className="list-disc space-y-1 pl-6">
          <li>Visa and Mastercard bank cards</li>
          <li>Apple Pay</li>
          <li>Google Pay</li>
          <li>Other payment methods supported by WayForPay</li>
        </ul>
        <p>
          Prices are shown on the pricing page before purchase. The amount charged is the amount
          displayed at the moment of the transaction.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">4. Delivery of the digital service</h2>
        <p>
          Because Foltum Studio is a digital service, delivery is electronic and instant. Immediately
          after a successful payment is confirmed by WayForPay, the corresponding access — the active
          subscription and/or the purchased credits — is provided online within the user&rsquo;s
          account, with no delay and no physical shipment. Generated content is made available for
          download and viewing directly inside the Service.
        </p>
        <p>
          If, due to a technical failure, access or credits are not delivered after a successful
          payment, the user should contact support at{' '}
          <a href="mailto:support@foltum-studio.com" className="text-primary hover:underline">
            support@foltum-studio.com
          </a>{' '}
          and the issue will be resolved (access restored or a refund issued — see the Refund Policy).
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">5. Acceptable use</h2>
        <p>
          Users agree to use the Service lawfully and not to generate content that is illegal,
          infringing, or that violates the rights of third parties. The user is responsible for the
          prompts they submit and the content they create.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">6. Refunds</h2>
        <p>
          Refunds are governed by our{' '}
          <a href="/refund-policy" className="text-primary hover:underline">
            Refund Policy
          </a>
          , which forms part of these Terms &amp; Conditions.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">7. Merchant details</h2>
        <MerchantDetails />
      </section>
    </LegalPage>
  )
}
