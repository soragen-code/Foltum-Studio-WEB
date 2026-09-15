/**
 * Stage 122 — SCENE REGION PLATES.
 *
 * A "region plate" is a pre-generated ENVIRONMENT reference of the specific part of a location where a scene
 * happens. It is produced by a CONTROLLED Seedream EDIT of the master LAYOUT plate (fallback: the wide plate):
 * "move the camera to frame THIS part of the location" while PRESERVING all master geometry — same walls, same
 * fixed furniture in the same places (wall-adjacent furniture stays flush against its wall), same architecture,
 * materials, colours and light. It is NOT an independent fresh generation, and it is NOT a keyframe: it imposes no
 * character pose and is never used as a video's first frame. It is sent into the scene's video clips as the PRIMARY
 * geometry/background reference (see scene-prompt.ts), so the environment no longer depends on the fragile
 * last-frame re-angle. The re-angle is KEPT for people/motion continuity only.
 *
 * Region plates are generated AHEAD at episode-prep time and REUSED: several scenes in the same region of the same
 * location share ONE cached plate, keyed by (locationId + normalized region). No camera restriction is imposed —
 * the video clips' camera stays free; the plate only fixes the environment of that region.
 */
import { createHash } from "node:crypto";
import { buildWaveSpeedImageRequest } from "./providers/image-provider";

/** A location's master plates + set inventory, as needed to edit a region plate out of them. */
export interface RegionPlateLocation {
  id: string;
  name?: string | null;
  /** Master WIDE establishing plate (fallback base / secondary geometry reference). */
  imageUrl?: string | null;
  /** Master elevated LAYOUT plate — the floor-plan authority; the PRIMARY base of the edit. */
  imageReverse?: string | null;
  /** Optional set inventory ("object — placement" per line/entry) to reinforce what must be preserved. */
  setInventory?: string[] | string | null;
}

/**
 * Normalize a free-text region description into a stable cache key: lowercased, punctuation stripped, whitespace
 * collapsed. Two scenes whose "region" wording matches (the script is told to reuse identical wording for the same
 * corner) resolve to the SAME key and therefore share ONE plate. Empty / whitespace → "" (no region).
 */
export function deriveRegionKey(regionDesc: string | null | undefined): string {
  return (regionDesc ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The per-location cache key for a region (locationId + normalized region). Empty region → "". */
export function regionPlateCacheKey(locationId: string, regionDesc: string | null | undefined): string {
  const key = deriveRegionKey(regionDesc);
  return key ? `${locationId}::${key}` : "";
}

/** Parse a Location.regionPlates JSON string into a { regionKey: url } map. Tolerant: bad JSON → {}. */
export function parseRegionPlates(json: string | null | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const out: Record<string, string> = {};
      for (const [k, u] of Object.entries(v)) if (typeof u === "string" && u) out[k] = u;
      return out;
    }
  } catch {
    /* ignore malformed cache */
  }
  return {};
}

/** Look up a cached region plate URL by normalized region key; null when absent. */
export function resolveRegionPlate(json: string | null | undefined, regionDesc: string | null | undefined): string | null {
  const key = deriveRegionKey(regionDesc);
  if (!key) return null;
  return parseRegionPlates(json)[key] ?? null;
}

/** Return an updated Location.regionPlates JSON string with { regionKey: url } added / replaced. */
export function putRegionPlate(json: string | null | undefined, regionDesc: string | null | undefined, url: string): string {
  const key = deriveRegionKey(regionDesc);
  const map = parseRegionPlates(json);
  if (key && url) map[key] = url;
  return JSON.stringify(map);
}

/**
 * The Seedream EDIT request that turns a location's master plate into a region plate for `regionDesc`.
 * Base of the edit = the elevated LAYOUT plate (floor-plan authority); the wide plate is added as a secondary
 * geometry reference when present. The edit MOVES THE CAMERA to frame the requested region while preserving all
 * master geometry — no furniture added/removed/moved, no wall turned into columns/openings, same light, no people.
 * No camera restriction is imposed on the downstream video clips; this only fixes the environment of the region.
 */
export function buildRegionPlateRequest(input: { location: RegionPlateLocation; regionDesc: string }) {
  const { location, regionDesc } = input;
  const region = (regionDesc ?? "").replace(/\s+/g, " ").trim();
  if (!region) throw new Error("A region description is required to build a region plate.");
  const layout = (location.imageReverse ?? "").trim();
  const wide = (location.imageUrl ?? "").trim();
  // Primary base = LAYOUT (floor-plan authority); fall back to WIDE when the layout plate is missing.
  const base = layout || wide;
  if (!base) throw new Error("The location has no master layout/wide plate to derive a region plate from.");
  // image_input: base first, then the other master plate (deduped) as extra geometry truth.
  const image_input = Array.from(new Set([base, layout, wide].filter(Boolean)));
  const inventory = Array.isArray(location.setInventory)
    ? location.setInventory.filter(Boolean).join("; ")
    : (location.setInventory ?? "").replace(/\s+/g, " ").trim();
  const name = (location.name ?? "").trim();
  const prompt = [
    `CAMERA-MOVE EDIT of the attached master location plate${image_input.length > 1 ? "s" : ""}${name ? ` of "${name}"` : ""}. Keep the SAME real place; move the camera to frame THIS part of the location: ${region}.`,
    "This is a controlled re-frame of the EXISTING environment, NOT a fresh scene and NOT a new room: reconstruct the exact same environment as the source plate(s) — the SAME walls, the SAME fixed furniture at the SAME places, the SAME architecture, materials, colours, floor pattern, fixtures and lighting. Any furniture set against a wall keeps its back/rear side FLUSH against that same wall, welded to the architecture with no gap, columns or open space behind it, exactly as in the source layout plate.",
    "Do NOT add, remove, resize, restyle, duplicate or rearrange any furniture or fixed object; do NOT replace a wall with columns, pillars, a passage, an archway, an opening, a doorway, a window, an escalator or open space, and do NOT invent any architecture, structure or objects that are not present in the source plate(s). When the new framing reveals a previously occluded surface, reconstruct it strictly from the source plate(s) rather than inventing anything.",
    inventory ? `The location's fixed set objects (each must stay exactly as placed): ${inventory}.` : "",
    "EMPTY SET: no people, no animals, no text, no captions, no logos — just the environment. Photorealistic single vertical (9:16) film frame.",
  ].filter(Boolean).join("\n");
  const request = buildWaveSpeedImageRequest({ prompt, aspect_ratio: "9:16", image_input, kind: "location" });
  const cacheKey = regionPlateCacheKey(location.id, region);
  const hash = createHash("sha256")
    .update(JSON.stringify({ version: 122, cacheKey, region, base, image_input, request }))
    .digest("hex");
  return { ...request, prompt, image_input, base, cacheKey, hash, cacheId: `region-plate-${hash}` };
}
export type RegionPlateRequest = ReturnType<typeof buildRegionPlateRequest>;
