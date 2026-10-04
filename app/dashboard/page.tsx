import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db'
import { computeEntitlements } from '@/lib/entitlements'
import { EntitlementsProvider } from '@/components/entitlements-context'
import { DashboardClient } from './_components/dashboard-client'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const session = await auth()
  if (!session?.user) redirect('/login')
  // Тариф нужен клиенту для кнопки «Ручной режим» (Pro): без доступа — disabled + бейдж тарифа.
  const user = session.user.email
    ? await prisma.user.findUnique({ where: { email: session.user.email }, select: { subscriptionTier: true, subscriptionExpiresAt: true } })
    : null
  return (
    <EntitlementsProvider value={computeEntitlements(user)}>
      <DashboardClient />
    </EntitlementsProvider>
  )
}
