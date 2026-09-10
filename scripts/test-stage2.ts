/** Stage 2 unit checks: season/episode schemas, timing validation, cost plan. Run: npx tsx scripts/test-stage2.ts */
import { episodeScriptSchema, validateEpisodeScript, normalizeEpisodeScript, spokenWordCount, dialogueSentenceCount, sceneClipPlan, seasonStructureSchema, matchCharacter, estimateDurationSec, hardProblems, isEnglishDialogue, fixDialogueLanguages, nonEnglishScenes, ensureEnglishDialogue, PACE_DIRECTION, episodeScriptSystemPrompt, EPISODE_MIN_SCENES, SCENE_MIN_SECONDS, SCENE_MAX_SECONDS, SCALE_DEPTH_RULE, EVERYDAY_BEHAVIOR_RULE, LOCATION_PRESENCE_RULE } from "../lib/season";
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
assert(slow.some((p) => /soft: .*words for 30s/.test(p)) && slow.some((p) => /soft: .*slow\/lingering/.test(p)) && hardProblems(slow).length === 0, `pace validation is soft only: ${slow.join(" | ")}`);
// Regression (prod): a 24-word exchange → 15 s and NO error — the 15 s floor cannot go lower.
const short24 = 'ANNA (sharply): "You knew he was not coming back and still sent the boat out there?"\nVICTOR (quietly): "I sent it because otherwise we would have lost both of them tonight."';
const shortEp = normalizeEpisodeScript(episodeScriptSchema.parse({ visualIdentity: "photoreal cinematic", scenes: mk(6).map((s) => ({ ...s, dialogue: short24 })) }));
assert(spokenWordCount(short24) >= 20 && spokenWordCount(short24) <= 30 && shortEp.scenes[0].durationSec === SCENE_MIN_SECONDS, `24-ish words → ${shortEp.scenes[0].durationSec}s`);
assert(hardProblems(validateEpisodeScript(shortEp)).length === 0, `short scenes at 15s are not hard errors: ${validateEpisodeScript(shortEp).join(" | ") || "(none)"}`);
const withLocal = normalizeEpisodeScript(episodeScriptSchema.parse({ visualIdentity: "photoreal cinematic", scenes: mk(6).map((s) => ({ ...s, dialogue: 'ANNA (softly): "You knew from the very start and stayed silent all this time?"\nMARK (sharply): "I stayed silent because otherwise you would have left that winter."\nANNA: "Maybe that would have been more honest than this lie."', dialogueLocal: talk })) }));
assert(withLocal.scenes[0].dialogueLocal === talk, "dialogueLocal preserved by normalize");
assert(/ALWAYS in ENGLISH/.test(episodeScriptSystemPrompt("ru")) && /dialogueLocal/.test(episodeScriptSystemPrompt("ru")) && !/dialogueLocal/.test(episodeScriptSystemPrompt("en")), "episode prompt: EN speech + local subtitles only for non-EN");
assert(/Nobody sets a running time/.test(episodeScriptSystemPrompt("ru")) && /Western names/.test(episodeScriptSystemPrompt("ru")), "episode prompt: no running time asked, Western names");
assert(/natural conversational rhythm/.test(PACE_DIRECTION) && !/NO pauses/.test(PACE_DIRECTION) && /2–4 cuts/.test(PACE_DIRECTION) && episodeScriptSystemPrompt("ru").includes(PACE_DIRECTION), "pace/camera/expression direction in prompt (natural tempo, no speed-forcing)");
// stage7: масштаб/объём сцен + бытовые действия персонажей в промптах эпизода и трейлера
assert(/SCALE & DEPTH/.test(SCALE_DEPTH_RULE) && /SPACIOUS/.test(SCALE_DEPTH_RULE) && /WIDE or ESTABLISHING/.test(SCALE_DEPTH_RULE) && /foreground/.test(SCALE_DEPTH_RULE), "SCALE_DEPTH_RULE: spacious, wide/establishing, depth");
assert(/CHARACTERS ACT/.test(EVERYDAY_BEHAVIOR_RULE) && /talking heads/.test(EVERYDAY_BEHAVIOR_RULE) && /lip-sync-safe/.test(EVERYDAY_BEHAVIOR_RULE) && /moderation-safe/.test(EVERYDAY_BEHAVIOR_RULE), "EVERYDAY_BEHAVIOR_RULE: physical business, lip-sync & moderation safe");
assert(/ALIVE/.test(LOCATION_PRESENCE_RULE) && /background life/.test(LOCATION_PRESENCE_RULE), "LOCATION_PRESENCE_RULE: living background");
assert(episodeScriptSystemPrompt("ru").includes(SCALE_DEPTH_RULE) && episodeScriptSystemPrompt("ru").includes(EVERYDAY_BEHAVIOR_RULE) && episodeScriptSystemPrompt("ru").includes(LOCATION_PRESENCE_RULE), "episode prompt embeds scale/depth + everyday behavior + location presence");
// stage7b: диалоги на общих планах (без крупного лица во весь экран) + естественная расстановка, не «лицом к лицу»
assert(/never fills the screen/.test(PACE_DIRECTION) && /DO NOT push in to a full-screen face close-up/.test(PACE_DIRECTION), "PACE_DIRECTION: no full-screen face close-up");
assert(/never two people simply standing face to face/.test(PACE_DIRECTION) && /NATURALLY in the space/.test(PACE_DIRECTION), "PACE_DIRECTION: natural staging, no face-off");
assert(/NO full-screen face close-up/.test(episodeScriptSystemPrompt("ru")) && /squared off face to face/.test(episodeScriptSystemPrompt("ru")), "episode prompt: wide-shot dialogue + natural staging");
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
// --- Speech language guard: Seedance voices `dialogue`, so it must be English even when gpt-4o swaps the fields ---
const ru = 'МАРИНА (тихо): "Дедушка, ты всегда знал, что для меня значит этот дом."\nАНДРЕЙ (с вызовом): "Это бизнес, Марина."';
const en = 'МАРИНА (тихо): "Grandpa, you always knew what this house means to me."\nАНДРЕЙ (с вызовом): "It is business, Marina."';
assert(isEnglishDialogue(en) && !isEnglishDialogue(ru) && isEnglishDialogue("[NO DIALOGUE]"), "Cyrillic speaker names/cues do not hide the spoken language");
const swapped = normalizeEpisodeScript(episodeScriptSchema.parse({ visualIdentity: "photoreal cinematic", scenes: mk(6).map((sc) => ({ ...sc, dialogue: ru, dialogueLocal: en })) }), []);
const fixedSwap = fixDialogueLanguages(swapped);
assert(fixedSwap.scenes.every((sc) => sc.dialogue === en && sc.dialogueLocal === ru), "swapped dialogue/dialogueLocal are swapped back");
const noEn = normalizeEpisodeScript(episodeScriptSchema.parse({ visualIdentity: "photoreal cinematic", scenes: mk(6).map((sc) => ({ ...sc, dialogue: ru, dialogueLocal: ru })) }), []);
assert(nonEnglishScenes(noEn).length === 6, "all-Russian scenes are detected as non-English");
void (async () => {
let translateCalls = 0;
const translated = await ensureEnglishDialogue(noEn, async (_sys, user) => {
  translateCalls++;
  const req = JSON.parse(user) as { scenes: { number: number }[] };
  return { scenes: req.scenes.map((sc) => ({ number: sc.number, dialogue: en })) };
});
assert(translateCalls === 1 && translated.scenes.every((sc) => sc.dialogue === en && sc.dialogueLocal === ru) && nonEnglishScenes(translated).length === 0, "non-English scenes are translated in one call; local text kept for subtitles");
assert(translated.scenes.every((sc) => sc.durationSec >= SCENE_MIN_SECONDS && sc.durationSec <= SCENE_MAX_SECONDS), "translated scenes keep durationSec in range");
const unchanged = await ensureEnglishDialogue(fixedSwap, async () => { throw new Error("must not be called"); });
assert(unchanged.scenes[0].dialogue === en, "no translation call when English is already present");
const failed = await ensureEnglishDialogue(noEn, async () => { throw new Error("llm down"); });
assert(failed.scenes.length === 6 && failed.scenes[0].dialogue === ru, "translation failure never throws (script returned as-is)");
})().catch((e) => { console.error(e); process.exit(1); });

import { sceneReviseSchema, locationReviseSchema, renderScriptFromScenes } from "../lib/season";
import { GENERATE_ALL_CONCURRENCY } from "../app/api/ai/episodes/[id]/generate-all/route";
assert(sceneReviseSchema.safeParse({ shotType: "Close-up", durationSec: 30, locationDesc: "INT — Маяк — ночь", action: "Анна молчит.", dialogue: talk, videoPrompt: prompt }).success, "scene revise schema ok");
assert(!sceneReviseSchema.safeParse({ shotType: "Close-up", durationSec: 40, locationDesc: "x", action: "y", dialogue: talk, videoPrompt: prompt }).success, "scene revise rejects 40s");
assert(locationReviseSchema.safeParse({ locationName: "Порт", locationDesc: "A foggy fishing port with rusted trawlers and sodium lamps.", scenes: [{ number: 1, locationDesc: "EXT — Порт — ночь", videoPrompt: prompt }] }).success, "location revise schema ok");
assert(renderScriptFromScenes({ number: 1, title: "T", logline: "L", locationName: "Маяк", cliffhanger: "C" }, ["Анна"], ok.scenes).includes("СЦЕНА 12"), "script text renders 12 scenes");
assert(GENERATE_ALL_CONCURRENCY === 1, `sequential generation: concurrency must be 1 (was ${GENERATE_ALL_CONCURRENCY}) so each scene chains from the previous scene's last frame`);
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
