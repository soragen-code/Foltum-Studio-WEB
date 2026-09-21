/**
 * Stage 123 — SUB-LOCATION ANGLE REFERENCES.
 *
 * A "sub-location" is a distinct SPOT / vantage WITHIN one location where a scene physically happens
 * (e.g. "by the tall window", "at the front door", "behind the bar counter"). The script model marks it in a
 * machine-readable field (see season.ts S16) and it is parsed into Scene.subLocation.
 *
 * A "sub-location angle reference" is a pre-generated ENVIRONMENT reference of that spot, produced by a CONTROLLED
 * Seedream EDIT of the location's master plate(s): "move the camera to frame THIS spot of the location" while
 * PRESERVING all master geometry — same walls, same fixed furniture in the same places, same architecture,
 * materials, colours and light. It is NOT an independent fresh generation and NOT a keyframe (it imposes no
 * character pose and is never used as a video's first frame). It is a LOCATION VISUAL REFERENCE for every scene set
 * at that spot, so the environment is consistent across the sub-location. This mirrors the region-plate mechanism
 * (lib/region-plate.ts); the region plate stays the PRIMARY geometry reference — the sub-location angle is an
 * additional per-spot location visual reference, reused across scenes.
 *
 * Angle references are generated AHEAD and REUSED: several scenes at the same spot of the same location share ONE
 * cached reference, keyed by (locationId + normalized sub-location) in Location.subLocationRefs.
 */
import { createHash } from "node:crypto";
import { buildWaveSpeedImageRequest } from "./providers/image-provider";

/** A location's master plates + set inventory, as needed to edit a sub-location angle out of them. */
export interface SubLocationRefLocation {
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
 * Normalize a free-text sub-location label into a stable cache key: lowercased, punctuation stripped, whitespace
 * collapsed. The script is told (S16) to reuse identical wording for the same spot, so two scenes at the same spot
 * resolve to the SAME key and share ONE angle reference. Empty / whitespace → "" (no sub-location).
 */
export function normalizeSubLocation(sub: string | null | undefined): string {
  return (sub ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The per-location cache key for a sub-location (locationId + normalized spot). Empty spot → "". */
export function subLocationRefCacheKey(locationId: string, sub: string | null | undefined): string {
  const key = normalizeSubLocation(sub);
  return key ? `${locationId}::${key}` : "";
}

/** Parse a Location.subLocationRefs JSON string into a { subLocationKey: url } map. Tolerant: bad JSON → {}. */
export function parseSubLocationRefs(json: string | null | undefined): Record<string, string> {
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

/** Look up a cached sub-location angle reference URL by normalized spot key; null when absent. */
export function resolveSubLocationRef(json: string | null | undefined, sub: string | null | undefined): string | null {
  const key = normalizeSubLocation(sub);
  if (!key) return null;
  return parseSubLocationRefs(json)[key] ?? null;
}

/** Return an updated Location.subLocationRefs JSON string with { subLocationKey: url } added / replaced. */
export function putSubLocationRef(json: string | null | undefined, sub: string | null | undefined, url: string): string {
  const key = normalizeSubLocation(sub);
  const map = parseSubLocationRefs(json);
  if (key && url) map[key] = url;
  return JSON.stringify(map);
}

/**
 * The Seedream EDIT request that turns a location's master plate into an angle reference for `subLocation`.
 * Base of the edit = the elevated LAYOUT plate (floor-plan authority); the wide plate is added as a secondary
 * geometry reference when present. The edit MOVES THE CAMERA to frame the requested spot while preserving all
 * master geometry — no furniture added/removed/moved, no wall turned into columns/openings, same light, no people.
 * Vertical 9:16, empty set. Fully analogous to buildRegionPlateRequest (lib/region-plate.ts).
 */
export function buildSubLocationRefRequest(input: { location: SubLocationRefLocation; subLocation: string }) {
  const { location, subLocation } = input;
  const spot = (subLocation ?? "").replace(/\s+/g, " ").trim();
  if (!spot) throw new Error("A sub-location label is required to build a sub-location angle reference.");
  const layout = (location.imageReverse ?? "").trim();
  const wide = (location.imageUrl ?? "").trim();
  // Primary base = LAYOUT (floor-plan authority); fall back to WIDE when the layout plate is missing.
  const base = layout || wide;
  if (!base) throw new Error("The location has no master layout/wide plate to derive a sub-location angle from.");
  // image_input: base first, then the other master plate (deduped) as extra geometry truth.
  const image_input = Array.from(new Set([base, layout, wide].filter(Boolean)));
  const inventory = Array.isArray(location.setInventory)
    ? location.setInventory.filter(Boolean).join("; ")
    : (location.setInventory ?? "").replace(/\s+/g, " ").trim();
  const name = (location.name ?? "").trim();
  const prompt = [
    `CAMERA-MOVE EDIT of the attached master location plate${image_input.length > 1 ? "s" : ""}${name ? ` of "${name}"` : ""}. Keep the SAME real place; move the camera to frame THIS spot within the location: ${spot}.`,
    "This is a controlled re-frame of the EXISTING environment, NOT a fresh scene and NOT a new room: reconstruct the exact same environment as the source plate(s) — the SAME walls, the SAME fixed furniture at the SAME places, the SAME architecture, materials, colours, floor pattern, fixtures and lighting. Any furniture set against a wall keeps its back/rear side FLUSH against that same wall, welded to the architecture with no gap, columns or open space behind it, exactly as in the source layout plate.",
    "Do NOT add, remove, resize, restyle, duplicate or rearrange any furniture or fixed object; do NOT replace a wall with columns, pillars, a passage, an archway, an opening, a doorway, a window, an escalator or open space, and do NOT invent any architecture, structure or objects that are not present in the source plate(s). When the new framing reveals a previously occluded surface, reconstruct it strictly from the source plate(s) rather than inventing anything.",
    inventory ? `The location's fixed set objects (each must stay exactly as placed): ${inventory}.` : "",
    "EMPTY SET: no people, no animals, no text, no captions, no logos — just the environment. Photorealistic single vertical (9:16) film frame.",
  ].filter(Boolean).join("\n");
  const request = buildWaveSpeedImageRequest({ prompt, aspect_ratio: "9:16", image_input, kind: "location" });
  const cacheKey = subLocationRefCacheKey(location.id, spot);
  const hash = createHash("sha256")
    .update(JSON.stringify({ version: 123, cacheKey, spot, base, image_input, request }))
    .digest("hex");
  return { ...request, prompt, image_input, base, cacheKey, hash, cacheId: `sub-location-ref-${hash}` };
}
export type SubLocationRefRequest = ReturnType<typeof buildSubLocationRefRequest>;
