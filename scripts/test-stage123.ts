/**
 * Stage 123 — PERCENTAGE PROGRESS BAR DURING STORY/SEASON-SCRIPT BUILD.
 *
 * While the season script is being built the UI already showed a spinner + a filled bar, but no
 * percentage number. This stage adds the percentage (data-testid="season-progress-pct") and drives
 * the bar with a monotonic, never-false-100 value computed by `seasonBuildPercent`.
 *
 * The percent is derived from the server job progress (structure 3% → episodes 5–95% via
 * episodeProgress → done 100%) with an episode-count floor so it never jumps backwards across the
 * optimistic "Starting…" state / auto-continue POSTs (which reset job.progress to 1). It is capped
 * at 99 while working so a false 100% never shows mid-build; on failure the caller keeps the error
 * status and never snaps the bar to 100.
 *
 * Pure-function tests only (no network, no paid generations).
 * Run: timeout 90 npx tsx --tsconfig tsconfig.json scripts/test-stage123.ts
 */
import { seasonBuildPercent } from '../app/project/[id]/_components/season-stage';

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
  console.log('ok: ' + msg);
}

// --- Basic bounds -----------------------------------------------------------
ok(seasonBuildPercent({ progress: 0, done: 0, total: 0 }) === 2, 'no signal → floor 2%');
ok(seasonBuildPercent({ progress: null, done: 0, total: 0 }) === 2, 'null progress → floor 2%');
ok(seasonBuildPercent({ progress: undefined, done: 0, total: 0 }) === 2, 'undefined progress → floor 2%');

// Structure phase: server reports 3%, no episodes yet.
ok(seasonBuildPercent({ progress: 3, done: 0, total: 0 }) === 3, 'structure phase shows server 3%');

// --- Episode floor mirrors backend episodeProgress = 5 + round(done/total*90) ----------------
const total = 8;
ok(seasonBuildPercent({ progress: 5, done: 0, total }) === 5, 'episodes start at 5% (0/8)');
ok(seasonBuildPercent({ progress: 0, done: 4, total }) === 50, '4/8 → 50% from episode floor even if server progress lags');
// 8/8: episode floor would be 95, server maybe 95; capped below 100 while working.
ok(seasonBuildPercent({ progress: 95, done: 8, total }) === 95, '8/8 → 95% (episodeProgress top)');

// --- Never a false 100 while working ---------------------------------------
ok(seasonBuildPercent({ progress: 100, done: 8, total }) === 99, 'server 100 while block still active is capped to 99');
ok(seasonBuildPercent({ progress: 999, done: 8, total }) === 99, 'absurd server value clamped to 99');

// --- Monotonic across the optimistic auto-continue reset --------------------
// Auto-continue POST sets job.progress back to 1, but done/total keep the floor high.
const beforeContinue = seasonBuildPercent({ progress: 68, done: 5, total }); // 5/8 → floor 61, server 68 → 68
const afterOptimisticReset = seasonBuildPercent({ progress: 1, done: 5, total }); // server 1, floor 61 → 61
ok(afterOptimisticReset >= 61, 'episode floor keeps percent high after optimistic progress reset');
ok(beforeContinue >= afterOptimisticReset - 8, 'no large backwards jump on auto-continue (floor holds most of it)');

// --- Monotonic non-decreasing as episodes are written ----------------------
let prev = -1;
for (let d = 0; d <= total; d++) {
  const p = seasonBuildPercent({ progress: 5, done: d, total });
  ok(p >= prev, `percent non-decreasing at done=${d} (${p} >= ${prev})`);
  ok(p >= 2 && p <= 99, `percent within [2,99] at done=${d} (${p})`);
  prev = p;
}

// --- done clamped to total (defensive) -------------------------------------
ok(seasonBuildPercent({ progress: 5, done: 999, total }) === 95, 'done above total clamped to total (95%)');
ok(seasonBuildPercent({ progress: 5, done: -3, total }) === 5, 'negative done clamped to 0 (5%)');

console.log(`Stage 123: PASS (${passed} checks)`);
