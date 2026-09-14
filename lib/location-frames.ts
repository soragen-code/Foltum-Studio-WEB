/**
 * Stage 46E — pure frame-set arithmetic for "Delete frame" on a location.
 *
 * A location keeps three named slots (master `imageUrl`, `imageReverse`, `imageDetail`) plus a JSON array of
 * extra frames (`imageExtra`). Removing a frame never leaves the location empty: at least one frame must stay.
 * Removing the MASTER promotes the first remaining frame (reverse → detail → extra[0]) into `imageUrl`, so the
 * master (which every angle chain and scene reference relies on) is always present when any frame exists.
 * Stage 111: the `reverse` slot now holds the MANDATORY elevated LAYOUT view — it cannot be deleted, only
 * regenerated (POST /shot { slot: "layout" }).
 */
export type LocationFrameSlot = "master" | "reverse" | "detail" | "extra";

export interface LocationFrameState {
  imageUrl: string | null;
  imageReverse: string | null;
  imageDetail: string | null;
  /** Parsed extra frames (URLs), in order. */
  extras: string[];
}

export const MIN_FRAMES_ERROR = "At least one frame must remain";
export const LAYOUT_LOCKED_ERROR = "The layout view is mandatory — regenerate it instead of deleting";

function has(u: string | null | undefined): u is string {
  return typeof u === "string" && u.trim().length > 0;
}

/** Number of non-empty frames in the state. */
export function countLocationFrames(s: LocationFrameState): number {
  return [s.imageUrl, s.imageReverse, s.imageDetail].filter(has).length + s.extras.filter(has).length;
}

export type RemoveFrameResult = { ok: true; state: LocationFrameState } | { ok: false; error: string; status: 400 | 404 };

export function removeLocationFrame(state: LocationFrameState, slot: LocationFrameSlot, index?: number): RemoveFrameResult {
  const s: LocationFrameState = {
    imageUrl: has(state.imageUrl) ? state.imageUrl : null,
    imageReverse: has(state.imageReverse) ? state.imageReverse : null,
    imageDetail: has(state.imageDetail) ? state.imageDetail : null,
    extras: state.extras.filter(has),
  };
  // Existence checks first — a missing frame is a 404, not a «min 1» violation.
  if (slot === "extra") {
    if (index === undefined || !Number.isInteger(index) || index < 0 || index >= s.extras.length) {
      return { ok: false, error: "No such shot", status: 404 };
    }
  } else if (!s[slot === "master" ? "imageUrl" : slot === "reverse" ? "imageReverse" : "imageDetail"]) {
    return { ok: false, error: "No such shot", status: 404 };
  }
  if (slot === "reverse") return { ok: false, error: LAYOUT_LOCKED_ERROR, status: 400 };
  if (countLocationFrames(s) <= 1) return { ok: false, error: MIN_FRAMES_ERROR, status: 400 };

  if (slot === "extra") {
    return { ok: true, state: { ...s, extras: s.extras.filter((_, i) => i !== index) } };
  }
  if (slot === "detail") return { ok: true, state: { ...s, imageDetail: null } };
  // master: promote the first remaining frame into imageUrl and clear its old slot. The layout view is
  // NOT promoted (it is an elevated view, not an establishing frame) — it is cleared together with the
  // master it was chained on, so the author regenerates the pair.
  if (s.imageDetail) return { ok: true, state: { ...s, imageUrl: s.imageDetail, imageDetail: null, imageReverse: null } };
  const [first, ...rest] = s.extras;
  if (first) return { ok: true, state: { ...s, imageUrl: first, imageReverse: null, extras: rest } };
  // Only the layout view remains besides the master — deleting the master would strand it; refuse.
  return { ok: false, error: MIN_FRAMES_ERROR, status: 400 };
}
