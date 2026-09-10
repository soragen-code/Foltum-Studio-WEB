/**
 * Stage 28 tests — AI-seamless episode stitching (FILM frame-interpolation) pure logic.
 * Run: npx tsx scripts/test-stage28.ts
 *
 * Pure-logic only (NO Replicate / network / ffmpeg): proves the per-seam bridge PLANNING
 * that guarantees (a) total episode duration is preserved, (b) a too-short neighbour or an
 * unusable bridge degrades to a plain cut (null) instead of failing assembly — the fallback
 * the runtime relies on when FILM is unavailable for a seam.
 */
import assert from "node:assert";
import { planSeamBridge } from "../lib/ffmpeg";

let pass = 0;
const ok = (c: unknown, m: string) => {
  assert(c, m);
  console.log("ok:", m);
  pass++;
};

// ── 1. A normal ~0.3s bridge between two full-length clips is accepted ────────────────────────────
const normal = planSeamBridge(0.3, 5, 5);
ok(normal !== null, "normal seam produces a bridge");
ok(normal!.bridge === 0.3, "normal bridge keeps the model's 0.3s length");
ok(Math.abs(normal!.half - 0.15) < 1e-9, "half = bridge/2 (trimmed from each neighbour → duration preserved)");

// ── 2. Bridge is clamped to ≤30% of the shorter neighbour (keeps bodies positive) ─────────────────
const clamped = planSeamBridge(2.0, 1.0, 8.0);
ok(clamped !== null, "long raw bridge on a short neighbour still bridges");
ok(Math.abs(clamped!.bridge - 0.3) < 1e-9, "bridge clamped to 30% of the 1.0s neighbour (0.3)");
ok(clamped!.half === clamped!.bridge / 2, "clamped half stays bridge/2");

// ── 3. A too-short neighbour → null → plain-cut fallback (no bridge, assembly still completes) ─────
ok(planSeamBridge(0.3, 0.2, 5) === null, "neighbour A too short → no bridge (fallback to cut)");
ok(planSeamBridge(0.3, 5, 0.3) === null, "neighbour B too short → no bridge (fallback to cut)");

// ── 4. An unusable / zero-length bridge output → null (fallback) ───────────────────────────────────
ok(planSeamBridge(0, 5, 5) === null, "zero-length bridge output → no bridge");
ok(planSeamBridge(0.01, 5, 5) === null, "sub-threshold bridge output → no bridge");

// ── 5. Duration preservation invariant: trimmed (half*2) equals inserted bridge on every seam ──────
for (const [raw, a, b] of [[0.3, 5, 5], [0.5, 2, 3], [1.5, 4, 4]] as const) {
  const p = planSeamBridge(raw, a, b);
  if (p) ok(Math.abs(p.half * 2 - p.bridge) < 1e-9, `duration preserved for seam (${raw},${a},${b}): 2·half == bridge`);
}

console.log(`\nStage 28: ${pass} checks passed.`);
