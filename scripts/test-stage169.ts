/**
 * Stage 169 (task Stage 1: dramaBible) — the structured STORY BIBLE.
 *
 * Offline, synthetic unit tests for every pure piece introduced in Stage 1:
 *   - the drama-bible prompt module: PROMPT_VERSION, count bounds, dramaBibleBrief (present + "" for null = backward compat);
 *   - the zod schema: a valid bible passes; out-of-range counts are rejected (genreTropes <3 / >6,
 *     escalationLadder <5 / >7, secrets <3 / >4);
 *   - field-named validators: each rule names the offending FIELD (counts, required non-empty, secret.revealEpisode
 *     out of range — both <1 and beyond the episode count);
 *   - normalizeDramaBible: never throws on garbage; { dramaBible } / { bible } unwrap;
 *   - toDramaBibleForMap: maps the real escalation ladder / secrets / finale question when present, null when absent;
 *   - the season map consuming REAL bible data (validateSecretSchedule / validateFinale) AND falling back when absent;
 *   - the bible→synopsis ORDER (mock chatFn/proseFn: the bible system prompt fires before the synopsis system prompt);
 *   - generateDramaBible with a PURE fake chatFn: valid first try; invalid→valid retry; persistently invalid returns
 *     valid:false with attempts=maxRetries+1 and NEVER throws; transport throw is swallowed.
 *
 * Pure/synthetic only — NO network, NO LLM, NO DB, NO paid generations (chatFn/proseFn are local fakes).
 * Per repo convention (no vitest wiring) this uses the hand-written assertion style.
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage169.ts
 */
import {
  DRAMA_BIBLE_PROMPT_VERSION,
  GENRE_TROPES_MIN,
  GENRE_TROPES_MAX,
  ESCALATION_LADDER_MIN,
  ESCALATION_LADDER_MAX,
  SECRETS_MIN,
  SECRETS_MAX,
  DRAMA_BIBLE_SYSTEM,
  SYNOPSIS_FROM_BIBLE_SYSTEM,
  dramaBibleBrief,
  type DramaBible,
} from "../lib/prompts/drama-bible";
import {
  dramaBibleSchema,
  validateDramaBible,
  validateBibleCounts,
  validateSecretReveals,
  validateBibleRequired,
  normalizeDramaBible,
  toDramaBibleForMap,
  generateDramaBible,
  synopsisFromBible,
  generateBibleThenSynopsis,
  type DramaBibleChatFn,
  type DramaBibleProseFn,
} from "../lib/drama-bible";
import { normalizeSeasonMap, validateSecretSchedule, validateFinale } from "../lib/season-map";
import type { SeasonMapCell } from "../lib/prompts/season-map";

let passed = 0;
function ok(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
}

/** A fully valid bible for an 8-episode season (min counts; reveals in range). */
function validBible(): DramaBible {
  return {
    theme: "Loyalty corrupts when survival is at stake",
    genreTropes: ["mistaken identity", "hidden heir", "forbidden romance"],
    protagonist: { want: "reclaim the throne", need: "learn to trust", flaw: "pride", arcStart: "isolated exile", arcEnd: "united leader" },
    antagonist: {
      goal: "keep the throne",
      pressureMechanism: "blackmail and spies",
      escalationLadder: ["veiled threats", "framing", "arrest", "public trial", "execution order"],
    },
    secrets: [
      { secret: "the heir is alive", knownBy: ["mentor"], revealEpisode: 2 },
      { secret: "the regent killed the king", knownBy: ["antagonist"], revealEpisode: 4 },
      { secret: "the ally is a double agent", knownBy: ["ally"], revealEpisode: 6 },
    ],
    midpointReversal: "the protagonist's ally is exposed as the regent's spy",
    finaleQuestion: "Will the true heir take the throne without becoming the tyrant?",
    bLine: { conflict: "a servant romance across class lines", characters: ["maid", "guard"] },
    relationships: [{ a: "heir", b: "mentor", dynamic: "student-teacher", tension: "withheld truth" }],
  };
}

function clone(b: DramaBible): DramaBible {
  return JSON.parse(JSON.stringify(b));
}

void (async () => {
  /* ───────── prompt module constants + brief ───────── */
  ok(DRAMA_BIBLE_PROMPT_VERSION === "6.4.0", "PROMPT_VERSION is the 6.4.0 family bump");
  ok(GENRE_TROPES_MIN === 3 && GENRE_TROPES_MAX === 6, "genreTropes bounds are 3-6");
  ok(ESCALATION_LADDER_MIN === 5 && ESCALATION_LADDER_MAX === 7, "escalationLadder bounds are 5-7");
  ok(SECRETS_MIN === 3 && SECRETS_MAX === 4, "secrets bounds are 3-4");

  const brief = dramaBibleBrief(validBible());
  ok(brief.includes("Loyalty corrupts") && brief.includes("ESCALATION LADDER") && brief.includes("FINALE QUESTION"), "dramaBibleBrief renders theme, ladder and finale question");
  ok(dramaBibleBrief(null) === "" && dramaBibleBrief(undefined) === "", "dramaBibleBrief is '' for a null/undefined bible (backward compat)");

  /* ───────── zod schema: accept valid ───────── */
  ok(dramaBibleSchema.safeParse(validBible()).success, "zod: a fully valid bible passes");

  /* ───────── zod schema: reject out-of-range counts ───────── */
  const tropesLow = clone(validBible()); tropesLow.genreTropes = ["a", "b"]; // 2 < 3
  const tropesHigh = clone(validBible()); tropesHigh.genreTropes = ["a", "b", "c", "d", "e", "f", "g"]; // 7 > 6
  ok(!dramaBibleSchema.safeParse(tropesLow).success, "zod: genreTropes < 3 rejected");
  ok(!dramaBibleSchema.safeParse(tropesHigh).success, "zod: genreTropes > 6 rejected");

  const ladderLow = clone(validBible()); ladderLow.antagonist.escalationLadder = ["a", "b", "c", "d"]; // 4 < 5
  const ladderHigh = clone(validBible()); ladderHigh.antagonist.escalationLadder = ["a", "b", "c", "d", "e", "f", "g", "h"]; // 8 > 7
  ok(!dramaBibleSchema.safeParse(ladderLow).success, "zod: escalationLadder < 5 rejected");
  ok(!dramaBibleSchema.safeParse(ladderHigh).success, "zod: escalationLadder > 7 rejected");

  const secretsLow = clone(validBible()); secretsLow.secrets = secretsLow.secrets.slice(0, 2); // 2 < 3
  const secretsHigh = clone(validBible());
  secretsHigh.secrets = [...secretsHigh.secrets, { secret: "s4", knownBy: ["x"], revealEpisode: 7 }, { secret: "s5", knownBy: ["y"], revealEpisode: 8 }]; // 5 > 4
  ok(!dramaBibleSchema.safeParse(secretsLow).success, "zod: secrets < 3 rejected");
  ok(!dramaBibleSchema.safeParse(secretsHigh).success, "zod: secrets > 4 rejected");

  /* ───────── field-named validators ───────── */
  ok(validateDramaBible(validBible(), { episodeCount: 8 }).ok, "validateDramaBible: valid bible passes with episodeCount");

  const cErr = validateBibleCounts(tropesLow);
  ok(cErr.some((e) => e.field === "genreTropes"), "validator names the failing field: genreTropes");
  ok(validateBibleCounts(ladderLow).some((e) => e.field === "antagonist.escalationLadder"), "validator names the failing field: antagonist.escalationLadder");
  ok(validateBibleCounts(secretsLow).some((e) => e.field === "secrets"), "validator names the failing field: secrets");

  // secret.revealEpisode beyond the season's episode count is rejected (field-named)
  const revealHigh = clone(validBible()); revealHigh.secrets[1].revealEpisode = 99;
  const rhErr = validateSecretReveals(revealHigh, 8);
  ok(rhErr.some((e) => e.field === "secrets[1].revealEpisode"), "secret.revealEpisode beyond episodeCount rejected with field name");
  // and revealEpisode < 1 is rejected too
  const revealZero = clone(validBible()); revealZero.secrets[0].revealEpisode = 0;
  ok(validateSecretReveals(revealZero, 8).some((e) => e.field === "secrets[0].revealEpisode"), "secret.revealEpisode < 1 rejected with field name");
  // whole-bible validation surfaces the out-of-range reveal
  ok(!validateDramaBible(revealHigh, { episodeCount: 8 }).ok, "validateDramaBible fails when a reveal is beyond the season");

  // required non-empty fields
  const noTheme = clone(validBible()); noTheme.theme = "   ";
  ok(validateBibleRequired(noTheme).some((e) => e.field === "theme"), "required validator names an empty theme");

  /* ───────── normalizeDramaBible: never throws + unwrap ───────── */
  let threwN = false;
  try {
    normalizeDramaBible(null);
    normalizeDramaBible("garbage");
    normalizeDramaBible(42);
    normalizeDramaBible({ secrets: "nope", genreTropes: 5 });
  } catch {
    threwN = true;
  }
  ok(!threwN, "normalizeDramaBible never throws on garbage");
  const unwrapped = normalizeDramaBible({ dramaBible: validBible() });
  ok(unwrapped.theme === "Loyalty corrupts when survival is at stake", "normalizeDramaBible unwraps { dramaBible }");
  ok(normalizeDramaBible({ bible: validBible() }).theme.length > 0, "normalizeDramaBible unwraps { bible }");
  ok(Array.isArray(normalizeDramaBible(null).genreTropes) && Array.isArray(normalizeDramaBible(null).secrets), "normalizeDramaBible always yields arrays");

  /* ───────── toDramaBibleForMap: present + absent ───────── */
  ok(toDramaBibleForMap(null) === null, "toDramaBibleForMap(null) is null (season map falls back structurally)");
  const forMap = toDramaBibleForMap(validBible())!;
  ok(!!forMap && (forMap.escalationLadder ?? []).length === 5, "toDramaBibleForMap carries the real 5-step escalation ladder");
  ok((forMap.secrets ?? []).length === 3 && forMap.secrets![0].id === "the heir is alive" && forMap.secrets![0].revealEpisode === 2, "toDramaBibleForMap maps secrets (id = secret text, real revealEpisode)");
  ok(forMap.finaleQuestion === "Will the true heir take the throne without becoming the tyrant?", "toDramaBibleForMap carries the finale question");
  ok(forMap.finaleSecretId === "the ally is a double agent", "toDramaBibleForMap picks the latest-revealed secret as the finale secret");

  /* ───────── season map consuming REAL bible data vs falling back ───────── */
  // Build 8 defaulted cells, then satisfy the schedule from the mapped bible.
  const cells = normalizeSeasonMap(null, { episodeCount: 8, bible: forMap });
  for (const s of forMap.secrets ?? []) {
    const cell = cells.find((c) => c.episode === s.revealEpisode)!;
    cell.secretRevealed = s.id;
  }
  ok(validateSecretSchedule(cells, forMap).length === 0, "season map: secret schedule satisfied when cells reveal the bible secrets on time");
  // Break one reveal → the validator flags it (consuming the real bible)
  const brokenCells: SeasonMapCell[] = cells.map((c) => (c.episode === 4 ? { ...c, secretRevealed: null } : c));
  ok(validateSecretSchedule(brokenCells, forMap).some((e) => e.episode === 4), "season map: a missing scheduled reveal is flagged from the real bible");
  // Absent bible → the schedule rule is skipped (fallback / backward compat)
  ok(validateSecretSchedule(brokenCells, null).length === 0, "season map: no bible ⇒ secret-schedule rule skipped (fallback)");

  // finale with the bible's finale secret: last cell must reveal it
  const finaleCells = cells.map((c) => ({ ...c }));
  const last = finaleCells[finaleCells.length - 1];
  last.beatType = "reveal"; last.cliffhangerType = "reveal"; last.secretRevealed = forMap.finaleSecretId!;
  ok(validateFinale(finaleCells, forMap).length === 0, "season map: finale resolves and reveals the bible's finale secret");
  last.secretRevealed = null;
  ok(validateFinale(finaleCells, forMap).some((e) => e.rule === "finale-resolve"), "season map: finale missing the bible's finale secret is flagged");

  /* ───────── bible → synopsis ORDER (mock chatFn/proseFn) ───────── */
  const order: string[] = [];
  const chatFn: DramaBibleChatFn = async (system) => {
    order.push(system === DRAMA_BIBLE_SYSTEM ? "bible" : "other");
    return validBible();
  };
  const proseFn: DramaBibleProseFn = async (system) => {
    order.push(system === SYNOPSIS_FROM_BIBLE_SYSTEM ? "synopsis" : "other");
    return "A cinematic prose synopsis derived from the bible.";
  };
  const flow = await generateBibleThenSynopsis({ idea: "a deposed heir returns", episodeCount: 8 }, chatFn, proseFn);
  ok(order[0] === "bible" && order.includes("synopsis") && order.indexOf("bible") < order.indexOf("synopsis"), "flow: the bible is generated BEFORE the synopsis (order enforced)");
  ok(flow.bibleValid && flow.synopsis.startsWith("A cinematic prose synopsis"), "flow: returns a valid bible and the derived prose synopsis");

  // synopsisFromBible swallows a throwing prose fn → ""
  const throwingProse: DramaBibleProseFn = async () => { throw new Error("network down"); };
  ok((await synopsisFromBible(validBible(), throwingProse)) === "", "synopsisFromBible swallows a throwing prose fn and returns ''");

  /* ───────── generateDramaBible loop with a pure fake chatFn ───────── */
  // 1) valid on the first try
  let c1 = 0;
  const validFirst: DramaBibleChatFn = async () => { c1++; return validBible(); };
  const r1 = await generateDramaBible({ idea: "x", episodeCount: 8 }, validFirst, { maxRetries: 3 });
  ok(r1.valid && r1.attempts === 1 && c1 === 1, "generate: valid on the first attempt");

  // 2) invalid → valid on retry (first output has too few tropes)
  let c2 = 0;
  const invalidThenValid: DramaBibleChatFn = async () => {
    c2++;
    if (c2 === 1) { const bad = clone(validBible()); bad.genreTropes = ["only-one"]; return bad; }
    return validBible();
  };
  const r2 = await generateDramaBible({ idea: "x", episodeCount: 8 }, invalidThenValid, { maxRetries: 3 });
  ok(r2.valid && r2.attempts === 2 && c2 === 2, "generate: recovers on a targeted retry");

  // 3) persistently invalid → valid:false, attempts = maxRetries+1, never throws, best-effort bible returned
  let c3 = 0;
  const alwaysInvalid: DramaBibleChatFn = async () => { c3++; const bad = clone(validBible()); bad.theme = ""; return bad; };
  let threw3 = false;
  let r3: Awaited<ReturnType<typeof generateDramaBible>> | null = null;
  try { r3 = await generateDramaBible({ idea: "x", episodeCount: 8 }, alwaysInvalid, { maxRetries: 3 }); } catch { threw3 = true; }
  ok(!threw3 && r3 !== null, "generate: persistently invalid never throws");
  ok(r3!.valid === false && r3!.errors.length > 0 && r3!.attempts === 4 && c3 === 4, "generate: exhausts maxRetries+1 attempts, returns valid:false with errors");

  // 4) a chatFn that THROWS (transport failure) is swallowed → best-effort defaulted bible, no throw
  const throwing: DramaBibleChatFn = async () => { throw new Error("network down"); };
  let threw4 = false;
  let r4: Awaited<ReturnType<typeof generateDramaBible>> | null = null;
  try { r4 = await generateDramaBible({ idea: "x", episodeCount: 8 }, throwing, { maxRetries: 1 }); } catch { threw4 = true; }
  ok(!threw4 && r4 !== null && r4!.valid === false, "generate: swallows a throwing chatFn and returns a best-effort invalid bible");

  console.log(`\nStage 169: PASS (${passed} checks)`);
})();
