import { auth } from '@/auth'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db'
import { Suspense } from 'react'
import { ProjectWizard } from './_components/project-wizard'
import { computeEntitlements } from '@/lib/entitlements'

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth()
  if (!session?.user) redirect('/login')
  const { id } = await params

  const user = await prisma.user.findUnique({ where: { email: session.user.email! } })
  if (!user) redirect('/login')

  const project = await prisma.project.findFirst({
    where: { id, userId: user.id },
    include: {
      characters: { orderBy: { createdAt: 'asc' } },
      locations: { orderBy: { createdAt: 'asc' } },
      seasons: {
        include: {
          episodes: {
            include: {
              scenes: {
                include: { characters: { include: { character: true } } },
                orderBy: { number: 'asc' },
              },
            },
            orderBy: { number: 'asc' },
          },
        },
        orderBy: { number: 'asc' },
      },
    },
  })

  if (!project) redirect('/dashboard')

  // Feature access is computed server-side from the user's subscription and passed to the client wizard.
  const entitlements = computeEntitlements(user)

  // Suspense: the wizard reads `?tab=references` via useSearchParams.
  return <Suspense><ProjectWizard project={JSON.parse(JSON.stringify(project))} entitlements={entitlements} /></Suspense>
}
