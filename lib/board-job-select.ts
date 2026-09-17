/**
 * Stage 154 — pick which board-planning GenerationJob the storyboard UI should see (pure, DB-free).
 *
 * The defect this fixes: GET /api/ai/storyboard/boards used to return the latest job by createdAt
 * regardless of status, so an OLD FAILED board-planning job (carrying the obsolete pre-Stage-148
 * "outside the required 12–15" message) kept being surfaced even after boards could be planned
 * successfully — the user perceived a resolved error as "still breaking".
 *
 * Rules:
 *   • Retired jobs (status "superseded") are never authoritative and are ignored outright.
 *   • The most recent NON-failed job (pending / processing / completed / canceled) is authoritative
 *     — a newer successful/active job always wins over an older failure.
 *   • A failed job is surfaced ONLY when it is genuinely the current state: it is the latest live job,
 *     there are no usable persisted boards, and there is no newer non-failed job. This keeps genuine
 *     current failures visible while never showing a stale/superseded one.
 */
export type BoardJobLike = { status: string; createdAt: Date | string | number };

function ts(v: Date | string | number): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  const parsed = Date.parse(v);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Statuses that must never be surfaced as the current job (explicitly retired). */
const RETIRED_STATUSES = new Set(["superseded"]);

export function selectAuthoritativeBoardJob<J extends BoardJobLike>(
  jobs: readonly J[],
  hasBoards: boolean,
): J | null {
  if (!jobs.length) return null;
  // Newest first; ignore explicitly retired jobs entirely.
  const live = [...jobs]
    .filter((j) => !RETIRED_STATUSES.has(j.status))
    .sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
  if (!live.length) return null;

  const latest = live[0];
  // A non-failed latest job is authoritative (covers newer successful / pending / processing / canceled).
  if (latest.status !== "failed") return latest;

  // Latest is failed. Prefer the most recent non-failed job when boards already exist or such a job
  // exists at all; only surface the failure when it is genuinely the current, unresolved state.
  const mostRecentNonFailed = live.find((j) => j.status !== "failed") ?? null;
  if (hasBoards || mostRecentNonFailed) return mostRecentNonFailed;
  return latest;
}
