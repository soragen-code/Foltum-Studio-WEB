import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { ManualClient } from './_components/manual-client'

/** Stage 234 — "Manual mode": standalone photo + video generation outside of any project. Signed-in users only. */
export default async function ManualPage() {
  const session = await auth()
  if (!session?.user) redirect('/login')
  return <ManualClient />
}
