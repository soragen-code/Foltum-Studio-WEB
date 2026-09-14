/**
 * Stage 62 (Variant A) — scene continuity checks. When a scene CONTINUES the same location/sequence
 * (a previous scene exists AND it is not a sequence break), the previous scene's LAST FRAME is added
 * back as ONE continuity reference (with the lock-placement note), prioritized above crowds / extra
 * angles but never above characters or base angles, never in text-only mode, never after a break, only in
 * chain order (Stage 72: parallel order relies on the scripted frame states alone), and
 * never exposing the real URL in the prompt text. Pure assertions, no I/O.
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage62.ts
 */
import assert from "node:assert";
import {
  buildScenePrompt, REFERENCE_IMAGE_CAP,
  type ScenePromptScene, type ScenePromptCharacterLink, type ScenePromptLocation, type ScenePromptPrevious,
} from "../lib/scene-prompt";
import { VISUAL_STYLE_ID } from "../lib/visual-style";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };
// SCHEME is assembled from parts so the editor autolinker never rewrites a bare URL literal here.
const SCHEME = "http" + "s://";
const styledUrl = (name: string) => SCHEME + "media.invalid/" + VISUAL_STYLE_ID + "/" + name + ".webp";
// The previous scene's last frame is a rendered clip frame — NOT a styled asset. Deliberately a plain
// URL so the test also proves it does not need to pass isStyledAsset to be added.
const LAST_FRAME = SCHEME + "frames.invalid/prev-scene-last-frame.png";

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
const scene = (over: Partial<ScenePromptScene> = {}): ScenePromptScene => ({
  id: "s2", number: 2,
  videoPrompt: "[ACTION]: Anna and Mark keep talking.\n[CHARACTER]: Anna, Mark\n[TRANSITION]: hard cut",
  continuesFrom: "same-location-continuation",
  ...over,
});
const previous = (over: Partial<ScenePromptPrevious> = {}): ScenePromptPrevious => ({
  id: "s1", number: 1, lastFrameUrl: LAST_FRAME, endState: "WORLD: Anna by the window.\nCAMERA: wide", ...over,
});
const build = (opts: {
  characters?: ScenePromptCharacterLink[];
  loc?: ScenePromptLocation | null;
  prev?: ScenePromptPrevious | null;
  sceneOver?: Partial<ScenePromptScene>;
  textOnly?: boolean;
  /** Stage 72 — the last frame is fed only in chain order; default 'chain' so the continuity cases below exercise it. */
  chainMode?: "parallel" | "chain" | null;
  /** Pass the chainMode key through as absent (tests the omitted case). */
  omitChainMode?: boolean;
} = {}) => buildScenePrompt({
  scene: scene(opts.sceneOver),
  characters: opts.characters ?? [mkChar("a", "Anna"), mkChar("m", "Mark")],
  location: opts.loc === undefined ? location() : opts.loc,
  previous: opts.prev === undefined ? previous() : opts.prev,
  textOnlyWhenNoReferences: opts.textOnly ?? false,
  ...(opts.omitChainMode ? {} : { chainMode: opts.chainMode === undefined ? "chain" : opts.chainMode }),
});

// Stage112 intentionally supersedes raw-frame transport, text-only switches and extra angle selection.
// Keep these regressions for every legacy chain/break/override combination; full edit lifecycle is in test-stage112.
for (const chainMode of ["chain", "parallel", null] as const) {
  for (const continuesFrom of ["same-location-continuation", "location-change", "new-sequence"]) {
    const result = build({ chainMode, sceneOver: { continuesFrom, skipReferences: true } });
    ok(!result.referenceImages.includes(LAST_FRAME), "raw previous frame never sent, regardless of legacy mode");
    ok(!result.retryRefs.some(r => r.kind === "previous_frame"), "retry plan never contains raw frame");
    ok(result.referenceImages.length === 4, "cast + mandatory wide/layout retained despite legacy skip");
    ok(!result.prompt.includes(LAST_FRAME), "reference URL stays out of prompt text");
  }
}
const noPrev = build({ prev: null });
ok(!noPrev.newSceneReference, "no intermediate still without a predecessor");
ok(build({ characters: [], loc: null, prev: null }).referenceImages.length === 0, "empty reference list never triggers still generation");
console.log(`Stage62 updated for Stage112: ${pass} checks passed.`);
