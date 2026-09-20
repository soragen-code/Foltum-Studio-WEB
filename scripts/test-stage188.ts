/**
 * Stage 188 — P7: the episode SCENE BREAKDOWN is built from the APPROVED SCRIPT (the single source of
 * truth for events + dialogue), never re-derived from the synopsis / description. When there is no approved
 * script the worker HALTS with a clear error instead of silently generating from the description.
 *
 * Verifies the PURE gate (lib/scene-breakdown.ts) on synthetic fixtures AND greps the real worker
 * (lib/workers/scenes-job.ts) to prove the gate + the script-as-source wiring are actually in place.
 *
 * Pure/synthetic only — NO network, NO LLM, NO DB, NO paid generations.
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage188.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

import { scriptApprovalState, scriptFingerprint } from "../lib/scene-breakdown";

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

/* ───────────── 1) scriptApprovalState — a non-empty script IS the approval signal ───────────── */
{
  ok(scriptApprovalState({ script: "INT. KITCHEN — NIGHT\nANNA: \"You lied.\"" }).approved === true, "a non-empty script is approved");
  ok(scriptApprovalState({ script: "", status: "script_ready" }).approved === false, "an empty script is NOT approved (status alone does not approve)");
  ok(scriptApprovalState({ script: "   \n\t  " }).approved === false, "a whitespace-only script is NOT approved");
  ok(scriptApprovalState({ script: null }).approved === false, "a null script is NOT approved");
  ok(scriptApprovalState(null).approved === false, "a missing episode is NOT approved");
  ok(scriptApprovalState(undefined).approved === false, "an undefined episode is NOT approved");
}

/* ───────────── 2) the HALT reason is a clear, actionable message (used verbatim on failJob) ───────────── */
{
  const reason = scriptApprovalState({ script: "" }).reason;
  ok(typeof reason === "string" && reason.length > 20, "the not-approved reason is a non-trivial message");
  ok(/script/i.test(reason) && /(synopsis|description)/i.test(reason), "the reason explains the script is the source, not the synopsis/description");
  ok(scriptApprovalState({ script: "real script" }).reason.length > 0, "the approved reason is also present");
}

/* ───────────── 3) scriptFingerprint — stable, order-sensitive, whitespace-insensitive change detector ───────────── */
{
  const a = "ANNA: hello\nDANE: goodbye";
  ok(scriptFingerprint(a) === scriptFingerprint(a), "the fingerprint is deterministic (same input → same hash)");
  ok(scriptFingerprint(a) === scriptFingerprint("ANNA:   hello   \n\n  DANE: goodbye"), "cosmetic whitespace does NOT change the fingerprint");
  ok(scriptFingerprint(a) !== scriptFingerprint("ANNA: hello\nDANE: goodbye now"), "a real content change DOES change the fingerprint");
  ok(scriptFingerprint(a) !== scriptFingerprint("DANE: goodbye\nANNA: hello"), "reordering the script changes the fingerprint (order-sensitive)");
  ok(scriptFingerprint("") === scriptFingerprint("   "), "empty and whitespace-only scripts fingerprint identically");
  ok(/-\d+$/.test(scriptFingerprint(a)), "the fingerprint carries the length suffix (collision-resistant)");
}

/* ───────────── 4) the worker wires the gate + uses the approved script as the source ───────────── */
{
  const src = readSource("lib/workers/scenes-job.ts");
  ok(/from "@\/lib\/scene-breakdown"/.test(src), "scenes-job imports the pure helpers from lib/scene-breakdown");
  ok(/scriptApprovalState\(episode\)/.test(src), "buildUserMessage calls scriptApprovalState on the episode");
  ok(/if \(!approval\.approved\) return \{ error: approval\.reason \}/.test(src), "buildUserMessage HALTS (returns an error) when the script is not approved");
  // the HALT propagates to failJob before any LLM call (buildUserMessage runs before startBackgroundJSON)
  ok(/const built = await buildUserMessage[\s\S]*?if \("error" in built\) \{ await failJob/.test(src), "runScenesJob fails the job on the not-approved error BEFORE starting the model");
  ok(/APPROVED EPISODE SCRIPT — THE SINGLE SOURCE OF TRUTH/.test(src), "the user message embeds the approved script as the single source of truth");
  ok(/\$\{approvedScript\}/.test(src), "the approved script text is interpolated into the user message");
  ok(/SINGLE SOURCE OF TRUTH for this episode/.test(src), "the SYSTEM prompt names the approved script as the single source of truth");
  ok(/CONTEXT ONLY — do NOT re-derive the story from this/.test(src), "the synopsis is demoted to context only (not the story source)");
}

console.log(`\nStage 188: PASS (${passed} checks)`);
