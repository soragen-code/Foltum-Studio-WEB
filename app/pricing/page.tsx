import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { PricingClient } from './_components/pricing-client'

export default async function PricingPage() {
  const session = await auth()
  if (!session?.user) redirect('/login')
  return <PricingClient />
}
