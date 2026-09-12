/**
 * Stage 46D unit tests (no live API): full-body proportion rule in the prompt + vision proportion guard.
 *   npx tsx --tsconfig tsconfig.json scripts/test-stage46d.ts
 */
import assert from "node:assert";
import {
  parseProportionAssessment, parseFullBodyCheck, evaluateProportions, buildProportionFixPrompt,
  fullBodyPasses, fullBodyScore, fullBodyCorrectionSuffix, buildFullBodyCheckRequest, FULL_BODY_CHECK_SYSTEM_PROMPT,
  MAX_TORSO_HEADS, MIN_LEGS_RATIO, MAX_HEADS_TALL, type FullBodyCheck, type ProportionAssessment,
} from "../lib/full-body-check";
import {
  FULL_BODY_PROPORTIONS_RULE, characterShotPrompt, characterExtraShotPrompt, withFullBodyProportionsRule, isFullBodyExtraIndex,
} from "../lib/full-body-prompt";
import { characterImagePrompt, characterExtraAnglePrompt } from "../lib/visual-style";
import { generateFullBodyWithGuard, FULL_BODY_MAX_ATTEMPTS } from "../lib/workers/character-images-job";

let n = 0;
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); n++; };

const noFlags = { elongatedTorso: false, shortLegs: false, smallHead: false, inconsistentVolume: false };
const natural: ProportionAssessment = { headsTall: 7.3, torsoHeads: 3.0, legsRatio: 0.48, flags: { ...noFlags }, notes: "" };

// ---------------------------------------------------------------- 1. JSON parsing
{
  const raw = '```json\n{"fullBody":true,"feetVisible":true,"headsTall":8.6,"torsoHeads":4.1,"legsRatio":0.40,"flags":{"elongatedTorso":true,"shortLegs":true,"smallHead":true,"inconsistentVolume":true},"proportionsOk":false,"issues":["elongated torso","short legs","small head"],"notes":"bloated midsection, thin shins"}\n```';
  const p = parseProportionAssessment(raw);
  ok("parse: strict JSON → all measurements", !!p && p.headsTall === 8.6 && p.torsoHeads === 4.1 && p.legsRatio === 0.4);
  ok("parse: flags carried over", !!p && p.flags.elongatedTorso && p.flags.shortLegs && p.flags.smallHead && p.flags.inconsistentVolume);
  ok("parse: notes carried over", !!p && p.notes === "bloated midsection, thin shins");
  const c = parseFullBodyCheck(raw);
  ok("parseFullBodyCheck: one answer carries framing AND proportions", !!c && c.fullBody && !c.proportionsOk && !!c.proportions && c.proportions.torsoHeads === 4.1);
  ok("parse: malformed text → unknown (null)", parseProportionAssessment("the figure looks fine") === null);
  ok("parse: broken JSON → unknown", parseProportionAssessment('{"headsTall": 7.2, "torsoHeads": ') === null);
  ok("parse: empty / non-object → unknown", parseProportionAssessment("") === null && parseProportionAssessment(null) === null && parseProportionAssessment(42) === null);
  ok("parse: legacy shape without measurements → unknown", parseProportionAssessment({ fullBody: true, feetVisible: true, proportionsOk: true }) === null);
  const legacy = parseFullBodyCheck('{"fullBody":true,"feetVisible":true,"proportionsOk":true}');
  ok("parseFullBodyCheck: legacy answer still parses with proportions=null", !!legacy && legacy.proportions === null && fullBodyPasses(legacy));
  const partial = parseProportionAssessment({ headsTall: "7.4", torsoHeads: "abc", legsRatio: -1, flags: "nope" });
  ok("parse: non-numeric / negative fields → 0 (unknown), flags default false", !!partial && partial.headsTall === 7.4 && partial.torsoHeads === 0 && partial.legsRatio === 0 && !partial.flags.shortLegs);
  ok("unknown never blocks: evaluateProportions(null) ok, empty defects, score 100", (() => { const v = evaluateProportions(null); return v.ok && v.defects.length === 0 && v.score === 100; })());
}

// ---------------------------------------------------------------- 2. thresholds at the boundaries
{
  ok("thresholds exported as specified (Stage 52 tightened)", MAX_TORSO_HEADS === 3.3 && MIN_LEGS_RATIO === 0.44 && MAX_HEADS_TALL === 7.9);
  ok("natural figure passes", evaluateProportions(natural).ok && evaluateProportions(natural).score === 100);
  ok("torsoHeads 3.3 exactly → ok", evaluateProportions({ ...natural, torsoHeads: 3.3 }).ok);
  ok("torsoHeads 3.31 → elongatedTorso", evaluateProportions({ ...natural, torsoHeads: 3.31 }).defects.join() === "elongatedTorso");
  ok("legsRatio 0.44 exactly → ok", evaluateProportions({ ...natural, legsRatio: 0.44 }).ok);
  ok("legsRatio 0.439 → shortLegs", evaluateProportions({ ...natural, legsRatio: 0.439 }).defects.join() === "shortLegs");
  ok("legsRatio 0 (unmeasured) → not shortLegs", evaluateProportions({ ...natural, legsRatio: 0 }).ok);
  ok("headsTall 7.9 exactly → ok", evaluateProportions({ ...natural, headsTall: 7.9 }).ok);
  ok("headsTall 7.91 → smallHead", evaluateProportions({ ...natural, headsTall: 7.91 }).defects.join() === "smallHead");
  ok("model's inconsistentVolume flag alone → defect, FAIL", (() => { const v = evaluateProportions({ ...natural, flags: { ...noFlags, inconsistentVolume: true } }); return !v.ok && v.defects.join() === "inconsistentVolume"; })());
  ok("model's elongatedTorso flag with natural numbers → still a defect", !evaluateProportions({ ...natural, flags: { ...noFlags, elongatedTorso: true } }).ok);
  const worst = evaluateProportions({ headsTall: 8.6, torsoHeads: 4.1, legsRatio: 0.4, flags: { elongatedTorso: true, shortLegs: true, smallHead: true, inconsistentVolume: true }, notes: "" });
  ok("the user's frame (torso ~4, legs 40%, 8+ heads, bloated midsection) → all four defects, FAIL", !worst.ok && worst.defects.length === 4);
  ok("score: more/severer defects → lower score", worst.score < evaluateProportions({ ...natural, torsoHeads: 3.6 }).score && evaluateProportions({ ...natural, torsoHeads: 3.6 }).score < 100);
  ok("score: severity scales with the excess", evaluateProportions({ ...natural, torsoHeads: 4.5 }).score < evaluateProportions({ ...natural, torsoHeads: 3.6 }).score);
  ok("score never negative", evaluateProportions({ headsTall: 20, torsoHeads: 20, legsRatio: 0.01, flags: { elongatedTorso: true, shortLegs: true, smallHead: true, inconsistentVolume: true }, notes: "" }).score === 0);
}

// ---------------------------------------------------------------- 3. guard verdict + best-candidate selection
const framingOk: FullBodyCheck = { fullBody: true, feetVisible: true, proportionsOk: true, headsTall: 7.4, issues: [], proportions: natural };
{
  ok("framing ok + natural proportions → pass", fullBodyPasses(framingOk));
  ok("framing ok but elongated torso → FAIL (was passing before 46D)", !fullBodyPasses({ ...framingOk, proportions: { ...natural, torsoHeads: 4.0 } }));
  ok("framing ok but short legs → FAIL", !fullBodyPasses({ ...framingOk, proportions: { ...natural, legsRatio: 0.38 } }));
  ok("framing ok but small head (8.6 heads) → FAIL", !fullBodyPasses({ ...framingOk, headsTall: 8.6, proportions: { ...natural, headsTall: 8.6 } }));
  ok("framing ok, proportions unknown → pass (vision failure must not block)", fullBodyPasses({ ...framingOk, proportions: null }) && fullBodyPasses({ ...framingOk, proportions: undefined }));
  ok("child: small-head threshold still applies", !fullBodyPasses({ ...framingOk, headsTall: 8.6, proportions: { ...natural, headsTall: 8.6 } }, { child: true }));
  // Stage 52: distorted / extra-limb findings fail for adult AND child, even with natural measurements + proportionsOk
  ok("distorted anatomy issue → FAIL (adult)", !fullBodyPasses({ ...framingOk, issues: ["distorted anatomy"] }));
  ok("extra-limb issue → FAIL (adult)", !fullBodyPasses({ ...framingOk, issues: ["extra limb"] }));
  ok("fused-limbs issue → FAIL (child too)", !fullBodyPasses({ ...framingOk, issues: ["fused limbs"] }, { child: true }));
  ok("deformed body issue → FAIL", !fullBodyPasses({ ...framingOk, issues: ["deformed body"] }));

  const cropped: FullBodyCheck = { ...framingOk, fullBody: false, feetVisible: false, proportions: natural };
  const oneDefect: FullBodyCheck = { ...framingOk, proportionsOk: false, proportions: { ...natural, torsoHeads: 3.7 } };
  const twoDefects: FullBodyCheck = { ...framingOk, proportionsOk: false, proportions: { ...natural, torsoHeads: 4.2, legsRatio: 0.39 } };
  ok("best candidate: framing OK preferred over cropped even with a defect", fullBodyScore(oneDefect) > fullBodyScore(cropped));
  ok("best candidate: fewer / milder defects win", fullBodyScore(oneDefect) > fullBodyScore(twoDefects));
  ok("best candidate: a stretched 9-head figure earns no height bonus over a natural one", fullBodyScore({ ...framingOk, headsTall: 9, proportions: { ...natural, headsTall: 9 } }) < fullBodyScore(framingOk));
  ok("null check ranks lowest", fullBodyScore(null) < fullBodyScore(cropped));
}

// ---------------------------------------------------------------- 4. fix-prompt composition
{
  ok("no defects → empty fix prompt", buildProportionFixPrompt([]) === "");
  const fix = buildProportionFixPrompt(["shortLegs", "elongatedTorso", "inconsistentVolume", "smallHead", "shortLegs"]);
  ok("fix: canonical order, deduplicated", /had: elongatedTorso, shortLegs, smallHead, inconsistentVolume\)/.test(fix));
  ok("fix: shorten the torso", /shorten the torso/.test(fix));
  ok("fix: lengthen the legs to half", /lengthen the legs to half of the total body height/.test(fix));
  ok("fix: enlarge the head", /enlarge the head to natural size/.test(fix));
  ok("fix: consistent thickness", /arm, leg and torso thickness consistent with one build/.test(fix));
  ok("fix: neutral camera", /50mm lens, no vertical stretching/.test(fix));
  const only = buildProportionFixPrompt(["smallHead"]);
  ok("fix: only the found defect is named", /had: smallHead\)/.test(only) && !/shorten the torso/.test(only));

  // correction suffix: stretched figure gets the opposite correction from a dwarf one
  const stretched = fullBodyCorrectionSuffix({ ...framingOk, proportionsOk: false, proportions: { ...natural, headsTall: 8.6, torsoHeads: 4.1 } }, 2);
  ok("suffix: stretched figure → 7 to 7.5 heads target, not 'TALLER'", /about 7 to 7\.5 heads tall/.test(stretched) && !/TALLER and slimmer/.test(stretched));
  ok("suffix: stretched figure → includes the PROPORTION FIX block", /PROPORTION FIX/.test(stretched) && /shorten the torso/.test(stretched) && /enlarge the head/.test(stretched));
  const dwarf = fullBodyCorrectionSuffix({ fullBody: true, feetVisible: true, proportionsOk: false, headsTall: 5.2, issues: ["oversized head", "short legs"] }, 2);
  ok("suffix: dwarf figure → still TALLER correction, no PROPORTION FIX block, never asks for 8+ heads", /TALLER and slimmer/.test(dwarf) && !/PROPORTION FIX/.test(dwarf) && /never 8 or more/.test(dwarf));
  ok("suffix: attempt 3 escalates", /Step the camera further back/.test(fullBodyCorrectionSuffix(framingOk, 3)));
  // Stage 52: a distorted-anatomy finding is named explicitly in the correction
  const distorted = fullBodyCorrectionSuffix({ ...framingOk, proportionsOk: false, issues: ["distorted anatomy", "extra limb"] }, 2);
  ok("suffix: distorted anatomy named in the correction", /distorted anatomy \(extra, missing, fused or warped limbs\)/.test(distorted));
}

// ---------------------------------------------------------------- 5. vision request asks for both framing and proportions in ONE call
{
  const req = buildFullBodyCheckRequest("data:image/png;base64,AAAA");
  const text = JSON.stringify(req.messages);
  ok("one request: framing fields", /fullBody/.test(text) && /feetVisible/.test(text));
  ok("one request: proportion fields", /torsoHeads/.test(text) && /legsRatio/.test(text) && /inconsistentVolume/.test(text) && /notes/.test(text));
  ok("system prompt names the stretched-figure failure (Stage 52 tightened numbers)", /7\.9\+ heads/.test(FULL_BODY_CHECK_SYSTEM_PROMPT) && /3\.3\+ heads/.test(FULL_BODY_CHECK_SYSTEM_PROMPT) && /44%/.test(FULL_BODY_CHECK_SYSTEM_PROMPT));
  ok("system prompt also names distorted anatomy / cropped framing (Stage 52)", /distorted, deformed or twisted/.test(FULL_BODY_CHECK_SYSTEM_PROMPT) && /extra \/ missing \/ duplicated \/ fused limbs/.test(FULL_BODY_CHECK_SYSTEM_PROMPT) && /cut off by an edge/.test(FULL_BODY_CHECK_SYSTEM_PROMPT));
  ok("high-detail image attached", /"detail":"high"/.test(text));
}

// ---------------------------------------------------------------- 6. proportion rule in the prompt builders
{
  const app = "A woman in her thirties, red hair, athletic";
  ok("rule text: heads / legs / torso / head / volume / camera", /7 to 7\.5 heads/.test(FULL_BODY_PROPORTIONS_RULE) && /HALF of the total height/.test(FULL_BODY_PROPORTIONS_RULE)
    && /about 3 head-heights/.test(FULL_BODY_PROPORTIONS_RULE) && /NOT be undersized/.test(FULL_BODY_PROPORTIONS_RULE) && /ONE consistent build/.test(FULL_BODY_PROPORTIONS_RULE)
    && /chest height/.test(FULL_BODY_PROPORTIONS_RULE) && /50mm/.test(FULL_BODY_PROPORTIONS_RULE) && /no wide-angle distortion/.test(FULL_BODY_PROPORTIONS_RULE) && /vertical stretching/.test(FULL_BODY_PROPORTIONS_RULE));
  ok("rule text (Stage 52): neutral frontal pose, uncropped whole figure, correct anatomy / no extra limbs", /neutral frontal pose/.test(FULL_BODY_PROPORTIONS_RULE)
    && /nothing cropped/.test(FULL_BODY_PROPORTIONS_RULE) && /correct human anatomy/.test(FULL_BODY_PROPORTIONS_RULE) && /no extra, missing, fused, duplicated or warped limbs/.test(FULL_BODY_PROPORTIONS_RULE));

  const full = characterShotPrompt(app, "full", "Mara", null, null, false);
  ok("full (text-to-image) includes the rule", full.includes(FULL_BODY_PROPORTIONS_RULE));
  ok("full = visual-style prompt + rule (visual-style untouched)", full.startsWith(characterImagePrompt(app, "full", "Mara", null, null, false)));
  ok("full (chained on face) includes the rule", characterShotPrompt(app, "full", "Mara", null, null, true, "face").includes(FULL_BODY_PROPORTIONS_RULE));
  ok("full (chained on full anchor) includes the rule", characterShotPrompt(app, "full", "Mara", null, null, true, "full").includes(FULL_BODY_PROPORTIONS_RULE));
  ok("child full-body also gets the rule", characterShotPrompt("A 9-year-old boy with freckles", "full", "Tim", null, null, false).includes(FULL_BODY_PROPORTIONS_RULE));
  ok("front (face) does NOT include the rule", !characterShotPrompt(app, "front", "Mara", null, null, true, "full").includes(FULL_BODY_PROPORTIONS_RULE) && !/50mm/.test(characterShotPrompt(app, "front", "Mara", null, null, true, "full")));
  ok("profile does NOT include the rule", !characterShotPrompt(app, "profile", "Mara", null, null, true, "face").includes(FULL_BODY_PROPORTIONS_RULE));
  ok("front/profile identical to the visual-style builder", characterShotPrompt(app, "front", "Mara", null, null, true, "full") === characterImagePrompt(app, "front", "Mara", null, null, true, "full")
    && characterShotPrompt(app, "profile", "Mara", null, null, true) === characterImagePrompt(app, "profile", "Mara", null, null, true));
  ok("crowd full shot unchanged (no rule)", characterShotPrompt("guests", "full", "Guests", "CROWD", 6) === characterImagePrompt("guests", "full", "Guests", "CROWD", 6));

  ok("extra index 1 (full-body BACK) is a full-length slot; index 0 (right profile) is not", isFullBodyExtraIndex(1) && !isFullBodyExtraIndex(0) && isFullBodyExtraIndex(3) && !isFullBodyExtraIndex(2));
  ok("full-body extra includes the rule", characterExtraShotPrompt(app, "Mara", 1, "full").includes(FULL_BODY_PROPORTIONS_RULE));
  ok("full-body extra = visual-style extra prompt + rule", characterExtraShotPrompt(app, "Mara", 1, "full").startsWith(characterExtraAnglePrompt(app, "Mara", 1, "full")));
  ok("right-profile extra does NOT include the rule", characterExtraShotPrompt(app, "Mara", 0, "face") === characterExtraAnglePrompt(app, "Mara", 0, "face"));
  ok("withFullBodyProportionsRule is idempotent", withFullBodyProportionsRule(withFullBodyProportionsRule("P")) === `P ${FULL_BODY_PROPORTIONS_RULE}`);
}

// ---------------------------------------------------------------- 7. guard loop: proportion failures trigger the bounded retry, best candidate kept
(async () => {
  ok("attempt budget unchanged (3 total)", FULL_BODY_MAX_ATTEMPTS === 3);
  const good = framingOk;
  const stretched = (torso: number, legs: number): FullBodyCheck => ({ ...framingOk, proportionsOk: false, proportions: { ...natural, torsoHeads: torso, legsRatio: legs } });

  // proportions fail on attempt 1 → retry carries the fix, attempt 2 passes
  let k = 0; const prompts: string[] = []; const checks: string[] = [];
  const r1 = await generateFullBodyWithGuard("BASE", async (p) => { prompts.push(p); return `u${++k}`; }, { check: async (u) => { checks.push(u); return u === "u1" ? stretched(4.1, 0.4) : good; } });
  ok("retry on proportion failure: passes on attempt 2", r1.url === "u2" && r1.attempts === 2 && r1.passed && !r1.proportionsWarning);
  ok("one vision call per attempt (no doubling)", checks.length === 2);
  ok("retry prompt = base + correction + PROPORTION FIX", prompts[1].startsWith("BASE") && /CORRECTION \(attempt 2\)/.test(prompts[1]) && /PROPORTION FIX .*elongatedTorso, shortLegs/.test(prompts[1]));

  // all attempts fail → exactly 3 generations, best (mildest) candidate kept, proportionsWarning listed
  k = 0; prompts.length = 0;
  const seq: Record<string, FullBodyCheck> = { u1: stretched(4.2, 0.39), u2: stretched(3.6, 0.48), u3: { ...stretched(3.4, 0.5), fullBody: false, feetVisible: false } };
  const r2 = await generateFullBodyWithGuard("BASE", async (p) => { prompts.push(p); return `u${++k}`; }, { check: async (u) => seq[u] });
  ok("all fail: bounded at 3 generations", prompts.length === 3 && r2.attempts === 3 && !r2.passed);
  ok("all fail: best = framing OK with the single mildest defect (u2), not the cropped defect-free u3", r2.url === "u2");
  ok("all fail: proportionsWarning lists the remaining defects", Array.isArray(r2.proportionsWarning) && r2.proportionsWarning.join() === "elongatedTorso");
  ok("attempt 3 prompt escalates", /attempt 3/.test(prompts[2]));

  // vision unknown → accept the frame, no retry
  k = 0;
  const r3 = await generateFullBodyWithGuard("BASE", async () => `u${++k}`, { check: async () => null });
  ok("vision failure → frame accepted after 1 generation", r3.url === "u1" && k === 1 && r3.check === null);
  // framing parsed but proportions unknown (legacy answer) → pass on attempt 1
  k = 0;
  const r4 = await generateFullBodyWithGuard("BASE", async () => `u${++k}`, { check: async () => ({ ...framingOk, proportions: null }) });
  ok("proportions unknown → accepted as pass on attempt 1", r4.passed && r4.attempts === 1);

  console.log(`Stage 46D: ${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
