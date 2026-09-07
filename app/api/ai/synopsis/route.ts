export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'

// STUB: GPT-4o synopsis generation
export async function POST(request: Request) {
  try {
    const session = await auth()
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { projectId, prompt, correction, currentSynopsis } = await request.json()
    if (!projectId) return NextResponse.json({ error: 'Project ID required' }, { status: 400 })

    // STUB: In production, this calls GPT-4o
    let synopsis = ''
    if (correction && currentSynopsis) {
      synopsis = `${currentSynopsis}\n\n[Revised based on: ${correction}]\nThe story takes a new turn as the narrative deepens. Characters face unexpected challenges that test their resolve. The atmosphere shifts dramatically, creating tension and anticipation for what comes next.`
    } else {
      synopsis = `Based on your idea: "${prompt}"\n\nIn a world where reality bends to the will of the unseen, a group of unlikely heroes discovers a secret that could reshape civilization. Their journey takes them through breathtaking landscapes and dangerous territories, where alliances are tested and betrayals lurk in every shadow.\n\nThe story weaves together themes of identity, power, and redemption as our protagonists race against time to prevent a catastrophe that threatens to unravel the very fabric of their existence. Each episode peels back another layer of mystery, revealing that nothing is quite what it seems.\n\nGenre: Drama / Thriller / Sci-Fi\nTone: Dark, atmospheric, with moments of hope\nTarget: 2 seasons, episodic format`
    }

    // Save to DB
    await prisma.project.update({
      where: { id: projectId },
      data: { synopsis },
    })

    return NextResponse.json({ synopsis })
  } catch (err: any) {
    console.error('Synopsis generation error:', err)
    return NextResponse.json({ error: 'Generation failed' }, { status: 500 })
  }
}
