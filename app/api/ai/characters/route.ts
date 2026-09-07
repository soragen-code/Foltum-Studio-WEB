export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'

// STUB: Character extraction from synopsis
export async function POST(request: Request) {
  try {
    const session = await auth()
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { projectId } = await request.json()
    if (!projectId) return NextResponse.json({ error: 'Project ID required' }, { status: 400 })

    // Delete existing chars for this project
    await prisma.character.deleteMany({ where: { projectId } })

    const placeholder = 'https://placehold.co/300x400/1a1a2e/eab308?text='

    // STUB characters
    const stubChars = [
      {
        name: 'Alex Morgan',
        description: 'The reluctant hero who discovers they have the ability to perceive hidden patterns in reality.',
        role: 'Protagonist',
        personality: 'Determined, analytical, compassionate but guarded. Struggles with trust but fiercely loyal.',
        appearance: 'Mid-30s, athletic build, dark hair with silver streaks, intense brown eyes, usually wears a weathered leather jacket.',
        imageFront: placeholder + 'Alex+Front',
        imageProfile: placeholder + 'Alex+Profile',
        imageFull: placeholder + 'Alex+Full',
      },
      {
        name: 'Dr. Elara Voss',
        description: 'A brilliant scientist whose research inadvertently triggered the events of the story.',
        role: 'Deuteragonist',
        personality: 'Brilliant, emotionally complex, haunted by guilt. Uses humor to deflect from deeper pain.',
        appearance: 'Late 20s, slender, red curly hair, green eyes, rectangular glasses, lab coat over casual clothes.',
        imageFront: placeholder + 'Elara+Front',
        imageProfile: placeholder + 'Elara+Profile',
        imageFull: placeholder + 'Elara+Full',
      },
      {
        name: 'Marcus Kane',
        description: 'A former military operative turned enigmatic informant with his own hidden agenda.',
        role: 'Antagonist',
        personality: 'Charming, calculating, believes the ends justify the means. Complex moral compass.',
        appearance: 'Mid-40s, tall, muscular, shaved head, sharp jawline, scar across left eyebrow, dark suits.',
        imageFront: placeholder + 'Marcus+Front',
        imageProfile: placeholder + 'Marcus+Profile',
        imageFull: placeholder + 'Marcus+Full',
      },
      {
        name: 'Zara Chen',
        description: 'A street-smart hacker who becomes an unlikely ally in the quest for truth.',
        role: 'Supporting',
        personality: 'Quick-witted, rebellious, fiercely independent. Hides vulnerability behind sarcasm.',
        appearance: 'Early 20s, petite, black pixie cut with neon highlights, dark eyes, multiple ear piercings, hoodies.',
        imageFront: placeholder + 'Zara+Front',
        imageProfile: placeholder + 'Zara+Profile',
        imageFull: placeholder + 'Zara+Full',
      },
    ]

    const created = []
    for (const c of stubChars) {
      const char = await prisma.character.create({
        data: { projectId, ...c },
      })
      created.push(char)
    }

    return NextResponse.json({ characters: created })
  } catch (err: any) {
    console.error('Character generation error:', err)
    return NextResponse.json({ error: 'Generation failed' }, { status: 500 })
  }
}
