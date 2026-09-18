/**
 * Stage 168 (task Stage 3 seasonMap) — validated per-episode SEASON MAP.
 *
 * Offline, synthetic unit tests for every pure piece introduced in Stage 3:
 *   - the season-map prompt module: enum lists + guards, major/finale classification, long/short threshold,
 *     majorBeatCadence, seasonMapCellBrief (present + "" for a null cell = backward compat), retry note;
 *   - the zod cell schema shape;
 *   - EACH validator: a valid map passes, and each rule fails on a targeted mutation —
 *     cell-count, cell-shape, consecutive-cliffhanger, major-cadence (short AND long), escalation-rising,
 *     secret-schedule (WITH a bible AND graceful skip WITHOUT), finale-resolve (structural + bible secret);
 *   - normalizeSeasonMap: safe enum/locations/escalation defaults, { seasonMap } unwrap, NEVER throws on garbage;
 *   - deriveEscalationStep (ladder clamp vs episode index);
 *   - generateSeasonMap with a PURE fake chatFn: valid first try; invalid→valid retry; persistently invalid
 *     returns valid:false with attempts=maxRetries+1 and NEVER throws; transport throw is swallowed.
 *
 * Pure/synthetic only — NO network, NO LLM, NO DB, NO paid generations (chatFn is a local fake).
 * Per repo convention (no vitest wiring) this uses the hand-written assertion style.
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage168.ts
 */
import {
  BEAT_TYPES,
  CLIFFHANGER_TYPES,
  TIME_SKIP_VALUES,
  MAJOR_BEAT_TYPES,
  MAJOR_CLIFFHANGER_TYPES,
  RESOLVING_BEAT_TYPES,
  CLOSING_CLIFFHANGER_TYPES,
  LONG_SEASON_MIN_EPISODES,
  SHORT_SEASON_MAJOR_CADENCE,
  LONG_SEASON_MAJOR_CADENCE,
  SEASON_MAP_PROMPT_VERSION,
  isBeatType,
  isCliffhangerType,
  isTimeSkip,
  isLongSeason,
  majorBeatCadence,
  seasonMapCellBrief,
  seasonMapUserPrompt,
  seasonMapRetryNote,
  SEASON_MAP_SYSTEM,
  type SeasonMapCell,
  type DramaBibleForMap,
} from "@/lib/prompts/season-map";
import {
  seasonMapCellSchema,
  seasonMapSchema,
  validateCellCount,
  validateCellShape,
  validateConsecutiveCliffhangers,
  validateMajorCadence,
  validateEscalationRising,
  validateSecretSchedule,
  validateFinale,
  validateSeasonMap,
  normalizeSeasonMap,
  deriveEscalationStep,
  isMajorCell,
  generateSeasonMap,
  type SeasonMapChatFn,
} from "@/lib/season-map";

let passed = 0;
function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exit(1);
  }
  passed++;
  console.log("ok: " + msg);
}

/* ────────────────────────────── fixtures ────────────────────────────── */

/**
 * Build a VALID N-cell map that satisfies every rule: rotating non-repeating cliffhangers, a rising
 * escalation, a resolving finale, and a major turn within cadence. `majorEvery` places a reveal beat so
 * the major-cadence rule holds for the season length.
 */
function validMap(n: number, majorEvery = SHORT_SEASON_MAJOR_CADENCE): SeasonMapCell[] {
  const cliffs = CLIFFHANGER_TYPES; // reveal, threat, choice, betrayal, arrival — rotate to avoid repeats
  const cells: SeasonMapCell[] = [];
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    const major = i % majorEvery === 0; // guarantees a major within every majorEvery window
    cells.push({
      episode: i + 1,
      beatType: isLast ? "choice" : major ? "reveal" : "humiliation",
      escalationStep: i + 1,
      secretRevealed: null,
      // avoid consecutive repeats: rotate, and force the finale to a CLOSING cliffhanger ("choice")
      cliffhangerType: isLast ? "choice" : cliffs[i % cliffs.length] === "choice" ? "threat" : cliffs[i % cliffs.length],
      timeSkipBefore: i === 0 ? "none" : "hours",
      locations: ["loft"],
      activeThreads: ["mainThread"],
    });
  }
  // fix any accidental consecutive-cliffhanger collisions from the rotation
  for (let i = 1; i < cells.length; i++) {
    if (cells[i].cliffhangerType === cells[i - 1].cliffhangerType) {
      const alt = CLIFFHANGER_TYPES.find((c) => c !== cells[i - 1].cliffhangerType && (i !== cells.length - 1 || CLOSING_CLIFFHANGER_TYPES.includes(c)))!;
      cells[i].cliffhangerType = alt;
    }
  }
  return cells;
}

const episodesOf = (n: number) => Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `Ep ${i + 1}`, logline: `Logline ${i + 1}` }));

/* ────────────────────────────── prompt module: constants & guards ────────────────────────────── */

ok(SEASON_MAP_PROMPT_VERSION === "6.3.0", "SEASON_MAP_PROMPT_VERSION is 6.3.0");
ok(BEAT_TYPES.length === 7 && BEAT_TYPES.includes("reveal") && BEAT_TYPES.includes("betrayal"), "BEAT_TYPES has all 7 beat types");
ok(CLIFFHANGER_TYPES.length === 5 && CLIFFHANGER_TYPES.includes("arrival"), "CLIFFHANGER_TYPES has all 5 types");
ok(TIME_SKIP_VALUES[0] === "none" && TIME_SKIP_VALUES.includes("weeks"), "TIME_SKIP_VALUES include none..weeks");
ok(isBeatType("reveal") && !isBeatType("nope") && !isBeatType(3), "isBeatType guard works");
ok(isCliffhangerType("threat") && !isCliffhangerType("revealX"), "isCliffhangerType guard works");
ok(isTimeSkip("days") && !isTimeSkip("months"), "isTimeSkip guard works");

// long/short threshold: 12 = short, 13 = long
ok(LONG_SEASON_MIN_EPISODES === 13, "LONG_SEASON_MIN_EPISODES is 13");
ok(isLongSeason(13) && isLongSeason(20), "13+ episodes is a long season");
ok(!isLongSeason(12) && !isLongSeason(6), "12 and below is a short season");
ok(majorBeatCadence(12) === SHORT_SEASON_MAJOR_CADENCE && SHORT_SEASON_MAJOR_CADENCE === 4, "short season cadence is 4");
ok(majorBeatCadence(13) === LONG_SEASON_MAJOR_CADENCE && LONG_SEASON_MAJOR_CADENCE === 10, "long season cadence is 10");

// classification sets
ok(MAJOR_BEAT_TYPES.includes("reveal") && MAJOR_BEAT_TYPES.includes("betrayal") && !MAJOR_BEAT_TYPES.includes("humiliation"), "MAJOR_BEAT_TYPES = reveal/betrayal");
ok(MAJOR_CLIFFHANGER_TYPES.includes("reveal") && MAJOR_CLIFFHANGER_TYPES.includes("betrayal"), "MAJOR_CLIFFHANGER_TYPES = reveal/betrayal");
ok(RESOLVING_BEAT_TYPES.includes("reveal") && RESOLVING_BEAT_TYPES.includes("choice") && RESOLVING_BEAT_TYPES.includes("rescue"), "RESOLVING_BEAT_TYPES = reveal/choice/rescue");
ok(CLOSING_CLIFFHANGER_TYPES.includes("reveal") && CLOSING_CLIFFHANGER_TYPES.includes("choice") && !CLOSING_CLIFFHANGER_TYPES.includes("threat"), "CLOSING_CLIFFHANGER_TYPES = reveal/choice");

/* ────────────────────────────── prompt builders ────────────────────────────── */

const up = seasonMapUserPrompt(episodesOf(8), { seasonLogline: "A heist unravels", locations: ["loft", "dock"] });
ok(up.includes("EXACTLY 8 cells") && up.includes("SHORT (8 episodes"), "seasonMapUserPrompt states count + short season");
const upLong = seasonMapUserPrompt(episodesOf(15), {});
ok(upLong.includes("LONG (15 episodes"), "seasonMapUserPrompt marks a long season");
ok(seasonMapUserPrompt(episodesOf(3), {}).includes("STORY BIBLE: (none yet"), "user prompt notes absent bible defensively");
ok(SEASON_MAP_SYSTEM.includes("SEASON MAP") && SEASON_MAP_SYSTEM.includes("seasonMap"), "SEASON_MAP_SYSTEM mentions the season map + JSON key");
ok(seasonMapRetryNote("SOME RULE").includes("SOME RULE") && seasonMapRetryNote("x").includes("Regenerate"), "retry note names the failing rule");

/* ────────────────────────────── seasonMapCellBrief (+ backward compat) ────────────────────────────── */

const briefCell: SeasonMapCell = { episode: 2, beatType: "betrayal", escalationStep: 3, secretRevealed: "s1", cliffhangerType: "reveal", timeSkipBefore: "days", locations: ["loft", "dock"], activeThreads: ["t1", "t2"] };
const brief = seasonMapCellBrief(briefCell);
ok(brief.includes('"betrayal"') && brief.includes('"reveal"') && brief.includes("ESCALATION STEP: 3") && brief.includes("days"), "cell brief renders beat/cliffhanger/escalation/time-skip");
ok(brief.includes("loft, dock") && brief.includes("t1, t2") && brief.includes('reveal "s1"'), "cell brief renders locations/threads/secret");
ok(seasonMapCellBrief(null) === "" && seasonMapCellBrief(undefined) === "", "cell brief is '' for a missing cell (backward compat)");
const briefNoSecret = seasonMapCellBrief({ ...briefCell, secretRevealed: null, activeThreads: [] });
ok(!briefNoSecret.includes("SECRET:") && !briefNoSecret.includes("ACTIVE THREADS"), "cell brief omits empty secret/threads lines");

/* ────────────────────────────── zod cell schema ────────────────────────────── */

ok(seasonMapCellSchema.safeParse(briefCell).success, "zod: a well-formed cell parses");
ok(!seasonMapCellSchema.safeParse({ ...briefCell, beatType: "nope" }).success, "zod: bad beatType rejected");
ok(!seasonMapCellSchema.safeParse({ ...briefCell, locations: [] }).success, "zod: empty locations rejected");
ok(!seasonMapCellSchema.safeParse({ ...briefCell, locations: ["a", "b", "c", "d"] }).success, "zod: >3 locations rejected");
ok(!seasonMapCellSchema.safeParse({ ...briefCell, escalationStep: 0 }).success, "zod: escalationStep<1 rejected");
ok(seasonMapSchema.safeParse(validMap(6)).success, "zod: a full valid map array parses");

/* ────────────────────────────── validators: a valid map passes every rule ────────────────────────────── */

const good6 = validMap(6);
ok(validateSeasonMap(good6, { episodeCount: 6 }).ok, "validateSeasonMap: valid 6-ep map passes");
ok(validateCellCount(good6, 6).length === 0, "cell-count: correct count passes");
ok(validateCellShape(good6).length === 0, "cell-shape: valid cells pass");
ok(validateConsecutiveCliffhangers(good6).length === 0, "consecutive-cliffhanger: rotating map passes");
ok(validateMajorCadence(good6).length === 0, "major-cadence: valid short map passes");
ok(validateEscalationRising(good6).length === 0, "escalation-rising: rising steps pass");
ok(validateFinale(good6).length === 0, "finale-resolve: resolving finale passes");
const good20 = validMap(20, LONG_SEASON_MAJOR_CADENCE);
ok(validateSeasonMap(good20, { episodeCount: 20 }).ok, "validateSeasonMap: valid 20-ep long map passes");

/* ────────────────────────────── validators: each rule fails on a targeted mutation ────────────────────────────── */

// cell-count
ok(validateCellCount(good6, 7).some((e) => e.rule === "cell-count"), "cell-count: wrong count flagged");
const misnum = validMap(6).map((c, i) => (i === 3 ? { ...c, episode: 99 } : c));
ok(validateCellCount(misnum, 6).some((e) => e.rule === "cell-count"), "cell-count: out-of-order episode flagged");

// cell-shape
const badShape = validMap(6);
(badShape[2] as unknown as Record<string, unknown>).beatType = "nonsense";
ok(validateCellShape(badShape).some((e) => e.rule === "cell-shape"), "cell-shape: malformed cell flagged");

// consecutive-cliffhanger
const consec = validMap(6);
consec[3].cliffhangerType = consec[2].cliffhangerType;
ok(validateConsecutiveCliffhangers(consec).some((e) => e.rule === "consecutive-cliffhanger"), "consecutive-cliffhanger: adjacent repeat flagged");

// major-cadence SHORT: no major within 4
const noMajorShort: SeasonMapCell[] = validMap(6);
// no reveal/betrayal beats or cliffhangers anywhere → no major turn; rotate non-major cliffs to avoid repeats
noMajorShort.forEach((c, i) => { c.beatType = "humiliation"; c.cliffhangerType = (["threat", "choice", "arrival"] as const)[i % 3]; c.episode = i + 1; });
ok(validateMajorCadence(noMajorShort).some((e) => e.rule === "major-cadence"), "major-cadence (short): season with no major turn flagged");

// major-cadence LONG: first major after episode 10
const lateMajorLong: SeasonMapCell[] = validMap(15, 1);
lateMajorLong.forEach((c, i) => { c.beatType = "humiliation"; c.cliffhangerType = (["threat", "choice", "arrival"] as const)[i % 3]; c.episode = i + 1; c.escalationStep = i + 1; });
lateMajorLong[12].beatType = "reveal"; // only major at ep13 → first major too late (>10)
ok(isLongSeason(15) && validateMajorCadence(lateMajorLong).some((e) => e.rule === "major-cadence"), "major-cadence (long): first major after ep10 flagged");
// and a long season WITH a timely major passes cadence
const timelyLong = validMap(15, LONG_SEASON_MAJOR_CADENCE);
ok(validateMajorCadence(timelyLong).length === 0, "major-cadence (long): major within 10 passes");

// escalation-rising
const slide = validMap(6);
slide[4].escalationStep = 1; // drops below previous
ok(validateEscalationRising(slide).some((e) => e.rule === "escalation-rising"), "escalation-rising: a step drop flagged");

// finale-resolve: structural
const openFinale = validMap(6);
openFinale[5].cliffhangerType = "threat"; // opens instead of closing
ok(validateFinale(openFinale).some((e) => e.rule === "finale-resolve"), "finale-resolve: an opening finale cliffhanger flagged");
const openBeat = validMap(6);
openBeat[5].beatType = "betrayal"; // not a resolving beat
ok(validateFinale(openBeat).some((e) => e.rule === "finale-resolve"), "finale-resolve: a non-resolving finale beat flagged");

/* ────────────────────────────── secret-schedule: WITH a bible AND graceful skip WITHOUT ────────────────────────────── */

const bible: DramaBibleForMap = { secrets: [{ id: "sX", revealEpisode: 4 }], finaleQuestion: "Who betrayed her?", finaleSecretId: "sFin" };
const secretMissing = validMap(6);
ok(validateSecretSchedule(secretMissing, bible).some((e) => e.rule === "secret-schedule"), "secret-schedule: unrevealed scheduled secret flagged (with bible)");
const secretOk = validMap(6);
secretOk[3].secretRevealed = "sX"; // episode 4 reveals sX
ok(validateSecretSchedule(secretOk, bible).length === 0, "secret-schedule: correctly-scheduled secret passes");
ok(validateSecretSchedule(secretMissing, null).length === 0, "secret-schedule: no bible → skipped gracefully");
ok(validateSecretSchedule(secretMissing, { secrets: [] }).length === 0, "secret-schedule: empty secrets → skipped gracefully");

// finale bible secret
const finaleBible: DramaBibleForMap = { finaleQuestion: "Who?", finaleSecretId: "sFin" };
const finaleNoSecret = validMap(6); // last cell reveals nothing
ok(validateFinale(finaleNoSecret, finaleBible).some((e) => e.rule === "finale-resolve"), "finale-resolve: finale missing the answering secret flagged (with bible)");
const finaleWithSecret = validMap(6);
finaleWithSecret[5].secretRevealed = "sFin";
ok(validateFinale(finaleWithSecret, finaleBible).length === 0, "finale-resolve: finale revealing the answering secret passes");
ok(validateFinale(finaleNoSecret, null).length === 0 || validateFinale(finaleNoSecret).length === 0, "finale-resolve: structural-only finale (no bible) passes");

/* ────────────────────────────── isMajorCell ────────────────────────────── */

ok(isMajorCell({ ...briefCell, beatType: "reveal", cliffhangerType: "threat" }), "isMajorCell: reveal beat is major");
ok(isMajorCell({ ...briefCell, beatType: "humiliation", cliffhangerType: "betrayal" }), "isMajorCell: betrayal cliffhanger is major");
ok(!isMajorCell({ ...briefCell, beatType: "humiliation", cliffhangerType: "threat" }), "isMajorCell: neither → not major");

/* ────────────────────────────── deriveEscalationStep ────────────────────────────── */

ok(deriveEscalationStep(0) === 1 && deriveEscalationStep(5) === 6, "deriveEscalationStep: episode index + 1 without ladder");
ok(deriveEscalationStep(9, { escalationLadder: ["a", "b", "c"] }) === 3, "deriveEscalationStep: clamps to ladder length");
ok(deriveEscalationStep(1, { escalationLadder: ["a", "b", "c"] }) === 2, "deriveEscalationStep: within ladder = index+1");

/* ────────────────────────────── normalizeSeasonMap: defaults + never throws ────────────────────────────── */

const nFromWrapper = normalizeSeasonMap({ seasonMap: [{ episode: 1, beatType: "reveal", cliffhangerType: "threat", timeSkipBefore: "none", escalationStep: 2, locations: ["a"], activeThreads: [] }] }, { episodeCount: 3 });
ok(nFromWrapper.length === 3, "normalize: { seasonMap } unwrapped + padded to episodeCount");
ok(nFromWrapper[0].beatType === "reveal" && nFromWrapper[0].escalationStep === 2, "normalize: keeps valid provided values");
ok(nFromWrapper[1].episode === 2 && nFromWrapper[2].episode === 3, "normalize: forces episode = index+1");
const nGarbage = normalizeSeasonMap({ junk: true }, { episodeCount: 4 });
ok(nGarbage.length === 4 && nGarbage.every((c) => isBeatType(c.beatType) && isCliffhangerType(c.cliffhangerType) && isTimeSkip(c.timeSkipBefore)), "normalize: garbage input → 4 safe-defaulted cells");
ok(nGarbage.every((c) => c.locations.length >= 1 && c.locations.length <= 3), "normalize: locations clamped to 1..3 (default 'main')");
ok(nGarbage.every((c, i) => c.escalationStep === i + 1), "normalize: escalationStep defaults to episode position");
const nBadEnums = normalizeSeasonMap([{ beatType: "xxx", cliffhangerType: "yyy", timeSkipBefore: "zzz", locations: ["a", "b", "c", "d", "e"], escalationStep: -3, activeThreads: "notarray" }], { episodeCount: 1 });
ok(isBeatType(nBadEnums[0].beatType) && isCliffhangerType(nBadEnums[0].cliffhangerType) && isTimeSkip(nBadEnums[0].timeSkipBefore), "normalize: bad enums coerced to safe defaults");
ok(nBadEnums[0].locations.length === 3 && nBadEnums[0].escalationStep === 1 && Array.isArray(nBadEnums[0].activeThreads), "normalize: over-long locations trimmed, bad escalation/threads fixed");
// never throws on wild input
for (const wild of [null, undefined, 42, "str", [], {}, [null, 1, "x"], { seasonMap: "notarray" }]) {
  let threw = false;
  try { normalizeSeasonMap(wild, { episodeCount: 2 }); } catch { threw = true; }
  ok(!threw, `normalize: never throws on ${JSON.stringify(wild)}`);
}

/* ────────────────────────────── generateSeasonMap with a PURE fake chatFn ────────────────────────────── */

const validRaw = (n: number) => ({ seasonMap: validMap(n) });
void (async () => {
  // 1) valid on the first try
  let calls = 0;
  const alwaysValid: SeasonMapChatFn = async () => { calls++; return validRaw(6); };
  const r1 = await generateSeasonMap({ episodes: episodesOf(6) }, alwaysValid, { maxRetries: 3 });
  ok(r1.valid && r1.errors.length === 0 && r1.attempts === 1 && calls === 1, "generate: valid on first attempt (1 call)");
  ok(r1.seasonMap.length === 6, "generate: returns a 6-cell map");

  // 2) invalid then valid → retries, ends valid
  let c2 = 0;
  const invalidThenValid: SeasonMapChatFn = async () => {
    c2++;
    if (c2 === 1) return { seasonMap: validMap(6).map((c) => ({ ...c, cliffhangerType: "threat" })) }; // consecutive repeats → invalid
    return validRaw(6);
  };
  const r2 = await generateSeasonMap({ episodes: episodesOf(6) }, invalidThenValid, { maxRetries: 3 });
  ok(r2.valid && r2.attempts === 2 && c2 === 2, "generate: recovers on a retry (attempt 2)");

  // 3) persistently invalid → valid:false, attempts=maxRetries+1, NEVER throws, best-effort map returned
  let c3 = 0;
  const alwaysInvalid: SeasonMapChatFn = async () => { c3++; return { seasonMap: validMap(6).map((c) => ({ ...c, cliffhangerType: "threat" })) }; };
  let threw3 = false;
  let r3: Awaited<ReturnType<typeof generateSeasonMap>> | null = null;
  try { r3 = await generateSeasonMap({ episodes: episodesOf(6) }, alwaysInvalid, { maxRetries: 3 }); } catch { threw3 = true; }
  ok(!threw3 && r3 !== null, "generate: persistently invalid never throws");
  ok(r3!.valid === false && r3!.errors.length > 0 && r3!.attempts === 4 && c3 === 4, "generate: exhausts maxRetries+1 attempts, returns valid:false with errors");
  ok(r3!.seasonMap.length === 6, "generate: still returns a best-effort normalized map when invalid");

  // 4) a chatFn that THROWS (transport failure) is swallowed → best-effort defaulted map, no throw
  const throwing: SeasonMapChatFn = async () => { throw new Error("network down"); };
  let threw4 = false;
  let r4: Awaited<ReturnType<typeof generateSeasonMap>> | null = null;
  try { r4 = await generateSeasonMap({ episodes: episodesOf(5) }, throwing, { maxRetries: 1 }); } catch { threw4 = true; }
  ok(!threw4 && r4 !== null && r4!.seasonMap.length === 5, "generate: swallows a throwing chatFn and returns a defaulted 5-cell map");

  console.log(`\nStage 168: PASS (${passed} checks)`);
})();
