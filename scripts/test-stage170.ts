/**
 * Stage 170 (task Stage 4) — pure-logic tests for the live SeasonState world-state.
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage170.ts
 */
import {
  seedSeasonState,
  renderSeasonStateBlock,
  validateSeasonStateShape,
  validateContradictions,
  normalizeSeasonState,
  generateSeasonStateUpdate,
  toSceneSeasonState,
  SEASON_STATE_PROMPT_VERSION,
  type SeasonStateData,
} from "../lib/season-state";
import { episodeScriptUserPrompt } from "../lib/season";
import { shotCharacterBlock, type ShotPromptInput } from "../lib/prompts/shot";

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  passed++;
}

/* ---------- a clean, valid state fixture ---------- */
function cleanState(): SeasonStateData {
  return {
    characters: [
      { id: "anna", name: "Anna", location: "kitchen", physicalState: "tired", wardrobe: "red coat", knows: ["the letter exists"], wants: "escape", relationships: { Boris: "distrust" }, arcStage: "denial" },
      { id: "boris", name: "Boris", location: "garage", physicalState: "unhurt", wardrobe: "grey suit", knows: [], wants: "control", relationships: { Anna: "obsession" }, arcStage: "setup" },
    ],
    props: [{ id: "letter", holder: "Anna", location: null, state: "intact" }],
    openThreads: ["Who sent the letter?"],
    plantedSetups: [{ setup: "hidden safe behind the painting", payoffEpisode: 5 }],
    revealedToAudience: ["the letter exists"],
    lastSceneEndState: "Anna clutches the letter as headlights sweep the kitchen.",
  };
}

void (async () => {
/* ---------- 1. shape validator: accept / reject ---------- */
ok(validateSeasonStateShape(cleanState()).length === 0, "clean state passes shape validation");
ok(validateSeasonStateShape({ characters: "nope" }).length > 0, "malformed state is rejected by shape validation");
ok(validateSeasonStateShape(null).length > 0, "null is rejected by shape validation");

/* ---------- 2. seeding from cast + bible ---------- */
const seeded = seedSeasonState(
  [
    { id: "c1", name: "Anna", appearance: "young woman, red coat" },
    { id: "c2", name: "Boris", appearance: "older man, grey suit" },
  ],
  {
    theme: "trust", genreTropes: [], protagonist: { want: "", need: "", flaw: "", arcStart: "", arcEnd: "" },
    antagonist: { goal: "", pressureMechanism: "", escalationLadder: [] },
    secrets: [{ secret: "Boris killed the father", knownBy: ["Boris"], revealEpisode: 6 }],
    midpointReversal: "", finaleQuestion: "Will Anna escape?", bLine: { conflict: "", characters: [] },
    relationships: [{ a: "Anna", b: "Boris", dynamic: "distrust", tension: "power imbalance" }],
  } as any,
);
ok(seeded.characters.length === 2, "seed creates one character per cast member");
ok(seeded.characters[0].wardrobe === "young woman, red coat", "seed uses appearance as initial wardrobe");
ok(seeded.characters[0].relationships["Boris"] === "distrust", "seed enriches relationships from the bible");
ok(seeded.openThreads.includes("Will Anna escape?"), "seed seeds the finale question as an open thread");
ok(seeded.plantedSetups.some((s) => s.setup === "Boris killed the father" && s.payoffEpisode === 6), "seed maps bible secrets to planted setups");
ok(validateSeasonStateShape(seeded).length === 0, "seeded state is shape-valid");

/* ---------- 3. renderer ---------- */
const block = renderSeasonStateBlock(cleanState(), 6);
ok(block.includes("Anna") && block.includes("red coat") && block.includes("kitchen"), "render includes character location + wardrobe");
ok(block.includes("letter") && block.includes("held by Anna"), "render includes live props with holder");
ok(block.includes("Who sent the letter?"), "render includes open threads");
ok(block.includes("hidden safe") && block.includes("payoff DUE"), "render marks a setup whose payoff is due");
ok(block.includes("Anna clutches the letter"), "render includes the last-scene end state");

/* ---------- 4. contradiction validator per type + clean pass ---------- */
ok(validateContradictions(cleanState()).length === 0, "clean state has no contradictions");

// (1) character in two places
const twoPlaces = cleanState();
twoPlaces.characters.push({ ...twoPlaces.characters[0], location: "rooftop" });
ok(validateContradictions(twoPlaces).some((e) => e.field === "characters[Anna].location"), "flags a character in two locations");

// (2a) prop held but destroyed
const destroyedHeld = cleanState();
destroyedHeld.props = [{ id: "letter", holder: "Anna", location: null, state: "destroyed in the fire" }];
ok(validateContradictions(destroyedHeld).some((e) => e.field === "props[letter].holder"), "flags a destroyed prop that is still held");

// (2b) prop held by unknown character
const unknownHolder = cleanState();
unknownHolder.props = [{ id: "letter", holder: "Ghost", location: null, state: "intact" }];
ok(validateContradictions(unknownHolder).some((e) => e.field === "props[letter].holder" && /unknown/.test(e.message)), "flags a prop held by an unknown character");

// (3) character knows an un-revealed fact
const knowsUnrevealed = cleanState();
knowsUnrevealed.characters[1].knows = ["the secret ending"];
ok(validateContradictions(knowsUnrevealed, { requireRevealedKnowledge: true }).some((e) => e.field === "characters[Boris].knows"), "flags knowing an un-revealed fact");

// (4) conflicting wardrobe / physical
const conflictWardrobe = cleanState();
conflictWardrobe.characters.push({ ...conflictWardrobe.characters[0], wardrobe: "black dress" });
ok(validateContradictions(conflictWardrobe).some((e) => e.field === "characters[Anna].wardrobe"), "flags conflicting wardrobe entries");

// (5) referencing a closed thread (overdue setup still open)
const overdue = cleanState();
ok(validateContradictions(overdue, { reflectsEpisodeNumber: 8 }).some((e) => e.field.startsWith("plantedSetups[")), "flags an overdue planted setup at a later episode");

/* ---------- 5. update mapping with mock chatFn (generate -> validate -> retry) ---------- */
const updatedJson: SeasonStateData = cleanState();
updatedJson.characters[0].location = "rooftop";
updatedJson.lastSceneEndState = "Anna steps onto the rooftop ledge.";
let calls = 0;
const goodChat = async () => {
  calls++;
  return { state: updatedJson };
};
const res = await generateSeasonStateUpdate(
  { currentState: cleanState(), episodeScript: "INT. ROOFTOP ...", episodeNumber: 2, seasonTitle: "S1" },
  goodChat,
);
ok(res.valid === true, "valid update returns valid:true");
ok(res.attempts === 1, "valid update succeeds on the first attempt");
ok(res.state.characters[0].location === "rooftop", "update maps the LLM output into the new state");
ok(res.version === SEASON_STATE_PROMPT_VERSION, "update stamps the prompt version");

// retry: first attempt returns a contradiction, second returns clean
let n = 0;
const flakyChat = async () => {
  n++;
  if (n === 1) {
    const bad = cleanState();
    bad.characters.push({ ...bad.characters[0], location: "elsewhere" }); // two places
    return { state: bad };
  }
  return { state: cleanState() };
};
const res2 = await generateSeasonStateUpdate(
  { currentState: cleanState(), episodeScript: "...", episodeNumber: 3 },
  flakyChat,
  { maxRetries: 2 },
);
ok(res2.attempts === 2 && res2.valid === true, "a contradicting first attempt triggers a targeted retry that then passes");

// never throws on transport failure
const throwChat = async () => { throw new Error("boom"); };
const res3 = await generateSeasonStateUpdate({ currentState: cleanState(), episodeScript: "x", episodeNumber: 1 }, throwChat, { maxRetries: 1 });
ok(res3.attempts >= 1 && !!res3.state && Array.isArray(res3.state.characters), "generate never throws on transport failure and returns a best-effort state");

/* ---------- 6. normalizer never throws ---------- */
ok(normalizeSeasonState(null).characters.length === 0, "normalize(null) yields an empty well-formed state");
ok(normalizeSeasonState({ state: cleanState() }).characters.length === 2, "normalize unwraps a {state:...} wrapper");
const junk = normalizeSeasonState({ characters: [{ name: "X", location: 5, knows: "no" }], props: "bad" });
ok(junk.characters[0].id === "x" && junk.characters[0].knows.length === 0 && junk.props.length === 0, "normalize coerces junk into safe defaults");

/* ---------- 7. next-episode prompt uses state vs falls back to the tail ---------- */
const baseArgs = {
  synopsis: "syn", season: { title: "S", logline: "L" } as any,
  episode: { number: 2, title: "Two", arcRole: "rising", logline: "lg", cliffhanger: "cliff", locationName: "Bar", locationDesc: "a dim bar", characters: ["Anna"], description: "desc" } as any,
  characters: [{ name: "Anna" } as any],
  previous: [{ number: 1, title: "One", logline: "l1", cliffhanger: "c1" }],
  previousEnding: { number: 1, title: "One", cliffhanger: "c1", endState: "OLD END STATE", tail: "OLD TAIL TEXT" },
};
const withState = episodeScriptUserPrompt({ ...baseArgs, seasonStateBlock: renderSeasonStateBlock(cleanState(), 2) });
ok(withState.includes("SEASON STATE") && withState.includes("red coat"), "next-episode prompt uses the SeasonState block when present");
ok(!withState.includes("OLD TAIL TEXT"), "SeasonState block REPLACES the old previous-episode text tail");
const withoutState = episodeScriptUserPrompt(baseArgs);
ok(withoutState.includes("OLD TAIL TEXT") && !withoutState.includes("SEASON STATE"), "falls back to the previous-episode tail when no SeasonState");

/* ---------- 8. shot CHARACTER block: wardrobe from state vs fallback ---------- */
const shotBase: ShotPromptInput = {
  characters: [{ characterId: "anna", name: "Anna", appearance: "young woman", wardrobe: "default jacket" }],
  shot: { size: "CU", type: "clean-single" } as any,
};
const shotWithState = shotCharacterBlock({ ...shotBase, seasonState: toSceneSeasonState(cleanState()) });
ok(shotWithState.includes("wardrobe: red coat"), "shot CHARACTER block reads wardrobe from SeasonState when present");
ok(shotWithState.includes("physical: tired"), "shot CHARACTER block reads physicalState from SeasonState when present");
const shotNoState = shotCharacterBlock(shotBase);
ok(shotNoState.includes("wardrobe: default jacket"), "shot CHARACTER block falls back to per-shot wardrobe when no SeasonState");

/* ---------- 9. backward compat: mapper + empty state ---------- */
ok(toSceneSeasonState(null) === null, "toSceneSeasonState(null) returns null (structural fallback)");
const mapped = toSceneSeasonState(cleanState());
ok(!!mapped && mapped.characters!.length === 2 && mapped.lastSceneEndState!.includes("Anna clutches"), "toSceneSeasonState projects the minimal scene slice");

console.log(`\nStage 170: PASS (${passed} checks)`);
})().catch((e) => { console.error(e); process.exit(1); });
