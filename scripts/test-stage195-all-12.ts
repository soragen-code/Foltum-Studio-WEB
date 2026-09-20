/**
 * Stage 195 — P12: the UNIFIED runner for all 12 MANDATORY pipeline test-cases.
 *
 * It maps each required case to the concrete test script(s) that cover it, RE-RUNS every backing script
 * (each is a standalone, offline, no-network, no-paid-generation assert suite that exits non-zero on
 * failure), and prints a per-case PASS/FAIL line plus a final summary. Nothing here hits the network,
 * an LLM, a DB, or a paid generation — it only orchestrates the existing pure/synthetic suites.
 *
 * Run: timeout 600 npx tsx --tsconfig tsconfig.json scripts/test-stage195-all-12.ts
 */
import { execFileSync } from "child_process";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..");

/** One mandatory case → the script(s) + the specific assert(s) that verify it. */
interface CaseSpec {
  n: number;
  title: string;
  scripts: string[];
  assertRef: string;
}

const CASES: CaseSpec[] = [
  {
    n: 1,
    title: "Script vs description contradict → scenes follow Episode.script, not the description",
    scripts: ["test-stage188.ts"],
    assertRef:
      "188 §1/§4: scriptApprovalState(non-empty)=approved; scenes-job embeds 'APPROVED EPISODE SCRIPT — THE SINGLE SOURCE OF TRUTH' and demotes synopsis to 'CONTEXT ONLY — do NOT re-derive'.",
  },
  {
    n: 2,
    title: "A mute reaction is preserved — no dialogue is invented for it",
    scripts: ["test-stage194.ts"],
    assertRef:
      "194 §#2: validateSceneCoverage does not flag an action-only scene as missing-speaker; assembleShotPrompt emits no LINE block for a lineless shot.",
  },
  {
    n: 3,
    title: "No keyProp → the system does NOT add one for an old rule",
    scripts: ["test-stage186.ts", "test-stage194.ts"],
    assertRef:
      "186 §4/§5 + 194 §#3: shot-plan says 'a scene need not use a keyProp'; a no-keyProp episode is not hard-gated; scenes-job dropped the old 'missingDrama' keyProp mandate (now 'missingCore' = action/dialogue only).",
  },
  {
    n: 4,
    title: "A conflict resolved by refusal → no forced physical aggression",
    scripts: ["test-stage186.ts", "test-stage194.ts"],
    assertRef:
      "186 §3/§4 + 194 §#4: prompts allow refusal/one-sided/withheld/loaded-silence; tension may come from refusal/pause/withheld-info/goal-shift/stakes; no prompt mandates a fight/violence.",
  },
  {
    n: 5,
    title: "Model returned an extra scene carrying the finale → the finale is not lost to a slice",
    scripts: ["test-stage189.ts"],
    assertRef:
      "189 §2/§3/§5: validateSceneCoverage flags a missing final scene; over-limit is reported EXPLICITLY (overLimit/overflow) and trimmed with a logged note; the old blind rawScenes.slice(0, MAX_SCENES) is gone.",
  },
  {
    n: 6,
    title: "Invalid memory → it does NOT become canonical",
    scripts: ["test-stage193.ts"],
    assertRef: "193 §7: scenes-job gates season-state persistence on result.valid (invalid state is not written).",
  },
  {
    n: 7,
    title: "Reworking an early episode → no state from the future is used",
    scripts: ["test-stage193.ts"],
    assertRef:
      "193 §1/§2/§7: pickPredecessorState picks the max reflectsEpisodeNumber < current and ignores a newer row reflecting a later episode; scenes-job reads all states via findMany (not findFirst orderBy updatedAt).",
  },
  {
    n: 8,
    title: "A non-English dialogue language survives to the video prompt",
    scripts: ["test-stage191.ts", "test-stage192.ts", "test-stage194.ts"],
    assertRef:
      "191 §5 + 192 + 194 §#8: assembleShotPrompt names the spoken language ('spoken in Russian') at the provider boundary while reading the English translation; video-job passes dialogueLanguage: getDialogueLanguage(project).",
  },
  {
    n: 9,
    title: "Script changed → previously-derived data (scenes/shots) is not treated as fresh (stale)",
    scripts: ["test-stage188.ts", "test-stage189.ts", "test-stage193.ts"],
    assertRef:
      "188 §3 (scriptFingerprint changes on content change) + 189 §5 (recreated scenes reset stale=false) + 193 §6/§7 (dependentStateIds marks later states stale via updateMany).",
  },
  {
    n: 10,
    title: "Assembly does NOT call subtitle functions or create subtitle artifacts",
    scripts: ["test-stage184.ts"],
    assertRef:
      "184 §10: shot-pipeline/ffmpeg no longer export the subtitle helpers; assembly-job.ts source references no subtitle symbol / .ass / burn.",
  },
  {
    n: 11,
    title: "Provider returned a clip longer than the plan → assembly uses the ACTUAL file",
    scripts: ["test-stage184.ts"],
    assertRef:
      "184 §11: buildSeamlessCutGraph keeps a long clip full-length (not clamped to a plan); buildFinalRenderArgs binds -t to the given probed duration.",
  },
  {
    n: 12,
    title: "A spoken line does not fit → it is NOT silently truncated",
    scripts: ["test-stage184.ts", "test-stage194.ts"],
    assertRef:
      "184 §11/§12 + 194 §#12: seam trim is bounded (never below the min-clip floor); the final -t equals the given duration; the real-provider returned-file duration is documented as out of scope for an offline suite (not faked).",
  },
];

function runScript(rel: string): { ok: boolean; tail: string } {
  try {
    const out = execFileSync("npx", ["tsx", "--tsconfig", "tsconfig.json", "scripts/" + rel], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180000,
    });
    const lines = out.trim().split("\n");
    return { ok: /PASS/.test(out), tail: lines[lines.length - 1] ?? "" };
  } catch (e: any) {
    const out = `${e?.stdout ?? ""}\n${e?.stderr ?? ""}`.trim();
    const lines = out.split("\n");
    return { ok: false, tail: lines[lines.length - 1] ?? "process failed" };
  }
}

// Run each distinct backing script ONCE, then map results back onto the cases.
const scriptResults = new Map<string, { ok: boolean; tail: string }>();
const allScripts = Array.from(new Set(CASES.flatMap((c) => c.scripts)));
console.log("Running backing suites (offline, no network / LLM / DB / paid generation):\n");
for (const s of allScripts) {
  const r = runScript(s);
  scriptResults.set(s, r);
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${s}  — ${r.tail}`);
}

console.log("\n─────────────────────────────────────────────────────────────");
console.log("12 MANDATORY CASES → COVERAGE");
console.log("─────────────────────────────────────────────────────────────");

let failures = 0;
for (const c of CASES) {
  const scriptsOk = c.scripts.every((s) => scriptResults.get(s)?.ok);
  if (!scriptsOk) failures++;
  console.log(`\n#${c.n}  [${scriptsOk ? "PASS" : "FAIL"}]  ${c.title}`);
  console.log(`     covered by: ${c.scripts.join(", ")}`);
  console.log(`     assert: ${c.assertRef}`);
}

console.log("\n─────────────────────────────────────────────────────────────");
if (failures === 0) {
  console.log(`ALL 12 MANDATORY CASES COVERED AND PASSING (${CASES.length}/12).`);
  process.exit(0);
} else {
  console.error(`${failures} case(s) FAILED — see above.`);
  process.exit(1);
}
