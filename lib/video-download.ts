/**
 * Server-side ownership check for the video download proxy.
 * The proxy never streams an arbitrary URL: the URL must be a generated video (an assembled
 * episode, a scene clip or a shot clip) that belongs to a project the caller owns. This mirrors
 * `reference-download.ts` for reference frames, but for mp4 clips.
 */
import { prisma } from "@/lib/db";

function valid(u: unknown): u is string {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}

/**
 * Returns true when `url` is the videoUrl of an Episode / Scene / Shot inside a project owned by
 * `userId`. Used to gate GET /api/files/download-video so it cannot be turned into an open proxy.
 */
export async function isOwnedVideoUrl(userId: string, url: string): Promise<boolean> {
  if (!valid(url)) return false;
  const owner = { season: { project: { userId } } };

  const episode = await prisma.episode.findFirst({ where: { ...owner, videoUrl: url }, select: { id: true } });
  if (episode) return true;

  const scene = await prisma.scene.findFirst({ where: { videoUrl: url, episode: owner }, select: { id: true } });
  if (scene) return true;

  const shot = await prisma.shot.findFirst({ where: { videoUrl: url, scene: { episode: owner } }, select: { id: true } });
  if (shot) return true;

  return false;
}
