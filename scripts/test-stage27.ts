/**
 * Stage 27a unit checks: natural dialogue tempo + auto-split of over-long scenes.
 * Run: npx tsx scripts/test-stage27.ts
 */
import {
  episodeScriptSchema,
  sceneScriptSchema,
  normalizeEpisodeScript,
  splitOverlongScenes,
  validateEpisodeScript,
  hardProblems,
  estimateDurationSec,
  spokenWordCount,
  NATURAL_WORDS_PER_SEC,
  SPEECH_WORDS_PER_SEC,
  SCENE_MAX_SECONDS,
  SCENE_MIN_SECONDS,
  type SceneScript,
} from "../lib/season";

const assert = (c: unknown, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };
const prompt = "[SHOT TYPE]: Medium two-shot\n[VISUAL STYLE]: x\n[LIGHTING]: y\n[BLOCKING]: z\n[GAZE]: a\n[NON-VERBAL]: b\n[ACTION]: c\n[CHARACTER]: d\n[TRANSITION]: e";

// --- Feature #1: natural pace is clearly slower than the old brisk pace ---
assert(NATURAL_WORDS_PER_SEC < SPEECH_WORDS_PER_SEC && NATURAL_WORDS_PER_SEC === 2.1, `natural pace ${NATURAL_WORDS_PER_SEC} < brisk ${SPEECH_WORDS_PER_SEC}`);
// The same dialogue is planned LONGER at the natural pace than the old brisk pace would have (before clamping).
const medium = 'ANNA (softly): "You knew from the very start and stayed silent all this time, every single night."\nMARK (sharply): "I stayed silent because otherwise you would have packed your things and left that winter."';
const wMedium = spokenWordCount(medium);
assert(Math.ceil(wMedium / NATURAL_WORDS_PER_SEC) > Math.ceil(wMedium / SPEECH_WORDS_PER_SEC), "natural pace yields a longer planned clip than brisk pace");

// --- Feature #2: a dialogue scene whose speech overflows one clip is split into 2+ fitting scenes ---
// Six substantial turns (~100+ words) → well over SCENE_MAX_SECONDS at the natural pace.
const longEn = [
  'ANNA (softly): "You knew from the very start and stayed silent all this time, every single night you looked at me."',
  'MARK (sharply): "I stayed silent because otherwise you would have packed your things and left that cold winter for the city."',
  'ANNA (bitterly): "Maybe leaving then would have been far more honest than living inside this quiet lie for so many years."',
  'MARK (quietly): "Honest for you, perhaps, but the lighthouse would have gone dark and cold and empty without the two of us here."',
  'ANNA (firmly): "The lighthouse is not the reason and you know it, Mark, so please do not hide behind it again tonight."',
  'MARK (holding back): "Then tell me what the real reason is, because I have spent every year trying to understand it."',
].join("\n");
const longRu = [
  'АННА (тихо): "Ты знал с самого начала и молчал всё это время, каждую ночь ты смотрел на меня."',
  'МАРК (резко): "Я молчал, потому что иначе ты собрала бы вещи и уехала той холодной зимой в город."',
  'АННА (горько): "Может, уехать тогда было бы куда честнее, чем жить внутри этой тихой лжи столько лет."',
  'МАРК (тихо): "Честнее для тебя, но маяк остался бы тёмным, холодным и пустым без нас двоих здесь."',
  'АННА (твёрдо): "Маяк тут ни при чём, и ты это знаешь, Марк, так что не прячься за ним снова сегодня."',
  'МАРК (сдержанно): "Тогда скажи мне, в чём настоящая причина, ведь я потратил каждый год, пытаясь её понять."',
].join("\n");

const longWords = spokenWordCount(longEn);
assert(Math.ceil(longWords / NATURAL_WORDS_PER_SEC) > SCENE_MAX_SECONDS, `long dialogue (${longWords} words) overflows one clip at natural pace`);

const longScene: SceneScript = sceneScriptSchema.parse({ number: 1, shotType: "Medium two-shot", durationSec: 30, locationDesc: "INT — Lighthouse — night", characters: ["Anna", "Mark"], action: "Anna and Mark stand apart by the window.", dialogue: longEn, dialogueLocal: longRu, videoPrompt: prompt, startState: "Anna stands in the doorway, facing the window, hands empty, wide shot from the corner.", endState: "Anna stands by the window, back to the door, hands on the sill, medium shot from the doorway.", presence: "Anna by the window, Mark by the stairs", entrances: "none", continuesFrom: "new-sequence" });

const pieces = splitOverlongScenes([longScene]);
assert(pieces.length >= 2, `over-long dialogue split into ${pieces.length} scenes`);
assert(pieces.every((p) => Math.ceil(spokenWordCount(p.dialogue) / NATURAL_WORDS_PER_SEC) <= SCENE_MAX_SECONDS), "every split piece fits one clip at natural pace");
// No spoken words are lost across the split.
assert(pieces.reduce((a, p) => a + spokenWordCount(p.dialogue), 0) === longWords, "no dialogue words lost by the split");
// First piece keeps the original continuity; later pieces continue in the same location, nobody enters.
assert(pieces[0].continuesFrom === "new-sequence" && pieces[0].presence === "Anna by the window, Mark by the stairs", "first half keeps original continuity");
assert(pieces.slice(1).every((p) => p.continuesFrom === "same-location-continuation" && p.entrances === "none" && !!p.presence), "later halves: same-location-continuation, no entrances, presence carried");
// Shared fields are copied to every half.
assert(pieces.every((p) => p.locationDesc === longScene.locationDesc && p.videoPrompt === longScene.videoPrompt && p.sceneKind === "dialogue"), "halves share location / videoPrompt / sceneKind");
// dialogueLocal is split at the SAME line boundary (line counts match) so both halves carry local subtitles.
assert(pieces.every((p) => !!p.dialogueLocal && p.dialogueLocal.split(/\n/).length === p.dialogue.split(/\n/).length), "dialogueLocal mirrors the dialogue split line-for-line");

// --- End-to-end through normalizeEpisodeScript: contiguous numbering + fitting durations, above the 15 cap ok ---
const mkFit = (n: number) => Array.from({ length: n }, (_, i) => ({ number: i + 1, shotType: "Medium two-shot", durationSec: 30, locationDesc: "INT — Lighthouse — night", characters: ["Anna", "Mark"], action: "They talk.", dialogue: medium, videoPrompt: prompt, startState: "Anna stands in the doorway, facing the window, hands empty, wide shot from the corner.", endState: "Anna stands by the window, back to the door, hands on the sill, medium shot from the doorway." }));
// 5 normal scenes + 1 over-long scene → over-long expands, others stay; result renumbered 1..N.
const raw = episodeScriptSchema.parse({ visualIdentity: "photoreal cinematic", scenes: [...mkFit(5), { number: 6, shotType: "Medium two-shot", durationSec: 30, locationDesc: "INT — Lighthouse — night", characters: ["Anna", "Mark"], action: "They face off.", dialogue: longEn, dialogueLocal: longRu, videoPrompt: prompt, startState: "Anna stands in the doorway, facing the window, hands empty, wide shot from the corner.", endState: "Anna stands by the window, back to the door, hands on the sill, medium shot from the doorway." }] });
const norm = normalizeEpisodeScript(raw);
assert(norm.scenes.length > 6, `episode expanded from 6 to ${norm.scenes.length} scenes by the split`);
assert(norm.scenes.every((s, i) => s.number === i + 1), "scenes renumbered contiguously 1..N after split");
assert(norm.scenes.every((s) => s.durationSec >= SCENE_MIN_SECONDS && s.durationSec <= SCENE_MAX_SECONDS && s.durationSec === estimateDurationSec(s.dialogue, s.action)), "every scene durationSec is in range and derived from its own dialogue");
assert(hardProblems(validateEpisodeScript(norm)).length === 0, `an auto-split episode above the 15 cap has no HARD problems: ${validateEpisodeScript(norm).join(" | ") || "(none)"}`);

// --- Narration scenes split at sentence boundaries ---
const longNarr = "For thirty long years the light on the cape never once failed, guiding the fishing boats safely home through every storm. The keeper climbed the iron stairs each dusk and each dawn without complaint. But on the night the fog rolled in thick and grey, something changed in the old tower forever. No one who was there that night ever spoke of what they saw above the waves.";
const narrScene: SceneScript = sceneScriptSchema.parse({ number: 1, shotType: "Wide b-roll", durationSec: 30, locationDesc: "EXT — Cape — dusk", characters: [], action: "Waves crash under the tower.", dialogue: "[NO DIALOGUE]", sceneKind: "narration", voiceover: longNarr, voiceoverLocal: "Тридцать лет маяк не гас. Смотритель поднимался каждый вечер. Но в ночь тумана всё изменилось. Никто не рассказал, что видел.", videoPrompt: prompt, startState: "Anna stands in the doorway, facing the window, hands empty, wide shot from the corner.", endState: "Anna stands by the window, back to the door, hands on the sill, medium shot from the doorway." });
const narrPieces = splitOverlongScenes([narrScene]);
assert(narrPieces.length >= 2, `over-long narration split into ${narrPieces.length} scenes`);
assert(narrPieces.every((p) => p.sceneKind === "narration" && !!p.voiceover), "narration halves stay narration with voiceover");
assert(narrPieces.slice(1).every((p) => p.continuesFrom === "same-location-continuation" && p.entrances === "none"), "later narration halves continue same-location");

// --- A scene that already fits is NOT split ---
const fits = splitOverlongScenes([sceneScriptSchema.parse({ number: 1, shotType: "Medium", durationSec: 30, locationDesc: "INT — room", characters: ["Anna"], action: "She speaks.", dialogue: medium, videoPrompt: prompt, startState: "Anna stands in the doorway, facing the window, hands empty, wide shot from the corner.", endState: "Anna stands by the window, back to the door, hands on the sill, medium shot from the doorway." })]);
assert(fits.length === 1, "a scene that fits one clip is left untouched");

console.log("ALL STAGE27 UNIT CHECKS PASSED");
