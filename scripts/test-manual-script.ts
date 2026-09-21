/**
 * Deterministic manual-script pre-parser checks.
 * Run: npx tsx scripts/test-manual-script.ts
 *
 * Reproduces the reported bug: a 5-scene author script whose headers use "Scene N·" (middle dot) and
 * "<Location> — <SubLocation>" must split into EXACTLY 5 scenes with the right location/sub-location, and
 * normalizeManualScript must emit 5 unambiguous "=== SCENE N ===" blocks carrying the author's dialogue.
 */
import { parseManualScriptScenes, normalizeManualScript } from "../lib/manual-script";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log("  ok  -", msg);
  else { console.error("  FAIL -", msg); failures++; }
}

// The exact script the user pasted (Scene N· ... — ... , ИМЯ(ремарка) + line dialogue).
const script = `Scene 1· Оазис у водонапорной башни — Насосная яма
Анна и Юрий работают над насосом. Анна держит гаечный ключ, склонившись над насосом, её лицо сосредоточенно. Юрий стоит рядом, указывая на детали. Слышен звук металлических инструментов по металлу и тихий гул оазиса вокруг.

АННА(решительно)
Что-нибудь узнал о Павле и Миле?

ЮРИЙ(нерешительно)
Только слухи, Анна. Но это начало.

Scene 2· Оазис у водонапорной башни — Советский стол
Анна стоит у стола, окружённого членами совета. Она объясняет что-то, размахивая руками, в то время как члены совета слушают. Свет падает через пыльные окна, создавая полосы на их лицах.

ЧЛЕН СОВЕТА(обеспокоенно)
Если мы это починим, какие у нас гарантии?

АННА(твёрдо)
У вас есть моё слово. И я найду свою семью.

Scene 3· Оазис у водонапорной башни — Медпункт
Сайра перебирает аптечку, Анна стоит рядом, показывая на раздатчик воды. Сайра кивает, но её лицо выражает сомнение. Ветер колышет занавески, создавая тихий шелест.

САЙРА(сомнительно)
А что, если это не сработает?

АННА(уверенно)
Мы этого не допустим. Доверься мне.

Scene 4· Оазис у водонапорной башни — Раздаточный пункт
Лев стоит у раздаточного пункта, держа канистру, его лицо напряжено. Анна подходит к нему, протягивая руку для приветствия. Ветер поднимает пыль, и слышен скрип металла.

ЛЕВ(напряжённо)
Думаешь, это сработает?

АННА(уверенно)
Должно. У нас нет выбора.

Scene 5· Оазис у водонапорной башни — Водопроводный кран
Анна и Сайра стоят у крана, Сайра открывает его, но вода не течет. На табло над краном загорается сообщение: «ВОДА ЗАБЛОКИРОВАНА. ВЫДАТЬ: АННА СОКОЛОВА». Анна с ужасом смотрит на табло, Сайра в шоке отступает назад. Ветер усиливает тревожность момента.

АННА(в шоке)
Нет... этого не может быть...

САЙРА(шёпотом)
Они хотят тебя.`;

console.log("== 5-scene author script (Scene N· middle-dot headers) ==");
const scenes = parseManualScriptScenes(script);
assert(scenes.length === 5, `parsed exactly 5 scenes (got ${scenes.length})`);

const expectedLoc = "Оазис у водонапорной башни";
const expectedSub = ["Насосная яма", "Советский стол", "Медпункт", "Раздаточный пункт", "Водопроводный кран"];
scenes.forEach((s, i) => {
  assert(s.location === expectedLoc, `scene ${i + 1} location = "${expectedLoc}" (got "${s.location}")`);
  assert(s.subLocation === expectedSub[i], `scene ${i + 1} sub-location = "${expectedSub[i]}" (got "${s.subLocation}")`);
});
// Dialogue stays in the right scene body.
assert(scenes[0].body.includes("Что-нибудь узнал о Павле и Миле?"), "scene 1 keeps its dialogue");
assert(scenes[4].body.includes("Они хотят тебя."), "scene 5 keeps its dialogue");
assert(!scenes[0].body.includes("Scene 2"), "scene 1 body does not leak into scene 2");

console.log("== normalizeManualScript ==");
const norm = normalizeManualScript(script);
const markers = (norm.match(/=== SCENE \d+ ===/g) ?? []).length;
assert(markers === 5, `emits 5 "=== SCENE N ===" markers (got ${markers})`);
assert(norm.includes("LOCATION: Оазис у водонапорной башни"), "emits explicit LOCATION line");
assert(norm.includes("SUB-LOCATION: Водопроводный кран"), "emits explicit SUB-LOCATION line");
assert(norm.includes("Они хотят тебя."), "preserves author dialogue verbatim");

console.log("== header-format tolerance ==");
const formats = `Сцена 1. Кухня — Стол
line a
Scene 2 : Улица
line b
SCENE 3 - Крыша — Карниз
line c
Scene 4— Двор
line d`;
const fs2 = parseManualScriptScenes(formats);
assert(fs2.length === 4, `mixed separators (·/./:/-/—) → 4 scenes (got ${fs2.length})`);
assert(fs2[0].location === "Кухня" && fs2[0].subLocation === "Стол", "Сцена 1. -> Кухня — Стол");
assert(fs2[1].location === "Улица" && fs2[1].subLocation === "", "Scene 2 : -> Улица (no sub)");
assert(fs2[2].location === "Крыша" && fs2[2].subLocation === "Карниз", "SCENE 3 - -> Крыша — Карниз");

console.log("== non-matching text is passed through unchanged ==");
const plain = "Just a paragraph of prose with no scene headers at all.";
assert(normalizeManualScript(plain) === plain, "text without >=2 headers returned unchanged");

if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log("\nAll manual-script checks passed.");
