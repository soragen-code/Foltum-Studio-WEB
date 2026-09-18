/**
 * Stage 172 (Stage 7) — critic-driven generation framework (lib/critic.ts).
 *
 * PURE LOGIC ONLY — no network, no DB. The LLM-facing helpers are exercised through injected stubs.
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage172.ts
 */
import {
  CRITIC_PROMPT_VERSION,
  RUBRIC_AXES,
  RISK_AXES,
  ACCEPT_THRESHOLD,
  DEFAULT_AXIS_SCORE,
  aggregateScore,
  actionForOverall,
  parseCriticResponse,
  pickBestVariant,
  buildFixInstruction,
  buildGenerationLog,
  critiqueCandidate,
  generateBestOfN,
  runCriticLoop,
  type RubricScores,
  type Critique,
} from "../lib/critic";

let passed = 0;
function ok(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
}

const mid = (): RubricScores => {
  const s = {} as RubricScores;
  for (const axis of RUBRIC_AXES) s[axis] = 5;
  return s;
};

// ── version + rubric shape ────────────────────────────────────────────────
ok(CRITIC_PROMPT_VERSION === "6.7.0", "CRITIC_PROMPT_VERSION is 6.7.0");
ok(RUBRIC_AXES.length === 7, "7 rubric axes");
ok(RISK_AXES.has("continuityRisk") && RISK_AXES.size === 1, "continuityRisk is the only risk axis");
ok(DEFAULT_AXIS_SCORE === 5, "default axis score 5");

// ── aggregateScore: risk inversion ────────────────────────────────────────
// all mid (5): quality axes → 5, risk axis inverted → 11-5=6. mean = (6*5 + 1*6)/7 = 36/7 ≈ 5.14
ok(Math.abs(aggregateScore(mid()) - 5.14) < 0.02, "all-mid aggregate ≈ 5.14 (risk inverted)");

// low continuityRisk RAISES overall; high continuityRisk LOWERS it
const lowRisk = { ...mid(), continuityRisk: 1 };
const highRisk = { ...mid(), continuityRisk: 10 };
ok(aggregateScore(lowRisk) > aggregateScore(highRisk), "low continuityRisk beats high continuityRisk");
// raising a quality axis raises overall
const betterHook = { ...mid(), hookStrength: 10 };
ok(aggregateScore(betterHook) > aggregateScore(mid()), "higher hookStrength raises overall");
// missing axes default to 5
ok(Math.abs(aggregateScore({}) - aggregateScore(mid())) < 1e-9, "empty scores default to all-mid");
// clamping: out-of-range values are clamped into 1..10
ok(aggregateScore({ ...mid(), hookStrength: 999 } as any) <= aggregateScore({ ...mid(), hookStrength: 10 }) + 1e-9, "over-range clamps to 10");

// ── actionForOverall threshold ────────────────────────────────────────────
ok(actionForOverall(ACCEPT_THRESHOLD) === "accept", "at threshold → accept");
ok(actionForOverall(ACCEPT_THRESHOLD - 0.01) === "improve", "below threshold → improve");
ok(actionForOverall(10) === "accept", "10 → accept");

// ── parseCriticResponse (defensive) ───────────────────────────────────────
// valid object; overall recomputed, not trusted from model
const p1 = parseCriticResponse({ scores: { ...mid(), hookStrength: 9, continuityRisk: 1 }, notes: ["a", "b"], overall: 0.1, action: "improve" });
ok(Math.abs(p1.overall - aggregateScore({ ...mid(), hookStrength: 9, continuityRisk: 1 })) < 1e-9, "overall recomputed, model overall ignored");
ok(p1.action === "improve", "explicit action honored");
ok(p1.notes.length === 2, "notes preserved");

// JSON string input
const p2 = parseCriticResponse(JSON.stringify({ scores: mid(), notes: ["x"] }));
ok(p2.notes.length === 1 && p2.notes[0] === "x", "JSON string parsed");

// fenced JSON
const p3 = parseCriticResponse("```json\n" + JSON.stringify({ scores: mid(), notes: [] }) + "\n```");
ok(Math.abs(p3.overall - aggregateScore(mid())) < 1e-9, "fenced JSON parsed");

// garbage → all defaults
const p4 = parseCriticResponse("not json at all");
ok(RUBRIC_AXES.every((a) => p4.scores[a] === 5), "garbage → default mid scores");
ok(p4.notes.length === 0, "garbage → no notes");

// missing axes default to 5; notes trimmed to 3; action derived when absent
const p5 = parseCriticResponse({ scores: { hookStrength: 8 }, notes: ["1", "2", "3", "4", "5"] });
ok(p5.scores.stakesClarity === 5, "missing axis → 5");
ok(p5.notes.length === 3, "notes trimmed to 3");
ok(p5.action === actionForOverall(p5.overall), "action derived from overall when not explicit");

// flat scores (no nested "scores") also accepted
const p6 = parseCriticResponse({ ...mid(), hookStrength: 10 });
ok(Math.abs(p6.overall - aggregateScore({ ...mid(), hookStrength: 10 })) < 1e-9, "flat score object accepted");

// ── pickBestVariant ───────────────────────────────────────────────────────
ok(pickBestVariant([{ overall: 4 }, { overall: 9 }, { overall: 7 }]) === 1, "picks highest overall");
ok(pickBestVariant([{ overall: 8 }, { overall: 8 }]) === 0, "tie breaks to earlier");
ok(pickBestVariant([]) === -1, "empty → -1");

// ── buildFixInstruction ───────────────────────────────────────────────────
const fix = buildFixInstruction(["Sharpen the hook", "Raise the stakes"], { label: "synopsis" });
ok(fix.includes("1. Sharpen the hook") && fix.includes("2. Raise the stakes"), "numbered fix list");
ok(fix.toLowerCase().includes("synopsis"), "label included");
ok(buildFixInstruction([]) === "", "empty notes → empty string");
ok(buildFixInstruction(["", "  "]) === "", "blank notes → empty string");
ok(buildFixInstruction(["a", "b", "c", "d"]).split("\n").filter((l) => /^\d+\./.test(l)).length === 3, "capped at 3 notes");

// ── buildGenerationLog ────────────────────────────────────────────────────
const log = buildGenerationLog({
  projectId: "p1",
  kind: "dramaBible",
  model: "gpt-6-astra",
  promptVersion: CRITIC_PROMPT_VERSION,
  attempts: 3,
  finalScore: 7.2,
  accepted: true,
  notes: ["n1", "", "n2"],
  error: null,
});
ok(log.projectId === "p1" && log.seasonId === null && log.episodeId === null, "optional ids null-coerced");
ok(log.attempts === 3 && log.accepted === true, "attempts + accepted preserved");
ok(log.notes !== null && log.notes.length === 2, "blank notes filtered");
ok(log.finalScore === 7.2, "finalScore preserved");
const log2 = buildGenerationLog({ kind: "synopsis", model: "", promptVersion: "", attempts: -5, accepted: false, error: "x".repeat(5000) });
ok(log2.attempts === 0, "negative attempts clamped to 0");
ok(log2.model === "unknown" && log2.promptVersion === CRITIC_PROMPT_VERSION, "empty model/version defaulted");
ok(log2.error !== null && log2.error.length === 1000, "long error truncated to 1000");
ok(log2.finalScore === null && log2.notes === null, "missing finalScore/notes → null");

// ── async orchestrators (stubbed, no network) ─────────────────────────────
const critiqueOverall = (overall: number): Critique => {
  // craft scores whose aggregate ≈ overall by scaling all quality axes; risk stays mid
  const s = {} as RubricScores;
  for (const axis of RUBRIC_AXES) s[axis] = RISK_AXES.has(axis) ? 5 : overall;
  return { scores: s, overall, notes: overall >= ACCEPT_THRESHOLD ? [] : ["fix it"], action: actionForOverall(overall) };
};

void (async () => {
  // critiqueCandidate: stub returns valid JSON → parsed
  const c1 = await critiqueCandidate(async () => ({ scores: { ...mid(), hookStrength: 9 }, notes: ["n"] }), "synopsis", "cand");
  ok(c1.notes.length === 1, "critiqueCandidate parses stub JSON");
  // critiqueCandidate: stub throws → defensive neutral critique (mid, improve, no notes)
  const c2 = await critiqueCandidate(async () => { throw new Error("boom"); }, "synopsis", "cand");
  ok(c2.action === "improve" && c2.notes.length === 0, "critiqueCandidate defensive on client failure");

  // generateBestOfN: picks best variant by critique, runs improve when best not accepted
  let improveCalls = 0;
  const out1 = await generateBestOfN<{ v: number }>({
    variantCount: 3,
    generate: async (i) => ({ v: i }),
    render: (c) => `variant-${c.v}`,
    // variant 1 is the best (overall 6), still below threshold → improve should run
    critique: async (r) => critiqueOverall(r === "variant-1" ? 6 : 3),
    improve: async (best) => { improveCalls++; return { v: best.v + 100 }; },
  });
  ok(out1.best.v === 101, "generateBestOfN picked best (idx1) and improved");
  ok(improveCalls === 1, "generateBestOfN ran exactly one improve pass");
  ok(out1.accepted === true, "generateBestOfN accepted after improve");
  ok(out1.attempts === 4, "generateBestOfN attempts = 3 variants + 1 improve");

  // generateBestOfN: best already accepted → no improve
  let improveCalls2 = 0;
  const out2 = await generateBestOfN<{ v: number }>({
    variantCount: 2,
    generate: async (i) => ({ v: i }),
    render: (c) => `v${c.v}`,
    critique: async () => critiqueOverall(9),
    improve: async (best) => { improveCalls2++; return best; },
  });
  ok(improveCalls2 === 0, "generateBestOfN skips improve when accepted");
  ok(out2.attempts === 2, "generateBestOfN attempts = variants only when accepted");

  // generateBestOfN: defensive — every variant fails → throws
  let threw = false;
  try {
    await generateBestOfN<{ v: number }>({
      variantCount: 2,
      generate: async () => { throw new Error("gen fail"); },
      render: () => "x",
      critique: async () => critiqueOverall(5),
    });
  } catch { threw = true; }
  ok(threw, "generateBestOfN throws when all variants fail");

  // generateBestOfN: some variants fail → still works with survivors
  const out3 = await generateBestOfN<{ v: number }>({
    variantCount: 3,
    generate: async (i) => { if (i === 0) throw new Error("x"); return { v: i }; },
    render: (c) => `v${c.v}`,
    critique: async () => critiqueOverall(9),
  });
  ok(out3.accepted && out3.attempts === 2, "generateBestOfN tolerates partial variant failure");

  // runCriticLoop: improves until accept
  let fixCalls = 0;
  const loop1 = await runCriticLoop<{ v: number }>({
    variantCount: 2,
    maxIterations: 3,
    generate: async (i) => ({ v: i }),
    render: (c) => `v${c.v}`,
    // improve twice, then the third critique accepts
    critique: async () => critiqueOverall(fixCalls >= 1 ? 9 : 4),
    fix: async (cur) => { fixCalls++; return { v: cur.v + 1 }; },
  });
  ok(loop1.accepted === true, "runCriticLoop reaches accept");
  ok(fixCalls === 1, "runCriticLoop stopped applying fixes once accepted");
  ok(loop1.attempts === 3, "runCriticLoop attempts = 2 variants + 1 fix");

  // runCriticLoop: respects maxIterations (never accepts)
  let fixCalls2 = 0;
  const loop2 = await runCriticLoop<{ v: number }>({
    variantCount: 2,
    maxIterations: 3,
    generate: async (i) => ({ v: i }),
    render: (c) => `v${c.v}`,
    critique: async () => critiqueOverall(3),
    fix: async (cur) => { fixCalls2++; return { v: cur.v + 1 }; },
  });
  ok(loop2.accepted === false, "runCriticLoop stops unaccepted at maxIterations");
  // iteration starts at 1; loop runs while iteration < 3 → 2 fix passes
  ok(fixCalls2 === 2, "runCriticLoop capped fix passes at maxIterations-1");

  // runCriticLoop: a fix failure stops the loop gracefully
  const loop3 = await runCriticLoop<{ v: number }>({
    variantCount: 2,
    maxIterations: 3,
    generate: async (i) => ({ v: i }),
    render: (c) => `v${c.v}`,
    critique: async () => critiqueOverall(3),
    fix: async () => { throw new Error("fix fail"); },
  });
  ok(loop3.accepted === false && loop3.attempts === 2, "runCriticLoop survives fix failure");

  console.log(`\nStage 172: PASS (${passed} checks)`);
})();
