/**
 * Stage 54 unit tests (no live API). Two parts:
 *   A) EPISODE PROP REGISTRY (lib/prop-registry.ts): hash / parse / validate / cache-by-hash /
 *      mock-LLM extraction / verbatim substitution matcher — all pure & deterministic.
 *   B) SECTIONED SCENE PROMPT (lib/scene-prompt.ts): the deterministic REFERENCE MAP + PEOPLE IN
 *      FRAME (exact people counter) + CLOTHING & PROPS (verbatim prop substitution) + fixed NEGATIVES,
 *      section order after the OPENING/END STATE blocks, no full location re-description, override
 *      untouched. Proven WITHOUT any live paid video generation.
 */
import assert from "node:assert";
import {
  buildScenePrompt,
  OPENING_STATE_PREFIX,
  END_STATE_PREFIX,
  SCENE_SECTION,
  buildPeopleCounter,
  buildReferenceMap,
  buildPropsSection,
  buildNegatives,
} from "../lib/scene-prompt";
import {
  propSlug,
  propRegistryHash,
  parsePropRegistry,
  validatePropRegistryResult,
  matchPropsInText,
  buildPropRegistry,
  PROP_REGISTRY_CAP,
  type PropLLM,
  type PropRegistryEntry,
} from "../lib/prop-registry";
import { VISUAL_STYLE_ID } from "../lib/visual-style";

let n = 0;
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); n++; };

// A bare secure-URL literal in a test file gets an autolinker injected into it — build URLs indirectly.
const proto = "htt" + "ps:/" + "/";
const styledUrl = (k: string) => `${proto}cdn.example.com/public/references/p1/${VISUAL_STYLE_ID}/${k}.jpg`;

// ─────────────────────────────────────────────────────────────────────────────
// PART A — PROP REGISTRY (pure)
// ─────────────────────────────────────────────────────────────────────────────

// A1. propSlug — deterministic, url-safe, stable id.
{
  ok("A1: slug lowercases + hyphenates", propSlug("Blue Enamel Tin") === "blue-enamel-tin");
  ok("A1: slug strips punctuation & edges", propSlug("  The 'Red' Envelope!  ") === "the-red-envelope");
  ok("A1: empty name → 'prop'", propSlug("") === "prop" && propSlug("!!!") === "prop");
}

// A2. propRegistryHash — invariant to surrounding whitespace, sensitive to content.
{
  ok("A2: hash ignores outer whitespace", propRegistryHash("  the script  ") === propRegistryHash("the script"));
  ok("A2: hash changes with content", propRegistryHash("scene one") !== propRegistryHash("scene two"));
  ok("A2: empty / null hash equal & stable", propRegistryHash("") === propRegistryHash(null) && propRegistryHash("").length > 0);
}

// A3. validatePropRegistryResult — accepts array OR {props}, needs name + desc>=8, dedupes by slug, caps.
{
  const arr = validatePropRegistryResult([
    { name: "Blue tin", description: "a small round blue enamel tin with a dented lid" },
    { name: "Blue Tin", description: "DUPLICATE by slug — dropped" },
    { name: "Ledger", description: "short" },              // desc < 8 chars → dropped
    { name: "", description: "no name here at all" },       // no name → dropped
    { description: "no name key" },                          // no name → dropped
    { name: "Brass key", description: "a heavy tarnished brass key on a red ribbon" },
  ]);
  ok("A3: keeps only valid, dedupes by slug", arr.length === 2 && arr[0].name === "Blue tin" && arr[1].name === "Brass key");
  ok("A3: assigns slug id", arr[0].id === "blue-tin" && arr[1].id === "brass-key");
  ok("A3: accepts {props:[...]} wrapper", validatePropRegistryResult({ props: [{ name: "Lamp", description: "a green banker's lamp" }] }).length === 1);
  ok("A3: garbage → []", validatePropRegistryResult(null).length === 0 && validatePropRegistryResult("nope" as unknown).length === 0 && validatePropRegistryResult({}).length === 0);
  const many = validatePropRegistryResult(Array.from({ length: PROP_REGISTRY_CAP + 8 }, (_, i) => ({ name: `Prop ${i}`, description: `canonical description number ${i}` })));
  ok("A3: caps at PROP_REGISTRY_CAP", many.length === PROP_REGISTRY_CAP);
  ok("A3: collapses newlines in description", validatePropRegistryResult([{ name: "Map", description: "a folded\n  paper map\nwith red ink" }])[0].description === "a folded paper map with red ink");
}

// A4. parsePropRegistry — round-trips a stored snapshot, rejects malformed.
{
  const snap = JSON.stringify({ hash: "abc", props: [{ id: "blue-tin", name: "Blue tin", description: "a small blue enamel tin" }] });
  const parsed = parsePropRegistry(snap);
  ok("A4: parses a valid snapshot", !!parsed && parsed!.hash === "abc" && parsed!.props.length === 1 && parsed!.props[0].name === "Blue tin");
  ok("A4: null / malformed → null", parsePropRegistry(null) === null && parsePropRegistry("{not json") === null && parsePropRegistry(JSON.stringify({ hash: 1 })) === null);
  ok("A4: drops non-conforming prop entries", parsePropRegistry(JSON.stringify({ hash: "h", props: [{ name: "ok", description: "kept here" }, { name: 5 }] }))!.props.length === 1);
}

// A5. matchPropsInText — case-insensitive substring on the NAME, registry order preserved.
{
  const props: PropRegistryEntry[] = [
    { id: "blue-tin", name: "blue tin", description: "a small round blue enamel tin" },
    { id: "brass-key", name: "brass key", description: "a heavy tarnished brass key" },
    { id: "red-envelope", name: "red envelope", description: "a sealed crimson paper envelope" },
  ];
  ok("A5: matches by name, case-insensitive", matchPropsInText(props, "She grabs the BLUE TIN and a Red Envelope.").map(p => p.id).join(",") === "blue-tin,red-envelope");
  ok("A5: preserves registry order (not text order)", matchPropsInText(props, "red envelope ... blue tin").map(p => p.id).join(",") === "blue-tin,red-envelope");
  ok("A5: no mention → []", matchPropsInText(props, "an empty room").length === 0);
  ok("A5: empty text / no props → []", matchPropsInText(props, "").length === 0 && matchPropsInText([], "blue tin").length === 0);
}

// A6. buildPropRegistry — mock LLM, cache-by-hash, invalid → empty (never throws).
async function testBuildPropRegistry() {
  const script = "INT. SHOP. Anna hides the blue tin. Later she opens the blue tin again.";
  let calls = 0;
  const goodLLM: PropLLM = async () => { calls++; return { props: [{ name: "blue tin", description: "a small round blue enamel tin with a dented lid" }] }; };

  const first = await buildPropRegistry(script, null, goodLLM);
  ok("A6: fresh extraction runs the LLM once", calls === 1 && !first.fromCache && first.registry.props.length === 1);
  ok("A6: registry hash matches the script hash", first.registry.hash === propRegistryHash(script));

  const cached = await buildPropRegistry(script, first.registry, goodLLM);
  ok("A6: same script → cache hit, no second LLM call", cached.fromCache && calls === 1 && cached.registry.props[0].name === "blue tin");

  const changed = await buildPropRegistry(script + " New ending.", first.registry, goodLLM);
  ok("A6: changed script → re-extraction", !changed.fromCache && calls === 2);

  const throwing: PropLLM = async () => { throw new Error("boom"); };
  const failed = await buildPropRegistry(script, null, throwing);
  ok("A6: LLM failure → empty registry + warning, never throws", failed.registry.props.length === 0 && !!failed.warning && !failed.fromCache);

  const empty = await buildPropRegistry("   ", null, throwing);
  ok("A6: empty script → empty registry without calling the LLM", empty.registry.props.length === 0 && !empty.warning);
}

// ─────────────────────────────────────────────────────────────────────────────
// PART B — SECTIONED SCENE PROMPT
// ─────────────────────────────────────────────────────────────────────────────

// B0. Pure section builders.
{
  ok("B0: 1 person counter", buildPeopleCounter([{ name: "Anna" }], false) === `${SCENE_SECTION.people}: In frame exactly one person: Anna. No other people in frame.`);
  ok("B0: N people counter", buildPeopleCounter([{ name: "Anna" }, { name: "Mark" }], false) === `${SCENE_SECTION.people}: In frame exactly 2 people: Anna, Mark. No other people in frame.`);
  ok("B0: people + crowd", /Plus a background crowd \(extras\) behind them; no other named individuals in frame\.$/.test(buildPeopleCounter([{ name: "Anna" }], true)));
  ok("B0: crowd only (no named)", /only a background crowd/.test(buildPeopleCounter([], true)));
  ok("B0: no cast at all → empty", buildPeopleCounter([], false) === "");
  ok("B0: reference map lists images in order", buildReferenceMap([{ name: "Anna" }, { name: "Mark" }], "Kitchen", []).startsWith(`${SCENE_SECTION.referenceMap}: Image1 = Anna, Image2 = Mark`));
  ok("B0: reference map mentions same place / same light, not a full description", /same place, same light/.test(buildReferenceMap([{ name: "Anna" }], "Kitchen", [])));
  ok("B0: props section joins verbatim descriptions", buildPropsSection([{ id: "t", name: "tin", description: "a blue tin" }, { id: "k", name: "key", description: "a brass key" }]) === `${SCENE_SECTION.props}: a blue tin; a brass key.`);
  ok("B0: empty props → empty section", buildPropsSection([]) === "");
  ok("B0: negatives base", buildNegatives(false).startsWith(`${SCENE_SECTION.negatives}: no logos`) && /no other people in frame than described above\.$/.test(buildNegatives(false)));
  ok("B0: negatives add narration-only bits", /no background music over the narration/.test(buildNegatives(true)) && /lips move to the off-screen narration/.test(buildNegatives(true)));
}

// Shared scene fixture.
const baseScene = {
  id: "s1", number: 1, sceneKind: null, voiceover: null, language: "en",
  locationDesc: "Kitchen", continuesFrom: "new-sequence", startState: "", endState: "",
  promptOverride: null,
};
const loc = { id: "loc", name: "Kitchen", imageUrl: styledUrl("k-wide"), imageReverse: styledUrl("k-rev"), imageDetail: styledUrl("k-det"), imageExtra: null };
const char = (name: string, tier = "MAIN") => ({ characterId: name.toLowerCase(), name, tier, appearance: "x", age: null, imageFull: styledUrl(`${name.toLowerCase()}-full`), imageFront: styledUrl(`${name.toLowerCase()}-front`) });

// B1. People counter is injected from the ACTUAL cast, not the text.
{
  const scene = { ...baseScene, videoPrompt: "[SHOT TYPE]: medium. [ACTION]: Anna and Mark talk.", dialogue: 'ANNA: "Now."', dialogueEn: 'ANNA: "Now."' };
  const one = buildScenePrompt({ scene, characters: [char("Anna")], location: loc, previous: null, provider: "seedance" });
  ok("B1: single-person counter present", one.prompt.includes(`${SCENE_SECTION.people}: In frame exactly one person: Anna. No other people in frame.`));
  const two = buildScenePrompt({ scene, characters: [char("Anna"), char("Mark")], location: loc, previous: null, provider: "seedance" });
  ok("B1: two-person counter present", two.prompt.includes(`${SCENE_SECTION.people}: In frame exactly 2 people: Anna, Mark. No other people in frame.`));
  const crowd = buildScenePrompt({ scene, characters: [char("Anna"), char("Guests", "CROWD")], location: loc, previous: null, provider: "seedance" });
  ok("B1: crowd handled as background, not counted as a named person", /In frame exactly one person: Anna\. Plus a background crowd/.test(crowd.prompt) && !crowd.prompt.includes("2 people"));
  const broll = buildScenePrompt({ scene: { ...scene, videoPrompt: "[SHOT TYPE]: wide. [ACTION]: empty street." }, characters: [], location: loc, previous: null, provider: "seedance" });
  ok("B1: no cast → no false counter", !broll.prompt.includes(SCENE_SECTION.people));
}

// B2. Reference map present; no full location re-description.
{
  const scene = { ...baseScene, videoPrompt: "[SHOT TYPE]: medium. [ACTION]: Anna waits.", dialogue: "", dialogueEn: "" };
  const b = buildScenePrompt({ scene, characters: [char("Anna")], location: loc, previous: null, provider: "seedance" });
  ok("B2: reference map present, binds Image1 to the character", b.prompt.includes(`${SCENE_SECTION.referenceMap}: Image1 = Anna`));
  ok("B2: reference map names the location by name + several angles", /the location "Kitchen" from several angles/.test(b.prompt));
  ok("B2: location is NOT fully re-described (only same place/light)", /same place, same light/.test(b.prompt));
}

// B3. VERBATIM prop substitution — the same registry across two different scenes.
{
  const props: PropRegistryEntry[] = [
    { id: "blue-tin", name: "blue tin", description: "a small round blue enamel tin with a dented lid and a faded gold rim" },
    { id: "brass-key", name: "brass key", description: "a heavy tarnished brass key on a frayed red ribbon" },
  ];
  const sceneA = { ...baseScene, videoPrompt: "[SHOT TYPE]: close. [ACTION]: Anna hides the blue tin.", dialogue: "", dialogueEn: "" };
  const sceneB = { ...baseScene, id: "s5", number: 5, videoPrompt: "[SHOT TYPE]: close. [ACTION]: Anna opens the blue tin with a brass key.", dialogue: "", dialogueEn: "" };
  const a = buildScenePrompt({ scene: sceneA, characters: [char("Anna")], location: loc, previous: null, provider: "seedance", props });
  const bb = buildScenePrompt({ scene: sceneB, characters: [char("Anna")], location: loc, previous: null, provider: "seedance", props });
  ok("B3: scene A shows only the matched prop (blue tin)", a.prompt.includes(`${SCENE_SECTION.props}: ${props[0].description}.`) && !a.prompt.includes(props[1].description));
  ok("B3: scene B shows both matched props in registry order", bb.prompt.includes(`${SCENE_SECTION.props}: ${props[0].description}; ${props[1].description}.`));
  ok("B3: the SHARED prop reads IDENTICALLY in both scenes (verbatim)", a.prompt.includes(props[0].description) && bb.prompt.includes(props[0].description));
  const none = buildScenePrompt({ scene: { ...baseScene, videoPrompt: "[SHOT TYPE]: wide. [ACTION]: an empty room.", dialogue: "", dialogueEn: "" }, characters: [char("Anna")], location: loc, previous: null, provider: "seedance", props });
  ok("B3: a scene mentioning none of the props has no CLOTHING & PROPS section", !none.prompt.includes(SCENE_SECTION.props));
  const noReg = buildScenePrompt({ scene: sceneB, characters: [char("Anna")], location: loc, previous: null, provider: "seedance" });
  ok("B3: without a registry there is no props section (graceful fallback)", !noReg.prompt.includes(SCENE_SECTION.props));
}

// B4. NEGATIVES present on auto prompts; narration adds the audio-only bits.
{
  const scene = { ...baseScene, videoPrompt: "[SHOT TYPE]: medium. [ACTION]: Anna waits.", dialogue: 'ANNA: "Now."', dialogueEn: 'ANNA: "Now."' };
  const b = buildScenePrompt({ scene, characters: [char("Anna")], location: loc, previous: null, provider: "seedance" });
  ok("B4: negatives present on a dialogue scene", b.prompt.includes(`${SCENE_SECTION.negatives}: no logos`) && !/no background music over the narration/.test(b.prompt));
  const narr = { ...baseScene, sceneKind: "narration", voiceover: "The city never slept.", videoPrompt: "[SHOT TYPE]: wide. [ACTION]: streets at night.", dialogue: "", dialogueEn: "" };
  const nb = buildScenePrompt({ scene: narr, characters: [char("Anna")], location: loc, previous: null, provider: "seedance" });
  ok("B4: narration negatives add the music / lip-sync bits", /no background music over the narration/.test(nb.prompt) && /lips move to the off-screen narration/.test(nb.prompt));
}

// B5. Section order: OPENING STATE → END STATE → structure → 9-tag body; and override is untouched.
{
  const scene = { ...baseScene, startState: "Anna stands at the door.", endState: "Anna sits down.", videoPrompt: "[SHOT TYPE]: medium. [ACTION]: Anna crosses the room.", dialogue: "", dialogueEn: "" };
  const previous = { id: "s0", number: 0, locationDesc: "Kitchen", lastFrameUrl: null, endState: "prev end", endStateActual: null };
  const b = buildScenePrompt({ scene, characters: [char("Anna")], location: loc, previous, provider: "seedance", props: [] });
  const iOpen = b.prompt.indexOf(OPENING_STATE_PREFIX);
  const iEnd = b.prompt.indexOf(END_STATE_PREFIX);
  const iRef = b.prompt.indexOf(SCENE_SECTION.referenceMap);
  const iPeople = b.prompt.indexOf(SCENE_SECTION.people);
  const iBody = b.prompt.indexOf("[SHOT TYPE]"); // the reused 9-tag body (after the [VISUAL STYLE] header)
  const iNeg = b.prompt.indexOf(SCENE_SECTION.negatives);
  ok("B5: prompt still opens with OPENING STATE", b.prompt.startsWith(OPENING_STATE_PREFIX));
  ok("B5: structure sits after the state blocks", iOpen >= 0 && iEnd > iOpen && iRef > iEnd && iPeople > iRef);
  ok("B5: 9-tag body comes after the structure", iBody > iPeople);
  ok("B5: negatives close the prompt (after the body)", iNeg > iBody);

  const ov = buildScenePrompt({ scene: { ...scene, promptOverride: "MY MANUAL PROMPT" }, characters: [char("Anna")], location: loc, previous, provider: "seedance", props: [{ id: "blue-tin", name: "blue tin", description: "a blue tin" }] });
  ok("B5: a manual override stays verbatim (no sections, no negatives)", ov.prompt === "MY MANUAL PROMPT");
}

// Run the async prop-registry extraction tests last, then report. Wrapped (no top-level await; the
// test runner compiles to CJS where top-level await is unavailable).
testBuildPropRegistry()
  .then(() => { console.log(`test-stage54: ALL ${n} ASSERTIONS PASSED`); })
  .catch((e) => { console.error(e); process.exit(1); });
