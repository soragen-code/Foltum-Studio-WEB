import { prisma } from "@/lib/db";
import { generateImage, GenerationCanceledError } from "@/lib/providers/image-provider";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { VISUAL_STYLE_ID, REFERENCE_ASPECT_RATIO } from "@/lib/visual-style";
import {
  buildRegionPlateRequest,
  resolveRegionPlate,
  putRegionPlate,
  type RegionPlateLocation,
} from "@/lib/region-plate";

/**
 * Stage 122 — SCENE REGION PLATES worker.
 *
 * A region plate is an ENVIRONMENT reference of the specific part of a location where a scene happens,
 * produced by a controlled Seedream EDIT of the master LAYOUT plate ("move the camera to frame THIS part of the
 * location" while preserving all master geometry — see lib/region-plate.ts). It becomes the PRIMARY
 * geometry/background reference for the scene's video clips and its camera re-angle, so the environment no longer
 * depends on the fragile last-frame re-angle. The re-angle is KEPT for people/motion continuity only.
 *
 * Plates are generated AHEAD (ideally at episode-prep via `ensureEpisodeRegionPlates`, otherwise lazily by the
 * video job before the clip is built) and REUSED: scenes in the same region of the same location share ONE cached
 * plate, keyed by (locationId + normalized region) in Location.regionPlates. No camera restriction is imposed on
 * the video clips — this only fixes the environment of that region, and it is NOT a keyframe (imposes no pose and
 * is never a first frame).
 *
 * Fallback-safe / non-blocking: any missing input (no region description, no master plates) or generation failure
 * resolves to null and the scene falls back to the Stage 121 behaviour (master plates + re-angle). Legacy scenes
 * without a region description are never migrated automatically.
 */

/** The scene fields needed to resolve/generate a region plate. */
interface SceneRow {
  id: string;
  episodeId: string;
  regionDesc: string | null;
  regionKey: string | null;
  regionPlateUrl: string | null;
}

/** The location fields needed to derive & cache a region plate. */
interface LocationRow extends RegionPlateLocation {
  projectId: string;
  regionPlates: string | null;
}

/** In-process guard so two concurrent scenes of the SAME region on this instance don't both pay for a plate. */
const inFlight = new Map<string, Promise<string | null>>();

/**
 * Resolve (or generate once and cache) the region plate URL for ONE scene. Returns the S3 URL, or null when a
 * region plate does not apply (no region description, no master plates) or generation failed — the caller then
 * falls back to the Stage 121 master-plate + re-angle path. Never throws.
 */
export async function ensureSceneRegionPlate(input: {
  sceneId: string;
  jobId?: string;
  imageModel?: string;
}): Promise<string | null> {
  const { sceneId, jobId, imageModel } = input;
  try {
    const scene = (await prisma.scene.findUnique({
      where: { id: sceneId },
      select: { id: true, episodeId: true, regionDesc: true, regionKey: true, regionPlateUrl: true },
    })) as SceneRow | null;
    if (!scene) return null;
    // Already resolved for this scene.
    if (scene.regionPlateUrl) return scene.regionPlateUrl;
    const regionDesc = (scene.regionDesc ?? "").trim();
    if (!regionDesc) return null; // no region described — Stage 121 fallback (no auto-migration of legacy scenes)

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
            regionPlates: true,
          },
        },
      },
    });
    const loc = episode?.location as LocationRow | null | undefined;
    // No master plates to edit from → cannot build a controlled re-frame; fall back.
    if (!loc || (!loc.imageUrl && !loc.imageReverse)) return null;

    // Cache hit on the location (a sibling scene in the same region already made the plate).
    const cached = resolveRegionPlate(loc.regionPlates, regionDesc);
    if (cached) {
      await prisma.scene
        .update({ where: { id: sceneId }, data: { regionPlateUrl: cached } })
        .catch(() => {});
      return cached;
    }

    // Build the deterministic edit request; its cacheKey (locationId::region) de-dups concurrent work.
    const request = buildRegionPlateRequest({ location: loc, regionDesc });
    const lockKey = request.cacheKey || `${loc.id}::${sceneId}`;
    const existing = inFlight.get(lockKey);
    if (existing) {
      const url = await existing.catch(() => null);
      if (url) {
        await prisma.scene
          .update({ where: { id: sceneId }, data: { regionPlateUrl: url } })
          .catch(() => {});
      }
      return url;
    }

    const work = (async (): Promise<string | null> => {
      // Re-check the location cache right before paying (a concurrent instance may have just written it).
      const fresh = await prisma.location.findUnique({
        where: { id: loc.id },
        select: { regionPlates: true },
      });
      const already = resolveRegionPlate(fresh?.regionPlates, regionDesc);
      if (already) return already;

      const remote = await generateImage(
        { prompt: request.prompt, aspect_ratio: REFERENCE_ASPECT_RATIO, image_input: request.image_input },
        { jobId: jobId ?? "", imageModel },
      );
      const url = await uploadRemoteToS3(
        remote,
        `media/public/locations/${loc.projectId}/${loc.id}/${VISUAL_STYLE_ID}/region-${request.hash.slice(0, 12)}.png`,
        "image/png",
      );
      // Persist to the location cache (reused by sibling scenes) atomically with the freshest JSON.
      const latest = await prisma.location.findUnique({
        where: { id: loc.id },
        select: { regionPlates: true },
      });
      await prisma.location
        .update({
          where: { id: loc.id },
          data: { regionPlates: putRegionPlate(latest?.regionPlates, regionDesc, url) },
        })
        .catch(() => {});
      return url;
    })();
    inFlight.set(lockKey, work);
    let url: string | null;
    try {
      url = await work;
    } catch (e: any) {
      if (e instanceof GenerationCanceledError) return null;
      console.warn(`[region-plate] scene ${sceneId}: generation failed, falling back — ${e?.message ?? e}`);
      return null;
    } finally {
      inFlight.delete(lockKey);
    }
    if (url) {
      await prisma.scene
        .update({ where: { id: sceneId }, data: { regionPlateUrl: url } })
        .catch(() => {});
    }
    return url;
  } catch (e: any) {
    console.warn(`[region-plate] scene ${sceneId}: resolve failed, falling back — ${e?.message ?? e}`);
    return null;
  }
}

/**
 * Pre-generate region plates for an ENTIRE episode AHEAD of any clip. Scenes are processed in order so the first
 * scene of each region generates the plate and every later scene in the same region reuses the cached one. Best
 * effort: a per-scene failure is logged and skipped (that scene falls back to the Stage 121 path). Safe to call
 * repeatedly (idempotent via the Location.regionPlates + Scene.regionPlateUrl caches).
 */
export async function ensureEpisodeRegionPlates(input: {
  episodeId: string;
  jobId?: string;
  imageModel?: string;
}): Promise<{ resolved: number; total: number }> {
  const { episodeId, jobId, imageModel } = input;
  const scenes = await prisma.scene.findMany({
    where: { episodeId },
    orderBy: { number: "asc" },
    select: { id: true, regionDesc: true },
  });
  let resolved = 0;
  let total = 0;
  for (const s of scenes) {
    if (!(s.regionDesc ?? "").trim()) continue;
    total += 1;
    const url = await ensureSceneRegionPlate({ sceneId: s.id, jobId, imageModel });
    if (url) resolved += 1;
  }
  return { resolved, total };
}
