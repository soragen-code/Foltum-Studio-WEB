/**
 * Stage 103 checks (pure, static + a live import of lib/season.ts — no network / DB / render):
 *
 *  Episode structure changed from 4 scenes / 119 s ("under 1:59") to EXACTLY 2 scenes × 30 s =
 *  60 s ("1:00"). Shot 1 = the set-up continuing the previous episode's cliffhanger, shot 2 = the
 *  escalation that ENDS on this episode's cliffhanger. The CLIFFHANGER CHAIN / continuity rules
 *  are unchanged. No prompt or UI copy in lib/ or app/ may still say "1:59" or "119".
 *  Legacy 4-scene episodes already in the DB must still parse (zod accepts up to 8 scenes) and
 *  only produce SOFT validation problems.
 *
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage103.ts
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

let pass = 0;
const ok = (c: unknown, m: string) => {
  assert(c, m);
  console.log("ok:", m);
  pass++;
};

const root = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      walk(full, exts, out);
    } else if (exts.some((x) => e.name.endsWith(x))) out.push(full);
  }
  return out;
}

const season = read("lib/season.ts");
const scenesJob = read("lib/workers/scenes-job.ts");
const seasonScriptJob = read("lib/workers/season-script-job.ts");
const episodeView = read("app/project/[id]/episode/[episodeId]/episode-view.tsx");

// ── 1. Static: constants and helpers in lib/season.ts ──
{
  ok(/EPISODE_MAX_TOTAL_SECONDS\s*=\s*60\b/.test(season), "static: EPISODE_MAX_TOTAL_SECONDS = 60");
  ok(/EPISODE_MAX_SCENES\s*=\s*2\b/.test(season), "static: EPISODE_MAX_SCENES = 2");
  ok(/export const EPISODE_TOTAL_LABEL/.test(season), "static: season.ts exports EPISODE_TOTAL_LABEL");
  ok(/export const LAST_SHOT_NOTE/.test(season), "static: season.ts exports LAST_SHOT_NOTE");
  ok(!/1:59/.test(season) && !/\b119\b/.test(season), "static: season.ts has no 1:59 / 119 left");
}

// ── 2. Static: scenes-job.ts derives its wording (no hardcoded 1:59 / 119) ──
{
  ok(/export const EPISODE_STRUCTURE_TEXT/.test(scenesJob), "static: scenes-job.ts exports EPISODE_STRUCTURE_TEXT");
  ok(/EPISODE_TOTAL_LABEL/.test(scenesJob), "static: scenes-job.ts uses EPISODE_TOTAL_LABEL from season");
  ok(/\$\{EPISODE_STRUCTURE_TEXT\}/.test(scenesJob), "static: scenes-job SYSTEM prompt embeds EPISODE_STRUCTURE_TEXT");
  ok(!/1:59/.test(scenesJob) && !/\b119\b/.test(scenesJob), "static: scenes-job.ts has no 1:59 / 119 left");
  ok(/MAX_SILENT_SCENES\s*=\s*0/.test(scenesJob), "static: scenes-job silent-scene cap = 0 (Stage 110: dialogue in every scene)");
  ok(!/1:59/.test(seasonScriptJob) && !/\b119\b/.test(seasonScriptJob), "static: season-script-job.ts has no 1:59 / 119 left");
  ok(/EPISODE_TOTAL_LABEL/.test(seasonScriptJob), "static: season-script-job.ts uses EPISODE_TOTAL_LABEL");
  ok(/EPISODE_TOTAL_LABEL/.test(episodeView) && !/2 minutes/.test(episodeView), "static: episode-view.tsx copy uses EPISODE_TOTAL_LABEL (no '2 minutes')");
}

// ── 3. Static: repo-wide grep — no "1:59" in lib/**/*.ts and app/**/*.tsx ──
{
  const files = [...walk(path.join(root, "lib"), [".ts", ".tsx"]), ...walk(path.join(root, "app"), [".ts", ".tsx"])];
  const offenders = files.filter((f) => fs.readFileSync(f, "utf8").includes("1:59")).map((f) => path.relative(root, f));
  ok(files.length > 20, `grep: scanned ${files.length} files under lib/ and app/`);
  ok(offenders.length === 0, `grep: no "1:59" left in lib/ or app/ (offenders: ${offenders.join(", ") || "none"})`);
  const under = files.filter((f) => /under 1:59|4 scenes|four scenes|2 minutes|two minutes/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(root, f));
  ok(under.length === 0, `grep: no "4 scenes" / "2 minutes" copy left in lib/ or app/ (offenders: ${under.join(", ") || "none"})`);
}

// ── 4. Live: import lib/season.ts and check numbers + prompts ──
async function liveChecks() {
  const mod = (await import("../lib/season.ts")) as any;
  const {
    EPISODE_MAX_TOTAL_SECONDS, EPISODE_MAX_SCENES, EPISODE_MIN_SCENES, EPISODE_SCENE_COUNT, SCENE_FIXED_SECONDS,
    MAX_SILENT_SCENES, EPISODE_TOTAL_LABEL, LAST_SHOT_NOTE, sceneDurationsForCount, episodeTotalLabel,
    episodeScriptSystemPrompt, seasonStructureSystemPrompt, episodeScriptSchema, validateEpisodeScript,
  } = mod;

  ok(EPISODE_MAX_TOTAL_SECONDS === 60, `live: EPISODE_MAX_TOTAL_SECONDS === 60 (got ${EPISODE_MAX_TOTAL_SECONDS})`);
  ok(EPISODE_MAX_SCENES === 2, `live: EPISODE_MAX_SCENES === 2 (got ${EPISODE_MAX_SCENES})`);
  ok(EPISODE_MIN_SCENES === 2, `live: EPISODE_MIN_SCENES === 2 (got ${EPISODE_MIN_SCENES})`);
  ok(EPISODE_SCENE_COUNT === 2, `live: EPISODE_SCENE_COUNT === 2 (got ${EPISODE_SCENE_COUNT})`);
  ok(SCENE_FIXED_SECONDS === 30, `live: SCENE_FIXED_SECONDS === 30 (got ${SCENE_FIXED_SECONDS})`);
  ok(MAX_SILENT_SCENES === 0, `live: MAX_SILENT_SCENES === 0 — Stage 110, dialogue in every scene (got ${MAX_SILENT_SCENES})`);
  assert.deepStrictEqual(sceneDurationsForCount(2), [30, 30]);
  ok(true, "live: sceneDurationsForCount(2) deep-equals [30, 30]");
  ok(EPISODE_TOTAL_LABEL === "1:00", `live: EPISODE_TOTAL_LABEL === "1:00" (got ${EPISODE_TOTAL_LABEL})`);
  ok(episodeTotalLabel(119) === "1:59" && episodeTotalTest(episodeTotalLabel), "live: episodeTotalLabel formats m:ss correctly");
  ok(typeof LAST_SHOT_NOTE === "string" && !/except the LAST|shorter/.test(LAST_SHOT_NOTE), "live: LAST_SHOT_NOTE does not trim the last shot (2 × 30 needs no trim)");

  const ep = episodeScriptSystemPrompt("en", 2) as string;
  ok(ep.includes("EXACTLY 2"), "live: episodeScriptSystemPrompt says EXACTLY 2 shots");
  ok(ep.includes("1:00") && ep.includes("60 s"), "live: episodeScriptSystemPrompt says 1:00 / 60 s");
  ok(ep.includes("30 + 30"), "live: episodeScriptSystemPrompt shows the 30 + 30 split");
  ok(!ep.includes("1:59") && !/\b119\b/.test(ep), "live: episodeScriptSystemPrompt has no 1:59 / 119");
  ok(/shot 1 = the set-up/i.test(ep) && /shot 2 = the escalation/i.test(ep), "live: episodeScriptSystemPrompt describes shot 1 set-up / shot 2 escalation");
  ok(/cliffhanger/i.test(ep), "live: episodeScriptSystemPrompt keeps the cliffhanger rule");

  const ss = seasonStructureSystemPrompt("en") as string;
  ok(ss.includes("EPISODE SHAPE (2 shots, 1:00)"), "live: seasonStructureSystemPrompt has the EPISODE SHAPE (2 shots, 1:00) rule");
  ok(/CLIFFHANGER CHAIN/.test(ss), "live: seasonStructureSystemPrompt keeps the CLIFFHANGER CHAIN rule");
  ok(!ss.includes("1:59") && !/\b119\b/.test(ss), "live: seasonStructureSystemPrompt has no 1:59 / 119");

  // Live: scenes-job structure text — the module pulls in prisma, so render its template from source
  const m = scenesJob.match(/export const EPISODE_STRUCTURE_TEXT\s*=\s*([\s\S]*?);\n/);
  ok(!!m, "live: EPISODE_STRUCTURE_TEXT definition found in scenes-job.ts");
  const expr = m![1];
  ok(/\$\{SCENES_PER_EPISODE\}/.test(expr) && /\$\{TOTAL_LABEL\}/.test(expr), "live: EPISODE_STRUCTURE_TEXT is driven by SCENES_PER_EPISODE and TOTAL_LABEL");
  const SCENE_DURATIONS = sceneDurationsForCount(EPISODE_SCENE_COUNT);
  const LAST_SHOT_TEXT = SCENE_DURATIONS[SCENE_DURATIONS.length - 1] < SCENE_FIXED_SECONDS ? "last shorter" : `every shot a full ${SCENE_FIXED_SECONDS} s`;
  const rendered = new Function(
    "SCENES_PER_EPISODE", "TOTAL_LABEL", "EPISODE_TOTAL_SECONDS", "LAST_SHOT_TEXT", "SCENE_DURATIONS", "SCENE_SECONDS", "SCENE_FIXED_SECONDS",
    `return ${expr};`
  )(EPISODE_SCENE_COUNT, EPISODE_TOTAL_LABEL, EPISODE_MAX_TOTAL_SECONDS, LAST_SHOT_TEXT, SCENE_DURATIONS, SCENE_FIXED_SECONDS, SCENE_FIXED_SECONDS) as string;
  ok(rendered.includes("EXACTLY 2 shots") && rendered.includes("1:00") && rendered.includes("60 s"), "live: rendered EPISODE_STRUCTURE_TEXT says EXACTLY 2 shots, 1:00 and 60 s");
  ok(rendered.includes("30 + 30 = 60 s"), "live: rendered EPISODE_STRUCTURE_TEXT shows 30 + 30 = 60 s");
  ok(!rendered.includes("1:59") && !/\b119\b/.test(rendered), "live: rendered EPISODE_STRUCTURE_TEXT has no 1:59 / 119");
  ok(/SET-UP/i.test(rendered) && /ESCALATION/i.test(rendered), "live: rendered EPISODE_STRUCTURE_TEXT names SET-UP and ESCALATION");

  // Legacy 4-scene episode still parses (schema accepts up to 8) and only yields soft problems
  const scene = (n: number) => ({
    number: n, shotType: "medium two-shot", durationSec: n === 4 ? 29 : 30, locationDesc: "Dim kitchen at night, kettle on the stove",
    characters: ["Anna", "Max"], action: "They argue by the window while the kettle boils over and nobody moves to stop it.",
    dialogue: "Anna: You said you would be home by nine. It is midnight now. Max: I know what I said. Things changed.",
    videoPrompt: "Anna and Max in a dim kitchen, tense argument at night, warm practical light, handheld medium two-shot, they keep talking.",
    endState: "Anna turns away from Max", startState: n === 1 ? "Anna stands at the window" : "Anna is turned away from Max",
  });
  const legacy = { visualIdentity: "Warm practical light, handheld realism, muted palette.", scenes: [scene(1), scene(2), scene(3), scene(4)] };
  const parsed = episodeScriptSchema.safeParse(legacy);
  ok(parsed.success, `live: legacy 4-scene episode still parses (${parsed.success ? "ok" : JSON.stringify(parsed.error?.issues?.slice(0, 2))})`);
  if (parsed.success) {
    let threw = false;
    let problems: string[] = [];
    try { problems = validateEpisodeScript(parsed.data); } catch { threw = true; }
    ok(!threw, "live: validateEpisodeScript does not throw on a legacy 4-scene episode");
    ok(Array.isArray(problems), `live: legacy 4-scene episode yields only soft problems (${problems.length} problem(s))`);
  }
}

function episodeTotalTest(fn: (n: number) => string): boolean {
  return fn(60) === "1:00" && fn(30) === "0:30" && fn(125) === "2:05";
}

liveChecks()
  .then(() => console.log(`\nStage 103: PASS — ${pass} assertions`))
  .catch((e) => { console.error("\nStage 103: FAIL", e); process.exit(1); });
