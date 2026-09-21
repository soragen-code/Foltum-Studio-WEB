import { Suspense } from 'react'
import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { SuccessClient } from './_components/success-client'

export const dynamic = 'force-dynamic'

export default async function PaymentSuccessPage() {
  const session = await auth()
  if (!session?.user) redirect('/login')
  // SuccessClient uses useSearchParams() — it must be wrapped in Suspense for the App Router.
  return (
    <Suspense fallback={null}>
      <SuccessClient />
    </Suspense>
  )
}
