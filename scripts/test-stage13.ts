/**
 * Stage 13 tests — «Ассембл» final polish (episode-wide continuity audit + scene selection).
 * Run: npx tsx scripts/test-stage13.ts
 *
 * Pure-logic only (NO LLM / network calls): proves the seam-audit prompt + schema and the
 * `selectPolishScenes` selection logic. Seedance video is expensive and NOT exercised here —
 * we prove the correctness at the prompt + unit level exactly as required.
 */
import assert from "node:assert";
import {
  episodeContinuityAuditSchema,
  episodeContinuityAuditSystemPrompt,
  episodeContinuityAuditUserPrompt,
  CONTINUITY_RULE,
  type AuditSceneInput,
} from "../lib/season";
import {
  selectPolishScenes,
  MIN_CORRECTED_PROMPT_LEN,
  type AuditSceneResult,
  type PolishSceneInput,
} from "../lib/polish";

let pass = 0;
const ok = (c: unknown, m: string) => {
  assert(c, m);
  console.log("ok:", m);
  pass++;
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Audit system prompt: mentions the seam problems it must detect + CONTINUITY_RULE
// ─────────────────────────────────────────────────────────────────────────────
const sys = episodeContinuityAuditSystemPrompt("en");
ok(sys.includes(CONTINUITY_RULE), "audit system prompt embeds CONTINUITY_RULE");
ok(/TELEPORT/i.test(sys) && /VANISH/i.test(sys), "audit prompt names teleport/vanish seam errors");
ok(/correctedVideoPrompt/.test(sys), "audit prompt asks for correctedVideoPrompt");
ok(/hasIssue/.test(sys), "audit prompt asks for hasIssue flag");
ok(/9 lines|\[SHOT TYPE\]/.test(sys), "audit prompt keeps the 9-line videoPrompt format");
ok(/hasIssue=false|hasIssue is false|hasIssue":false/.test(sys) || /consistent/i.test(sys),
  "audit prompt instructs to leave consistent scenes untouched");
// language propagation (Russian issue text)
const sysRu = episodeContinuityAuditSystemPrompt("ru");
ok(sysRu.includes(CONTINUITY_RULE), "russian audit prompt still embeds CONTINUITY_RULE");
ok(/Russian/i.test(sysRu), "russian audit prompt localizes the issue language");

// ─────────────────────────────────────────────────────────────────────────────
// 2. Audit user prompt: renders the ordered chain with per-scene continuity fields
// ─────────────────────────────────────────────────────────────────────────────
const chain: AuditSceneInput[] = [
  {
    number: 1,
    durationSec: 16,
    sceneKind: "dialogue",
    locationDesc: "A dim harbor office at dusk",
    dialogueEn: "We leave before midnight.",
    presence: "Mara, Jonas",
    entrances: "(none)",
    continuesFrom: "(none)",
    videoPrompt: "[SHOT TYPE] wide\n[VISUAL STYLE] photoreal\n[CHARACTER] Mara, Jonas",
  },
  {
    number: 2,
    durationSec: 15,
    sceneKind: "dialogue",
    locationDesc: "The same harbor office",
    dialogueEn: "Where did Jonas go?",
    presence: "Mara",
    entrances: "(none)",
    continuesFrom: "Scene 1",
    videoPrompt: "[SHOT TYPE] medium\n[VISUAL STYLE] photoreal\n[CHARACTER] Mara",
  },
];
const userPrompt = episodeContinuityAuditUserPrompt(chain);
ok(userPrompt.includes("Scene 1") && userPrompt.includes("Scene 2"), "user prompt lists every scene in order");
ok(userPrompt.includes("presence: Mara, Jonas"), "user prompt includes presence line");
ok(userPrompt.includes("continuesFrom: Scene 1"), "user prompt includes continuesFrom line");
ok(userPrompt.includes("We leave before midnight."), "user prompt includes scene 1 dialogue");
ok(userPrompt.includes("2 scenes"), "user prompt states the scene count");
// narration scene renders as off-screen narration with voiceover
const narrChain: AuditSceneInput[] = [
  { number: 1, sceneKind: "narration", voiceover: "Years passed in silence.", dialogueEn: null, videoPrompt: "[SHOT TYPE] wide" },
];
const narrUser = episodeContinuityAuditUserPrompt(narrChain);
ok(narrUser.includes("off-screen narration") && narrUser.includes("Years passed in silence."),
  "narration scene rendered with voiceover text");

// ─────────────────────────────────────────────────────────────────────────────
// 3. Schema parsing
// ─────────────────────────────────────────────────────────────────────────────
const goodAudit = episodeContinuityAuditSchema.parse({
  scenes: [
    { number: 1, hasIssue: false },
    { number: 2, hasIssue: true, issue: "Jonas vanished with no exit", correctedVideoPrompt: "x".repeat(60) },
  ],
});
ok(goodAudit.scenes.length === 2, "schema parses a valid audit");
ok(goodAudit.scenes[0].hasIssue === false && goodAudit.scenes[1].hasIssue === true, "schema keeps hasIssue flags");
// invalid: number missing → throws
let threw = false;
try {
  episodeContinuityAuditSchema.parse({ scenes: [{ hasIssue: true }] });
} catch {
  threw = true;
}
ok(threw, "schema rejects a scene entry without a number");

// ─────────────────────────────────────────────────────────────────────────────
// 4. selectPolishScenes — the core selection logic
// ─────────────────────────────────────────────────────────────────────────────
const scenes: PolishSceneInput[] = [
  { id: "s1", number: 1, videoPrompt: "prompt one original", hasActiveJob: false },
  { id: "s2", number: 2, videoPrompt: "prompt two original", hasActiveJob: false },
  { id: "s3", number: 3, videoPrompt: "prompt three original", hasActiveJob: false },
];
const CORRECTED = "[SHOT TYPE] medium\n[ACTION] Jonas walks out through the office door before the cut, seat left empty";
assert(CORRECTED.length >= MIN_CORRECTED_PROMPT_LEN, "test fixture corrected prompt long enough");

// 4a: a flagged scene with a substantial, changed corrected prompt is selected; consistent scenes are NOT
const audit1: AuditSceneResult[] = [
  { number: 1, hasIssue: false },
  { number: 2, hasIssue: true, issue: "Jonas vanished with no exit", correctedVideoPrompt: CORRECTED },
  { number: 3, hasIssue: false },
];
const sel1 = selectPolishScenes(audit1, scenes);
ok(sel1.length === 1 && sel1[0].number === 2, "only the flagged scene is selected");
ok(sel1[0].sceneId === "s2" && sel1[0].correctedVideoPrompt === CORRECTED, "selection carries scene id + corrected prompt");
ok(sel1[0].needsCharge === true, "selected scene without an active job needs a charge");
ok(!sel1.some((s) => s.number === 1 || s.number === 3), "consistent scenes are never touched (no wasted credits)");

// 4b: fully consistent episode → empty selection → just stitch, no credits
const auditAllOk: AuditSceneResult[] = [
  { number: 1, hasIssue: false },
  { number: 2, hasIssue: false },
  { number: 3, hasIssue: false },
];
ok(selectPolishScenes(auditAllOk, scenes).length === 0, "consistent episode selects nothing");

// 4c: idempotency / double-charge protection — active job ⇒ needsCharge=false
const scenesActive: PolishSceneInput[] = scenes.map((s) =>
  s.number === 2 ? { ...s, hasActiveJob: true } : s
);
const sel3 = selectPolishScenes(audit1, scenesActive);
ok(sel3.length === 1 && sel3[0].needsCharge === false, "scene with an active job is not charged again");

// 4d: junk / too-short corrected prompt is ignored (keeps the old clip)
const auditShort: AuditSceneResult[] = [{ number: 2, hasIssue: true, issue: "x", correctedVideoPrompt: "too short" }];
ok(selectPolishScenes(auditShort, scenes).length === 0, "too-short corrected prompt is ignored");

// 4e: no-op correction (identical to current prompt) is skipped — no credit spent
const auditNoop: AuditSceneResult[] = [
  { number: 2, hasIssue: true, issue: "flagged", correctedVideoPrompt: "  prompt two original  " },
];
ok(selectPolishScenes(auditNoop, scenes).length === 0, "no-op correction equal to current prompt is skipped");

// 4f: backward/forward compat — audit for a scene number that doesn't exist is skipped
const auditGhost: AuditSceneResult[] = [{ number: 99, hasIssue: true, issue: "ghost", correctedVideoPrompt: CORRECTED }];
ok(selectPolishScenes(auditGhost, scenes).length === 0, "audit for a non-existent scene number is skipped");

// 4g: hasIssue true but no corrected prompt at all → skipped
const auditNoPrompt: AuditSceneResult[] = [{ number: 2, hasIssue: true, issue: "flagged but no fix" }];
ok(selectPolishScenes(auditNoPrompt, scenes).length === 0, "flagged scene without a corrected prompt is skipped");

// 4h: duplicate scene numbers from the model are de-duplicated
const auditDup: AuditSceneResult[] = [
  { number: 2, hasIssue: true, issue: "a", correctedVideoPrompt: CORRECTED },
  { number: 2, hasIssue: true, issue: "b", correctedVideoPrompt: CORRECTED + " more" },
];
ok(selectPolishScenes(auditDup, scenes).length === 1, "duplicate flagged numbers are de-duplicated");

// 4i: null / empty audit or scene videoPrompt does not crash (backward compat)
ok(selectPolishScenes(null, scenes).length === 0, "null audit yields empty selection");
ok(selectPolishScenes(undefined, scenes).length === 0, "undefined audit yields empty selection");
const scenesNullPrompt: PolishSceneInput[] = [{ id: "s2", number: 2, videoPrompt: null, hasActiveJob: false }];
const selNull = selectPolishScenes(audit1, scenesNullPrompt);
ok(selNull.length === 1 && selNull[0].correctedVideoPrompt === CORRECTED,
  "scene with a null current prompt still gets its correction");

// 4j: multiple flagged scenes are all selected, order preserved
const scenes5: PolishSceneInput[] = [1, 2, 3, 4, 5].map((n) => ({ id: `s${n}`, number: n, videoPrompt: `orig ${n}`, hasActiveJob: false }));
const audit5: AuditSceneResult[] = [
  { number: 1, hasIssue: false },
  { number: 2, hasIssue: true, issue: "seam a", correctedVideoPrompt: CORRECTED + " a" },
  { number: 3, hasIssue: false },
  { number: 4, hasIssue: true, issue: "seam b", correctedVideoPrompt: CORRECTED + " b" },
  { number: 5, hasIssue: false },
];
const sel5 = selectPolishScenes(audit5, scenes5);
ok(sel5.length === 2 && sel5[0].number === 2 && sel5[1].number === 4, "multiple flagged scenes selected in order");

// 4k: default issue text when the model omits the issue string
const auditNoIssue: AuditSceneResult[] = [{ number: 2, hasIssue: true, correctedVideoPrompt: CORRECTED }];
const selNoIssue = selectPolishScenes(auditNoIssue, scenes);
ok(selNoIssue.length === 1 && selNoIssue[0].issue.length > 0, "missing issue text falls back to a default label");

console.log(`\nAll Stage 13 tests passed (${pass} assertions).`);
