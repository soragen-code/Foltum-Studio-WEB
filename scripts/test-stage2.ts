/** Stage 2 unit checks: season/episode schemas, timing validation, cost plan. Run: npx tsx scripts/test-stage2.ts */
import { episodeScriptSchema, validateEpisodeScript, normalizeEpisodeScript, spokenWordCount, dialogueSentenceCount, sceneClipPlan, seasonStructureSchema, matchCharacter, estimateDurationSec, PACE_DIRECTION, episodeScriptSystemPrompt, EPISODE_MIN_SCENES, SCENE_MIN_SECONDS, SCENE_MAX_SECONDS } from "../lib/season";
import { trailerSystemPrompt } from "../lib/trailer";
const assert = (c: unknown, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };
const prompt = "[SHOT TYPE]: Medium close-up\n[VISUAL STYLE]: x\n[LIGHTING]: y\n[BLOCKING]: z\n[GAZE]: a\n[NON-VERBAL]: b\n[ACTION]: c\n[CHARACTER]: d\n[TRANSITION]: e";
const talk = 'АННА (тихо): "Ты знал об этом с самого начала и молчал всё это время? Каждый вечер ты смотрел мне в глаза и ничего не говорил."\nМАРК (резко): "Я молчал, потому что иначе ты бы ушла ещё тогда, той зимой. Ты бы собрала вещи и уехала в город, а маяк остался бы пустым."\nАННА: "Может, так было бы честнее. Но теперь мы оба заперты здесь с этой ложью."';
const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ number: i + 1, shotType: "Medium shot", durationSec: 30, locationDesc: "INT — Маяк — ночь", characters: ["Анна"], action: "Анна входит.", dialogue: i % 6 === 0 ? "[NO DIALOGUE]" : talk, videoPrompt: prompt }));
assert(spokenWordCount(talk) > 40, `spoken words = ${spokenWordCount(talk)} (no upper limit anymore)`);
assert(dialogueSentenceCount(talk) >= 5 && dialogueSentenceCount(talk) <= 7, `dialogue sentences = ${dialogueSentenceCount(talk)}`);
assert(dialogueSentenceCount("[NO DIALOGUE]") === 0, "silent scene has 0 sentences");
const ok = normalizeEpisodeScript(episodeScriptSchema.parse({ visualIdentity: "photoreal cinematic", scenes: mk(12) }));
assert(validateEpisodeScript(ok).length === 0, "12-scene episode valid");
// Stage 4: the script (not the author) decides the length — 6–15 scenes, durationSec derived from dialogue.
assert(episodeScriptSchema.safeParse({ visualIdentity: "photoreal cinematic", scenes: mk(EPISODE_MIN_SCENES) }).success, `${EPISODE_MIN_SCENES} scenes accepted`);
assert(!episodeScriptSchema.safeParse({ visualIdentity: "photoreal cinematic", scenes: mk(5) }).success, "5 scenes rejected");
assert(estimateDurationSec("[NO DIALOGUE]") === SCENE_MIN_SECONDS, "silent scene → 15s");
assert(estimateDurationSec(talk) >= 20 && estimateDurationSec(talk) <= SCENE_MAX_SECONDS, `talk (${spokenWordCount(talk)} words) → ${estimateDurationSec(talk)}s`);
assert(estimateDurationSec('АННА: "Да."') === SCENE_MIN_SECONDS, "one word → clamped to 15s");
assert(ok.scenes.every((s) => s.durationSec === estimateDurationSec(s.dialogue, s.action)), "normalize sets durationSec from dialogue, ignores the LLM's 30");
const slow = validateEpisodeScript({ ...ok, scenes: ok.scenes.map((s, i) => (i === 1 ? { ...s, durationSec: 30, dialogue: 'АННА: "Ты знал. Ты знал и молчал. Всё это время. Каждый вечер. Смотрел и молчал."' } : i === 2 ? { ...s, videoPrompt: s.videoPrompt.replace("Medium close-up", "slow motion push-in, lingering") } : s)) });
assert(slow.some((p) => /words for 30s/.test(p)) && slow.some((p) => /slow\/lingering/.test(p)), `pace validation: ${slow.join(" | ")}`);
const withLocal = normalizeEpisodeScript(episodeScriptSchema.parse({ visualIdentity: "photoreal cinematic", scenes: mk(6).map((s) => ({ ...s, dialogue: 'ANNA (softly): "You knew from the very start and stayed silent all this time? Every night you looked me in the eye and said nothing at all."\nMARK (sharply): "I stayed silent because otherwise you would have left back then, that winter. You would have packed and gone to the city, and the lighthouse would be empty."\nANNA: "Maybe that would have been more honest. But now we are both locked in here with this lie."', dialogueLocal: talk })) }));
assert(withLocal.scenes[0].dialogueLocal === talk, "dialogueLocal preserved by normalize");
assert(/ALWAYS in ENGLISH/.test(episodeScriptSystemPrompt("ru")) && /dialogueLocal/.test(episodeScriptSystemPrompt("ru")) && !/dialogueLocal/.test(episodeScriptSystemPrompt("en")), "episode prompt: EN speech + local subtitles only for non-EN");
assert(/Nobody sets a running time/.test(episodeScriptSystemPrompt("ru")) && /Western names/.test(episodeScriptSystemPrompt("ru")), "episode prompt: no running time asked, Western names");
assert(/NO pauses/.test(PACE_DIRECTION) && /2–4 cuts/.test(PACE_DIRECTION) && episodeScriptSystemPrompt("ru").includes(PACE_DIRECTION), "pace/camera/expression direction in prompt");
assert(/ALWAYS in ENGLISH/.test(trailerSystemPrompt("ru")) && trailerSystemPrompt("ru").includes(PACE_DIRECTION) && /CUT LIST/.test(trailerSystemPrompt("ru")), "trailer prompt: EN speech, pace, cut list");
assert(!episodeScriptSchema.safeParse({ visualIdentity: "photoreal cinematic", scenes: mk(16) }).success, "16 scenes rejected");
const bad = { ...ok, scenes: ok.scenes.map((s) => ({ ...s, dialogue: "[NO DIALOGUE]" })) };
assert(validateEpisodeScript(bad).some((p) => /silent|no dialogue/.test(p)), "all-silent episode flagged");
const ep = { number: 1, title: "t", logline: "Логлайн эпизода достаточно длинный.", locationName: "Маяк", locationDesc: "A weathered white lighthouse on a granite cliff, rusted railings, fog.", characters: ["Анна"], arcRole: "завязка", cliffhanger: "Свет гаснет." };
assert(!seasonStructureSchema.safeParse({ title: "S", logline: "Сезонный логлайн.", episodes: Array(2).fill(ep) }).success, "2 episodes rejected (min 3 — story decides the count)");
assert(seasonStructureSchema.safeParse({ title: "S", logline: "Сезонный логлайн.", episodes: Array(8).fill(ep) }).success, "8 episodes accepted");
const plan = sceneClipPlan("HIGH", 12);
assert(plan.duration === 30 && plan.costPerScene === 24 && plan.total === 288, `HIGH plan ${JSON.stringify({ ...plan, clips: undefined })}`);
assert(sceneClipPlan("LOW", 12).costPerScene === 6 && sceneClipPlan("MEDIUM", 12).costPerScene === 18, "LOW/MEDIUM cost at 30s");
const mixed = sceneClipPlan("LOW", [{ durationSec: 15 }, { durationSec: 30 }, { durationSec: null }]);
assert(mixed.total === 3 + 6 + 6 && mixed.totalSeconds === 75 && mixed.duration === 30, `mixed plan ${JSON.stringify({ ...mixed, clips: undefined })}`);
const shortTalk = validateEpisodeScript({ ...ok, scenes: ok.scenes.map((s) => ({ ...s, dialogue: 'АННА: "Да."' })) });
assert(shortTalk.some((p) => /dialogue sentences/.test(p)), "too-short dialogue flagged (soft)");
console.log("ALL STAGE2 UNIT CHECKS PASSED");
// --- revise schemas + queue concurrency ---
import { sceneReviseSchema, locationReviseSchema, renderScriptFromScenes } from "../lib/season";
import { GENERATE_ALL_CONCURRENCY } from "../app/api/ai/episodes/[id]/generate-all/route";
assert(sceneReviseSchema.safeParse({ shotType: "Close-up", durationSec: 30, locationDesc: "INT — Маяк — ночь", action: "Анна молчит.", dialogue: talk, videoPrompt: prompt }).success, "scene revise schema ok");
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
