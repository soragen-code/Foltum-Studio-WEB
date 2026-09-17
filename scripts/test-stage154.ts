/**
 * Stage 154 — the storyboard board-planning UI must not be shown a STALE FAILED job.
 *
 * Defect: GET /api/ai/storyboard/boards returned the newest job by createdAt regardless of status, so
 * an old FAILED plan (carrying the obsolete pre-Stage-148 "outside the required 12–15" message) kept
 * surfacing even after boards could be planned. This tests the pure selector that fixes it.
 *
 * No network, no DB, no paid generation — pure logic over plain job objects.
 */
import assert from "node:assert";
import { selectAuthoritativeBoardJob, type BoardJobLike } from "../lib/board-job-select";

let passed = 0;
function ok(cond: boolean, msg: string) {
  assert.ok(cond, msg);
  passed++;
}

const D = (iso: string) => new Date(iso);

// 1. Persisted boards + an older failed job → never surface the failure.
{
  const jobs: BoardJobLike[] = [
    { status: "failed", createdAt: D("2026-01-01T10:00:00Z") },
  ];
  const sel = selectAuthoritativeBoardJob(jobs, /* hasBoards */ true);
  ok(sel === null || (sel as any).status !== "failed", "boards exist → stale failed job is not surfaced");
}

// 2. Newer successful job + older failed job → return the newer successful one.
{
  const success = { status: "completed", createdAt: D("2026-01-02T10:00:00Z") };
  const jobs: BoardJobLike[] = [
    success,
    { status: "failed", createdAt: D("2026-01-01T10:00:00Z") },
  ];
  const sel = selectAuthoritativeBoardJob(jobs, false);
  ok(sel === success, "newer successful job wins over older failure");
}

// 2b. Newer pending/processing job + older failed job → active job wins (failure never blocks a live retry).
{
  const active = { status: "processing", createdAt: D("2026-01-03T10:00:00Z") };
  const jobs: BoardJobLike[] = [
    active,
    { status: "failed", createdAt: D("2026-01-01T10:00:00Z") },
  ];
  const sel = selectAuthoritativeBoardJob(jobs, false);
  ok(sel === active, "newer active (processing) job wins over older failure");
}

// 3. ONLY a failed job, no boards, no newer active job → the failure IS surfaced (genuine current error).
{
  const fail = { status: "failed", createdAt: D("2026-01-01T10:00:00Z") };
  const jobs: BoardJobLike[] = [fail];
  const sel = selectAuthoritativeBoardJob(jobs, false);
  ok(sel === fail, "a genuine current failure (no boards, no newer job) is still shown");
}

// 4. A job explicitly retired as "superseded" is never authoritative, even if it is the newest.
{
  const superseded = { status: "superseded", createdAt: D("2026-01-05T10:00:00Z") };
  const older = { status: "completed", createdAt: D("2026-01-04T10:00:00Z") };
  const jobs: BoardJobLike[] = [superseded, older];
  const sel = selectAuthoritativeBoardJob(jobs, true);
  ok(sel === older, "a superseded job is ignored; the older completed job is authoritative");
}

// 4b. Superseded failure is ignored even with no boards and nothing else live.
{
  const supersededFail = { status: "superseded", createdAt: D("2026-01-05T10:00:00Z") };
  const jobs: BoardJobLike[] = [supersededFail];
  const sel = selectAuthoritativeBoardJob(jobs, false);
  ok(sel === null, "a superseded (retired) failure is never surfaced");
}

// 5. Empty list → null.
{
  ok(selectAuthoritativeBoardJob([], false) === null, "no jobs → null");
  ok(selectAuthoritativeBoardJob([], true) === null, "no jobs (with boards) → null");
}

// 6. String / number createdAt are ordered the same as Date (route may pass serialized values).
{
  const newer = { status: "completed", createdAt: "2026-02-02T00:00:00Z" };
  const older = { status: "failed", createdAt: "2026-02-01T00:00:00Z" };
  const sel = selectAuthoritativeBoardJob([older, newer], false);
  ok(sel === newer, "string timestamps ordered correctly (newer success wins)");
}

// 7. Ordering is independent of input array order.
{
  const success = { status: "completed", createdAt: D("2026-03-02T10:00:00Z") };
  const fail = { status: "failed", createdAt: D("2026-03-01T10:00:00Z") };
  const a = selectAuthoritativeBoardJob([fail, success], false);
  const b = selectAuthoritativeBoardJob([success, fail], false);
  ok(a === success && b === success, "selection stable regardless of input order");
}

console.log(`Stage 154: PASS (${passed} checks; pure logic, no network, no paid generation)`);
