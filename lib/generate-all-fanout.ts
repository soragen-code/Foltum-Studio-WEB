/**
 * Stage 39 — parallel scene generation helpers (pure, DB-free, unit-tested).
 *
 * Since Stage 38 a scene no longer depends on the previous scene's output (the last frame is never
 * sent as a reference), so nothing forces scenes to run one after another. «Сгенерировать все»
 * therefore FANS OUT: every queued scene job is started immediately, all at once.
 */

/** No cap: every queued scene of the episode is started at the same time. */
export const GENERATE_ALL_CONCURRENCY = Number.POSITIVE_INFINITY;

/**
 * Per-scene gate for starting a generation. Stage 39: ALWAYS open — a scene may start regardless of
 * the status of the previous scene or of any other scene in the episode. The only remaining
 * protection is against double-starting the SAME scene (handled by the routes via the active-job
 * lookup), which this helper is not concerned with. Kept as a function so the intent is testable.
 */
export function canStartScene(_scene: { number: number }, _previous?: { hasVideo: boolean; generating: boolean } | null): boolean {
  return true;
}

export interface FanOutResult<T> {
  started: number;
  results: PromiseSettledResult<T>[];
}

/**
 * Start `start(item)` for EVERY item synchronously (all starters are invoked before any of them can
 * resolve), then wait for all of them. A rejected starter never prevents the others from running;
 * `onError` (if given) is called for each rejection so the caller can log it.
 */
export async function fanOutAll<I, T>(items: readonly I[], start: (item: I) => Promise<T>, onError?: (item: I, err: unknown) => void): Promise<FanOutResult<T>> {
  const promises = items.map((item) =>
    Promise.resolve()
      .then(() => start(item))
      .catch((err) => { onError?.(item, err); throw err; }),
  );
  const results = await Promise.allSettled(promises);
  return { started: items.length, results };
}

/**
 * Decide how many scenes an up-front charge can cover: walks the scenes in order and stops charging
 * once the balance can no longer pay for the next one. Returns the scenes to start and the ones that
 * must be reported as «Недостаточно кредитов».
 */
export function splitByCredits<S>(scenes: readonly S[], costOf: (scene: S) => number, credits: number): { payable: S[]; unpaid: S[]; charged: number } {
  const payable: S[] = [];
  const unpaid: S[] = [];
  let left = credits;
  let charged = 0;
  for (const s of scenes) {
    const cost = costOf(s);
    if (unpaid.length === 0 && left >= cost) { payable.push(s); left -= cost; charged += cost; }
    else unpaid.push(s);
  }
  return { payable, unpaid, charged };
}
