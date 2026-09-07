import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { DashboardClient } from './_components/dashboard-client'

export default async function DashboardPage() {
  const session = await auth()
  if (!session?.user) redirect('/login')
  return <DashboardClient />
}
