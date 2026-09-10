/**
 * Stage 19 tests — background «Ассембл» job (episode_assemble) pure logic.
 * Run: npx tsx scripts/test-stage19.ts
 *
 * Pure-logic only (NO LLM / network / ffmpeg): proves the phase sequencing, progress mapping,
 * stitch-without-charge gate and resultData shape shared by the server orchestrator
 * (app/api/ai/assemble-episode/polish) and the client poller (episode-view.tsx). Also proves that a
 * zero-issue audit selects no scenes → the job stitches without charging (selectPolishScenes seam).
 */
import assert from "node:assert";
import {
  ASSEMBLE_JOB_TYPE,
  ASSEMBLE_PHASE_ORDER,
  nextAssemblePhase,
  assembleProgress,
  shouldStitchWithoutCharge,
  buildAssembleResult,
  type AssembleResultData,
  type AssemblePhase,
} from "../lib/assemble-plan";
import { selectPolishScenes, type AuditSceneResult, type PolishSceneInput } from "../lib/polish";

let pass = 0;
const ok = (c: unknown, m: string) => {
  assert(c, m);
  console.log("ok:", m);
  pass++;
};

// ── 1. Job type is the stable free-string used everywhere ────────────────────────────────────────
ok(ASSEMBLE_JOB_TYPE === "episode_assemble", "ASSEMBLE_JOB_TYPE is 'episode_assemble'");

// ── 2. Phase order + nextAssemblePhase ───────────────────────────────────────────────────────────
ok(
  JSON.stringify(ASSEMBLE_PHASE_ORDER) === JSON.stringify(["analyzing", "regen", "stitching", "done"]),
  "phase order is analyzing → regen → stitching → done"
);
ok(nextAssemblePhase("analyzing") === "regen", "analyzing → regen");
ok(nextAssemblePhase("regen") === "stitching", "regen → stitching");
ok(nextAssemblePhase("stitching") === "done", "stitching → done");
ok(nextAssemblePhase("done") === "done", "done is terminal (stays done)");

// ── 3. Progress mapping is monotonic and bounded 1..100 ──────────────────────────────────────────
const pAnalyze = assembleProgress("analyzing");
const pRegen0 = assembleProgress("regen", 0, 4);
const pRegenHalf = assembleProgress("regen", 2, 4);
const pRegenFull = assembleProgress("regen", 4, 4);
const pStitch = assembleProgress("stitching");
const pDone = assembleProgress("done");
ok(pAnalyze >= 1 && pAnalyze < pRegen0, "analyzing progress below regen start");
ok(pRegen0 < pRegenHalf && pRegenHalf < pRegenFull, "regen progress grows with done/total");
ok(pRegenFull <= pStitch && pStitch < pDone, "regen ≤ stitching < done");
ok(pDone === 100, "done progress is 100");
ok(assembleProgress("regen", 0, 0) === 15, "regen with total 0 clamps to 15 (no divide-by-zero)");
for (const ph of ASSEMBLE_PHASE_ORDER) {
  const v = assembleProgress(ph as AssemblePhase, 1, 3);
  ok(v >= 1 && v <= 100, `progress for ${ph} within 1..100 (${v})`);
}

// ── 4. shouldStitchWithoutCharge gate ────────────────────────────────────────────────────────────
ok(shouldStitchWithoutCharge(0) === true, "zero issues → stitch without charge");
ok(shouldStitchWithoutCharge(2) === false, "some issues → do not stitch without charge");
ok(shouldStitchWithoutCharge(-1) === true, "negative treated as no issues");

// ── 5. buildAssembleResult round-trips the shape the client reads ─────────────────────────────────
const data: AssembleResultData = {
  episodeId: "ep_123",
  phase: "done",
  issues: [{ number: 2, issue: "Персонаж телепортируется" }],
  done: 1,
  total: 1,
  failed: 0,
  videoUrl: "https://example.com/ep.mp4",
  fixedCount: 1,
};
const round = JSON.parse(buildAssembleResult(data)) as AssembleResultData;
ok(round.episodeId === "ep_123", "resultData keeps episodeId");
ok(round.phase === "done", "resultData keeps phase");
ok(round.issues.length === 1 && round.issues[0].number === 2, "resultData keeps issues");
ok(round.videoUrl === "https://example.com/ep.mp4", "resultData keeps videoUrl");
ok(round.fixedCount === 1, "resultData keeps fixedCount");

// ── 6. Zero-issue audit → empty selection → stitch-without-charge seam ────────────────────────────
const cleanAudit: AuditSceneResult[] = [
  { number: 1, hasIssue: false },
  { number: 2, hasIssue: false },
  { number: 3, hasIssue: false },
];
const sceneInputs: PolishSceneInput[] = [
  { id: "s1", number: 1, videoPrompt: "[SHOT TYPE] wide ...", hasActiveJob: false },
  { id: "s2", number: 2, videoPrompt: "[SHOT TYPE] wide ...", hasActiveJob: false },
  { id: "s3", number: 3, videoPrompt: "[SHOT TYPE] wide ...", hasActiveJob: false },
];
const cleanSel = selectPolishScenes(cleanAudit, sceneInputs);
ok(cleanSel.length === 0, "clean audit selects no scenes");
ok(shouldStitchWithoutCharge(cleanSel.length) === true, "clean audit → stitch without charge");

console.log(`\nStage 19: ${pass} checks passed.`);
