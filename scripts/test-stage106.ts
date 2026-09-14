/**
 * Stage 106 checks (pure — no network / DB / render):
 *  Season.fullStory = deterministic episode-by-episode 60-second footage built from the structure
 *  (buildFullStoryFromStructure); no LLM step for the plot; revise rebuilds the plot; UI renders footage rows.
 *
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage106.ts
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };
const root = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

const E1 = [
  "SHOT 1 (30 s): Ночь, блиндаж. Сержант Орлов считает последние три ракеты, рация хрипит голосом, которому он не отвечает.",
  "SHOT 2 (30 s): Голос называет имя его погибшего брата. Орлов хватает трубку и требует доказательств.",
  "CLIFFHANGER (last frame): Рука Орлова замирает на трубке — в тёмном углу блиндажа открываются светящиеся глаза.",
].join("\n");
const E2 = [
  "SHOT 1 (30 s): OPENS ON: Рука Орлова замирает на трубке — в тёмном углу блиндажа открываются светящиеся глаза. Он поднимает ракетницу: это голодный пёс с жетоном брата.",
  "SHOT 2 (30 s): Голос смеётся: пёс нашёл дорогу домой. Орлов читает координаты, выцарапанные на жетоне.",
  "CLIFFHANGER (last frame): Координаты совпадают с блиндажом — над люком замирают шаги.",
].join("\n");
// one-line variant of episode 3 (labels inline)
const E3_ONE_LINE = "SHOT 1 (30 s): OPENS ON: Координаты совпадают с блиндажом — над люком замирают шаги. Орлов гасит фонарь и целится в люк. SHOT 2 (30 s): Люк открывается: это его брат, живой, с рацией в руке. CLIFFHANGER (last frame): Брат улыбается и говорит голосом из рации.";

async function main() {
  const season = await import("../lib/season");
  const { buildFullStoryFromStructure, countFullStoryEpisodes, parseEpisodeFootage, validateEpisodeDescriptions, FULL_STORY_START_MARK, FULL_STORY_END_MARK, footageToLines, seasonStoryReviseSchema, seasonStoryReviseSystemPrompt } = season;

  const structure = {
    title: "Последний свет",
    logline: "Когда эксперимент на старой электростанции поглощает дневной свет, клерк Clara Johnson пытается остановить установку.",
    episodes: [
      { number: 1, title: "Последняя подпись", description: E1 },
      { number: 2, title: "Жетон", description: E2 },
      { number: 3, title: "Люк", description: E3_ONE_LINE },
    ],
  };
  const text = buildFullStoryFromStructure(structure, "ru", "Старая электростанция продолжает жить по сменным журналам. Вторая фраза синопсиса.");
  ok(countFullStoryEpisodes(text) === 3, "countFullStoryEpisodes(result) === 3");
  ok(text.includes(`${FULL_STORY_START_MARK} ЭПИЗОД 1: Последняя подпись ${FULL_STORY_START_MARK}`), "header line for episode 1 (Russian word)");
  ok(text.includes(`${FULL_STORY_END_MARK} КОНЕЦ ЭПИЗОДА 3 ${FULL_STORY_END_MARK}`), "closing line for episode 3");
  ok(text.startsWith(structure.logline), "overview starts with the season logline");
  ok(text.includes("Старая электростанция продолжает жить по сменным журналам.") && !text.includes("Вторая фраза"), "overview adds only the FIRST sentence of the synopsis");

  // split into blocks and check each body parses / validates
  const lines = text.split("\n");
  const blocks: { header: string; body: string[] }[] = [];
  let overview: string[] = [];
  for (const l of lines) {
    if (l.startsWith(FULL_STORY_START_MARK)) { blocks.push({ header: l, body: [] }); continue; }
    if (l.startsWith(FULL_STORY_END_MARK)) continue;
    if (!blocks.length) { if (l.trim()) overview.push(l); continue; }
    if (l.trim()) blocks[blocks.length - 1].body.push(l);
  }
  ok(blocks.length === 3 && overview.length === 1, "one overview paragraph + 3 episode blocks");
  const parsedEps = blocks.map((b, i) => ({ number: i + 1, description: b.body.join("\n") }));
  ok(parsedEps.every((e) => parseEpisodeFootage(e.description) !== null), "each block body parses with parseEpisodeFootage");
  ok(blocks.every((b) => b.body.length === 3), "each block body is exactly 3 lines");
  ok(blocks[2].body[0].startsWith("SHOT 1 (30 s):") && blocks[2].body[1].startsWith("SHOT 2 (30 s):") && blocks[2].body[2].startsWith("CLIFFHANGER (last frame):"), "one-line description is split into 3 labelled lines");
  const problems = validateEpisodeDescriptions(parsedEps);
  ok(problems.length === 0, `validateEpisodeDescriptions on reconstructed blocks → [] (${problems.join("; ")})`);
  ok(lines.every((l) => l.length <= 400), "no line longer than 400 chars");
  const labelRe = /^(SHOT 1 \(30 s\):|SHOT 2 \(30 s\):|CLIFFHANGER \(last frame\):)/;
  ok(blocks.every((b) => b.body.every((l) => labelRe.test(l))), "no unlabelled paragraph besides the overview");
  ok(!/\n\n\n/.test(text) && /═══\n\n═══|───\n\n═══/.test(text), "blank line between blocks");

  // footageToLines fallback
  ok(footageToLines("plain legacy prose") === "plain legacy prose", "footageToLines: unparseable → as-is");
  const legacy = buildFullStoryFromStructure({ logline: "L", episodes: [{ number: 1, title: "T", description: "plain legacy prose" }] }, "en");
  ok(legacy.includes("═══ EPISODE 1: T ═══\nplain legacy prose\n─── END OF EPISODE 1 ───"), "legacy description output as-is inside its block (English words)");

  // schema + prompt
  const sp = seasonStoryReviseSchema.shape.fullStory.safeParse("");
  ok(sp.success, "seasonStoryReviseSchema accepts empty fullStory");
  ok(seasonStoryReviseSchema.shape.fullStory.safeParse(undefined).success, "seasonStoryReviseSchema accepts missing fullStory");
  const prompt = seasonStoryReviseSystemPrompt("ru", 3);
  ok(!/3–6 paragraphs of vivid, concrete PROSE/.test(prompt), "revise prompt: prose format rules removed");
  ok(/SEASON PLOT = EPISODES/.test(prompt) && /SHOT 1 \(30 s\):/.test(prompt) && /empty string/.test(prompt), "revise prompt: plot = episode descriptions (footage rule), fullStory may be empty");

  // fs / grep assertions
  const job = read("lib/workers/season-script-job.ts");
  ok(!job.includes("seasonFullStorySystemPrompt") && !job.includes("seasonFullStoryUserPrompt"), "season-script-job: no LLM prompt for the fullStory step");
  ok(job.includes("buildFullStoryFromStructure"), "season-script-job references buildFullStoryFromStructure");
  ok(read("lib/workers/story-revise-job.ts").includes("buildFullStoryFromStructure"), "story-revise-job references buildFullStoryFromStructure");
  ok(read("app/api/ai/season/revise/route.ts").includes("buildFullStoryFromStructure"), "structure-screen revise route rebuilds fullStory");
  const ui = read("app/project/[id]/_components/story-stage.tsx");
  ok(ui.includes("The season, episode by episode: each episode is 60 seconds of footage — two 30-second shots and the final frame. Edit in the panel below; rewriting clears the generated scenes and videos of the affected episodes."), "Season plot subtitle updated");
  ok(ui.includes("EpisodeFootage") && ui.includes("parseEpisodeFootage"), "Season plot view renders footage blocks via EpisodeFootage");

  console.log(`\nStage 106: ${pass} checks passed`);
}
main().catch((e) => { console.error("FAIL:", e?.message ?? e); process.exit(1); });
