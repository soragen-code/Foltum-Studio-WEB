// Stage 14 (E): canonical per-reference frame counts + a concurrency limiter for the
// episode-reference batch generator. Pure/client-safe — no server imports, so it can be
// imported from both the browser UI and the background worker (and unit-tested).

/** How many photos every character reference must have (3 fixed angles, see CHARACTER_ANGLE_SET). */
export const CHARACTER_PHOTO_COUNT = 3
/** Stage 18: every artifact / important object reference has 1 frame (primary only). */
export const ARTIFACT_FRAME_COUNT = 1
/**
 * How many Replicate image requests may be in flight at once for one episode's
 * reference batch. The rest are queued and started as slots free up.
 */
export const REF_BATCH_CONCURRENCY = 20

/**
 * Run `worker` over `items` with at most `limit` promises in flight at any time.
 * Preserves result order, never starts more than `limit` concurrently, and drains the
 * queue as each task settles. `onSettled` fires after every item (for shared progress).
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onSettled?: (doneCount: number, total: number) => void | Promise<void>,
): Promise<R[]> {
  const total = items.length
  const results = new Array<R>(total)
  let next = 0
  let done = 0
  const size = Math.max(1, Math.min(limit, total || 1))

  async function runner(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= total) return
      try {
        results[i] = await worker(items[i], i)
      } finally {
        done += 1
        if (onSettled) await onSettled(done, total)
      }
    }
  }

  const runners: Promise<void>[] = []
  for (let k = 0; k < size; k++) runners.push(runner())
  await Promise.all(runners)
  return results
}

/**
 * Stage 18: the 3 FIXED character reference angles, in the stable display order they are
 * stored/shown: face close-up, LEFT profile, full-body FRONT.
 * Mapping to DB columns: face→imageFront, leftProfile→imageProfile, fullFront→imageFull.
 * imageExtra is no longer populated for characters. The angle set is fixed (not random) so
 * every character is covered from the same, predictable set of viewpoints. NOTE: the face
 * close-up is a REFERENCE photo — it does not violate the "no full-screen face close-ups in
 * dialogue" rule, which applies only to video scenes.
 */
export const CHARACTER_ANGLE_SET = ['face', 'leftProfile', 'fullFront'] as const
export type CharacterAngle = (typeof CHARACTER_ANGLE_SET)[number]
/** Back-compat alias: the 5 character shot slots in a stable order. */
export const CHARACTER_SHOTS = CHARACTER_ANGLE_SET
export type CharacterShot = CharacterAngle

/** Parse a JSON string array of image URLs (used for Character.imageExtra / Artifact.imageExtra). */
export function parseImageArray(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const a = JSON.parse(raw)
    return Array.isArray(a) ? a.filter((u): u is string => typeof u === 'string' && u.startsWith('http')) : []
  } catch {
    return []
  }
}
