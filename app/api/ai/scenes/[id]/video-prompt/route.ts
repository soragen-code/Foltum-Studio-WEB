export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { resolveVideoPredecessor } from "@/lib/reangle";
import { buildScenePrompt } from "@/lib/scene-prompt";
import { finalVideoPrompt } from "@/lib/video-prompt-final";

/**
 * GET /api/ai/scenes/[id]/video-prompt
 *
 * Stage 238 — the PRE-GENERATION preview. Returns the EXACT final scene prompt that the video worker will
 * submit (finalVideoPrompt(buildScenePrompt(...))) together with the ORDERED reference list, so the UI can
 * show the producer the prompt text + the image 1..N references (LOCATION, START FRAME, characters) before
 * the first generation. Side-effect-free: no look rewrite, no translation, no plates — it mirrors the
 * worker's builder call with the STORED scene fields (the builder uses dialogueEn ?? dialogue verbatim).
 *
 * Response: { prompt, hasOverride, references: [{ index, url, kind, note }] }.
 * Ownership: scene → episode → season → project → userId.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Login required" }, { status: 401 });

  const limited = rateLimitByUser(request, "ai:scene-video-prompt", session.user.email ?? session.user.id, RATE_LIMITS.ai);
  if (limited) return limited;

  const { id } = await ctx.params;

  // Ownership is enforced in the query: a scene of another user's project simply returns null.
  const scene = await prisma.scene.findFirst({
    where: { id, episode: { season: { project: { userId: session.user.id } } } },
    include: {
      location: true,
      characters: { include: { character: true }, orderBy: { characterId: "asc" } },
      episode: { select: { location: true } },
    },
  });
  if (!scene) return NextResponse.json({ error: "Scene not found" }, { status: 404 });

  // Resolve the previous scene (its LAST FRAME is image 2 = START FRAME). A missing/unready predecessor
  // must never break the preview — the first scene simply has no START FRAME.
  let previous: Awaited<ReturnType<typeof resolveVideoPredecessor>> = null;
  try {
    previous = await resolveVideoPredecessor(prisma, scene);
  } catch {
    previous = null;
  }

  // Same forbidden set as the worker (Stage 238): the previous LAST FRAME is NOT forbidden (it is the
  // START FRAME); only this scene's own keyframe and the predecessor's keyframe are excluded.
  const forbiddenReferenceUrls = [scene.keyframeUrl, (previous as { keyframeUrl?: string | null } | null)?.keyframeUrl]
    .filter((u): u is string => !!u);

  const characters = scene.characters.map(l => ({
    characterId: l.characterId,
    name: l.character.name,
    tier: l.character.tier,
    imageFront: l.character.imageFront,
    imageProfile: l.character.imageProfile,
    imageFull: l.character.imageFull,
    imageExtra: l.character.imageExtra,
    appearance: l.character.appearance,
    age: l.character.age,
  }));

  const location = scene.location ?? scene.episode.location ?? null;

  const built = buildScenePrompt({
    scene: scene as never,
    characters,
    location: location as never,
    previous: previous as never,
    forbiddenReferenceUrls,
  });

  const prompt = finalVideoPrompt(built);
  const references = built.retryRefs.map((r, i) => ({ index: i + 1, url: r.url, kind: r.kind, note: r.note ?? "" }));

  return NextResponse.json({ prompt, hasOverride: built.hasOverride, references });
}
