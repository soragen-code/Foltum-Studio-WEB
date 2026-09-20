/**
 * Stage 187 — P6: the CRITIC emits CONCRETE, verifiable defects (fragment + reason + fix), separates
 * blocking from advisory, gates accept/improve on blocking defects (NOT a subjective score), never judges
 * "interestingness"/engagement, and its improve loop is BOUNDED.
 *
 * Pure/synthetic only — NO network, NO LLM, NO DB, NO paid generations. All LLM calls are stubbed.
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage187.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

import {
  parseCriticResponse,
  hasBlockingDefect,
  RUBRIC_AXES,
  RISK_AXES,
  CRITIC_SYSTEM,
  CRITIC_PROMPT_VERSION,
  runCriticLoop,
  aggregateScore,
  type Critique,
  type CriticDefect,
} from "../lib/critic";

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

const midScores = {
  causalLogic: 5,
  clarity: 5,
  stagingConcreteness: 5,
  dialoguePurity: 5,
  characterDistinctness: 5,
  continuityRisk: 5,
};

/* ───────────── 1) defects are CONCRETE: fragment + reason + fix + severity are preserved ───────────── */
{
  const raw = {
    scores: midScores,
    defects: [
      {
        fragment: 'ANNA: "(*he grabs the knife*) stop"',
        reason: "stage direction inside a spoken line",
        fix: "move '*he grabs the knife*' into the action field",
        severity: "blocking",
      },
      {
        fragment: "the ending twist",
        reason: "minor: could land harder",
        fix: "foreshadow it one scene earlier",
        severity: "advisory",
      },
    ],
  };
  const c = parseCriticResponse(raw);
  ok(c.defects.length === 2, "both defects are parsed");
  const d0 = c.defects[0];
  ok(d0.fragment.includes("he grabs the knife") && d0.reason.includes("stage direction") && d0.fix.includes("action field"), "defect keeps its fragment + reason + fix (concrete, not a bare score)");
  ok(d0.severity === "blocking" && c.defects[1].severity === "advisory", "defect severity (blocking / advisory) is preserved");
  // notes are derived from defects when absent
  ok(c.notes.length >= 1 && c.notes.some((n) => n.includes("action field")), "notes are derived from the defects' fixes");
}

/* ───────────── 2) blocking vs advisory separation drives the accept/improve gate ───────────── */
{
  const blocking = parseCriticResponse({ scores: midScores, defects: [{ fragment: "x", reason: "causal gap", fix: "y", severity: "blocking" }] });
  ok(hasBlockingDefect(blocking.defects) === true, "hasBlockingDefect true when a blocking defect is present");
  ok(blocking.action === "improve", "a blocking defect forces action = improve (regardless of score)");

  const advisoryOnly = parseCriticResponse({ scores: midScores, defects: [{ fragment: "x", reason: "nit", fix: "y", severity: "advisory" }] });
  ok(hasBlockingDefect(advisoryOnly.defects) === false, "hasBlockingDefect false when only advisory defects exist");
  ok(advisoryOnly.action === "accept", "advisory-only defects → action = accept (not gated on a score)");

  const clean = parseCriticResponse({ scores: midScores, defects: [] });
  ok(clean.action === "accept", "no defects → accept");

  // an unknown/garbled severity defaults to advisory (cautious, not blocking)
  const weird = parseCriticResponse({ scores: midScores, defects: [{ fragment: "x", reason: "r", fix: "f", severity: "meh" }] });
  ok(weird.defects[0].severity === "advisory", "unknown severity defaults to advisory");

  // an explicit accept/improve from the model is honored
  const forced = parseCriticResponse({ scores: midScores, defects: [], action: "improve" });
  ok(forced.action === "improve", "explicit action from the model is honored");

  // an unparseable response is treated cautiously as improve
  const broken = parseCriticResponse("not json at all");
  ok(broken.action === "improve", "an unparseable critic response is treated cautiously as improve");

  // defects are capped at 8 (no unbounded list)
  const many = parseCriticResponse({ scores: midScores, defects: Array.from({ length: 20 }, (_, i) => ({ fragment: `f${i}`, reason: "r", fix: "x", severity: "advisory" })) });
  ok(many.defects.length === 8, "defects are capped at 8");
}

/* ───────────── 3) the rubric is verifiable-only; no subjective 'interestingness' axes ───────────── */
{
  ok(RUBRIC_AXES.length === 6, "rubric has exactly 6 verifiable axes");
  for (const a of ["causalLogic", "clarity", "stagingConcreteness", "dialoguePurity", "characterDistinctness", "continuityRisk"]) {
    ok((RUBRIC_AXES as readonly string[]).includes(a), `rubric includes verifiable axis "${a}"`);
  }
  for (const bad of ["hookStrength", "cliffhangerPull", "tropeExecution", "interestingness", "engagement"]) {
    ok(!(RUBRIC_AXES as readonly string[]).includes(bad), `rubric no longer has subjective axis "${bad}"`);
  }
  ok(RISK_AXES.has("continuityRisk") && RISK_AXES.size === 1, "continuityRisk is the sole inverted RISK axis");
  // all-mid aggregate is stable
  ok(aggregateScore(midScores) === 5.17, `all-mid aggregate = ${aggregateScore(midScores)} (5*5 quality + inverted risk, /6)`);

  // the system prompt explicitly refuses to judge interestingness/engagement
  ok(/Do NOT judge subjective 'interestingness'/i.test(CRITIC_SYSTEM), "CRITIC_SYSTEM refuses to judge subjective interestingness");
  ok(/never raise a blocking defect for weak 'engagement'/i.test(CRITIC_SYSTEM), "CRITIC_SYSTEM: engagement/soft cliffhanger/disliked trope are never blocking");
  for (const bad of ["hookStrength", "cliffhangerPull", "tropeExecution"]) {
    ok(!CRITIC_SYSTEM.includes(bad), `CRITIC_SYSTEM no longer mentions the old subjective axis "${bad}"`);
  }
  ok(CRITIC_PROMPT_VERSION === "7.0.0", `CRITIC_PROMPT_VERSION bumped to 7.0.0 (was ${CRITIC_PROMPT_VERSION})`);
}

/* ───────────── 4) the improve loop is BOUNDED (retries never run away) ───────────── */
void (async () => {
  // source guard exists
  const src = readSource("lib/critic.ts");
  ok(/iteration < maxIterations/.test(src), "runCriticLoop source has the `iteration < maxIterations` bound");

  // behavioral: a critic that ALWAYS returns a blocking defect must still terminate, bounded by maxIterations
  let critiqueCalls = 0;
  let fixCalls = 0;
  const alwaysBlocking = async (): Promise<Critique> => {
    critiqueCalls++;
    return parseCriticResponse({ scores: midScores, defects: [{ fragment: "x", reason: "causal gap", fix: "close it", severity: "blocking" }] });
  };
  const outcome = await runCriticLoop<string>({
    variantCount: 2,
    maxIterations: 3,
    generate: async (i) => `variant ${i}`,
    render: (c) => c,
    critique: alwaysBlocking,
    fix: async (c) => {
      fixCalls++;
      return c + " (fixed)";
    },
  });
  // 2 initial variants + at most (maxIterations - 1) improve passes = 2 + 2 = 4 generations
  ok(outcome.attempts === 4, `loop is bounded: attempts = ${outcome.attempts} (2 variants + 2 improve passes, maxIterations=3)`);
  ok(fixCalls === 2, `improve pass ran a bounded number of times (${fixCalls}), never runs away`);
  ok(outcome.accepted === false, "an always-blocking critic ends unaccepted (loop terminated by the bound, not by faking acceptance)");
  ok(outcome.critique.action === "improve" && hasBlockingDefect(outcome.critique.defects), "the final critique still reports the unresolved blocking defect honestly");

  console.log(`\nStage 187: PASS (${passed} checks)`);
})();
