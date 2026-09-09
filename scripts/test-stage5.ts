/** Stage 5 unit checks: season-level revise schema, affected-episode selection. Run: npx tsx scripts/test-stage5.ts */
import { seasonReviseSchema, affectedEpisodes, episodeNeedsRewrite, seasonReviseSystemPrompt, seasonReviseUserPrompt, SEASON_SYNC_INSTRUCTION, type SeasonStructure } from "../lib/season";
const assert = (c: unknown, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok:", m); };

const ep = (number: number, extra: Partial<SeasonStructure["episodes"][number]> = {}) => ({
  number, title: `Эпизод ${number}`, logline: `Анна узнаёт правду о брате и решает уехать из города. Виктор пытается её остановить (${number}).`,
  locationName: "Дом у моря", locationDesc: "A weathered two-storey wooden house on a cliff above the sea, grey shingles, salt-stained windows, evening light.",
  characters: ["Anna", "Victor"], arcRole: (number === 1 ? "завязка" : number === 8 ? "финал" : "развитие") as any, cliffhanger: `Звонок в дверь, которого никто не ждал (${number}).`, ...extra,
});
const before: SeasonStructure = { title: "Семья у моря", logline: "Семейная сага о доме на берегу и тайне, которая держит всех вместе.", episodes: Array.from({ length: 8 }, (_, i) => ep(i + 1)) };
assert(seasonReviseSchema.safeParse(before).success, "revise schema accepts a full 8-episode structure");
assert(!seasonReviseSchema.safeParse({ ...before, episodes: before.episodes.map((e) => ({ ...e, arcRole: "кульминация" })) }).success, "revise schema rejects unknown arcRole");

// Identical structure → nothing to rewrite.
assert(affectedEpisodes(before, JSON.parse(JSON.stringify(before))).length === 0, "identical structure → no affected episodes");
// Title-only / whitespace-only changes do not force a rewrite.
const cosmetic = { ...before, episodes: before.episodes.map((e) => ({ ...e, title: e.title + " — новое название", logline: e.logline + "  " })) };
assert(affectedEpisodes(before, cosmetic).length === 0, "title / whitespace changes → no rewrite");
// Example from the brief: open ending in ep 8 + a detective in eps 6–8.
const after: SeasonStructure = { ...before, episodes: before.episodes.map((e) => (e.number === 8 ? { ...e, cliffhanger: "Финал остаётся открытым: Анна стоит на пороге, дверь не закрыта." } : e.number >= 6 ? { ...e, characters: [...e.characters, "Detective Mark Reed"] } : e)) };
assert(JSON.stringify(affectedEpisodes(before, after)) === "[6,7,8]", `affected = ${JSON.stringify(affectedEpisodes(before, after))} (6,7,8 — others untouched)`);
assert(episodeNeedsRewrite(ep(3), ep(3, { locationName: "Пирс" })), "location change → rewrite");
assert(episodeNeedsRewrite(ep(3), ep(3, { arcRole: "поворот" })), "arc change → rewrite");
assert(!episodeNeedsRewrite(ep(3), ep(3, { characters: ["victor", "ANNA"] })), "same cast in different order/case → no rewrite");
assert(episodeNeedsRewrite(ep(3), ep(3, { characters: ["Anna"] })), "removed character → rewrite");
// Prompts mention the minimal-change rule and the fixed episode count.
const sys = seasonReviseSystemPrompt("ru", 8);
assert(/EXACTLY 8 episodes/.test(sys) && /MINIMAL CHANGE/.test(sys), "system prompt: fixed count + minimal change");
const usr = seasonReviseUserPrompt({ synopsis: "S", structure: before, characters: [], locations: [], instruction: SEASON_SYNC_INSTRUCTION });
assert(usr.includes("INSTRUCTION FROM THE AUTHOR") && usr.includes("Синхронизируй"), "user prompt carries structure + sync instruction");
console.log("stage5: all checks passed");
