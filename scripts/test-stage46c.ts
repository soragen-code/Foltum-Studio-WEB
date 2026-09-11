/** Stage 46C unit tests: episode limits 1..100, batching helper, Season backfill SQL. */
import { readFileSync } from "node:fs";
import { SEASON_MIN_EPISODES, SEASON_MAX_EPISODES, STRUCTURE_BATCH_SIZE, SHORT_SYNOPSIS_BATCH_SIZE, episodeBatches, seasonStructureSchema } from "../lib/season";
import { ideaSchema } from "../lib/validations";

let fails = 0;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) fails++; };

check("limits are 1..100", SEASON_MIN_EPISODES === 1 && SEASON_MAX_EPISODES === 100);
check("100 episodes → 10 structure batches", episodeBatches(100, STRUCTURE_BATCH_SIZE).length === 10);
check("25 episodes → 3 structure batches", episodeBatches(25, STRUCTURE_BATCH_SIZE).length === 3);
check("7 episodes → 1 structure batch", episodeBatches(7, STRUCTURE_BATCH_SIZE).length === 1);
check("100 loglines → 4 short-synopsis batches", episodeBatches(100, SHORT_SYNOPSIS_BATCH_SIZE).length === 4);
const b = episodeBatches(25, 10);
check("batch ranges are contiguous", b[0].from === 1 && b[0].to === 10 && b[2].from === 21 && b[2].to === 25);
check("0 episodes → no batches", episodeBatches(0, 10).length === 0);

const base = { title: "T", idea: "An idea that is long enough to pass the schema validation rules here.", language: "ru" };
const parse = (n: number) => ideaSchema.safeParse({ ...base, episodeCount: n });
check("zod accepts 100", parse(100).success || (parse(100).error?.issues.every((i) => i.path[0] !== "episodeCount") ?? false));
check("zod rejects 101", !parse(101).success && (parse(101).error?.issues.some((i) => i.path[0] === "episodeCount") ?? false));
check("zod rejects 0", !parse(0).success && (parse(0).error?.issues.some((i) => i.path[0] === "episodeCount") ?? false));
check("zod accepts 1", parse(1).error?.issues.every((i) => i.path[0] !== "episodeCount") ?? true);

const ep = (n: number) => ({ number: n, title: `E${n}`, logline: "Something dramatic happens here.", locationName: "Room", locationDesc: "A small room with a window and a table.", characters: ["A"], arcRole: "развитие", cliffhanger: "A door opens." });
check("structure schema accepts 100 episodes", seasonStructureSchema.safeParse({ title: "S", logline: "A season logline.", episodes: Array.from({ length: 100 }, (_, i) => ep(i + 1)) }).success);
check("structure schema rejects 101 episodes", !seasonStructureSchema.safeParse({ title: "S", logline: "A season logline.", episodes: Array.from({ length: 101 }, (_, i) => ep(i + 1)) }).success);

const sql = readFileSync("prisma/patch.sql", "utf8");
for (const col of ["premise", "previousSeasonId", "episodeCount", "direction"]) check(`patch.sql adds Season.${col}`, sql.includes(`ALTER TABLE "Season" ADD COLUMN IF NOT EXISTS "${col}"`));
check("patch.sql backfills Season.episodeCount", /UPDATE "Season" SET "episodeCount"/.test(sql));
const schema = readFileSync("prisma/schema.prisma", "utf8");
check("schema.prisma has Season.premise", /premise\s+String\?\s+@db\.Text/.test(schema));

console.log(fails ? `${fails} FAILED` : "ALL PASSED");
process.exit(fails ? 1 : 0);
