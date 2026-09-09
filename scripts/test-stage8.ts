/**
 * Stage 8 unit checks: batch video auto-continuation planner.
 * Verifies next-unfinished selection + strict idempotency (done / in-flight scenes are never re-taken).
 * Run: npx tsx scripts/test-stage8.ts
 */
import { planContinuation, type SceneJobSnapshot } from "../lib/batch-continue";

const assert = (c: unknown, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };

const NOW = 1_000_000_000;
const KICK = 75_000;
const OPTS = { nowMs: NOW, kickStaleMs: KICK, concurrency: 3, maxAttempts: 2, manualMaxAttempts: 4 };

const done = (n: number): SceneJobSnapshot => ({ sceneId: `d${n}`, number: n, hasVideo: true, attempts: 1, latestJob: { status: "completed", hasPrediction: true, isModeration: false, updatedAtMs: NOW - 500_000 } });
const inflight = (n: number): SceneJobSnapshot => ({ sceneId: `g${n}`, number: n, hasVideo: false, attempts: 1, latestJob: { status: "processing", hasPrediction: true, isModeration: false, updatedAtMs: NOW - 10_000 } });
const orphan = (n: number): SceneJobSnapshot => ({ sceneId: `o${n}`, number: n, hasVideo: false, attempts: 1, latestJob: { status: "pending", hasPrediction: false, isModeration: false, updatedAtMs: NOW - (KICK + 20_000) } });
const fresh = (n: number): SceneJobSnapshot => ({ sceneId: `f${n}`, number: n, hasVideo: false, attempts: 1, latestJob: { status: "pending", hasPrediction: false, isModeration: false, updatedAtMs: NOW - 5_000 } });
const failed = (n: number, attempts = 1, moderation = false): SceneJobSnapshot => ({ sceneId: `x${n}`, number: n, hasVideo: false, attempts, latestJob: { status: "failed", hasPrediction: false, isModeration: moderation, updatedAtMs: NOW - 200_000 } });
const nojob = (n: number): SceneJobSnapshot => ({ sceneId: `n${n}`, number: n, hasVideo: false, attempts: 0, latestJob: null });

// 1) Idempotency: a scene that already has a video is never resubmitted or retried.
{
  const p = planContinuation([done(1), done(2), orphan(3)], OPTS);
  assert(p.done === 2, "two done scenes counted");
  assert(!p.resubmit.includes("d1") && !p.resubmit.includes("d2") && !p.retry.includes("d1"), "done scenes never selected");
  assert(p.resubmit.includes("o3"), "orphan selected for resubmit");
}

// 2) In-flight (submitted, has predictionId) is never touched — poll recovery owns it.
{
  const p = planContinuation([inflight(1), inflight(2)], OPTS);
  assert(p.generating === 2 && p.resubmit.length === 0 && p.retry.length === 0, "in-flight scenes left alone");
  assert(p.remaining === 2, "in-flight counts as remaining work");
}

// 3) Orphaned pending (no prediction, stale) → resubmit; fresh pending → left as generating.
{
  const p = planContinuation([orphan(1), fresh(2)], OPTS);
  assert(p.resubmit.includes("o1"), "stale orphan resubmitted");
  assert(!p.resubmit.includes("f2") && p.generating === 1, "fresh pending NOT resubmitted (pool owns it)");
}

// 4) Auto mode never re-charges a failed scene (surfaced as terminal, excluded from remaining).
{
  const p = planContinuation([failed(1), done(2)], OPTS);
  assert(p.failed === 1 && p.retry.length === 0, "auto: failed scene not retried");
  assert(p.remaining === 0, "auto: batch finished when only done + terminal-failed remain (loop stops)");
}

// 5) Manual retry re-charges a failed scene (incl. moderation) under the cap.
{
  const p = planContinuation([failed(1, 1, true)], { ...OPTS, retryFailed: true });
  assert(p.retry.includes("x1"), "manual: moderation-failed scene retried");
  const capped = planContinuation([failed(1, 4, true)], { ...OPTS, retryFailed: true });
  assert(capped.retry.length === 0 && capped.failed === 1, "manual: retry cap respected (attempts >= manualMax)");
}

// 6) A never-queued scene is NOT auto-started (no accidental charge on page load) but IS started manually.
{
  const auto = planContinuation([nojob(1)], OPTS);
  assert(auto.retry.length === 0 && auto.remaining === 0, "auto: never-queued scene not charged/started, not remaining");
  const manual = planContinuation([nojob(1)], { ...OPTS, retryFailed: true });
  assert(manual.retry.includes("n1"), "manual: never-queued scene started on explicit request");
}

// 7) Concurrency: only (concurrency - generating) scenes are (re)started per invocation.
{
  const p = planContinuation([inflight(1), orphan(2), orphan(3), orphan(4)], OPTS); // concurrency 3, 1 in-flight → capacity 2
  assert(p.resubmit.length === 2, `capacity respected: started ${p.resubmit.length} (expected 2)`);
  assert(p.remaining === 4, "all four unfinished scenes counted as remaining");
}

// 8) Selection order: resubmit (already paid) is preferred over retry (fresh charge) within capacity.
{
  const p = planContinuation([orphan(1), orphan(2), orphan(3), failed(4)], { ...OPTS, retryFailed: true }); // capacity 3
  assert(p.resubmit.length === 3 && p.retry.length === 0, "resubmit fills capacity before retry");
}

// 9) All done → nothing to do, batch complete.
{
  const p = planContinuation([done(1), done(2), done(3)], OPTS);
  assert(p.remaining === 0 && p.resubmit.length === 0 && p.retry.length === 0 && p.done === 3, "all-done batch is complete");
}

console.log("\nAll Stage 8 planner checks passed.");
