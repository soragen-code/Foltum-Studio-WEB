export const dynamic = "force-dynamic";
export const maxDuration = 800;

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { startLocationImageJob } from "@/lib/location-refs";
import { normalizeImageModel } from "@/lib/ai-models";
import { parseBeatMeta } from "@/lib/simple-pipeline";

/**
 * Simplified pipeline — step 6. POST /api/ai/episodes/[id]/plate
 * Generates the episode's single master plate (Location.imageUrl) with the existing "location_image" job.
 * The plate is used ONLY as a lighting/palette reference for character refs, start frames and the storyboard.
 * If the episode has no Location yet, one is created from the shot list (scene 1 location) or Episode.locationName.
 * Body: { imageModel? }. Returns { jobId, resumed?, locationId }.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:episode-plate", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;
    const { id } = await ctx.params;
    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const episode = await prisma.episode.findFirst({
      where: { id, season: { project: { userId: user.id } } },
      include: {
        season: { select: { projectId: true } },
        location: true,
        scenes: { orderBy: { number: "asc" }, take: 5, select: { beatMeta: true, locationDesc: true, title: true } },
      },
    });
    if (!episode) return NextResponse.json({ error: "Episode not found" }, { status: 404 });
    const projectId = episode.season.projectId;
    const body = await request.json().catch(() => ({}));
    const imageModel = normalizeImageModel(body?.imageModel);

    let location = episode.location;
    if (!location) {
      const beat = episode.scenes.map((s) => parseBeatMeta(s.beatMeta)).find(Boolean) || null;
      const name = (episode.locationName || beat?.location || "Episode location").slice(0, 120);
      const description = (episode.locationDesc || beat?.location || episode.scenes[0]?.locationDesc || name).slice(0, 2000);
      // Reuse a project location with the same name before creating a new one.
      location =
        (await prisma.location.findFirst({ where: { projectId, name } })) ||
        (await prisma.location.create({ data: { projectId, name, description, visualPrompt: description, visualPromptAuto: description } }));
      await prisma.episode.update({ where: { id }, data: { locationId: location.id, locationName: episode.locationName || name, locationDesc: episode.locationDesc || description } });
    }

    await prisma.location.update({
      where: { id: location.id },
      data: { prevSnapshot: { kind: "location", imageUrl: location.imageUrl, imageReverse: location.imageReverse, imageDetail: location.imageDetail, imageExtra: location.imageExtra } },
    });
    const started = await startLocationImageJob({ user, projectId, locationIds: [location.id], imageModel });
    if ("error" in started) return NextResponse.json(started, { status: started.status });
    return NextResponse.json({ ...started, locationId: location.id });
  } catch (err: any) {
    console.error("Episode plate error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
