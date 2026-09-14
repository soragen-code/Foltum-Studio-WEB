/**
 * Stage 39 tests — parallel scene generation: the sequential gate is gone and «Сгенерировать все»
 * fans out every scene at once.
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage39.ts
 *
 * Pure-logic only (NO Replicate / network / LLM / DB).
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GENERATE_ALL_CONCURRENCY, canStartScene, fanOutAll, splitByCredits } from "../lib/generate-all-fanout";
import { planContinuation, type SceneJobSnapshot } from "../lib/batch-continue";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };

(async () => {
  // ── A. gating constant / function are gone ────────────────────────────────────────────────────
  ok(GENERATE_ALL_CONCURRENCY === Number.POSITIVE_INFINITY, "GENERATE_ALL_CONCURRENCY is unbounded (Infinity)");
  ok(canStartScene({ number: 1 }, null), "scene 1 can start");
  ok(canStartScene({ number: 5 }, { hasVideo: false, generating: false }), "scene N can start while the previous scene has no video");
  ok(canStartScene({ number: 5 }, { hasVideo: false, generating: true }), "scene N can start while the previous scene is generating");

  // ── B. fan-out: every starter is invoked before any of them resolves ──────────────────────────
  {
    const invoked: number[] = [];
    const resolved: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const items = [1, 2, 3, 4, 5];
    const run = fanOutAll(items, async (n) => { invoked.push(n); await gate; resolved.push(n); return n * 10; });
    await new Promise((r) => setTimeout(r, 0));
    ok(JSON.stringify(invoked) === JSON.stringify(items) && resolved.length === 0, "all 5 starters invoked before any resolved");
    release();
    const res = await run;
    ok(res.started === 5 && res.results.every((r) => r.status === "fulfilled"), "all 5 jobs settled");
    ok(resolved.length === 5, "all jobs completed in parallel");
  }
  {
    // A failing job never blocks the others.
    const errors: number[] = [];
    const res = await fanOutAll([1, 2, 3], async (n) => { if (n === 2) throw new Error("boom"); return n; }, (n) => errors.push(n));
    ok(res.results.filter((r) => r.status === "fulfilled").length === 2 && res.results[1].status === "rejected", "one rejected starter does not stop the others");
    ok(JSON.stringify(errors) === JSON.stringify([2]), "onError called for the failing item only");
  }

  // ── C. partial credits: pay for as many scenes as possible, report the rest ───────────────────
  {
    const scenes = [{ id: "a", cost: 4 }, { id: "b", cost: 4 }, { id: "c", cost: 4 }];
    const r = splitByCredits(scenes, (s) => s.cost, 9);
    ok(r.payable.map((s) => s.id).join() === "a,b" && r.unpaid.map((s) => s.id).join() === "c" && r.charged === 8, "9 credits → 2 of 3 scenes started, 1 unpaid");
    const all = splitByCredits(scenes, (s) => s.cost, 12);
    ok(all.payable.length === 3 && all.unpaid.length === 0, "enough credits → all started");
    const none = splitByCredits(scenes, (s) => s.cost, 3);
    ok(none.payable.length === 0 && none.unpaid.length === 3, "no credits → nothing started (route answers 402)");
  }

  // ── D. continuation planner: no frontier gate ─────────────────────────────────────────────────
  {
    const NOW = 1_000_000_000;
    const inflight = (n: number): SceneJobSnapshot => ({ sceneId: `g${n}`, number: n, hasVideo: false, attempts: 1, latestJob: { status: "processing", hasPrediction: true, isModeration: false, updatedAtMs: NOW - 10_000 } });
    const orphan = (n: number): SceneJobSnapshot => ({ sceneId: `o${n}`, number: n, hasVideo: false, attempts: 1, latestJob: { status: "pending", hasPrediction: false, isModeration: false, updatedAtMs: NOW - 200_000 } });
    const p = planContinuation([inflight(1), orphan(2), orphan(3), orphan(4)], { nowMs: NOW, kickStaleMs: 75_000, concurrency: GENERATE_ALL_CONCURRENCY, maxAttempts: 2 });
    ok(p.resubmit.length === 3 && p.generating === 1 && p.pending === 3 && p.remaining === 4, "planner kicks every orphan while scene 1 is still generating");
  }

  // ── E. UI source: gate hint removed, generate-all button present ──────────────────────────────
  {
    const src = readFileSync(join(__dirname, "..", "app", "project", "[id]", "episode", "[episodeId]", "episode-view.tsx"), "utf8");
    ok(!src.includes("Complete the previous scene first") && !src.includes("scene-gate-hint") && !src.includes("prevReady"), "episode-view: sequential gate + hint removed");
    ok(src.includes('data-testid="generate-all-scenes"') && src.includes("Generate all scenes"), "episode-view: «Generate all scenes» button present");
    const route = readFileSync(join(__dirname, "..", "app", "api", "ai", "episodes", "[id]", "generate-all", "route.ts"), "utf8");
    ok(route.includes("fanOutAll(") && !route.includes("for (const item of queued)"), "generate-all route fans out instead of looping sequentially");
    ok(route.includes("insufficient"), "generate-all route reports unpaid scenes");
  }

  console.log(`\nStage 39: ${pass} checks passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
