export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { assembleSceneScript } from "@/lib/scene-script";

/**
 * GET /api/ai/scenes/[id]/script
 *
 * Returns a clean, human-readable ENGLISH "Scene Script" (screenplay page) assembled READ-ONLY from
 * the scene's already-stored fields — no generation is triggered, no scene is reset, no ids/secrets
 * are exposed. The script OPENS exactly where the previous scene ENDED: for scene N>1 on a continuous
 * seam (continuesFrom not location-change / new-sequence) the opening block is the PREVIOUS scene's
 * ending (endStateActual — the chain-mode real last frame — else the scripted endState). Scene 1 and
 * sequence breaks open on the scene's own startState.
 *
 * Response: { script: string }. Ownership: scene → episode → season → project → userId.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Login required" }, { status: 401 });

  const limited = rateLimitByUser(request, "ai:scene-script", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;

  // Ownership is enforced in the query: a scene of another user's project simply returns null.
  const scene = await prisma.scene.findFirst({
    where: { id, episode: { season: { project: { userId: session.user.id } } } },
    include: {
      characters: { include: { character: { select: { name: true } } } },
      episode: { select: { id: true } },
    },
  });
  if (!scene) return NextResponse.json({ error: "Scene not found" }, { status: 404 });

  // The immediately-preceding scene's ending — its final frame is where THIS scene opens on a
  // continuous seam. Only the ending fields are read (no ids leak into the script).
  const previous = scene.number > 1
    ? await prisma.scene.findFirst({
        where: { episodeId: scene.episode.id, number: scene.number - 1 },
        select: { number: true, endState: true, endStateActual: true },
      })
    : null;

  const script = assembleSceneScript(
    {
      number: scene.number,
      title: scene.title,
      sceneKind: scene.sceneKind,
      durationSec: scene.durationSec,
      continuesFrom: scene.continuesFrom,
      locationDesc: scene.locationDesc,
      presence: scene.presence,
      entrances: scene.entrances,
      action: scene.action,
      dialogue: scene.dialogue,
      dialogueEn: scene.dialogueEn,
      voiceover: scene.voiceover,
      voiceoverLocal: scene.voiceoverLocal,
      startState: scene.startState,
      endState: scene.endState,
      endStateActual: scene.endStateActual,
      characters: scene.characters.map((l) => l.character.name),
    },
    previous,
  );

  return NextResponse.json({ script });
}
