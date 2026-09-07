export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'

// STUB: Structure generation
export async function POST(request: Request) {
  try {
    const session = await auth()
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { projectId } = await request.json()
    if (!projectId) return NextResponse.json({ error: 'Project ID required' }, { status: 400 })

    // Clear existing structure
    await prisma.season.deleteMany({ where: { projectId } })

    const seasonsData = [
      {
        number: 1,
        title: 'The Awakening',
        episodes: [
          { number: 1, title: 'Pilot', description: 'A mysterious event shatters the protagonist\'s ordinary life.', cliffhanger: 'They discover they are not the only one with abilities.' },
          { number: 2, title: 'The Signal', description: 'Strange signals lead to a hidden underground facility.', cliffhanger: 'The facility contains evidence of decades of cover-ups.' },
          { number: 3, title: 'Connections', description: 'New allies emerge, but trust is hard to find.', cliffhanger: 'One ally is revealed to be a double agent.' },
          { number: 4, title: 'The Descent', description: 'The team goes deeper into the conspiracy.', cliffhanger: 'They find evidence that the threat is far larger than imagined.' },
          { number: 5, title: 'Breaking Point', description: 'Personal conflicts threaten to tear the group apart.', cliffhanger: 'A betrayal forces everyone to choose sides.' },
          { number: 6, title: 'Revelations', description: 'The true nature of the phenomenon is partially revealed.', cliffhanger: 'The antagonist has been watching them all along.' },
          { number: 7, title: 'Convergence', description: 'All storylines converge in a dramatic confrontation.', cliffhanger: 'A major character makes an irreversible sacrifice.' },
          { number: 8, title: 'Aftermath', description: 'The team regroups and faces the consequences.', cliffhanger: 'A new, more dangerous threat emerges from the shadows.' },
          { number: 9, title: 'The Gambit', description: 'A desperate plan is put into motion.', cliffhanger: 'The plan succeeds but at a terrible cost.' },
          { number: 10, title: 'Season Finale: Eclipse', description: 'The season reaches its climax with a world-changing event.', cliffhanger: 'Everything the heroes believed is turned upside down.' },
        ],
      },
      {
        number: 2,
        title: 'The Reckoning',
        episodes: [
          { number: 1, title: 'New World', description: 'The aftermath of Season 1\'s finale reshapes everything.', cliffhanger: 'An old enemy returns with a new face.' },
          { number: 2, title: 'Alliances', description: 'New alliances form in the changed landscape.', cliffhanger: 'A shocking revelation about the protagonist\'s past.' },
          { number: 3, title: 'The Hunt', description: 'The team must track down a critical missing piece.', cliffhanger: 'They realize they\'ve been hunting the wrong target.' },
          { number: 4, title: 'Shadows', description: 'Hidden forces manipulate events from behind the scenes.', cliffhanger: 'The true puppet master is finally identified.' },
          { number: 5, title: 'Reckoning', description: 'Past actions come back to haunt every character.', cliffhanger: 'A character thought dead returns.' },
          { number: 6, title: 'The Final Gambit', description: 'Everything builds toward the ultimate confrontation.', cliffhanger: 'The fate of everyone hangs in the balance.' },
          { number: 7, title: 'Endgame', description: 'The final battle begins.', cliffhanger: 'A shocking twist changes who the real enemy is.' },
          { number: 8, title: 'Resolution', description: 'All storylines reach their conclusion.', cliffhanger: 'But a post-credits scene hints that the story isn\'t over...' },
        ],
      },
    ]

    const createdSeasons = []
    for (const sData of seasonsData) {
      const season = await prisma.season.create({
        data: {
          projectId,
          number: sData.number,
          title: sData.title,
        },
      })

      const eps = []
      for (const epData of sData.episodes) {
        const ep = await prisma.episode.create({
          data: {
            seasonId: season.id,
            number: epData.number,
            title: epData.title,
            description: epData.description,
            cliffhanger: epData.cliffhanger,
          },
        })
        eps.push(ep)
      }

      createdSeasons.push({ ...season, episodes: eps })
    }

    return NextResponse.json({ seasons: createdSeasons })
  } catch (err: any) {
    console.error('Structure generation error:', err)
    return NextResponse.json({ error: 'Generation failed' }, { status: 500 })
  }
}
