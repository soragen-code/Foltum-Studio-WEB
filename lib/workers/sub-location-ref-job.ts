import { prisma } from "@/lib/db";
import { generateImage, GenerationCanceledError } from "@/lib/providers/image-provider";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { VISUAL_STYLE_ID, REFERENCE_ASPECT_RATIO } from "@/lib/visual-style";
import {
  buildSubLocationRefRequest,
  resolveSubLocationRef,
  putSubLocationRef,
  type SubLocationRefLocation,
} from "@/lib/sub-location";

/**
 * Stage 123 — SUB-LOCATION ANGLE REFERENCES worker.
 *
 * A sub-location angle reference is an ENVIRONMENT reference of the specific SPOT within a location where a scene
 * happens (season.ts S16 marks the spot; it is parsed into Scene.subLocation). It is produced by a controlled
 * Seedream EDIT of the master LAYOUT plate ("move the camera to frame THIS spot" while preserving all master
 * geometry — see lib/sub-location.ts). It becomes an additional per-spot LOCATION VISUAL REFERENCE for every scene
 * set at that spot (see scene-prompt.ts); the region plate stays the PRIMARY geometry reference.
 *
 * References are generated AHEAD (ideally at episode-prep via `ensureEpisodeSubLocationRefs`, otherwise lazily by
 * the video job before the clip is built) and REUSED: scenes at the same spot of the same location share ONE cached
 * reference, keyed by (locationId + normalized sub-location) in Location.subLocationRefs.
 *
 * Fallback-safe / non-blocking: any missing input (no sub-location, no master plates) or generation failure
 * resolves to null and the scene falls back to its region plate / master plates. Legacy scenes without a
 * sub-location are never migrated automatically.
 */

/** The location fields needed to derive & cache a sub-location angle reference. */
interface LocationRow extends SubLocationRefLocation {
  projectId: string;
  subLocationRefs: string | null;
}

/** In-process guard so two concurrent scenes of the SAME spot on this instance don't both pay for a reference. */
const inFlight = new Map<string, Promise<string | null>>();

/**
 * Resolve (or generate once and cache) the sub-location angle reference URL for ONE scene. Returns the S3 URL, or
 * null when it does not apply (no sub-location, no master plates) or generation failed — the caller then falls back
 * to the region plate / master plates. Never throws.
 */
export async function ensureSceneSubLocationRef(input: {
  sceneId: string;
  jobId?: string;
  imageModel?: string;
}): Promise<string | null> {
  const { sceneId, jobId, imageModel } = input;
  try {
    const scene = await prisma.scene.findUnique({
      where: { id: sceneId },
      select: { id: true, episodeId: true, subLocation: true },
    });
    if (!scene) return null;
    const subLocation = (scene.subLocation ?? "").trim();
    if (!subLocation) return null; // no spot marked — fall back (no auto-migration of legacy scenes)

    const episode = await prisma.episode.findUnique({
      where: { id: scene.episodeId },
      select: {
        location: {
          select: {
            id: true,
            projectId: true,
            name: true,
            imageUrl: true,
            imageReverse: true,
            setInventory: true,
            subLocationRefs: true,
          },
        },
      },
    });
    const loc = episode?.location as LocationRow | null | undefined;
    // No master plates to edit from → cannot build a controlled re-frame; fall back.
    if (!loc || (!loc.imageUrl && !loc.imageReverse)) return null;

    // Cache hit on the location (a sibling scene at the same spot already made the reference).
    const cached = resolveSubLocationRef(loc.subLocationRefs, subLocation);
    if (cached) return cached;

    // Build the deterministic edit request; its cacheKey (locationId::spot) de-dups concurrent work.
    const request = buildSubLocationRefRequest({ location: loc, subLocation });
    const lockKey = request.cacheKey || `${loc.id}::${sceneId}`;
    const existing = inFlight.get(lockKey);
    if (existing) return await existing.catch(() => null);

    const work = (async (): Promise<string | null> => {
      // Re-check the location cache right before paying (a concurrent instance may have just written it).
      const fresh = await prisma.location.findUnique({
        where: { id: loc.id },
        select: { subLocationRefs: true },
      });
      const already = resolveSubLocationRef(fresh?.subLocationRefs, subLocation);
      if (already) return already;

      const remote = await generateImage(
        { prompt: request.prompt, aspect_ratio: REFERENCE_ASPECT_RATIO, image_input: request.image_input },
        { jobId: jobId ?? "", imageModel },
      );
      const url = await uploadRemoteToS3(
        remote,
        `media/public/locations/${loc.projectId}/${loc.id}/${VISUAL_STYLE_ID}/sublocation-${request.hash.slice(0, 12)}.png`,
        "image/png",
      );
      // Persist to the location cache (reused by sibling scenes) atomically with the freshest JSON.
      const latest = await prisma.location.findUnique({
        where: { id: loc.id },
        select: { subLocationRefs: true },
      });
      await prisma.location
        .update({
          where: { id: loc.id },
          data: { subLocationRefs: putSubLocationRef(latest?.subLocationRefs, subLocation, url) },
        })
        .catch(() => {});
      return url;
    })();
    inFlight.set(lockKey, work);
    try {
      return await work;
    } catch (e: any) {
      if (e instanceof GenerationCanceledError) return null;
      console.warn(`[sub-location-ref] scene ${sceneId}: generation failed, falling back — ${e?.message ?? e}`);
      return null;
    } finally {
      inFlight.delete(lockKey);
    }
  } catch (e: any) {
    console.warn(`[sub-location-ref] scene ${sceneId}: resolve failed, falling back — ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Pre-generate sub-location angle references for an ENTIRE episode AHEAD of any clip. Scenes are processed in order
 * so the first scene of each spot generates the reference and every later scene at the same spot reuses the cached
 * one. Best effort: a per-scene failure is logged and skipped. Safe to call repeatedly (idempotent via the
 * Location.subLocationRefs cache).
 */
export async function ensureEpisodeSubLocationRefs(input: {
  episodeId: string;
  jobId?: string;
  imageModel?: string;
}): Promise<{ resolved: number; total: number }> {
  const { episodeId, jobId, imageModel } = input;
  const scenes = await prisma.scene.findMany({
    where: { episodeId },
    orderBy: { number: "asc" },
    select: { id: true, subLocation: true },
  });
  let resolved = 0;
  let total = 0;
  const seen = new Set<string>();
  for (const s of scenes) {
    const sub = (s.subLocation ?? "").trim().toLowerCase();
    if (!sub) continue;
    if (seen.has(sub)) continue; // already ensured this spot in this pass (cache will serve the rest)
    seen.add(sub);
    total += 1;
    const url = await ensureSceneSubLocationRef({ sceneId: s.id, jobId, imageModel });
    if (url) resolved += 1;
  }
  return { resolved, total };
}
