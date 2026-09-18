/**
 * Stage 2 (Stage171) — tests for the cast + location contract.
 * Pure logic only (no network / no paid gen). Run:
 *   npx tsx --tsconfig tsconfig.json scripts/test-stage171.ts
 */
import type { DramaBible } from "@/lib/prompts/drama-bible";
import {
  CAST_PROMPT_VERSION,
  CAST_MAIN_MIN,
  CAST_MAIN_MAX,
  CAST_SUPPORT_MIN,
  CAST_SUPPORT_MAX,
  CAST_NAMED_MAX,
  CAST_LOCATIONS_MIN,
  CAST_LOCATIONS_MAX,
  CAST_SPEECH_TICS_MIN,
  CAST_SPEECH_TICS_MAX,
  isNamedTier,
  isMainTier,
  isSupportTier,
  mainCastSeedFromBible,
  secretsKnownFor,
  relationshipsToFor,
  threadBibleIntoCharacter,
  castUserPrompt,
  type PlannedCharacter,
  type PlannedLocation,
} from "@/lib/prompts/cast";
import {
  validateCastSize,
  validateCharacterDepth,
  validateLocations,
  validateCast,
  normalizeCharacter,
  normalizeLocation,
} from "@/lib/cast";

let passed = 0;
function ok(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exit(1);
  }
  passed++;
  console.log("ok: " + msg);
}

/* ───────── constants ───────── */
ok(CAST_PROMPT_VERSION === "6.6.0", "CAST_PROMPT_VERSION is 6.6.0");
ok(CAST_MAIN_MIN === 3 && CAST_MAIN_MAX === 5, "MAIN bounds 3-5");
ok(CAST_SUPPORT_MIN === 2 && CAST_SUPPORT_MAX === 4, "SUPPORT bounds 2-4");
ok(CAST_NAMED_MAX === 8, "NAMED max 8");
ok(CAST_LOCATIONS_MIN === 4 && CAST_LOCATIONS_MAX === 7, "LOCATIONS bounds 4-7");
ok(CAST_SPEECH_TICS_MIN === 2 && CAST_SPEECH_TICS_MAX === 3, "SPEECH_TICS bounds 2-3");

/* ───────── tier guards ───────── */
ok(isNamedTier("MAIN") && isNamedTier("SUPPORT") && isNamedTier("SUPPORTING") && isNamedTier("MINOR"), "isNamedTier true for named tiers");
ok(!isNamedTier("CROWD") && !isNamedTier("") && !isNamedTier(null), "isNamedTier false for CROWD/empty/null");
ok(isNamedTier("main"), "isNamedTier case-insensitive");
ok(isMainTier("MAIN") && !isMainTier("SUPPORT"), "isMainTier only MAIN");
ok(isSupportTier("SUPPORT") && isSupportTier("SUPPORTING") && !isSupportTier("MAIN"), "isSupportTier SUPPORT/SUPPORTING");

/* ───────── fixtures ───────── */
const named = (name: string, tier: PlannedCharacter["tier"]): PlannedCharacter => ({
  name,
  tier,
  voiceProfile: `${name} voice — warm, measured`,
  speechTics: ["clears throat", "trails off mid-sentence"],
});

const validChars: PlannedCharacter[] = [
  named("Mara", "MAIN"),
  named("Idris", "MAIN"),
  named("Selin", "MAIN"),
  named("Kofi", "SUPPORT"),
  named("Ana", "SUPPORT"),
  { name: "Market crowd", tier: "CROWD" }, // nameless background — exempt from depth
];

const validLocs: PlannedLocation[] = [
  { name: "Harbor market", dramaticFunction: "Where the leads first collide." },
  { name: "Back office", dramaticFunction: "Where the secret is kept.", isInterior: true, regionPlate: "plate-office-A", setInventory: ["desk — center", "safe — back wall"] },
  { name: "Rooftop", dramaticFunction: "Where confessions happen." },
  { name: "Stairwell", dramaticFunction: "The pressure corridor.", isInterior: true, regionPlate: "plate-stair-B", setInventory: ["railing — left"] },
];

/* ───────── size validator ───────── */
ok(validateCastSize(validChars).length === 0, "size: valid cast passes");
ok(validateCastSize([...validChars, named("X1", "MAIN"), named("X2", "MAIN"), named("X3", "MINOR"), named("X4", "MINOR")]).some((e) => e.field === "characters.named"), "size: >8 named fails on characters.named");
ok(validateCastSize([named("A", "MAIN"), named("B", "MAIN"), ...validChars.filter((c) => isSupportTier(c.tier))]).some((e) => e.field === "characters.MAIN"), "size: MAIN<3 fails");
ok(validateCastSize([named("A", "MAIN"), named("B", "MAIN"), named("C", "MAIN"), named("D", "MAIN"), named("E", "MAIN"), named("F", "MAIN"), named("G", "SUPPORT"), named("H", "SUPPORT")]).some((e) => e.field === "characters.MAIN"), "size: MAIN>5 fails");
ok(validateCastSize([named("A", "MAIN"), named("B", "MAIN"), named("C", "MAIN"), named("D", "SUPPORT")]).some((e) => e.field === "characters.SUPPORT"), "size: SUPPORT<2 fails");
ok(validateCastSize([named("A", "MAIN"), named("B", "MAIN"), named("C", "MAIN"), named("D", "SUPPORT"), named("E", "SUPPORT"), named("F", "SUPPORT"), named("G", "SUPPORT"), named("H", "SUPPORT")]).some((e) => e.field === "characters.SUPPORT"), "size: SUPPORT>4 fails");

/* ───────── depth validator ───────── */
ok(validateCharacterDepth(validChars).length === 0, "depth: valid cast passes");
ok(validateCharacterDepth([{ name: "NoVoice", tier: "MAIN", speechTics: ["a", "b"] }]).some((e) => e.field === "characters[NoVoice].voiceProfile"), "depth: missing voiceProfile fails");
ok(validateCharacterDepth([{ name: "OneTic", tier: "MAIN", voiceProfile: "v", speechTics: ["a"] }]).some((e) => e.field === "characters[OneTic].speechTics"), "depth: <2 speechTics fails");
ok(validateCharacterDepth([{ name: "FourTic", tier: "MAIN", voiceProfile: "v", speechTics: ["a", "b", "c", "d"] }]).some((e) => e.field === "characters[FourTic].speechTics"), "depth: >3 speechTics fails");
ok(validateCharacterDepth([{ name: "Crowd", tier: "CROWD" }]).length === 0, "depth: CROWD exempt");

/* ───────── location validator ───────── */
ok(validateLocations(validLocs).length === 0, "loc: valid locations pass");
ok(validateLocations(validLocs.slice(0, 2)).some((e) => e.field === "locations"), "loc: <4 locations fails");
ok(validateLocations([...validLocs, ...validLocs]).some((e) => e.field === "locations"), "loc: >7 locations fails");
ok(validateLocations([{ name: "NoFunc", dramaticFunction: "" }, ...validLocs.slice(1)]).some((e) => e.field === "locations[NoFunc].dramaticFunction"), "loc: missing dramaticFunction fails");
ok(validateLocations([{ name: "IntNoPlate", dramaticFunction: "x", isInterior: true, setInventory: ["a"] }, ...validLocs.slice(1)]).some((e) => e.field === "locations[IntNoPlate].regionPlate"), "loc: interior missing regionPlate fails");
ok(validateLocations([{ name: "IntNoInv", dramaticFunction: "x", isInterior: true, regionPlate: "p", setInventory: [] }, ...validLocs.slice(1)]).some((e) => e.field === "locations[IntNoInv].setInventory"), "loc: interior missing setInventory fails");

/* ───────── aggregate ───────── */
ok(validateCast(validChars, validLocs).ok === true, "aggregate: valid cast+locations ok");
ok(validateCast([], []).ok === false, "aggregate: empty fails");

/* ───────── bible threading ───────── */
const bible: DramaBible = {
  theme: "Trust is a debt.",
  genreTropes: ["heist", "family drama"],
  protagonist: { want: "the ledger", need: "to forgive", flaw: "pride", arcStart: "closed", arcEnd: "open" },
  antagonist: { goal: "buy the harbor", pressureMechanism: "debt collection", escalationLadder: ["warning", "seizure"] },
  secrets: [
    { secret: "The ledger is forged.", knownBy: ["Mara", "Idris"], revealEpisode: 5 },
    { secret: "Selin is an informant.", knownBy: ["Selin"], revealEpisode: 7 },
  ],
  midpointReversal: "The forgery is exposed.",
  finaleQuestion: "Will Mara forgive?",
  bLine: { conflict: "Kofi vs Ana over the shop", characters: ["Kofi", "Ana"] },
  relationships: [
    { a: "Mara", b: "Idris", dynamic: "estranged siblings", tension: "old betrayal" },
    { a: "Kofi", b: "Ana", dynamic: "rival vendors", tension: "shared lease" },
  ],
};

const seed = mainCastSeedFromBible(bible);
ok(seed.includes("Kofi") && seed.includes("Ana") && seed.includes("Mara") && seed.includes("Idris"), "seed: from bLine + relationships");
ok(secretsKnownFor("Mara", bible).includes("The ledger is forged."), "secretsKnownFor: Mara knows forged ledger");
ok(secretsKnownFor("Kofi", bible).length === 0, "secretsKnownFor: Kofi knows nothing");
const relMara = relationshipsToFor("Mara", bible);
ok(relMara["Idris"] === "estranged siblings", "relationshipsToFor: Mara->Idris");
const relIdris = relationshipsToFor("Idris", bible);
ok(relIdris["Mara"] === "estranged siblings", "relationshipsToFor: reverse direction Idris->Mara");
const threaded = threadBibleIntoCharacter({ name: "Mara", tier: "MAIN", voiceProfile: "v", speechTics: ["a", "b"] }, bible);
ok((threaded.secretsKnown ?? []).includes("The ledger is forged."), "thread: fills secretsKnown");
ok((threaded.relationshipsTo ?? {})["Idris"] === "estranged siblings", "thread: fills relationshipsTo");

/* ───────── defensive (no bible) ───────── */
ok(mainCastSeedFromBible(null).length === 0, "defensive: no bible seed is empty");
ok(mainCastSeedFromBible(undefined).length === 0, "defensive: undefined bible seed is empty");
ok(secretsKnownFor("Mara", null).length === 0, "defensive: no bible secrets empty");
ok(Object.keys(relationshipsToFor("Mara", null)).length === 0, "defensive: no bible relationships empty");
const unchanged = threadBibleIntoCharacter({ name: "Z", tier: "MAIN" }, null);
ok(unchanged.name === "Z" && !unchanged.secretsKnown?.length, "defensive: thread with no bible returns char unchanged");
ok(typeof castUserPrompt(null) === "string" && castUserPrompt(null).length > 0, "defensive: castUserPrompt(null) returns non-empty string");

/* ───────── prompt building ───────── */
const prompt = castUserPrompt(bible, { dialogueLanguage: "Turkish", setting: "Istanbul harbor" });
ok(prompt.includes("Turkish") && prompt.includes("Istanbul harbor"), "prompt: includes dialogue language + setting");
ok(prompt.includes("Kofi") && prompt.includes("The ledger is forged."), "prompt: includes seed + secrets");
ok(castUserPrompt(null).toLowerCase().includes("no drama bible"), "prompt: no-bible branch degrades gracefully");

/* ───────── normalizers (never throw) ───────── */
const nc = normalizeCharacter({ name: " Mara ", tier: "main", speechTics: ["a", "", "b"], relationshipsTo: { Idris: "x", Bad: 3 } });
ok(nc.name === "Mara" && nc.tier === "MAIN" && (nc.speechTics ?? []).length === 2, "normalizeCharacter: trims + coerces");
ok((nc.relationshipsTo ?? {})["Idris"] === "x" && !("Bad" in (nc.relationshipsTo ?? {})), "normalizeCharacter: drops non-string relations");
ok(normalizeCharacter(null).tier === "CROWD", "normalizeCharacter: null -> CROWD default, no throw");
const nl = normalizeLocation({ name: "X", isInterior: 1, setInventory: ["a", 2] });
ok(nl.isInterior === true && (nl.setInventory ?? []).length === 1, "normalizeLocation: coerces, no throw");

console.log(`\nStage 171: PASS (${passed} checks)`);
