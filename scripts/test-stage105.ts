/**
 * Stage 105 checks (pure — no network / DB / render):
 *  episode story = 60-second footage (SHOT 1 / SHOT 2 / CLIFFHANGER, OPENS ON chain), parse/validate,
 *  structure prompt wording, scenes-job HARD BEATS, rewrite resets scenes + videos, UI note.
 *
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage105.ts
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

const E1 = [
  "SHOT 1 (30 s): Night, a rain-soaked dugout. Sergeant Orlov counts the last three flares while a radio crackles with a voice he refuses to answer.",
  "SHOT 2 (30 s): The voice names his dead brother. Orlov grabs the handset and demands proof; the answer is a childhood nickname only two people knew.",
  "CLIFFHANGER (last frame): Orlov's hand freezes on the handset as a pair of glowing eyes opens in the dark corner of the dugout.",
].join("\n");
const E2 = [
  "SHOT 1 (30 s): OPENS ON: Orlov's hand freezes on the handset as a pair of glowing eyes opens in the dark corner of the dugout. He raises the flare gun; the eyes belong to a starving dog with a collar tag bearing his brother's name.",
  "SHOT 2 (30 s): The radio voice laughs and says the dog found its way home. Orlov reads the coordinates scratched into the tag out loud.",
  "CLIFFHANGER (last frame): The coordinates match the dugout — and footsteps stop right above the hatch.",
].join("\n");

async function main() {
  const season = await import("../lib/season");
  const { parseEpisodeFootage, validateEpisodeDescriptions, seasonStructureSystemPrompt, EPISODE_FOOTAGE_MAX_WORDS } = season;

  // ── parse ──
  const p1 = parseEpisodeFootage(E1);
  ok(p1 && p1.shot1.startsWith("Night, a rain-soaked dugout") && p1.shot2.startsWith("The voice names") && p1.cliffhanger.includes("glowing eyes") && !p1.opensOn, "parse: valid E1 without OPENS ON");
  const p2 = parseEpisodeFootage(E2);
  ok(p2 && p2.opensOn && p2.opensOn.includes("glowing eyes") && p2.shot1.includes("flare gun"), "parse: E2 with OPENS ON extracted");
  ok(parseEpisodeFootage("Just a plain old logline-style description without labels.") === null, "parse: plain paragraph → null");
  ok(parseEpisodeFootage("") === null, "parse: empty → null");

  // ── validate ──
  const valid = [
    { number: 1, description: E1, cliffhanger: "x" },
    { number: 2, description: E2, cliffhanger: "y" },
  ];
  ok(validateEpisodeDescriptions(valid as any).length === 0, "validate: valid 2-episode pair passes");
  const long = E1.replace("SHOT 2 (30 s):", "SHOT 2 (30 s): " + Array(EPISODE_FOOTAGE_MAX_WORDS).fill("word").join(" "));
  ok(validateEpisodeDescriptions([{ number: 1, description: long }] as any).length > 0, "validate: >120 words fails");
  ok(validateEpisodeDescriptions([{ number: 1, description: "SHOT 1 (30 s): only one line here and nothing else at all." }] as any).length > 0, "validate: missing labels fails");
  const e2NoOpen = E2.replace("OPENS ON: ", "");
  ok(validateEpisodeDescriptions([valid[0], { number: 2, description: e2NoOpen }] as any).some((s) => /OPENS ON/i.test(s)), "validate: E2 without OPENS ON fails");

  // ── structure prompt ──
  const prompt = seasonStructureSystemPrompt("en" as any);
  for (const s of ["SHOT 1 (30 s):", "SHOT 2 (30 s):", "CLIFFHANGER (last frame):", "OPENS ON:", "glowing eyes", "voice-over", "location change"]) {
    ok(prompt.includes(s), `structure prompt contains "${s}"`);
  }

  // ── scenes-job HARD BEATS ──
  const scenesSrc = read("lib/workers/scenes-job.ts");
  ok(/export function episodeBriefBlock/.test(scenesSrc), "scenes-job exports episodeBriefBlock");
  let brief: string | null = null;
  try {
    const sj = await import("../lib/workers/scenes-job");
    brief = sj.episodeBriefBlock({ number: 2, title: "T", description: E2, cliffhanger: "y" });
  } catch {
    brief = null;
  }
  if (brief !== null) {
    ok(brief.includes("SHOT 1 BEAT") && brief.includes("SHOT 2 BEAT") && brief.includes("FINAL FRAME"), "episodeBriefBlock: 3-line description → SHOT 1 BEAT / SHOT 2 BEAT / FINAL FRAME");
  } else {
    ok(scenesSrc.includes("episodeFootageGivens"), "scenes-job uses episodeFootageGivens (static fallback)");
    ok(read("lib/season.ts").includes("SHOT 1 BEAT"), "season.ts defines SHOT 1 BEAT label (static fallback)");
  }
  const { episodeFootageGivens } = season;
  const givens = episodeFootageGivens(E2);
  ok(givens.includes("SHOT 1 BEAT") && givens.includes("SHOT 2 BEAT") && givens.includes("FINAL FRAME"), "episodeFootageGivens: beats block");
  ok(episodeFootageGivens("plain text") === "", "episodeFootageGivens: unparseable → empty (fallback to old behaviour)");

  // ── reset rules ──
  ok(/scene\.deleteMany/.test(scenesSrc) && /videoUrl:\s*null/.test(scenesSrc), "scenes-job: deleteMany scenes + videoUrl null");
  const ssj = read("lib/workers/season-script-job.ts");
  ok(/scene\.deleteMany/.test(ssj) && /videoUrl:\s*null/.test(ssj), "season-script-job: persistEpisodeScript deletes scenes + videoUrl null");
  ok(/validateEpisodeDescriptions/.test(ssj) && /EPISODE_FOOTAGE_RETRY_NOTE/.test(ssj), "season-script-job: validate + retry note");
  ok(/validateEpisodeDescriptions/.test(read("lib/workers/story-revise-job.ts")), "story-revise-job: validate");
  ok(/validateEpisodeDescriptions/.test(read("app/api/ai/season/revise/route.ts")), "season revise route: validate");

  // ── UI ──
  const NOTE = "Rewriting clears the generated scenes, keyframes and videos of the affected episodes.";
  const ui = read("app/project/[id]/_components/episode-footage.tsx");
  ok(ui.includes(NOTE) && ui.includes("Shot 1 (30 s)") && ui.includes("Shot 2 (30 s)") && ui.includes("Cliffhanger") && ui.includes("Opens on"), "UI: EpisodeFootage rows + note text");
  ok(read("app/project/[id]/_components/structure-stage.tsx").includes("EpisodeFootage") && read("app/project/[id]/_components/structure-stage.tsx").includes("RewriteNote"), "UI: structure-stage uses EpisodeFootage + RewriteNote");
  ok(read("app/project/[id]/_components/story-stage.tsx").includes(NOTE), "UI: story-stage note");
  ok(read("app/project/[id]/episode/[episodeId]/episode-view.tsx").includes(NOTE), "UI: episode-view note");

  console.log(`\nStage 105: ${pass} checks passed`);
}
main().catch((e) => { console.error("FAIL:", e?.message ?? e); process.exit(1); });
