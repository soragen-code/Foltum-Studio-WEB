import { LegalPage, MerchantDetails } from '@/components/legal-page'

export const metadata = {
  title: 'Refund Policy — Foltum Studio',
  description: 'Refund conditions and procedure for the Foltum Studio digital service.',
}

export default function RefundPolicyPage() {
  return (
    <LegalPage title="Refund Policy" updated="September 2026">
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">1. Nature of the service</h2>
        <p>
          Foltum Studio is a digital service. Subscriptions and credits are delivered instantly and
          electronically after payment, and credits are consumed the moment they are used to
          generate video content. This Refund Policy explains when a refund is possible, what is
          non-refundable, and how to request a refund.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">2. When a refund is possible</h2>
        <p>A refund can be requested in the following cases:</p>
        <ul className="list-disc space-y-1 pl-6">
          <li>
            A failed or erroneous transaction — for example, you were charged but the subscription
            or credits were not added to your account.
          </li>
          <li>
            A technical failure on our side that prevented the delivery of the paid service and that
            we are unable to resolve.
          </li>
          <li>
            A duplicate payment for the same order (the duplicate amount is refunded).
          </li>
          <li>
            An unused, recently purchased credits package or subscription, where none of the paid
            credits have been consumed, requested within 14 days of the purchase.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">3. What is non-refundable</h2>
        <p>
          Credits that have already been consumed (used to generate content) and the corresponding
          generated content are non-refundable, because the digital service has already been
          delivered and rendered. Once a generation has been produced using credits, that portion of
          the payment cannot be returned.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">4. Refund procedure</h2>
        <p>To request a refund:</p>
        <ol className="list-decimal space-y-1 pl-6">
          <li>
            Contact us at{' '}
            <a href="mailto:support@foltum-studio.com" className="text-primary hover:underline">
              support@foltum-studio.com
            </a>{' '}
            with your account email, the transaction date and amount, and the reason for the refund.
          </li>
          <li>
            We review the request and respond within 3 business days. We may ask for additional
            details to confirm the transaction.
          </li>
          <li>
            If the refund is approved, it is processed back to the original payment method used for
            the purchase (bank card, Apple Pay, or Google Pay) through our payment provider,
            WayForPay.
          </li>
          <li>
            Approved refunds are typically issued within 7 business days. The time for the funds to
            appear on your statement depends on your bank or card issuer.
          </li>
        </ol>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">5. Chargebacks and cancellations</h2>
        <p>
          If you believe a transaction is incorrect, please contact us first at{' '}
          <a href="mailto:support@foltum-studio.com" className="text-primary hover:underline">
            support@foltum-studio.com
          </a>{' '}
          so we can resolve it quickly. A recurring subscription can be cancelled at any time; the
          cancellation stops future renewals, while access remains active until the end of the
          already-paid period.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">6. Merchant details</h2>
        <MerchantDetails />
      </section>
    </LegalPage>
  )
}
