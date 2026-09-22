/**
 * Stage 142 — SCENE ANCHOR FRAME for Storyboard board stills (pure, no network / DB).
 *
 * Why: every board used to be an INDEPENDENT Seedream call whose image_input held only the character
 * identity refs + the location plate(s). The plate does not show the scene's dressed furniture (the big
 * desk with its books/apparatus), so the diffusion model re-invented the desk on every board — a different
 * shape/position, or gone — and "person at the desk" compositions fused bodies into the desktop. A text
 * mandate alone (Stage 140 PERSISTENT SET PIECES) cannot pin geometry; an IMAGE reference can.
 *
 * Fix: the FIRST successfully rendered board of a scene becomes the scene's ANCHOR FRAME and is attached as
 * an image reference to every later board of that scene, with an explicit prompt block that names the
 * reference index and demands the identical set (only the camera angle changes). Boards of one scene render
 * strictly in order (the worker waits for a lower-index sibling that is still rendering); if the first board
 * fails, the next successful one becomes the anchor. A body/furniture non-intersection rule is added to
 * EVERY board. STORYBOARD only — SCENES is untouched; i2v is untouched (the anchor is an image-gen ref only).
 */

/** A sibling board of the same episode as seen by the worker (minimal projection). */
export interface AnchorSibling {
  id: string;
  index: number;
  imageUrl: string | null;
  status: string;
  /** Scene grouping key (see boardSceneKey). Boards with a different key never share an anchor. */
  sceneKey: string;
}

export interface SceneAnchor {
  anchorBoardId: string;
  anchorUrl: string;
  anchorIndex: number;
}

const validUrl = (u?: string | null): u is string => typeof u === "string" && u.startsWith("http") && u.length > 10;

/**
 * Scene grouping: the whole Storyboard episode plays in ONE bound location (Stage 131), so a "scene" is the
 * episode × its location. A `region` is only a corner of that same set (a different camera angle of the same
 * room), so boards in different corners DO share the anchor — that is exactly what keeps the desk in place on
 * a reverse / wide angle. Boards of another episode or another location never share an anchor.
 */
export function boardSceneKey(b: { episodeId: string; locationId?: string | null }): string {
  return `${b.episodeId}|${(b.locationId ?? "").trim() || "episode"}`;
}

/**
 * The anchor for `self`: the LOWEST-index sibling of the same scene, BEFORE this board, that already has a
 * rendered frame. Null → this board has no anchor (it is the first of its scene to render, so it BECOMES the
 * anchor for the boards after it). Re-rendering the first board of a scene therefore keeps it the anchor
 * (no lower sibling) and refreshes its frame; the user re-creates the later boards from it (never auto-paid).
 */
export function pickSceneAnchor(self: { id: string; index: number; sceneKey: string }, siblings: AnchorSibling[]): SceneAnchor | null {
  const candidates = siblings
    .filter((s) => s.id !== self.id && s.sceneKey === self.sceneKey && s.index < self.index && validUrl(s.imageUrl))
    .sort((a, b) => a.index - b.index);
  const first = candidates[0];
  return first ? { anchorBoardId: first.id, anchorUrl: first.imageUrl as string, anchorIndex: first.index } : null;
}

/**
 * Lower-index siblings of the same scene whose frame is STILL RENDERING. While any exist, this board must wait
 * (sequential render inside a scene) so the earliest successful one can become its anchor. Boards that were
 * never rendered ("pending") or that failed ("error") are not waited for — the next successful board takes over.
 */
export function renderingLowerSiblings(self: { id: string; index: number; sceneKey: string }, siblings: AnchorSibling[]): AnchorSibling[] {
  return siblings.filter((s) => s.id !== self.id && s.sceneKey === self.sceneKey && s.index < self.index && !validUrl(s.imageUrl) && s.status === "frame_generating");
}

/** Result of the Stage 145 sequential-frame gate. */
export interface BoardFrameGate {
  allowed: boolean;
  /** English reason (used as the 409 message and the UI tooltip) when blocked. */
  reason?: string;
}

/**
 * Stage 145 — STRICTLY SEQUENTIAL board frames (pure, no network / DB). A board frame may only be
 * rendered once the immediately-previous board (the highest `index` below this one, within the same
 * episode/scene) already has a ready frame. This is a HARD guard reinforcing the Stage 142/144
 * in-worker ordering, so the route can reject (409) a premature request instead of relying on the
 * worker's wait alone.
 *   - The first board of the episode (index 0, or no earlier sibling) is ALWAYS allowed.
 *   - Regenerating an already-completed board (its own frame is already rendered) is ALWAYS allowed —
 *     completed elements can be re-created in any order.
 *   - Otherwise the previous board's frame must be ready. "Ready" is keyed off a valid `imageUrl`
 *     rather than the exact `frame_ready` string, because a board keeps its frame while its status
 *     advances past it (frame_ready → animating → done); a rendered frame is the terminal-success
 *     signal for a board frame regardless of what happens to the clip afterwards.
 */
export function boardFramePrecondition(
  self: { index: number; imageUrl?: string | null; boardRole?: string | null },
  siblings: { index: number; imageUrl?: string | null }[],
): BoardFrameGate {
  // Stage 220 — per-scene model: a board carrying a boardRole (start/end) has its OWN scene-scoped shot plan and
  // is rendered in PARALLEL with its sibling and with every other scene, so it is never gated on a prior board.
  if (self.boardRole) return { allowed: true };
  if (self.index <= 0) return { allowed: true };
  if (validUrl(self.imageUrl)) return { allowed: true };
  const prev = siblings
    .filter((s) => s.index < self.index)
    .sort((a, b) => b.index - a.index)[0];
  if (!prev) return { allowed: true };
  if (validUrl(prev.imageUrl)) return { allowed: true };
  return { allowed: false, reason: "Generate the previous shot first." };
}

export interface ComposedBoardImageInput {
  imageInput: string[];
  /** 1-based position of the anchor frame inside imageInput (null when no anchor is attached). */
  anchorRefIndex: number | null;
  /** 1-based position of the continuity frame (previous board of this scene) inside imageInput (null when none). */
  continuityRefIndex: number | null;
  /** Plate URLs that actually made it into imageInput (in order). */
  platesAttached: string[];
  /** true when the (first) region plate survived the cap. */
  regionPlateAttached: boolean;
}

/**
 * Compose image_input with a strict priority under the provider cap:
 *   character identity refs → CONTINUITY FRAME (previous board of this scene) → SCENE ANCHOR FRAME
 *   → location plate(s) [region plate, wide, layout].
 * When over the cap the PLATES are dropped first (region plate first, since the anchor already carries the
 * dressed set); the continuity frame and the anchor are NEVER dropped, nor are the characters. Duplicates are
 * removed. The continuity frame (Stage 144: poses/body-contact/action from the immediately previous board) and
 * the anchor frame (set/furniture geometry) are frequently the SAME image when the previous board IS the scene
 * anchor (e.g. board 2 of a scene): that shared URL is attached once and both indices point at it.
 */
export function composeBoardImageInput(input: {
  characterRefs: string[];
  continuityUrl?: string | null;
  anchorUrl?: string | null;
  plateUrls: string[];
  hasRegionPlate: boolean;
  maxRefs: number;
}): ComposedBoardImageInput {
  // Defensive: a non-numeric cap (e.g. a partially mocked provider module) falls back to the provider default of 10.
  const max = Math.max(1, Number.isFinite(input.maxRefs) ? Math.floor(input.maxRefs) : 10);
  const chars = Array.from(new Set(input.characterRefs.filter(validUrl)));
  const continuity = validUrl(input.continuityUrl) ? input.continuityUrl : null;
  const anchor = validUrl(input.anchorUrl) ? input.anchorUrl : null;
  // The continuity frame and the anchor may be the same image (previous board == scene anchor): attach once.
  const sharedContinuityAnchor = continuity !== null && continuity === anchor;
  // Distinct non-character reference frames that must always survive the cap.
  const distinctExtras = sharedContinuityAnchor ? 1 : (continuity ? 1 : 0) + (anchor ? 1 : 0);
  // Characters are capped only in the pathological case where they alone would exceed the provider limit;
  // slots are always kept for the continuity/anchor frames when they exist.
  const charLimit = max - distinctExtras;
  const keptChars = chars.slice(0, Math.max(0, charLimit));

  const head: string[] = [...keptChars];
  let continuityRefIndex: number | null = null;
  let anchorRefIndex: number | null = null;
  if (sharedContinuityAnchor) {
    head.push(continuity as string);
    continuityRefIndex = head.length;
    anchorRefIndex = head.length;
  } else {
    if (continuity) {
      head.push(continuity);
      continuityRefIndex = head.length;
    }
    if (anchor) {
      head.push(anchor);
      anchorRefIndex = head.length;
    }
  }

  const plates = Array.from(new Set(input.plateUrls.filter(validUrl))).filter((u) => !head.includes(u));
  const room = Math.max(0, max - head.length);
  // Drop from the FRONT (region plate first) when the plates do not all fit: the anchor is the primary
  // environment truth, the master plates are the least specific backing reference.
  const platesAttached = room >= plates.length ? plates : plates.slice(plates.length - room);
  const regionPlateAttached = input.hasRegionPlate && plates.length > 0 && platesAttached.includes(plates[0]);
  return { imageInput: [...head, ...platesAttached], anchorRefIndex, continuityRefIndex, platesAttached, regionPlateAttached };
}

/** Prompt block naming the attached anchor frame by its reference index (English, for Seedream). */
export function buildSceneAnchorLine(refIndex: number): string {
  return `SCENE ANCHOR FRAME (reference image ${refIndex}): this is the same set moments earlier. Reproduce the EXACT same furniture and props — identical desk shape, size, position, orientation and the objects on it — the same floor pattern, walls and windows. Only the camera angle/framing changes as directed below; nothing in the set is added, removed, moved or resized. Where the anchor frame and a location plate differ, the anchor frame wins. The PEOPLE in the anchor frame are NOT a framing or cast reference: reproduce only the set, furniture, props, floor, walls and light; frame ONLY the characters listed in SHOT SIZE at the stated shot size.`;
}

/**
 * Stage 144 — prompt block naming the attached CONTINUITY frame (the immediately previous board of this scene)
 * by its reference index (English, for Seedream). This frame is the source of the ONGOING action: poses, body
 * contact, who-touches-whom and props-in-hand. It is NOT a set reference (that is the anchor) and NOT a cast /
 * framing reference (that is the SHOT SIZE line).
 */
export function buildContinuityLine(refIndex: number): string {
  return `CONTINUITY FRAME (reference image ${refIndex}): this is the SAME ongoing moment an instant earlier, from a different camera. Carry over the EXACT physical action and body contact shown there — if characters were embracing, holding hands, one hand on a shoulder, mid-gesture or holding a prop, they REMAIN in that exact pose, contact and grip; who-touches-whom and every prop-in-hand stay unchanged. This is a CUT to another vantage of the same instant, NOT a new moment: do NOT reset anyone to a neutral standing pose, do NOT break physical contact, do NOT restart the action. Use this frame ONLY for the characters' poses, contact and action — take the set/furniture from the anchor frame, and take WHO is in frame and the framing from the SHOT SIZE line (a closer shot may crop to fewer characters, but those shown keep their exact pose and contact, and a partner's touching hand or arm may enter at the frame edge).`;
}

/** Bodies never merge into furniture (English, for Seedream) — added to EVERY board frame. */
export const BOARD_BODY_FURNITURE_LINE =
  "BODY / FURNITURE SEPARATION: characters stand beside or behind furniture with a visible floor gap between their feet and any desk, table or bench; a body never intersects, merges into or passes through a desk/table/bench top or leg. If someone stands behind a desk, the desk edge occludes only the lower body cleanly along a single straight edge — torso, arms and head remain fully outside the desktop. Hands rest ON the surface (or hold an object above it), never inside it. Seated characters sit ON a chair/bench with a clear separation from the table edge.";
