/**
 * Stage 8 unit checks: batch video auto-continuation planner.
 * Verifies next-unfinished selection + strict idempotency (done / in-flight scenes are never re-taken).
 * Run: npx tsx scripts/test-stage8.ts
 */
import { planContinuation, type SceneJobSnapshot } from "../lib/batch-continue";

const assert = (c: unknown, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };

const NOW = 1_000_000_000;
const KICK = 75_000;
// Stage 39: generation is parallel — every kickable scene is (re)started in the same pass (no cap).
const OPTS = { nowMs: NOW, kickStaleMs: KICK, concurrency: Number.POSITIVE_INFINITY, maxAttempts: 2, manualMaxAttempts: 4 };

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

// 3) Orphaned pending (no prediction, stale) → resubmit; a freshly queued later scene is left alone (about to be submitted).
{
  const p = planContinuation([orphan(1), fresh(2)], OPTS);
  assert(p.resubmit.includes("o1"), "stale orphan is resubmitted");
  assert(!p.resubmit.includes("f2") && p.generating === 1, "freshly queued scene is not resubmitted and counts as in progress");
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

// 7) Parallel (Stage 39): EVERY orphan is resubmitted in one pass, regardless of order or in-flight scenes.
{
  const p = planContinuation([orphan(1), orphan(2), orphan(3)], OPTS);
  assert(JSON.stringify(p.resubmit) === JSON.stringify(["o1", "o2", "o3"]), `all orphans resubmitted at once (got ${JSON.stringify(p.resubmit)})`);
  assert(p.remaining === 3, "unfinished scenes keep the batch running");
  // An in-flight scene never blocks the others from starting.
  const q = planContinuation([inflight(1), orphan(2), orphan(3)], OPTS);
  assert(q.resubmit.length === 2 && q.generating === 1 && q.remaining === 3, "later scenes start while another scene is still generating");
  // A finite cap is still honoured when a caller asks for one.
  const capped = planContinuation([inflight(1), orphan(2), orphan(3)], { ...OPTS, concurrency: 2 });
  assert(capped.resubmit.length === 1 && capped.resubmit[0] === "o2", "explicit finite concurrency cap is respected");
}

// 8) No ordering gate across modes: a not-done predecessor never blocks a later scene.
{
  // Manual mode: the orphan (already paid) is resubmitted AND the later failed scene is retried in the same pass.
  const p = planContinuation([orphan(1), failed(2)], { ...OPTS, retryFailed: true });
  assert(p.resubmit.length === 1 && p.resubmit[0] === "o1" && p.retry.length === 1 && p.retry[0] === "x2", "resubmit and retry happen in the same pass");
  // Failed first scene + orphan second: both are kicked.
  const q = planContinuation([failed(1), orphan(2)], { ...OPTS, retryFailed: true });
  assert(q.retry.length === 1 && q.retry[0] === "x1" && q.resubmit.length === 1 && q.resubmit[0] === "o2", "later orphan is not gated behind a failed predecessor");
}

// 9) All done → nothing to do, batch complete.
{
  const p = planContinuation([done(1), done(2), done(3)], OPTS);
  assert(p.remaining === 0 && p.resubmit.length === 0 && p.retry.length === 0 && p.done === 3, "all-done batch is complete");
}

console.log("\nAll Stage 8 planner checks passed.");
