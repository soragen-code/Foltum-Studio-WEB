/**
 * Stage 75 — user-uploaded photo references for character generation.
 *
 * Character.userRefs stores a JSON array of public S3 URLs (max USER_REFS_MAX). These photos are fed
 * as `image_input` (FIRST, before any generated anchor) to every character reference generation, so
 * the model locks onto the real person's look. Pure helpers only — no DB, no network.
 */

/** Max user photo references per character. */
export const USER_REFS_MAX = 4;
/** Default image_input cap — safe for every provider (Replicate/WaveSpeed 10, ModelArk 14). */
export const IMAGE_INPUT_CAP = 10;
/** Accepted upload MIME types → file extension. */
export const USER_REF_MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
/** Max upload size (8 MB). */
export const USER_REF_MAX_BYTES = 8 * 1024 * 1024;

function isHttpUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const s = v.trim();
  return /^https?:\/\/\S+$/i.test(s);
}

/** Parse Character.userRefs JSON → clean list of http(s) URLs (deduped, max USER_REFS_MAX). */
export function parseUserRefs(json: string | null | undefined): string[] {
  if (!json || typeof json !== "string") return [];
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const v of arr) {
    if (!isHttpUrl(v)) continue;
    const s = v.trim();
    if (out.includes(s)) continue;
    out.push(s);
    if (out.length >= USER_REFS_MAX) break;
  }
  return out;
}

/**
 * Build the final image_input list: user refs FIRST, then the existing (generated) refs; deduped and
 * capped at `cap` (default IMAGE_INPUT_CAP). Empty entries are dropped.
 */
export function mergeImageInput(userRefs: string[], existing: string[] | undefined, cap: number = IMAGE_INPUT_CAP): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== "string") return;
    const s = v.trim();
    if (!s || out.includes(s)) return;
    if (out.length >= cap) return;
    out.push(s);
  };
  for (const u of userRefs ?? []) push(u);
  for (const e of existing ?? []) push(e);
  return out;
}
