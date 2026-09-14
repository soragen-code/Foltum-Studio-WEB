/**
 * Stage 107b — footage validation converges: targeted LLM repair passes + deterministic clamp; OPENS ON re-sync;
 * all three callers use repairEpisodeDescriptions and never throw "episode descriptions invalid".
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage107b.ts
 */
import fs from "fs";
import path from "path";

let passed = 0;
function ok(cond: unknown, label: string, extra?: unknown) {
  if (!cond) { console.error("FAIL:", label, extra ?? ""); process.exit(1); }
  passed++;
  console.log("ok:", label);
}
const root = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const D = (s1: string, s2: string, c: string) => `SHOT 1 (30 s): ${s1}\nSHOT 2 (30 s): ${s2}\nCLIFFHANGER (last frame): ${c}`;
const W = (n: number, prefix = "Word") => Array.from({ length: n }, (_, i) => (i === 0 ? prefix : "word")).join(" ");

async function main() {
  const season = await import("../lib/season");
  const repair = await import("../lib/footage-repair");
  const { validateEpisodeDescriptions, parseEpisodeFootage, countWords } = season;
  const { repairEpisodeDescriptions, clampDescription, stripQuotes, resyncOpensOn, groupProblems } = repair;
  const quiet = { log: () => {} };

  // ── the prod failure: caps overshot on 3 of 8 episodes + one quoted cliffhanger ──
  const c1 = "Over the rim, five pairs of glowing eyes open in the dark.";
  const good2 = D(`OPENS ON: ${c1} The creatures pour over the rim onto the huddled group.`, "Alex swings a shovel at the nearest creature; the kids press into the far corner.", "A clawed hand closes around a child's ankle as the lamp goes out.");
  const eps = [
    { number: 1, title: "Dugout", description: D("Alex's team climbs down into the dugout and huddles around a hissing radio.", "A voice on the radio promises shelter; the man turns the volume up.", W(19, "Glowing") + "."), cliffhanger: "x" },
    { number: 2, title: "Eyes", description: good2, cliffhanger: "y" },
    { number: 3, title: "Hatch", description: D(`OPENS ON: A clawed hand closes around a child's ankle as the lamp goes out. Alex fires a flare into the dark.`, W(24, "Emma") + ".", 'The radio crackles: "Stay where you are, we are coming." Emma freezes.'), cliffhanger: "z" },
  ];
  const before = validateEpisodeDescriptions(eps);
  ok(before.length >= 3 && groupProblems(before).size === 2 && groupProblems(before).has(1) && groupProblems(before).has(3), "fixture: episodes 1 and 3 fail, 2 passes", before);

  // (1) fake LLM returns a valid fix → repaired list, next episode's OPENS ON re-synced
  let calls: { system: string; user: string }[] = [];
  const newC1 = "Five pairs of glowing eyes open over the rim.";
  const goodLLM = async (system: string, user: string) => {
    calls.push({ system, user });
    return { episodes: [
      { number: 1, description: D("Alex's team climbs down into the dugout and huddles around a hissing radio.", "A voice on the radio promises shelter; the man turns the volume up.", newC1) },
      { number: 3, description: D("OPENS ON: A clawed hand closes around a child's ankle as the lamp goes out. Alex fires a flare into the dark.", "Emma drags the child toward the ladder while the flare sputters.", "The hatch above them creaks open.") },
    ] };
  };
  const r1 = await repairEpisodeDescriptions(eps, "en", goodLLM, quiet);
  ok(calls.length === 1, "valid fix: exactly one repair call");
  ok(/EPISODE 1 "Dugout"/.test(calls[0].user) && /EPISODE 3 "Hatch"/.test(calls[0].user) && !/EPISODE 2/.test(calls[0].user), "repair call contains ONLY the failing episodes");
  ok(/Problems:.*CLIFFHANGER has 19 words/.test(calls[0].user), "repair call carries the exact problem strings");
  ok(/Previous episode's CLIFFHANGER/.test(calls[0].user) && calls[0].user.includes("A clawed hand closes around a child's ankle"), "repair call gives the previous cliffhanger for OPENS ON");
  ok(/SHOT 1 \(30 s\):/.test(calls[0].system) && /HARD MAX 50 words/.test(calls[0].system) && /CUT WORDS/.test(calls[0].system), "repair system prompt: footage rule + caps + cut words");
  ok(validateEpisodeDescriptions(r1.episodes).length === 0, "valid fix: result passes validation", validateEpisodeDescriptions(r1.episodes));
  ok(JSON.stringify(r1.repaired) === "[1,3]" && r1.clamped.length === 0, "valid fix: repaired=[1,3], clamped=[]", r1);
  const f2 = parseEpisodeFootage(r1.episodes[1].description)!;
  ok(f2.opensOn === newC1 && f2.shot1.includes("The creatures pour over the rim onto the huddled group."), "episode 2 OPENS ON re-synced to the NEW cliffhanger of episode 1, body kept", f2);
  ok(r1.episodes[0].cliffhanger === newC1, "cliffhanger field mirrors the new CLIFFHANGER line");
  ok(r1.episodes[1].description !== good2 && parseEpisodeFootage(r1.episodes[1].description)!.shot2 === parseEpisodeFootage(good2)!.shot2, "untouched episode keeps its own SHOT 2");

  // (2) LLM keeps returning invalid text → 3 passes, then clamp
  calls = [];
  const badLLM = async (system: string, user: string) => {
    calls.push({ system, user });
    return { episodes: [
      { number: 1, description: D("Alex's team climbs down.", "The man turns the volume up.", W(30, "Still") + ".") },
      { number: 3, description: D("OPENS ON: whatever. Alex fires a flare.", W(40, "Emma") + ".", 'Someone shouts "we are coming now" from above. Emma freezes. The lamp dies.') },
    ] };
  };
  const r2 = await repairEpisodeDescriptions(eps, "en", badLLM, quiet);
  ok(calls.length === 3, "invalid fixes: exactly 3 repair passes before the clamp", calls.length);
  const p2 = validateEpisodeDescriptions(r2.episodes);
  ok(p2.length === 0, "clamp: result passes validateEpisodeDescriptions", p2);
  ok(JSON.stringify(r2.clamped) === "[1,3]", "clamp: clamped=[1,3]", r2.clamped);
  ok(!/["«»“”]/.test(r2.episodes[2].description), "clamp: quotes removed");
  for (const e of r2.episodes) {
    const f = parseEpisodeFootage(e.description)!;
    const own = f.shot1.replace(/^OPENS ON:\s*/i, "").replace(f.opensOn ?? "", "");
    ok(countWords(own) + countWords(f.shot2) + countWords(f.cliffhanger) <= 50 && countWords(f.cliffhanger) <= 14, `clamp: episode ${e.number} within 50 total / 14 cliffhanger`);
  }
  const c3 = parseEpisodeFootage(r2.episodes[1].description)!.cliffhanger;
  ok(parseEpisodeFootage(r2.episodes[2].description)!.opensOn === c3, "clamp: episode 3 opens on episode 2's cliffhanger");
  ok(parseEpisodeFootage(r2.episodes[1].description)!.opensOn === parseEpisodeFootage(r2.episodes[0].description)!.cliffhanger, "clamp: episode 2 opens on the clamped cliffhanger of episode 1");

  // (2b) LLM throws / returns garbage → still converges
  const r3 = await repairEpisodeDescriptions(eps, "en", async () => { throw new Error("boom"); }, quiet);
  ok(validateEpisodeDescriptions(r3.episodes).length === 0 && r3.clamped.length === 2, "LLM error: clamp still yields a valid result");
  const r4 = await repairEpisodeDescriptions(eps, "en", async () => ({ nonsense: true }), quiet);
  ok(validateEpisodeDescriptions(r4.episodes).length === 0, "LLM garbage: clamp still yields a valid result");

  // valid input → untouched, no LLM call
  let called = false;
  const r5 = await repairEpisodeDescriptions([eps[1]].map((e) => ({ ...e, number: 1 })), "en", async () => { called = true; return {}; }, quiet);
  ok(!called && r5.repaired.length === 0 && r5.clamped.length === 0, "valid input: no LLM call, nothing repaired");

  // clamp primitives
  ok(stripQuotes('The radio crackles: "Stay where you are." Emma freezes.') === "The radio crackles. Emma freezes.", "stripQuotes removes the quoted segment and the colon debris", stripQuotes('The radio crackles: "Stay where you are." Emma freezes.'));
  ok(stripQuotes("Голос: «Не выключайте маяк». Орлов замирает.") === "Голос. Орлов замирает.", "stripQuotes handles « »", stripQuotes("Голос: «Не выключайте маяк». Орлов замирает."));
  const clampedLong = clampDescription(D(W(30, "Alex") + ". " + W(10, "Then") + ".", W(25, "Emma") + ".", W(20, "Eyes") + ". More."), null);
  ok(validateEpisodeDescriptions([{ number: 1, description: clampedLong }]).length === 0, "clampDescription: long lines → valid", clampedLong);
  ok(/\.$/.test(parseEpisodeFootage(clampedLong)!.cliffhanger), "clampDescription: truncated cliffhanger ends with a period");
  const clampedPlain = clampDescription("Just a paragraph of prose. Another sentence here. And a final one.", "Prev cliff.");
  ok(validateEpisodeDescriptions([{ number: 1, description: D("a b.", "c d.", "Prev cliff.") }, { number: 2, description: clampedPlain }]).length === 0, "clampDescription: non-footage prose → valid 3-line footage with OPENS ON");
  const rs = resyncOpensOn(good2, "New cliff.");
  ok(parseEpisodeFootage(rs)!.opensOn === "New cliff." && rs.includes("The creatures pour over the rim onto the huddled group."), "resyncOpensOn replaces the OPENS ON text and keeps the body");
  // fuzz: random overshoots always converge
  for (let i = 0; i < 25; i++) {
    const rnd = (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1));
    const fz = [1, 2, 3, 4].map((n) => ({ number: n, description: D(`${n > 1 ? "OPENS ON: Old cliff " + (n - 1) + ". " : ""}${W(rnd(5, 40), "Alex")}. ${W(rnd(2, 15), "He")}. ${W(rnd(2, 8), "She")}.`, `${W(rnd(5, 40), "Emma")}: "quoted words here". ${W(rnd(2, 10), "Then")}.`, `${W(rnd(3, 30), "Eyes")}. ${W(rnd(2, 6), "Lamp")}.`) }));
    const rr = await repairEpisodeDescriptions(fz, "en", async () => ({}), quiet);
    const pp = validateEpisodeDescriptions(rr.episodes);
    if (pp.length) { console.error("FAIL: fuzz clamp not valid", pp, rr.episodes); process.exit(1); }
  }
  ok(true, "fuzz: 25 random overshoot seasons all converge to valid footage");

  // ── fs: callers ──
  const callers = ["lib/workers/season-script-job.ts", "lib/workers/story-revise-job.ts", "app/api/ai/season/revise/route.ts"];
  for (const c of callers) {
    const src = read(c);
    ok(src.includes("repairEpisodeDescriptions"), `${c} uses repairEpisodeDescriptions`);
    ok(!src.includes("episode descriptions invalid"), `${c} no longer throws "episode descriptions invalid"`);
    ok(src.includes("EPISODE_FOOTAGE_RETRY_NOTE"), `${c} keeps the cheap first retry with the format note`);
  }
  const hits: string[] = [];
  const walk = (dir: string) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) walk(p); else if (/\.tsx?$/.test(f.name) && read(path.relative(root, p)).includes("episode descriptions invalid")) hits.push(path.relative(root, p)); } };
  walk(path.join(root, "lib")); walk(path.join(root, "app"));
  ok(hits.length === 0, "no path in lib/ or app/ throws 'episode descriptions invalid'", hits);
  // season job: the first attempt still retries, the retry does not throw on caps
  const { validateStructure } = await import("../lib/workers/season-script-job");
  const badStructure = { title: "T", logline: "A long enough logline here.", episodes: [1, 2, 3, 4, 5, 6].map((n) => ({ number: n, title: `E${n}`, logline: "A long enough logline.", locationName: "Dugout", locationDesc: "A rain-soaked dugout under a broken sky.", characters: ["Alex"], arcRole: "завязка", cliffhanger: "Eyes open.", description: D(`${n > 1 ? "OPENS ON: Eyes open. " : ""}Alex climbs down.`, "Emma waits.", W(19, "Eyes") + ".") })) };
  let threw = false; try { validateStructure(badStructure, 6, 0); } catch { threw = true; }
  ok(threw, "validateStructure(attempt 0): overshoot → throws (cheap retry)");
  ok(validateStructure(badStructure, 6, 1).episodes.length === 6, "validateStructure(attempt 1): overshoot → accepted for repair");

  // ── rebuild script ──
  ok(fs.existsSync(path.join(root, "scripts/rebuild-full-story.ts")), "scripts/rebuild-full-story.ts exists");
  const rb = read("scripts/rebuild-full-story.ts");
  ok(rb.includes("DATABASE_URL") && rb.includes("--project") && rb.includes("buildFullStoryFromStructure") && rb.includes("parseEpisodeFootage") && rb.includes("season.update"), "rebuild script: env DATABASE_URL, --project, rebuild + update");

  console.log(`\nStage 107b: ${passed} checks passed`);
}
main().catch((e) => { console.error("FAIL:", e?.message ?? e); process.exit(1); });
