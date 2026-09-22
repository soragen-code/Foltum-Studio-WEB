export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'
import { chatJSON } from '@/lib/ai'
import {
  SEASON_MIN_EPISODES,
  SEASON_MAX_EPISODES,
  recommendEpisodeCountSystemPrompt,
  recommendEpisodeCountUserPrompt,
} from '@/lib/season'
import type { IdeaLanguage } from '@/lib/idea'

// Stage 173 (task 1) — ask the AI to recommend how many episodes this season should have, from the approved
// synopsis. Best-effort: any failure returns null and the flow proceeds unchanged (recommendation stays null).
async function recommendEpisodeCount(synopsis: string, language: IdeaLanguage): Promise<number | null> {
  try {
    const res = await chatJSON<{ episodeCount?: number }>(
      recommendEpisodeCountSystemPrompt(language),
      recommendEpisodeCountUserPrompt(synopsis),
      { json: true, maxTokens: 300, temperature: 0.4 },
    )
    const n = Math.round(Number(res?.episodeCount))
    if (!Number.isFinite(n)) return null
    return Math.min(SEASON_MAX_EPISODES, Math.max(SEASON_MIN_EPISODES, n))
  } catch (err) {
    console.error('[approve-synopsis] recommendEpisodeCount failed:', err)
    return null
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth()
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { id } = await params
    const { synopsis } = await request.json()

    // Stage 59 (step 2 → step 3): in the new 4-step flow, approving the synopsis advances straight to the
    // season-story step ("structure"), where the cast, locations and season script are generated from the
    // approved synopsis. The classic flow keeps its old path (synopsis → characters).
    const project = await prisma.project.findUnique({ where: { id }, select: { newFlow: true, language: true, episodeCount: true } })
    const nextStage = project?.newFlow ? 'structure' : 'characters'

    // Stage 173 (task 1) — compute the AI-recommended episode count from the (freshly approved) synopsis and
    // store it. If the producer has not chosen an episodeCount yet, prefill it with the recommendation so the
    // season is generated with the suggested length (they can still change it before generating).
    const synopsisText = String(synopsis ?? '').trim()
    const recommended = synopsisText
      ? await recommendEpisodeCount(synopsisText, (project?.language as IdeaLanguage) ?? 'en')
      : null

    await prisma.project.update({
      where: { id },
      data: {
        synopsis,
        synopsisApproved: true,
        stage: nextStage,
        ...(recommended != null ? { recommendedEpisodeCount: recommended } : {}),
        ...(recommended != null && (project?.episodeCount == null) ? { episodeCount: recommended } : {}),
      },
    })

    return NextResponse.json({ success: true, recommendedEpisodeCount: recommended })
  } catch (err: any) {
    console.error('Approve synopsis error:', err)
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
