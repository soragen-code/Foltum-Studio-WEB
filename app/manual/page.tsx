import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db'
import { canUse } from '@/lib/entitlements'
import { ManualClient } from './_components/manual-client'
import { ManualLocked } from './_components/manual-locked'

export const dynamic = 'force-dynamic'

/**
 * Stage 234 — "Manual mode": standalone photo + video generation outside of any project. Signed-in users only.
 * Feature `manual_mode` (Pro+): users below Pro see a locked stub with a link to /pricing (the API is gated too).
 */
export default async function ManualPage() {
  const session = await auth()
  if (!session?.user) redirect('/login')
  const user = await prisma.user.findUnique({ where: { email: session.user.email! }, select: { subscriptionTier: true, subscriptionExpiresAt: true } })
  if (!canUse(user, 'manual_mode')) return <ManualLocked />
  return <ManualClient />
}
