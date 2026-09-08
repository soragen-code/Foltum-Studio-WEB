/** Stage 3 unit checks: cast tiers, locations, crowd prompts, location matching. Run: npx tsx scripts/test-stage3.ts */
import { characterCardSchema, locationCardSchema, normalizeTier, dedupeCast, normalizeIdeaResult, normalizeCastExpansion, castExpansionSystemPrompt, ideaSystemPrompt } from "../lib/idea";
import { matchLocation, seasonStructureUserPrompt } from "../lib/season";
import { characterImagePrompt, locationImagePrompt } from "../lib/visual-style";
const assert = (c: unknown, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };

const base = { name: "Анна", age: 40, role: "мать", appearance: "40 лет, тёмные волосы, серое пальто", personality: "сдержанная, упрямая", firstAppearance: "На пристани в шторм" };
const legacy = characterCardSchema.parse(base);
assert(legacy.tier === "MAIN", "legacy card without tier → MAIN");
assert(normalizeTier("crowd") === "CROWD" && normalizeTier("weird") === "MAIN", "normalizeTier lower/unknown");
const crowd = characterCardSchema.parse({ ...base, name: "Рыбаки на пристани", tier: "CROWD", groupSize: "12" });
assert(crowd.tier === "CROWD" && crowd.groupSize === 12, "CROWD card keeps groupSize (coerced from string)");
const loc = locationCardSchema.parse({ name: "Маяк", description: "Старый маяк на скале", visualPrompt: "old stone lighthouse on a cliff, stormy sea" });
assert(loc.name === "Маяк", "location card parses");
assert(dedupeCast([legacy, { ...legacy, name: " анна " }, crowd], []).length === 2, "dedupeCast removes case/space duplicates");
assert(dedupeCast([crowd], ["Рыбаки на пристани"]).length === 0, "dedupeCast respects existing names");

const idea = normalizeIdeaResult({ language: "ru", synopsis: "Синопсис ".repeat(12), characters: [base, { ...base, name: "Марк" }], locations: [loc, loc] }, "Идея про маяк");
assert(idea.locations.length === 1 && idea.characters[0].tier === "MAIN", "normalizeIdeaResult returns deduped locations");
const exp = normalizeCastExpansion({ characters: [{ ...base, name: "Брат Анны", tier: "SUPPORTING", role: "младший брат Анны" }, { ...base, name: "Анна", tier: "MINOR" }] }, ["Анна"]);
assert(exp.length === 1 && exp[0].tier === "SUPPORTING", "cast expansion drops existing names, keeps tiers");
assert(/SUPPORTING/.test(castExpansionSystemPrompt("ru")) && /CROWD/.test(castExpansionSystemPrompt("ru", { hint: "добавь соседей" })), "expansion prompt mentions tiers");
assert(/locations/i.test(ideaSystemPrompt()), "idea prompt asks for locations");

const cp = characterImagePrompt(crowd.appearance, "full", crowd.name, "CROWD", 12);
assert(/group|crowd|12/i.test(cp), "crowd image prompt frames a group shot");
const lp = locationImagePrompt(loc.visualPrompt!, loc.name);
assert(/no people|empty|nobody|without people/i.test(lp), "location image prompt excludes people");

const locs = [{ id: "1", name: "Маяк" }, { id: "2", name: "Кухня в доме Анны" }, { id: "3", name: "Пристань" }];
assert(matchLocation(locs, "маяк")?.id === "1", "matchLocation case-insensitive exact");
assert(matchLocation(locs, "Кухня в доме Анны — вечер")?.id === "2", "matchLocation prefix/contains");
assert(matchLocation(locs, "Совсем новое место") === undefined, "matchLocation unknown → undefined");
const sp = seasonStructureUserPrompt("Синопсис", [legacy, crowd], locs.map((l) => ({ name: l.name, description: "" })));
assert(/Маяк/.test(sp) && /\[CROWD\]|CROWD/.test(sp), "season structure prompt lists locations and tiers");
console.log("stage3: all ok");
