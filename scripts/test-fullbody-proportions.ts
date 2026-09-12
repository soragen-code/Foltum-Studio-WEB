/**
 * Full-body proportion guard — unit checks (always) + optional live run against Replicate + OpenAI.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/test-fullbody-proportions.ts            # pure unit checks
 *   npx tsx --tsconfig tsconfig.json scripts/test-fullbody-proportions.ts --live     # + real generation
 *
 * Live mode generates the 9:16 full-body shot for two test characters from their existing front
 * references (same inputs the earlier dwarfed run used), saves outputs under /home/ubuntu/fullbody_check/v2/,
 * runs the new vision check and prints headsTall / proportionsOk / issues per attempt. It also measures
 * the OLD dwarfed images with the new check for a before/after comparison.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  parseFullBodyCheck, fullBodyPasses, fullBodyScore, fullBodyCorrectionSuffix, checkFullBodyImage,
  ADULT_MIN_HEADS_TALL, CHILD_MIN_HEADS_TALL, FULL_BODY_CHECK_SYSTEM_PROMPT,
} from "../lib/full-body-check";
import {
  characterImagePrompt, isChildAppearance, FULL_BODY_PROPORTIONS, FULL_BODY_PROPORTIONS_CHILD, FULL_BODY_REFERENCE_NOTE, FULL_BODY_FRAMING,
} from "../lib/visual-style";
import { generateFullBodyWithGuard, FULL_BODY_MAX_ATTEMPTS } from "../lib/workers/character-images-job";
import type { FullBodyCheck } from "../lib/full-body-check";

// ---------------------------------------------------------------- unit checks
function unit() {
  // parse: new shape with headsTall + issues
  const c = parseFullBodyCheck('```json\n{"fullBody":true,"feetVisible":true,"headsTall":5.4,"proportionsOk":false,"issues":["Oversized head","short legs"]}\n```');
  assert.ok(c);
  assert.equal(c.headsTall, 5.4);
  assert.deepEqual(c.issues, ["oversized head", "short legs"]);
  assert.equal(fullBodyPasses(c), false);
  // parse: legacy shape without headsTall still parses (headsTall 0 = unknown)
  const legacy = parseFullBodyCheck('{"fullBody":true,"feetVisible":true,"proportionsOk":true}');
  assert.ok(legacy && legacy.headsTall === 0 && legacy.issues.length === 0 && fullBodyPasses(legacy));
  assert.equal(parseFullBodyCheck("nope"), null);
  assert.equal(parseFullBodyCheck('{"fullBody":true}'), null);

  // pass/fail thresholds
  const ok: FullBodyCheck = { fullBody: true, feetVisible: true, proportionsOk: true, headsTall: 7.6, issues: [] };
  assert.equal(fullBodyPasses(ok), true);
  assert.equal(fullBodyPasses({ ...ok, headsTall: 6.2 }), false, "adult < 6.5 heads fails");
  assert.equal(fullBodyPasses({ ...ok, headsTall: 6.2 }, { child: true }), true, "child 6.2 heads passes");
  assert.equal(fullBodyPasses({ ...ok, headsTall: 4.5 }, { child: true }), false, "child < 5 heads fails");
  assert.equal(fullBodyPasses({ ...ok, issues: ["oversized head"] }), false, "oversized-head finding fails even when proportionsOk=true");
  assert.equal(fullBodyPasses({ ...ok, issues: ["short legs"] }), false);
  assert.equal(fullBodyPasses({ ...ok, fullBody: false }), false);
  assert.equal(fullBodyPasses(null), false);
  assert.ok(ADULT_MIN_HEADS_TALL === 6.5 && CHILD_MIN_HEADS_TALL === 5);
  assert.match(FULL_BODY_CHECK_SYSTEM_PROMPT, /headsTall/);

  // score ranks the taller / better-framed attempt higher
  assert.ok(fullBodyScore({ ...ok, headsTall: 7 }) > fullBodyScore({ ...ok, headsTall: 5 }));
  assert.ok(fullBodyScore({ ...ok, fullBody: false, headsTall: 8 }) < fullBodyScore({ ...ok, headsTall: 5 }));
  assert.ok(fullBodyScore(null) < fullBodyScore({ ...ok, fullBody: false, feetVisible: false, proportionsOk: false, headsTall: 4 }));

  // corrective suffix names the exact problem and escalates on attempt 3
  const s2 = fullBodyCorrectionSuffix({ ...ok, proportionsOk: false, headsTall: 5.2, issues: ["oversized head", "short legs"] }, 2);
  assert.match(s2, /oversized head/);
  assert.match(s2, /short stubby legs/);
  assert.match(s2, /7\.5 heads tall \(never 8 or more\)/, "Stage 46D: the dwarf correction no longer asks for 8 heads (that trips the small-head threshold)");
  assert.doesNotMatch(s2, /Step the camera further back/);
  const s3 = fullBodyCorrectionSuffix({ ...ok, proportionsOk: false, headsTall: 5.2, issues: [] }, 3);
  assert.match(s3, /5\.2 heads tall/);
  assert.match(s3, /Step the camera further back/);
  const sChild = fullBodyCorrectionSuffix({ ...ok, headsTall: 4, issues: [] }, 2, { child: true });
  assert.match(sChild, /child/);
  assert.match(fullBodyCorrectionSuffix(null, 2), /wrong body proportions/);

  // child detection
  assert.equal(isChildAppearance("A broad-shouldered man in his early 40s with tanned skin"), false);
  assert.equal(isChildAppearance("Mixed-race, athletic build with curly dark hair and hazel eyes."), false);
  assert.equal(isChildAppearance("A woman in her thirties, red hair"), false);
  assert.equal(isChildAppearance("A 9-year-old boy with freckles"), true);
  assert.equal(isChildAppearance("A small girl, about 7 years old, in a yellow raincoat"), true);
  assert.equal(isChildAppearance("A tall 25 years old man"), false);
  assert.equal(isChildAppearance("Мальчик 10 лет, худой"), true);
  assert.equal(isChildAppearance("His girlfriend, a tall blonde"), false);

  // prompt composition: adult gets adult proportions, child gets child proportions, reference note for chained
  const adult = characterImagePrompt("A man in his 40s, tanned skin", "full", "Gareth", null, null, true);
  assert.ok(adult.startsWith(FULL_BODY_FRAMING));
  assert.ok(adult.includes(FULL_BODY_PROPORTIONS));
  assert.ok(adult.includes(FULL_BODY_REFERENCE_NOTE));
  assert.match(adult, /7 to 7\.5 heads tall/);
  assert.match(adult, /NOT chibi/);
  assert.doesNotMatch(adult, /7\.5–8 heads tall/, "Stage 52: the contradictory 7.5–8 / small-head wording is gone");
  assert.match(adult, /NATURAL size for the body/, "Stage 52: head is natural size, not 'SMALL ~1/8'");
  assert.match(adult, /85–90% of the frame height/);
  assert.match(adult, /Do NOT copy the reference's framing, crop, head size or head-to-frame scale/);
  const child = characterImagePrompt("A 9-year-old boy with freckles", "full", "Tim", null, null, true);
  assert.ok(child.includes(FULL_BODY_PROPORTIONS_CHILD) && !child.includes(FULL_BODY_PROPORTIONS));
  const unchained = characterImagePrompt("A man in his 40s", "full", "G", null, null, false);
  assert.ok(!unchained.includes(FULL_BODY_REFERENCE_NOTE) && unchained.includes(FULL_BODY_PROPORTIONS));
  // other shots untouched
  assert.doesNotMatch(characterImagePrompt("A man", "front", "G"), /heads tall/);
  assert.doesNotMatch(characterImagePrompt("A man", "profile", "G", null, null, true), /heads tall/);

  console.log("unit: ok");
}

// generateFullBodyWithGuard with mocked gen/check: retries with corrective prompt, keeps best if all fail
async function unitGuard() {
  assert.equal(FULL_BODY_MAX_ATTEMPTS, 3);
  const prompts: string[] = [];
  const bad = (h: number): FullBodyCheck => ({ fullBody: true, feetVisible: true, proportionsOk: false, headsTall: h, issues: ["oversized head"] });
  const good: FullBodyCheck = { fullBody: true, feetVisible: true, proportionsOk: true, headsTall: 7.8, issues: [] };
  // passes on attempt 2
  let n = 0;
  const r1 = await generateFullBodyWithGuard("BASE", async (p) => { prompts.push(p); return `u${++n}`; }, { check: async (u) => (u === "u1" ? bad(5.3) : good) });
  assert.equal(r1.url, "u2"); assert.equal(r1.attempts, 2); assert.equal(r1.passed, true);
  assert.equal(prompts[0], "BASE"); assert.match(prompts[1], /CORRECTION \(attempt 2\).*oversized head/);
  // all fail → best (tallest) kept, exactly 3 generations
  n = 0; prompts.length = 0;
  const heads = [5.1, 6.0, 5.6];
  const r2 = await generateFullBodyWithGuard("BASE", async (p) => { prompts.push(p); return `u${++n}`; }, { check: async (u) => bad(heads[Number(u.slice(1)) - 1]) });
  assert.equal(prompts.length, 3); assert.equal(r2.url, "u2"); assert.equal(r2.passed, false);
  assert.match(prompts[2], /attempt 3/);
  // Stage 46D: framing OK but proportions stretched → retried with the proportion fix, passes on attempt 2
  n = 0; prompts.length = 0;
  const stretched: FullBodyCheck = { ...good, proportions: { headsTall: 8.6, torsoHeads: 4.1, legsRatio: 0.4, flags: { elongatedTorso: true, shortLegs: true, smallHead: true, inconsistentVolume: true }, notes: "" } };
  const r5 = await generateFullBodyWithGuard("BASE", async (p) => { prompts.push(p); return `u${++n}`; }, { check: async (u) => (u === "u1" ? stretched : good) });
  assert.equal(r5.url, "u2"); assert.equal(r5.passed, true); assert.equal(r5.proportionsWarning, undefined);
  assert.match(prompts[1], /PROPORTION FIX \(the previous attempt had: elongatedTorso, shortLegs, smallHead, inconsistentVolume\)/);
  // check unavailable → keep first, no retries
  n = 0; prompts.length = 0;
  const r3 = await generateFullBodyWithGuard("BASE", async () => `u${++n}`, { check: async () => null });
  assert.equal(r3.url, "u1"); assert.equal(n, 1);
  // child: 6.2 heads passes on first attempt
  n = 0;
  const r4 = await generateFullBodyWithGuard("BASE", async () => `u${++n}`, { child: true, check: async () => ({ ...good, headsTall: 6.2 }) });
  assert.equal(r4.attempts, 1); assert.equal(r4.passed, true);
  console.log("unit guard: ok");
}

// ---------------------------------------------------------------- live run
const OUT = "/home/ubuntu/fullbody_check/v2";
const CHARS = [
  { key: "gareth", name: "Gareth Stone", front: "https://foltum-studio-web-media.s3.us-east-1.amazonaws.com/media/public/characters/cmtw672800001l304gxz5khik/cmtw68qmy000fjw04h2eu7kny/realistic-original-v2/front-1789127876448.png",
    appearance: "A broad-shouldered man in his early 40s with a strong presence, tanned skin, short-cropped brown hair, and amber eyes. He wears sturdy armor that gleams with protective enchantments.",
    old: "/home/ubuntu/fullbody_check/new_gareth.png" },
  { key: "ethan", name: "Ethan Crowley", front: "https://foltum-studio-web-media.s3.us-east-1.amazonaws.com/media/public/characters/cmtw0fdxh0001if04qjxj0oa1/cmtw0gmuw000djs04hjzu0d62/realistic-original-v2/front-1789086761493.png",
    appearance: "Mixed-race, athletic build with curly dark hair and hazel eyes. His clothing is often dark and slightly worn, reflecting his alignment with the forces of darkness.",
    old: "/home/ubuntu/fullbody_check/new_ethan.png" },
];

async function live() {
  const { generateImage } = await import("../lib/replicate");
  fs.mkdirSync(OUT, { recursive: true });
  const summary: Record<string, unknown>[] = [];
  for (const c of CHARS) {
    // Measure the OLD dwarfed output with the new check (before).
    let before: FullBodyCheck | null = null;
    if (fs.existsSync(c.old)) {
      const b64 = fs.readFileSync(c.old).toString("base64");
      before = await checkFullBodyImage(`data:image/png;base64,${b64}`);
      console.log(`${c.name}: OLD image check =`, JSON.stringify(before));
    }
    const basePrompt = characterImagePrompt(c.appearance, "full", c.name, null, null, true);
    if (c === CHARS[0]) console.log("PROMPT:\n" + basePrompt + "\n");
    let k = 0;
    const attempts: { url: string; file: string; check: FullBodyCheck | null }[] = [];
    const t0 = Date.now();
    const r = await generateFullBodyWithGuard(basePrompt, async (prompt) => {
      k += 1;
      if (k > 1) console.log(`${c.name}: retry prompt suffix →`, prompt.slice(basePrompt.length));
      const t = Date.now();
      const url = await generateImage({ prompt, aspect_ratio: "9:16", image_input: [c.front] }, {});
      console.log(`${c.name}: attempt ${k} generated in ${((Date.now() - t) / 1000).toFixed(0)}s → ${url}`);
      const file = path.join(OUT, `${c.key}_a${k}.png`);
      fs.writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
      attempts.push({ url, file, check: null });
      return url;
    }, { label: c.name, child: isChildAppearance(c.appearance), check: async (url) => {
      const ch = await checkFullBodyImage(url);
      const a = attempts.find((x) => x.url === url); if (a) a.check = ch;
      return ch;
    } });
    const chosen = attempts.find((a) => a.url === r.url)!;
    fs.copyFileSync(chosen.file, path.join(OUT, `${c.key}_final.png`));
    console.log(`${c.name}: FINAL after ${r.attempts} attempt(s), passed=${r.passed}, total ${((Date.now() - t0) / 1000).toFixed(0)}s →`, JSON.stringify(r.check));
    summary.push({ name: c.name, before, attempts: attempts.map((a) => ({ file: a.file, check: a.check })), final: { file: chosen.file, check: r.check, passed: r.passed } });
  }
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log("\nSUMMARY:");
  for (const s of summary as any[]) console.log(`  ${s.name}: before headsTall=${s.before?.headsTall ?? "?"} proportionsOk=${s.before?.proportionsOk ?? "?"} → after headsTall=${s.final.check?.headsTall ?? "?"} proportionsOk=${s.final.check?.proportionsOk ?? "?"} passed=${s.final.passed}`);
}

(async () => {
  unit();
  await unitGuard();
  if (process.argv.includes("--live")) await live();
})().catch((e) => { console.error(e); process.exit(1); });
