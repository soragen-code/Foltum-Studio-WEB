import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db'
import { hasActiveSubscription } from '@/lib/entitlements'
import { PricingClient } from './_components/pricing-client'

export default async function PricingPage() {
  const session = await auth()
  if (!session?.user) redirect('/login')

  // Resolve the active plan server-side so the client can highlight «Ваш план».
  const email = session.user.email
  const user = email
    ? await prisma.user.findUnique({
        where: { email },
        select: { subscriptionTier: true, subscriptionExpiresAt: true },
      })
    : null
  const active = hasActiveSubscription(user ?? undefined)
  const currentTier = active ? (user?.subscriptionTier ?? null) : null

  return <PricingClient currentTier={currentTier} />
}
