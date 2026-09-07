export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { prisma } from '@/lib/db'

// STUB: Scene generation for an episode
export async function POST(request: Request) {
  try {
    const session = await auth()
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { projectId, episodeId } = await request.json()
    if (!episodeId) return NextResponse.json({ error: 'Episode ID required' }, { status: 400 })

    // Clear existing scenes
    await prisma.scene.deleteMany({ where: { episodeId } })

    const stubScenes = [
      {
        number: 1,
        dialogue: 'ALEX: "Something has changed. Can you feel it?"\nELARA: "The readings are off the charts. This shouldn\'t be possible."',
        locationDesc: 'Interior — Underground Research Lab — Night. Dim fluorescent lighting, banks of monitors showing anomalous data, exposed pipes and wiring.',
        videoPrompt: 'Cinematic shot of two people in a dark underground lab, blue monitor glow on their faces, tense atmosphere, 4K film quality',
      },
      {
        number: 2,
        dialogue: 'MARCUS: "You have no idea what you\'ve stumbled into."\nALEX: "Then enlighten me."',
        locationDesc: 'Exterior — Rooftop — Dusk. City skyline in background, dramatic sunset colors, wind blowing.',
        videoPrompt: 'Dramatic rooftop confrontation at sunset, two figures facing each other, cinematic lighting, city skyline background, film grain',
      },
      {
        number: 3,
        dialogue: 'ZARA: "I\'m in. Their firewall is nothing compared to what I\'ve cracked before."\nELARA: "Be careful. If they detect us..."',
        locationDesc: 'Interior — Safe House — Night. Multiple screens, hacker setup, green code reflections on faces.',
        videoPrompt: 'Hacker scene in dark room with multiple glowing screens, green code reflections, cyberpunk atmosphere, cinematic',
      },
      {
        number: 4,
        dialogue: 'ALEX: "We can\'t turn back now. Whatever happens next, we face it together."',
        locationDesc: 'Exterior — Abandoned Warehouse District — Night. Rain, neon reflections on wet ground, fog.',
        videoPrompt: 'Group walking through rainy neon-lit street, reflections on wet ground, cinematic rain, dramatic lighting, film quality',
      },
      {
        number: 5,
        dialogue: '[DRAMATIC REVEAL SCENE — NO DIALOGUE]',
        locationDesc: 'Interior — Hidden Chamber. Massive ancient structure revealed by flashlights, dust particles in light beams.',
        videoPrompt: 'Dramatic reveal of massive ancient hidden chamber, flashlight beams cutting through dust, awe-inspiring scale, cinematic wide shot',
      },
    ]

    const created = []
    for (const s of stubScenes) {
      const scene = await prisma.scene.create({
        data: {
          episodeId,
          number: s.number,
          dialogue: s.dialogue,
          locationDesc: s.locationDesc,
          videoPrompt: s.videoPrompt,
          status: 'pending',
        },
      })
      created.push(scene)
    }

    return NextResponse.json({ scenes: created })
  } catch (err: any) {
    console.error('Scene generation error:', err)
    return NextResponse.json({ error: 'Generation failed' }, { status: 500 })
  }
}
