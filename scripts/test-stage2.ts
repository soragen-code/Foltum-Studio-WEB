/** Stage 2 unit checks: season/episode schemas, timing validation, cost plan. Run: npx tsx scripts/test-stage2.ts */
import { episodeScriptSchema, validateEpisodeScript, normalizeEpisodeScript, spokenWordCount, sceneClipPlan, seasonStructureSchema , matchCharacter } from "../lib/season";
const assert = (c: unknown, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };
const prompt = "[SHOT TYPE]: Medium close-up\n[VISUAL STYLE]: x\n[LIGHTING]: y\n[BLOCKING]: z\n[GAZE]: a\n[NON-VERBAL]: b\n[ACTION]: c\n[CHARACTER]: d\n[TRANSITION]: e";
const talk = 'АННА (тихо): "Ты знал об этом с самого начала и молчал всё это время?"\nМАРК (резко): "Я молчал, потому что иначе ты бы ушла ещё тогда, той зимой."';
const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ number: i + 1, shotType: "Medium shot", durationSec: 15, locationDesc: "INT — Маяк — ночь", characters: ["Анна"], action: "Анна входит.", dialogue: i % 5 === 0 ? "[NO DIALOGUE]" : talk, videoPrompt: prompt }));
assert(spokenWordCount(talk) >= 18 && spokenWordCount(talk) <= 40, `spoken words = ${spokenWordCount(talk)}`);
const ok = normalizeEpisodeScript(episodeScriptSchema.parse({ visualIdentity: "photoreal cinematic", scenes: mk(12) }));
assert(validateEpisodeScript(ok).length === 0, "12-scene episode valid");
assert(!episodeScriptSchema.safeParse({ visualIdentity: "photoreal cinematic", scenes: mk(9) }).success, "9 scenes rejected");
assert(!episodeScriptSchema.safeParse({ visualIdentity: "photoreal cinematic", scenes: mk(16) }).success, "16 scenes rejected");
const bad = { ...ok, scenes: ok.scenes.map((s) => ({ ...s, dialogue: "[NO DIALOGUE]" })) };
assert(validateEpisodeScript(bad).some((p) => /silent|no dialogue/.test(p)), "all-silent episode flagged");
const ep = { number: 1, title: "t", logline: "Логлайн эпизода достаточно длинный.", locationName: "Маяк", locationDesc: "A weathered white lighthouse on a granite cliff, rusted railings, fog.", characters: ["Анна"], arcRole: "завязка", cliffhanger: "Свет гаснет." };
assert(!seasonStructureSchema.safeParse({ title: "S", logline: "Сезонный логлайн.", episodes: Array(5).fill(ep) }).success, "5 episodes rejected");
assert(seasonStructureSchema.safeParse({ title: "S", logline: "Сезонный логлайн.", episodes: Array(8).fill(ep) }).success, "8 episodes accepted");
const plan = sceneClipPlan("HIGH", 12);
assert(plan.duration === 15 && plan.costPerScene === 12 && plan.total === 144, `HIGH plan ${JSON.stringify(plan)}`);
assert(sceneClipPlan("LOW", 12).costPerScene === 3 && sceneClipPlan("MEDIUM", 12).costPerScene === 9, "LOW/MEDIUM cost");
console.log("ALL STAGE2 UNIT CHECKS PASSED");
// --- revise schemas + queue concurrency ---
import { sceneReviseSchema, locationReviseSchema, renderScriptFromScenes } from "../lib/season";
import { GENERATE_ALL_CONCURRENCY } from "../app/api/ai/episodes/[id]/generate-all/route";
assert(sceneReviseSchema.safeParse({ shotType: "Close-up", durationSec: 15, locationDesc: "INT — Маяк — ночь", action: "Анна молчит.", dialogue: talk, videoPrompt: prompt }).success, "scene revise schema ok");
assert(!sceneReviseSchema.safeParse({ shotType: "Close-up", durationSec: 40, locationDesc: "x", action: "y", dialogue: talk, videoPrompt: prompt }).success, "scene revise rejects 40s");
assert(locationReviseSchema.safeParse({ locationName: "Порт", locationDesc: "A foggy fishing port with rusted trawlers and sodium lamps.", scenes: [{ number: 1, locationDesc: "EXT — Порт — ночь", videoPrompt: prompt }] }).success, "location revise schema ok");
assert(renderScriptFromScenes({ number: 1, title: "T", logline: "L", locationName: "Маяк", cliffhanger: "C" }, ["Анна"], ok.scenes).includes("СЦЕНА 12"), "script text renders 12 scenes");
assert(GENERATE_ALL_CONCURRENCY >= 2 && GENERATE_ALL_CONCURRENCY <= 3, `queue concurrency ${GENERATE_ALL_CONCURRENCY}`);
console.log("ALL STAGE2 EXTENDED CHECKS PASSED");

// matchCharacter: LLM short names resolve to full project names
{
  const chars = [{ name: "Валерия Соколова" }, { name: "Ольга Смирнова" }, { name: "Александр Князев" }];
  if (matchCharacter(chars, "Валерия")?.name !== "Валерия Соколова") throw new Error("matchCharacter first name");
  if (matchCharacter(chars, "ВАЛЕРИЯ СОКОЛОВА")?.name !== "Валерия Соколова") throw new Error("matchCharacter case");
  if (matchCharacter(chars, "Смирнова")?.name !== "Ольга Смирнова") throw new Error("matchCharacter surname");
  if (matchCharacter(chars, "Незнакомец")) throw new Error("matchCharacter unknown should be undefined");
  console.log("ok: matchCharacter");
}
