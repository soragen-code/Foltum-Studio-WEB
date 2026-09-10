export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800; // download + per-scene audio mux + concatenation can take a while

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, assembleEpisodeSchema } from "@/lib/validations";
import { assembleEpisodeVideo } from "@/lib/assemble";

/**
 * Assemble a full episode from all accepted scene videos (in scene order).
 *
 * New scenes carry Seedance native speech and ambience. Older scenes may retain
 * a separate audio asset in `scene.audioUrl`; assembly preserves that compatibility:
 *   1. muxes each scene's voiceover into its clip (clips without a voiceover keep their
 *      own audio if they have one, otherwise get a silent track) so every clip has a
 *      uniform video + AAC audio layout,
 *   2. concatenates the clips with local ffmpeg — the audio stream is verified to be
 *      present in the result,
 *   3. uploads the file to S3 and stores the URL on the episode.
 */
export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.email)
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const limited = rateLimitByUser(request, "ai:assemble-episode", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const parsed = await parseBody(request, assembleEpisodeSchema);
    if (!parsed.ok) return parsed.response;
    const { episodeId } = parsed.data;
    if (!episodeId)
      return NextResponse.json({ error: "Episode ID required" }, { status: 400 });

    // Scope to the owner before stitching.
    const owned = await prisma.episode.findFirst({
      where: { id: episodeId, season: { project: { user: { email: session.user.email } } } },
      select: { id: true },
    });
    if (!owned) return NextResponse.json({ error: "Episode not found" }, { status: 404 });

    // Shared stitch helper — also used by the background episode_assemble job.
    const { videoUrl, sceneCount } = await assembleEpisodeVideo(episodeId);
    return NextResponse.json({ videoUrl, sceneCount });
  } catch (err: any) {
    console.error("Episode assembly error:", err);
    return NextResponse.json({ error: err?.message ?? "Assembly failed" }, { status: 500 });
  }
}
