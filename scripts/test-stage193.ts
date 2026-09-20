/**
 * Stage 193 — P10: season memory is read by PREDECESSOR episode number (not the newest-by-updatedAt row),
 * only persisted when the generated state is VALID, and the later (dependent) states of a reworked early
 * episode are marked STALE.
 *
 * Pure/synthetic only — NO network, NO LLM, NO DB, NO paid generations.
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage193.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

import {
  pickPredecessorState,
  dependentStateIds,
  type SeasonStateRowLike,
} from "../lib/scene-breakdown";

let passed = 0;
function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exit(1);
  }
  passed++;
  console.log("ok: " + msg);
}

const REPO_ROOT = join(__dirname, "..");
function readSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

const row = (id: string, n: number | null, updatedAt: string): SeasonStateRowLike => ({
  id,
  reflectsEpisodeNumber: n,
  updatedAt,
});

/* ───────────── 1) predecessor = the largest reflectsEpisodeNumber strictly LESS than the current episode ───────────── */
{
  const states = [row("s1", 1, "2024-01-01"), row("s2", 2, "2024-01-02"), row("s3", 3, "2024-01-03")];
  const pred = pickPredecessorState(states, 3);
  ok(pred?.id === "s2", "predecessor of episode 3 is the state reflecting episode 2 (max < 3)");
  const pred2 = pickPredecessorState(states, 2);
  ok(pred2?.id === "s1", "predecessor of episode 2 is the state reflecting episode 1");
}

/* ───────────── 2) THE BUG: a LATER state (newer updatedAt, higher episode) is NOT picked ───────────── */
{
  // Episode 2 was reworked; a state reflecting episode 5 was written most recently (newest updatedAt).
  const states = [
    row("s1", 1, "2024-01-01"),
    row("s5", 5, "2024-06-01"), // newest by updatedAt, but reflects a LATER episode
  ];
  const pred = pickPredecessorState(states, 2);
  ok(pred?.id === "s1", "predecessor of episode 2 ignores the newer state reflecting episode 5 (the bug is fixed)");
  ok(pred?.id !== "s5", "the newest-by-updatedAt row is NOT chosen when it reflects a later episode");
}

/* ───────────── 3) tie-break by updatedAt when two rows reflect the same predecessor number ───────────── */
{
  const states = [
    row("old", 2, "2024-01-01"),
    row("new", 2, "2024-05-01"),
    row("cur", 3, "2024-02-01"),
  ];
  const pred = pickPredecessorState(states, 4);
  ok(pred?.id === "cur", "predecessor of episode 4 is the max number < 4 (episode 3), not a lower tie");
  const predOf3 = pickPredecessorState(states, 3);
  ok(predOf3?.id === "new", "when two rows reflect episode 2, the most recently updated one wins the tie");
}

/* ───────────── 4) a seeded row (reflectsEpisodeNumber == null) is only a FALLBACK ───────────── */
{
  const seededOnly = [row("seed", null, "2024-01-01")];
  ok(pickPredecessorState(seededOnly, 1)?.id === "seed", "with no numbered predecessor, the seeded state is used as fallback");
  const withNumbered = [row("seed", null, "2024-01-01"), row("e1", 1, "2024-02-01")];
  ok(pickPredecessorState(withNumbered, 2)?.id === "e1", "a numbered predecessor is preferred over the seeded fallback");
}

/* ───────────── 5) null when there is no usable predecessor ───────────── */
{
  ok(pickPredecessorState([], 1) === null, "no states → null predecessor");
  ok(pickPredecessorState([row("s3", 3, "x")], 1) === null, "only later states → null predecessor for episode 1");
}

/* ───────────── 6) dependentStateIds = the later states invalidated by reworking an early episode ───────────── */
{
  const states = [
    row("s1", 1, "x"),
    row("s2", 2, "x"),
    row("s3", 3, "x"),
    row("s4", 4, "x"),
    row("seed", null, "x"),
  ];
  const deps = dependentStateIds(states, 2);
  ok(deps.includes("s3") && deps.includes("s4"), "reworking episode 2 marks the states of episodes 3 and 4 stale");
  ok(!deps.includes("s2"), "the reworked episode's own state is NOT in the dependent (stale) set — it is replaced");
  ok(!deps.includes("s1"), "an EARLIER episode's state is not a dependent of the reworked episode");
  ok(!deps.includes("seed"), "the seeded state is not a numbered dependent");
}

/* ───────────── 7) the worker wires these helpers correctly (source inspection) ───────────── */
{
  const src = readSource("lib/workers/scenes-job.ts");
  ok(/pickPredecessorState,/.test(src) && /dependentStateIds,/.test(src), "scenes-job imports the P10 helpers");
  ok(/prisma\.seasonState\.findMany\(/.test(src), "scenes-job reads ALL season states via findMany (not findFirst orderBy updatedAt)");
  ok(!/findFirst\(\s*\{[^}]*orderBy:\s*\{\s*updatedAt/.test(src), "the old 'findFirst orderBy updatedAt desc' predecessor read is gone");
  ok(/reflectsEpisodeNumber: true/.test(src), "the findMany selects reflectsEpisodeNumber (used to pick the predecessor)");
  ok(/pickPredecessorState\(seasonStates, episode\.number\)/.test(src), "scenes-job picks the predecessor by episode number");
  ok(/if \(!result\.valid\) \{/.test(src), "scenes-job gates persistence on result.valid");
  ok(/dependentStateIds\(seasonStates, episode\.number\)/.test(src), "scenes-job computes the dependent (stale) state ids");
  ok(/updateMany\(\{ where: \{ id: \{ in: staleIds \} \}, data: \{ stale: true \} \}\)/.test(src), "scenes-job marks the dependent states stale via updateMany");
  ok(/stale: false,/.test(src), "the freshly created season state is stale:false");
}

console.log(`\nStage 193: PASS (${passed} checks)`);
