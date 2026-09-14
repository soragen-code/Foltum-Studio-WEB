/**
 * Stage 107 — episode scripts on demand from the episode page; the season job = structure + plot only;
 * footage = action only (no dialogue, one action per shot, 20/14/50 caps).
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage107.ts
 */
import fs from "fs";
import path from "path";

let passed = 0;
function ok(cond: unknown, label: string) {
  if (!cond) { console.error("FAIL:", label); process.exit(1); }
  passed++;
  console.log("ok:", label);
}
const root = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

async function main() {
  // ── A1: planner never writes scripts on its own ──
  const { planNextStep } = await import("../lib/workers/season-script-job");
  const eps = (scripts: (string | null)[]) => scripts.map((s, i) => ({ id: `ep${i + 1}`, number: i + 1, script: s }));
  ok(planNextStep({ fullStory: "plot", episodes: eps([null, null, null]) }, {}).step === "done", "planner: plot ready + no scripts + no queue → done");
  ok(planNextStep({ fullStory: null, episodes: eps([null, null]) }, {}).step === "fullStory", "planner: no plot → fullStory");
  ok(planNextStep(null, {}).step === "structure", "planner: no season → structure");
  const q = planNextStep({ fullStory: "plot", episodes: eps([null, null]) }, { revise: { episodeIds: ["ep2"], instruction: "" } });
  ok(q.step === "episode" && q.episodeId === "ep2" && q.instruction === undefined, "planner: queue [ep2] + empty instruction → episode step, first-write prompt");
  const q2 = planNextStep({ fullStory: "plot", episodes: eps(["s", "s"]) }, { revise: { episodeIds: ["ep1"], instruction: "darker" } });
  ok(q2.step === "episode" && q2.episodeId === "ep1" && q2.instruction === "darker", "planner: queue with instruction → rewrite step");

  // ── A3: route ──
  const routePath = "app/api/ai/episodes/[id]/script/route.ts";
  ok(fs.existsSync(path.join(root, routePath)), "route file exists");
  const route = read(routePath);
  ok(route.includes("initialSeasonState"), "route uses initialSeasonState");
  ok(route.includes("A script job is already running"), "route: 409 text present");
  ok(route.includes("409"), "route: 409 status");

  // ── A4/A5: episode view ──
  const view = read("app/project/[id]/episode/[episodeId]/episode-view.tsx");
  for (const s of ["Generate script", "Regenerate script", "generate-script", "regenerate-script", "hasScript", "/script"]) {
    ok(view.includes(s), `episode-view contains "${s}"`);
  }
  const nav = read("app/project/[id]/episode/[episodeId]/episode-nav-grid.tsx");
  ok(nav.includes("no script") && nav.includes("hasScript"), "episode-nav-grid: 'no script' status via hasScript");
  const page = read("app/project/[id]/episode/[episodeId]/page.tsx");
  ok(page.includes("hasScript"), "episode page passes hasScript to siblings");

  // ── A2: story stage ──
  const story = read("app/project/[id]/_components/story-stage.tsx");
  ok(!story.includes("scripts {scriptsDone}"), "story-stage: scripts counter removed");
  ok(!story.includes("episodes left"), "story-stage: 'Continue generation (N episodes left)' removed");
  ok(story.includes("Season plot is ready. Open an episode to write its script."), "story-stage: plot-ready text");
  ok(!story.includes("find((e) => !!e.script)"), "story-stage: first episode no longer requires a script");

  // ── B: footage validation ──
  const season = await import("../lib/season");
  const { validateEpisodeDescriptions, EPISODE_FOOTAGE_EXAMPLE, EPISODE_FOOTAGE_RULE, EPISODE_FOOTAGE_RETRY_NOTE, hasQuotedDialogue, countSentences } = season;
  ok(season.FOOTAGE_SHOT_MAX_WORDS === 20 && season.FOOTAGE_CLIFFHANGER_MAX_WORDS === 14 && season.EPISODE_FOOTAGE_MAX_WORDS === 50, "caps 20/14/50");

  const base = (s1: string, s2: string, c: string) => `SHOT 1 (30 s): ${s1}\nSHOT 2 (30 s): ${s2}\nCLIFFHANGER (last frame): ${c}`;
  const good = base(
    "Alex's team climbs down into the dugout and huddles around a hissing radio.",
    "A voice on the radio promises shelter; the man turns the volume up and everyone leans toward the speaker.",
    "Over the dugout's rim, five pairs of glowing eyes open in the dark."
  );
  ok(validateEpisodeDescriptions([{ number: 1, description: good }]).length === 0, "validate: action-only example passes");

  const quoted = base("Alex's team climbs down into the dugout.", 'The radio crackles: "Come to the shelter, we have heat."', "Glowing eyes open in the dark.");
  const pq = validateEpisodeDescriptions([{ number: 1, description: quoted }]);
  ok(pq.some((p) => /SHOT 2 contains quoted dialogue/.test(p)), "validate: quoted dialogue (straight quotes) fails with a SHOT 2 message");
  const quotedRu = base("Орлов спускается в блиндаж.", "Голос из рации: «Не выключайте маяк». Орлов замирает.", "Глаза открываются в темноте.");
  ok(validateEpisodeDescriptions([{ number: 1, description: quotedRu }]).some((p) => /quoted dialogue/.test(p)), "validate: « » dialogue fails");
  ok(!hasQuotedDialogue("Alex's team climbs down; his brother's tag glints."), "apostrophes are not quotes");
  ok(hasQuotedDialogue("She says “we go now” and runs."), "curly quotes enclosing two words are dialogue");
  ok(!hasQuotedDialogue('the "group" waits'), "a single quoted word is not dialogue");

  const threeSentences = base("Alex climbs down. He kneels by the radio. He turns the dial.", "Everyone leans toward the speaker.", "Glowing eyes open in the dark.");
  const p3 = validateEpisodeDescriptions([{ number: 1, description: threeSentences }]);
  ok(p3.some((p) => /SHOT 1 has 3 sentences/.test(p)), "validate: 3-sentence SHOT fails");
  const twoSentences = base("Alex climbs down. He kneels by the radio.", "Everyone leans toward the speaker.", "Glowing eyes open in the dark.");
  ok(validateEpisodeDescriptions([{ number: 1, description: twoSentences }]).length === 0, "validate: 2 short sentences in a SHOT pass");
  const cliff2 = base("Alex climbs down into the dugout.", "Everyone leans toward the speaker.", "Glowing eyes open in the dark. The lamp goes out.");
  ok(validateEpisodeDescriptions([{ number: 1, description: cliff2 }]).some((p) => /CLIFFHANGER has 2 sentences/.test(p)), "validate: 2-sentence CLIFFHANGER fails");
  ok(countSentences("Over the rim, eyes open in the dark.") === 1, "countSentences: one sentence");
  const opensOn = "SHOT 1 (30 s): OPENS ON: Glowing eyes open in the dark. The creatures pour over the rim onto the huddled group.\nSHOT 2 (30 s): Alex swings a shovel at the nearest creature.\nCLIFFHANGER (last frame): A clawed hand closes around a child's ankle.";
  ok(validateEpisodeDescriptions([{ number: 1, description: good }, { number: 2, description: opensOn }]).length === 0, "validate: OPENS ON repetition is not counted as a SHOT 1 sentence");
  const longShot = base(Array(21).fill("word").join(" "), "Everyone leans toward the speaker.", "Glowing eyes open in the dark.");
  ok(validateEpisodeDescriptions([{ number: 1, description: longShot }]).some((p) => /SHOT 1 has 21 own words \(max 20\)/.test(p)), "validate: 21-word SHOT fails (cap 20)");
  const longCliff = base("Alex climbs down.", "Everyone leans in.", Array(15).fill("word").join(" "));
  ok(validateEpisodeDescriptions([{ number: 1, description: longCliff }]).some((p) => /CLIFFHANGER has 15 words \(max 14\)/.test(p)), "validate: 15-word CLIFFHANGER fails (cap 14)");

  // ── B: prompt text ──
  ok(validateEpisodeDescriptions([
    { number: 1, description: EPISODE_FOOTAGE_EXAMPLE.split('Episode 1 "description":\n')[1].split('\nEpisode 2')[0] },
    { number: 2, description: EPISODE_FOOTAGE_EXAMPLE.split('Episode 2 "description":\n')[1] },
  ]).length === 0, "EPISODE_FOOTAGE_EXAMPLE passes its own validation");
  ok(/NO dialogue/.test(EPISODE_FOOTAGE_RULE) && /NO motivations/.test(EPISODE_FOOTAGE_RULE) && /one action per shot/.test(EPISODE_FOOTAGE_RULE), "rule: action only (no dialogue, no motivations, one action per shot)");
  ok(/HARD MAX 50 words/.test(EPISODE_FOOTAGE_RULE) && /≤ 20 words/.test(EPISODE_FOOTAGE_RULE) && /≤ 14 words/.test(EPISODE_FOOTAGE_RULE), "rule: caps 50/20/14 in prompt text");
  ok(/NO quotes or dialogue/.test(EPISODE_FOOTAGE_RETRY_NOTE) && /NO explanations/.test(EPISODE_FOOTAGE_RETRY_NOTE) && /ONE physical action per shot/.test(EPISODE_FOOTAGE_RETRY_NOTE), "retry note: no quotes, no explanations, one action per shot");

  // ── worker text ──
  const worker = read("lib/workers/season-script-job.ts");
  ok(worker.includes("Season plot ready"), "worker: done message = Season plot ready");
  ok(worker.includes("Writing the episode script..."), "worker: first-write progress label");

  console.log(`\nStage 107: ${passed} checks passed`);
}
main().catch((e) => { console.error("FAIL:", e?.message ?? e); process.exit(1); });
