/**
 * Stage 64 — storyboard scene-generation mode. Pure assertions, no I/O, no paid calls.
 *  (a) text mode is byte-identical to Stage 62 (sceneMode omitted / "text" / storyboard without a frame);
 *  (b) storyboard mode on the VIDEO path: the storyboard frame is Image1, previous_frame is dropped,
 *      characters + location kept, REFERENCE MAP shifts indices, cap 30 never drops the storyboard;
 *  (c) buildStoryboardPrompt: ordering previous_storyboard → characters → location, continuation vs
 *      break, no real URL in the text, CLOTHING & PROPS identical to the video prompt line, cap 14.
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage64.ts
 */
import assert from "node:assert";
import {
  buildScenePrompt, REFERENCE_IMAGE_CAP, LAST_FRAME_CONTINUITY_NOTE, STORYBOARD_FIRST_FRAME_NOTE, STORYBOARD_REFERENCE_MAP_ENTRY, SCENE_SECTION,
  type ScenePromptScene, type ScenePromptCharacterLink, type ScenePromptLocation, type ScenePromptPrevious, type BuildScenePromptInput,
} from "../lib/scene-prompt";
import { buildStoryboardPrompt, SEEDREAM_IMAGE_INPUT_CAP, PREVIOUS_STORYBOARD_NOTE, STORYBOARD_FRAME_DIRECTIVE, STORYBOARD_PROMPT_MAX_CHARS, clampStoryboardOpening } from "../lib/storyboard-prompt";
import { VISUAL_STYLE_ID } from "../lib/visual-style";
import type { PropRegistryEntry } from "../lib/prop-registry";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };
const SCHEME = "http" + "s://";
const styledUrl = (name: string) => SCHEME + "media.invalid/" + VISUAL_STYLE_ID + "/" + name + ".webp";
const LAST_FRAME = SCHEME + "frames.invalid/prev-scene-last-frame.png";
const STORYBOARD = SCHEME + "storyboards.invalid/s2-frame.jpg";
const PREV_STORYBOARD = SCHEME + "storyboards.invalid/s1-frame.jpg";

const mkChar = (id: string, name: string): ScenePromptCharacterLink => ({
  characterId: id, name, tier: "LEAD", imageFull: styledUrl("char-" + id), imageFront: styledUrl("char-" + id + "-front"),
  appearance: name + " looks weathered", age: "40",
});
const mkCrowd = (id: string, name: string): ScenePromptCharacterLink => ({
  characterId: id, name, tier: "CROWD", imageFull: styledUrl("crowd-" + id), imageFront: styledUrl("crowd-" + id + "-front"),
});
const location = (extras: string[] = []): ScenePromptLocation => ({
  id: "loc1", name: "The Office",
  imageUrl: styledUrl("loc-wide"), imageReverse: styledUrl("loc-reverse"), imageDetail: styledUrl("loc-detail"),
  imageExtra: extras.length ? JSON.stringify(extras) : null,
});
const PROPS: PropRegistryEntry[] = [
  { id: "brass-watch", name: "brass watch", description: "a scratched brass pocket watch on a short chain" },
  { id: "red-folder", name: "red folder", description: "a thick red cardboard folder with a frayed corner" },
  { id: "umbrella", name: "umbrella", description: "a black umbrella with a bent spoke" },
];
const scene = (over: Partial<ScenePromptScene> = {}): ScenePromptScene => ({
  id: "s2", number: 2,
  videoPrompt: "[VISUAL STYLE]: gritty realism\n[LIGHTING]: cold window light\n[ACTION]: Anna hands Mark the red folder; the brass watch ticks.\n[CHARACTER]: Anna, Mark\n[TRANSITION]: hard cut",
  continuesFrom: "same-location-continuation",
  ...over,
});
const previous = (over: Partial<ScenePromptPrevious> = {}): ScenePromptPrevious => ({
  id: "s1", number: 1, lastFrameUrl: LAST_FRAME, endState: "WORLD: Anna by the window.\nCAMERA: wide", ...over,
});
const build = (opts: {
  characters?: ScenePromptCharacterLink[]; loc?: ScenePromptLocation | null; prev?: ScenePromptPrevious | null;
  sceneOver?: Partial<ScenePromptScene>; mode?: BuildScenePromptInput["sceneMode"]; storyboardUrl?: string | null; props?: PropRegistryEntry[];
} = {}) => buildScenePrompt({
  scene: scene(opts.sceneOver),
  characters: opts.characters ?? [mkChar("a", "Anna"), mkChar("m", "Mark")],
  location: opts.loc === undefined ? location() : opts.loc,
  previous: opts.prev === undefined ? previous() : opts.prev,
  textOnlyWhenNoReferences: false,
  props: opts.props ?? PROPS,
  ...(opts.mode !== undefined ? { sceneMode: opts.mode } : {}),
  ...(opts.storyboardUrl !== undefined ? { storyboardUrl: opts.storyboardUrl } : {}),
});

// ── A. text mode is byte-identical to the Stage 62 output ───────────────────────────────────────────
{
  const base = build();
  const asText = build({ mode: "text" });
  const asNull = build({ mode: null });
  const sbNoFrame = build({ mode: "storyboard", storyboardUrl: null });
  const sbBlank = build({ mode: "storyboard", storyboardUrl: "   " });
  const same = (r: typeof base) => r.prompt === base.prompt && JSON.stringify(r.referenceImages) === JSON.stringify(base.referenceImages) && r.previousFrameSceneId === base.previousFrameSceneId && JSON.stringify(r.retryRefs) === JSON.stringify(base.retryRefs);
  ok(same(asText), "A: sceneMode 'text' → prompt + references byte-identical to sceneMode omitted");
  ok(same(asNull), "A: sceneMode null → identical to omitted");
  ok(same(sbNoFrame), "A: storyboard mode WITHOUT a storyboard URL → identical to text mode (no-op)");
  ok(same(sbBlank), "A: storyboard mode with a whitespace URL → identical to text mode");
  ok(base.referenceImages.includes(LAST_FRAME) && base.prompt.includes(LAST_FRAME_CONTINUITY_NOTE), "A: the text-mode output still carries the Stage 62 last-frame continuity reference");
  ok(!base.prompt.includes(STORYBOARD_FIRST_FRAME_NOTE) && !base.prompt.includes(STORYBOARD_REFERENCE_MAP_ENTRY), "A: text mode never mentions the storyboard");
  ok(!base.retryRefs.some(r => r.kind === "storyboard"), "A: text mode has no 'storyboard' reference kind");
}

// ── B. storyboard mode on the video path ────────────────────────────────────────────────────────────
{
  const r = build({ mode: "storyboard", storyboardUrl: STORYBOARD, loc: location([styledUrl("loc-extra1")]) });
  ok(r.referenceImages[0] === STORYBOARD, "B: the storyboard frame is Image1 (first reference)");
  ok(r.retryRefs[0]?.kind === "storyboard" && r.retryRefs[0]?.note === STORYBOARD_FIRST_FRAME_NOTE, "B: first ref has kind 'storyboard' with the first-frame note");
  ok(r.prompt.includes(STORYBOARD_FIRST_FRAME_NOTE), "B: the first-frame note appears in the prompt text");
  ok(!r.referenceImages.includes(LAST_FRAME) && !r.prompt.includes(LAST_FRAME_CONTINUITY_NOTE), "B: the previous scene's last frame is NOT sent in storyboard mode");
  ok(r.previousFrameSceneId === null, "B: previousFrameSceneId is null in storyboard mode");
  ok(r.referenceImages.includes(styledUrl("char-a")) && r.referenceImages.includes(styledUrl("char-m")), "B: both character anchors are kept");
  ok(r.referenceImages.includes(styledUrl("loc-wide")) && r.referenceImages.includes(styledUrl("loc-extra1")), "B: location base + extra angles are kept");
  ok(r.referenceImages[1] === styledUrl("char-a") && r.referenceImages[2] === styledUrl("char-m"), "B: characters follow the storyboard frame in cast order");
  ok(r.prompt.includes(`${STORYBOARD_REFERENCE_MAP_ENTRY}, Image2 = Anna, Image3 = Mark`), "B: REFERENCE MAP = 'Image1 = first frame of this scene (storyboard), Image2 = Anna, Image3 = Mark'");
  ok(!r.prompt.includes(STORYBOARD) && !r.prompt.includes(SCHEME), "B: no real URL leaks into the prompt text");
  ok(((r.reference as { kinds?: string[] }).kinds ?? []).includes("storyboard"), "B: reference.kinds records the storyboard ref");
  // Cap: storyboard + 25 chars + 3 base + 2 extra + 6 crowds = 37 → 30; the storyboard is never dropped.
  const many = Array.from({ length: 25 }, (_, i) => mkChar("c" + i, "Person" + i));
  const crowds = Array.from({ length: 6 }, (_, i) => mkCrowd("k" + i, "Crowd" + i));
  const big = build({ mode: "storyboard", storyboardUrl: STORYBOARD, characters: [...many, ...crowds], loc: location([styledUrl("x1"), styledUrl("x2")]) });
  ok(big.referenceImages.length === REFERENCE_IMAGE_CAP, `B: capped to ${REFERENCE_IMAGE_CAP} references`);
  ok(big.referenceImages[0] === STORYBOARD, "B: under the cap the storyboard frame is still Image1 (never dropped)");
  ok(!big.referenceImages.some(u => u.includes("/crowd-")), "B: crowds are the first to be dropped under the cap");
  ok(new Set(big.referenceImages).size === big.referenceImages.length, "B: no duplicate references");
}

// ── C. buildStoryboardPrompt ────────────────────────────────────────────────────────────────────────
{
  const sbScene = { id: "s2", number: 2, videoPrompt: scene().videoPrompt, continuesFrom: "same-location-continuation", startState: "Anna stands at the desk holding the red folder." };
  const r = buildStoryboardPrompt({ scene: sbScene, characters: [mkChar("a", "Anna"), mkChar("m", "Mark")], location: location([styledUrl("loc-extra1")]), previous: { id: "s1", storyboardUrl: PREV_STORYBOARD }, props: PROPS });
  ok(r.continuesPrevious === true, "C: continuation with a previous storyboard → continuesPrevious");
  ok(r.refs[0].kind === "previous_storyboard" && r.refs[0].url === PREV_STORYBOARD && r.refs[0].note === PREVIOUS_STORYBOARD_NOTE, "C: previous storyboard is Image1 with the continuity note");
  const kinds = r.refs.map(x => x.kind);
  const lastChar = kinds.lastIndexOf("character"), firstLoc = kinds.indexOf("location");
  ok(kinds[1] === "character" && kinds[2] === "character" && lastChar < firstLoc, "C: ordering previous_storyboard → characters → location");
  ok(r.referenceImages.indexOf(styledUrl("loc-wide")) < r.referenceImages.indexOf(styledUrl("loc-extra1")), "C: base location angles precede extra angles");
  ok(!/https?:/.test(r.prompt), "C: no URL (http) in the storyboard prompt text");
  ok(r.prompt.includes(STORYBOARD_FRAME_DIRECTIVE), "C: the 9:16 frame directive is present");
  ok(r.prompt.split("\n").filter(l => l.startsWith("[Image")).length === r.refs.length, "C: one [ImageN] note per reference");
  // Break → no previous storyboard.
  const brk = buildStoryboardPrompt({ scene: { ...sbScene, continuesFrom: "location-change" }, characters: [mkChar("a", "Anna")], location: location(), previous: { id: "s1", storyboardUrl: PREV_STORYBOARD } });
  ok(brk.continuesPrevious === false && !brk.referenceImages.includes(PREV_STORYBOARD) && !brk.prompt.includes(PREVIOUS_STORYBOARD_NOTE), "C: 'location-change' break → previous storyboard not attached, no note");
  ok(brk.refs[0].kind === "character", "C: after a break the first reference is the first character");
  const noPrev = buildStoryboardPrompt({ scene: sbScene, characters: [mkChar("a", "Anna")], location: location(), previous: null });
  ok(noPrev.continuesPrevious === false && noPrev.refs.every(x => x.kind !== "previous_storyboard"), "C: no previous scene → no previous storyboard, no crash");
  // Props text identical to the video CLOTHING & PROPS line (verbatim registry descriptions).
  const video = build({ props: PROPS });
  const propsLine = (p: string) => p.split("\n").find(l => l.startsWith(SCENE_SECTION.props + ":")) ?? "";
  ok(propsLine(video.prompt).length > 0 && propsLine(video.prompt).includes("scratched brass pocket watch") && propsLine(video.prompt).includes("thick red cardboard folder"), "C: video prompt has a CLOTHING & PROPS line with both matched props");
  ok(propsLine(r.prompt) === propsLine(video.prompt), "C: the storyboard CLOTHING & PROPS line is identical to the video prompt line");
  ok(!propsLine(r.prompt).includes("umbrella"), "C: an unmentioned registry prop is not injected");
  // Cap 14: previous(1) + 5 chars + 3 base + 6 extras = 15 → 14, extras trimmed from the tail.
  const five = Array.from({ length: 5 }, (_, i) => mkChar("c" + i, "Person" + i));
  const extras = Array.from({ length: 6 }, (_, i) => styledUrl("ex" + i));
  const cap = buildStoryboardPrompt({ scene: sbScene, characters: five, location: location(extras), previous: { id: "s1", storyboardUrl: PREV_STORYBOARD } });
  ok(cap.referenceImages.length === SEEDREAM_IMAGE_INPUT_CAP, `C: capped to ${SEEDREAM_IMAGE_INPUT_CAP} image inputs`);
  ok(cap.referenceImages[0] === PREV_STORYBOARD && five.every(c => cap.referenceImages.includes(styledUrl("char-" + c.characterId))), "C: previous storyboard + all characters survive the cap");
  ok(cap.referenceImages.includes(styledUrl("ex0")) && cap.referenceImages.includes(styledUrl("ex4")) && !cap.referenceImages.includes(styledUrl("ex5")), "C: the LAST extra angle is the one trimmed (tail first)");
}

// ---------------------------------------------------------------------------------------------------------------
// D. Stage 64a — provider limit: Seedream rejects prompts > 4000 chars (HTTP 422). A scripted startState is
//    itself ~4000 chars, so the assembled prompt must be clamped: CAMERA block + roster + placements kept,
//    set dressing trimmed first, the rest of the prompt (style, lighting, people, props, notes) untouched.
// ---------------------------------------------------------------------------------------------------------------
{
  const sbScene = { id: "s2", number: 2, videoPrompt: scene().videoPrompt, continuesFrom: "same-location-continuation", startState: "" };
  const placements = Array.from({ length: 6 }, (_, i) => `Person${i} occupies frame LEFT in the foreground beside the coffin, faces north, and holds a folded sheet in the left hand while the empty right hand rests on the lid.`);
  const dressing = Array.from({ length: 16 }, (_, i) => `Dressing sentence ${i}: a walnut sideboard with a brass lamp and a stack of ivory letters stands against the east wall under a rain-streaked window with heavy velvet curtains.`);
  const camera = "CAMERA: A wide establishing composition looks north along the hall at high camera height with a natural wide-angle lens feel; the vertical 9:16 frame reveals the floor from the threshold to the pocket doors.";
  const longStart = `WORLD: IN FRAME: ${Array.from({ length: 6 }, (_, i) => "Person" + i).join(", ")}. NOT IN FRAME: none. ${placements.join(" ")} ${dressing.join(" ")} ${camera}`;
  ok(longStart.length > 3500, `D: fixture startState is ~scripted size (${longStart.length} chars)`);
  const six = Array.from({ length: 6 }, (_, i) => mkChar("c" + i, "Person" + i));
  const big = buildStoryboardPrompt({ scene: { ...sbScene, startState: longStart }, characters: six, location: location(), previous: { id: "s1", storyboardUrl: PREV_STORYBOARD }, props: PROPS });
  ok(big.prompt.length <= STORYBOARD_PROMPT_MAX_CHARS && STORYBOARD_PROMPT_MAX_CHARS < 4000, `D: clamped prompt fits the provider limit (${big.prompt.length} ≤ ${STORYBOARD_PROMPT_MAX_CHARS} < 4000)`);
  const opening = big.prompt.split("\n")[0];
  ok(opening.includes(camera), "D: the CAMERA block survives verbatim");
  ok(opening.includes("IN FRAME: Person0") && placements.every(pl => opening.includes(pl)), "D: roster + all 6 character placements survive");
  ok(!opening.includes("Dressing sentence 15"), "D: set dressing is what gets trimmed (from the end)");
  ok(big.prompt.includes(STORYBOARD_FRAME_DIRECTIVE) && big.prompt.split("\n").filter(l => l.startsWith("[Image")).length === big.refs.length && big.refs.length === 1 + 6 + 3, "D: directive, all [ImageN] notes and all references are intact after clamping");
  const small = buildStoryboardPrompt({ scene: { ...sbScene, startState: "WORLD: Anna stands by the window. CAMERA: medium shot, eye level." }, characters: [mkChar("a", "Anna")], location: location(), previous: null });
  ok(small.prompt.includes("WORLD: Anna stands by the window. CAMERA: medium shot, eye level."), "D: a short opening is passed through unchanged");
  ok(clampStoryboardOpening("short text", 100) === "short text", "D: clampStoryboardOpening is identity when it fits");
  const c = clampStoryboardOpening(`First one. Second one. Third one. ${camera}`, camera.length + 25);
  ok(c === `First one. Second one. ${camera}`, "D: clampStoryboardOpening cuts whole sentences from the end of WORLD and keeps CAMERA");
}

console.log(`\nStage 64: ${pass} checks passed`);
