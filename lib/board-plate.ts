/**
 * Stage 131 — STORYBOARD board GEOMETRY AUTHORITY selection (pure).
 *
 * Fixes the "location floats between boards" bug in STORYBOARD mode: board keyframes were generated from the
 * location TEXT only, with no visual authority, so the room drifted board-to-board (furniture / architecture /
 * materials / lighting changed). SCENES already solves this (Stage 122) by attaching the location's master
 * plate — and, when available, a per-zone REGION PLATE — as the authoritative environment reference.
 *
 * This module ports that plate SELECTION to boards, PURELY (no network / DB): given the episode Location's
 * master plates (wide + layout) and its cached region plates, plus the board's optional zone, it returns which
 * plate image(s) to attach as the geometry authority. Every board of the same location therefore shares ONE
 * authority, so the environment stays identical between consecutive boards. SCENES is untouched.
 */
import { resolveRegionPlate } from "@/lib/region-plate";

/** The episode Location's plate fields needed to pick a board's geometry authority. */
export interface BoardLocationPlates {
  id?: string | null;
  name?: string | null;
  /** Master WIDE establishing plate (9:16 after Stage 124). */
  imageUrl?: string | null;
  /** Master elevated LAYOUT plate (the floor-plan authority). */
  imageReverse?: string | null;
  /** Location.regionPlates JSON cache { regionKey: url } (Stage 122). */
  regionPlates?: string | null;
}

export interface BoardGeometryAuthority {
  /** Ordered plate image URLs to attach as image_input environment authority (region plate first, else masters). */
  plateUrls: string[];
  /** true when a cached REGION PLATE was selected as the primary authority; false when master plates are used. */
  hasRegionPlate: boolean;
  /** true when at least one plate is available to attach (false → no bound location plates yet: text-only fallback). */
  hasPlate: boolean;
  /** The single primary authority URL to persist on the board (region plate, else wide master, else layout). */
  primaryUrl: string | null;
}

/**
 * Pick the geometry authority for one board.
 *   - If the board has a zone AND a cached region plate exists for it → the REGION PLATE leads (primary), with the
 *     master plates kept behind it as backing geometry truth.
 *   - Otherwise → the location MASTER plates (wide + layout).
 * Reuses ONLY already-generated plates (never triggers a new paid generation). No location / no plates → hasPlate
 * is false and the caller keeps the Stage 127 text-only behaviour.
 */
export function pickBoardGeometryAuthority(
  location: BoardLocationPlates | null | undefined,
  region?: string | null,
): BoardGeometryAuthority {
  const wide = (location?.imageUrl ?? "").trim();
  const layout = (location?.imageReverse ?? "").trim();
  const regionPlate = region ? (resolveRegionPlate(location?.regionPlates, region) ?? "").trim() : "";

  if (regionPlate) {
    // Region plate is the PRIMARY environment authority; masters remain as backing geometry truth.
    const plateUrls = Array.from(new Set([regionPlate, wide, layout].filter(Boolean)));
    return { plateUrls, hasRegionPlate: true, hasPlate: plateUrls.length > 0, primaryUrl: regionPlate };
  }
  const plateUrls = Array.from(new Set([wide, layout].filter(Boolean)));
  return { plateUrls, hasRegionPlate: false, hasPlate: plateUrls.length > 0, primaryUrl: plateUrls[0] ?? null };
}

/**
 * True when two boards of the SAME location resolve to the SAME geometry authority (so their environment must be
 * identical). Used by tests to assert cross-board location identity, and as documentation of the invariant.
 */
export function sameGeometryAuthority(a: BoardGeometryAuthority, b: BoardGeometryAuthority): boolean {
  return a.primaryUrl != null && a.primaryUrl === b.primaryUrl;
}
