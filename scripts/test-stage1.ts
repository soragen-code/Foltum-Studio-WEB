import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  POWER_TIER_CONFIG,
  legacyTierToPower,
  powerToLegacyTier,
  resolvePowerTier,
  isPowerTier,
  CHARACTER_REFERENCE_COST,
} from "../lib/power-tier";
import {
  detectLanguage,
  normalizeLanguage,
  stripMarkup,
  ideaResultSchema,
  synopsisReviseResultSchema,
  characterCardSchema,
  normalizeIdeaResult,
  sanitizeCharacterCard,
  toCharacterCard,
  ideaSystemPrompt,
  reviseSynopsisSystemPrompt,
  reviseCharacterSystemPrompt,
  GENRES,
  GENRE_BY_ID,
  genresToEnglish,
  ideaAutoSystemPrompt,
  ideaAutoUserPrompt,
} from "../lib/idea";
import { createProjectSchema, ideaSchema, ideaReviseSchema, characterReviseSchema } from "../lib/validations";

const card = {
  name: "Марина Соколова",
  age: "29",
  role: "Протагонист",
  appearance: "A 29-year-old woman with pale skin, wind-tangled dark hair, grey eyes and a heavy wool coat.",
  personality: "Упрямая, наблюдательная, боится довериться людям.",
  firstAppearance: "В первой серии сходит с парома на остров с одним чемоданом.",
};

test("power tier: конфиг соответствует реальной схеме Seedance и старым числам", () => {
  for (const t of Object.values(POWER_TIER_CONFIG)) assert.ok(["480p", "720p"].includes(t.resolution));
  assert.deepEqual(
    [POWER_TIER_CONFIG.LOW, POWER_TIER_CONFIG.MEDIUM, POWER_TIER_CONFIG.HIGH].map((t) => [t.costPerScene, t.baseDuration, t.resolution]),
    [[1, 5, "480p"], [3, 5, "720p"], [8, 10, "720p"]]
  );
  assert.equal(legacyTierToPower("minimum"), "LOW");
  assert.equal(legacyTierToPower("medium"), "MEDIUM");
  assert.equal(legacyTierToPower("maximum"), "HIGH");
  assert.equal(legacyTierToPower("garbage"), "MEDIUM");
  assert.equal(powerToLegacyTier("HIGH"), "maximum");
  // legacy project (only tier) and new project (powerTier) resolve identically
  assert.equal(resolvePowerTier({ tier: "minimum" }).id, "LOW");
  assert.equal(resolvePowerTier({ powerTier: "HIGH", tier: "minimum" }).id, "HIGH");
  assert.equal(resolvePowerTier({}).id, "MEDIUM");
  assert.ok(isPowerTier("LOW") && !isPowerTier("low"));
  assert.equal(CHARACTER_REFERENCE_COST, 1);
});

test("validations: createProject принимает powerTier, idea/revise схемы", () => {
  assert.equal(createProjectSchema.parse({ name: "X", powerTier: "HIGH" }).powerTier, "HIGH");
  assert.ok(!createProjectSchema.safeParse({ name: "X", powerTier: "ULTRA" }).success);
  assert.ok(createProjectSchema.safeParse({ name: "X", tier: "medium" }).success);
  const id = "c" + "a".repeat(24);
  assert.ok(ideaSchema.safeParse({ projectId: id, idea: "Смотрительница маяка находит дневник" }).success);
  assert.ok(!ideaSchema.safeParse({ projectId: id, idea: "коротко" }).success);
  assert.ok(ideaReviseSchema.safeParse({ projectId: id, instruction: "мрачнее" }).success);
  assert.ok(characterReviseSchema.safeParse({ characterId: id, instruction: "старше" }).success);
});

test("stage7 авто-идея: схема, жанры и промпты", () => {
  const id = "c" + "a".repeat(24);
  // auto=true с жанром — валиден без текста идеи
  assert.ok(ideaSchema.safeParse({ projectId: id, auto: true, genres: ["detective"] }).success);
  // auto=true без жанров — отклоняется
  assert.ok(!ideaSchema.safeParse({ projectId: id, auto: true, genres: [] }).success);
  // manual (auto=false) без идеи — отклоняется
  assert.ok(!ideaSchema.safeParse({ projectId: id, auto: false }).success);
  // extras опциональны и допустимы
  assert.ok(ideaSchema.safeParse({ projectId: id, auto: true, genres: ["horror", "drama"], extras: "космос" }).success);
  // список жанров непустой, у каждого id/label/en
  assert.ok(GENRES.length >= 10);
  for (const g of GENRES) assert.ok(g.id && g.label && g.en, `genre ${g.id}`);
  assert.equal(GENRE_BY_ID["detective"].label, "Детектив");
  // маппинг id → английский дескриптор, неизвестные значения сохраняются
  assert.deepEqual(genresToEnglish(["detective", "СвойЖанр"]), [GENRE_BY_ID["detective"].en, "СвойЖанр"]);
  assert.deepEqual(genresToEnglish([" ", ""]), []);
  // авто-промпты — непустые строки, требуют 8-14 локаций и оригинальность
  const sys = ideaAutoSystemPrompt("ru");
  assert.match(sys, /8-14/);
  assert.match(sys, /INVENT/);
  assert.match(sys, /Russian/);
  assert.match(ideaAutoSystemPrompt("en"), /English/);
  const user = ideaAutoUserPrompt(["detective"], "маленький город");
  assert.match(user, /detective/);
  assert.match(user, /маленький город/);
  assert.ok(ideaAutoUserPrompt([]).length > 0);
});

test("язык: кириллица → ru, латиница → en, LLM-ответ нормализуется", () => {
  assert.equal(detectLanguage("Молодая смотрительница маяка находит дневник."), "ru");
  assert.equal(detectLanguage("A young lighthouse keeper finds a diary."), "en");
  assert.equal(detectLanguage("Молода доглядачка маяка знаходить щоденник її попередника."), "uk");
  assert.equal(detectLanguage(""), "en");
  assert.equal(normalizeLanguage("Russian", "Идея"), "ru"); // "ru" prefix
  assert.equal(normalizeLanguage("xx", "Идея на русском"), "ru");
  assert.equal(normalizeLanguage(undefined, "English idea"), "en");
});

test("stripMarkup убирает заголовки/жирный/списки, сохраняя абзацы", () => {
  const out = stripMarkup("## Синопсис\n\n**Завязка.** Марина приезжает.\n\n- пункт один\n* пункт два\n\n\n\nФинал.");
  assert.equal(out, "Синопсис\n\nЗавязка. Марина приезжает.\n\nпункт один\nпункт два\n\nФинал.");
});

test("схема ответа idea: валидный JSON проходит, невалидный отклоняется", () => {
  const good = { language: "ru", synopsis: "А".repeat(120), characters: [card, { ...card, name: "Олег Ветров", age: 54 }] };
  const parsed = ideaResultSchema.parse(good);
  assert.equal(parsed.characters[1].age, "54"); // number → string
  assert.ok(!ideaResultSchema.safeParse({ ...good, characters: [card] }).success, "минимум 2 персонажа");
  assert.ok(!ideaResultSchema.safeParse({ ...good, synopsis: "коротко" }).success);
  assert.ok(!ideaResultSchema.safeParse({ ...good, characters: [card, { ...card, appearance: "" }] }).success);
  assert.ok(!characterCardSchema.safeParse({ ...card, firstAppearance: undefined }).success);
  // stage7: до 16 локаций принимается, 17 — отклоняется
  const loc = { name: "Порт", description: "A".repeat(60), visualPrompt: "B".repeat(60) };
  assert.ok(ideaResultSchema.safeParse({ ...good, locations: Array(14).fill(loc) }).success);
  assert.ok(!ideaResultSchema.safeParse({ ...good, locations: Array(17).fill(loc) }).success);
});

test("normalizeIdeaResult: язык по идее, markdown снят, внешность санитизирована", () => {
  const raw = {
    synopsis: "**Первая серия.** " + "Марина приезжает на остров. ".repeat(6),
    characters: [
      { ...card, appearance: "A woman who looks like Angelina Jolie, dark hair, grey eyes, wearing Nike sneakers." },
      { ...card, name: "Олег Ветров" },
    ],
  };
  const res = normalizeIdeaResult(raw, "Смотрительница маяка на северном острове");
  assert.equal(res.language, "ru");
  assert.ok(!res.synopsis.includes("**"));
  assert.ok(!/Angelina|Jolie|Nike/i.test(res.characters[0].appearance), res.characters[0].appearance);
  assert.equal(res.characters[1].name, "Олег Ветров");
  // имя персонажа сохраняется при санитизации
  assert.equal(sanitizeCharacterCard(characterCardSchema.parse(card), ["Марина Соколова"]).name, card.name);
});

test("схема ревизии синопсиса: с персонажами и без", () => {
  const r1 = synopsisReviseResultSchema.parse({ synopsis: "Б".repeat(100) });
  assert.equal(r1.charactersChanged, false);
  const r2 = synopsisReviseResultSchema.parse({ synopsis: "Б".repeat(100), charactersChanged: true, changeSummary: "Добавлен Олег", characters: [card, card] });
  assert.equal(r2.characters?.length, 2);
});

test("toCharacterCard заполняет пропуски и промпты требуют язык/оригинальность", () => {
  const c = toCharacterCard({ name: "N", description: "desc" });
  assert.equal(c.personality, "desc");
  assert.equal(c.age, "—");
  assert.match(ideaSystemPrompt(), /ORIGINALITY/);
  assert.match(reviseSynopsisSystemPrompt("ru"), /Russian/);
  assert.match(reviseCharacterSystemPrompt("en"), /English/);
});

test("миграция: patch.sql аддитивна и содержит новые колонки", () => {
  const sql = readFileSync(new URL("../prisma/patch.sql", import.meta.url), "utf8");
  for (const col of ['"Project" ADD COLUMN IF NOT EXISTS "powerTier"', '"Project" ADD COLUMN IF NOT EXISTS "language"', '"Character" ADD COLUMN IF NOT EXISTS "age"', '"Character" ADD COLUMN IF NOT EXISTS "firstAppearance"', '"Episode" ADD COLUMN IF NOT EXISTS "script"', 'CREATE TABLE IF NOT EXISTS "EpisodeCharacter"'])
    assert.ok(sql.includes(col), col);
  assert.ok(!/DROP\s+(TABLE|COLUMN)/i.test(sql));
  assert.ok(!/ALTER\s+TABLE[^;]*(RENAME|ALTER\s+COLUMN)/i.test(sql));
});
