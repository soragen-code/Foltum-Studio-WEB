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
  buildScenePrompt, LAST_FRAME_CONTINUITY_NOTE, REFERENCE_IMAGE_CAP,
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

// ── A. continuation scene: previous exists, not a break, last frame present ─────────────────────────
{
  const r = build();
  ok(r.referenceImages.includes(LAST_FRAME), "A: continuation scene sends the previous last frame as a reference image");
  ok(r.prompt.includes(LAST_FRAME_CONTINUITY_NOTE), "A: the lock-placement continuity note appears in the prompt text");
  ok(r.previousFrameSceneId === "s1", "A: previousFrameSceneId is the previous scene's id when its last frame is kept");
  ok(r.retryRefs.some(x => x.kind === "previous_frame" && x.url === LAST_FRAME), "A: retryRefs carries the last frame with kind 'previous_frame'");
  ok(r.reference.mode === "character_references" && r.reference.kinds?.includes("previous_frame"), "A: reference.kinds records the previous_frame ref");
  // Preview safety — the real URL must NEVER appear in the prompt text (only [ImageN] + the note).
  ok(!r.prompt.includes(LAST_FRAME), "A: the real last-frame URL is NOT exposed in the prompt text (preview safe)");
}

// ── B. reference ORDER: characters → last-frame → base angles → extra → crowds ──────────────────────
{
  const r = build({ characters: [mkChar("a", "Anna"), mkChar("m", "Mark")], loc: location([styledUrl("loc-extra1")]) });
  const imgs = r.referenceImages;
  const chars = [r.referenceImages.indexOf(styledUrl("char-a")) >= 0, r.referenceImages.indexOf(styledUrl("char-m")) >= 0];
  const iLast = imgs.indexOf(LAST_FRAME);
  const iWide = imgs.indexOf(styledUrl("loc-wide"));
  const iExtra = imgs.indexOf(styledUrl("loc-extra1"));
  ok(chars[0] && chars[1], "B: both character refs present");
  ok(iLast >= 0 && iWide >= 0 && iLast < iWide, "B: the last frame comes AFTER the characters but BEFORE the base location angles");
  ok(iExtra >= 0 && iLast < iExtra, "B: the last frame comes before the extra location angle");
  // characters occupy the first slots (all character URLs before the last frame)
  ok(imgs.slice(0, iLast).every(u => u.includes("/char-")), "B: every reference before the last frame is a character");
}

// ── C. sequence break (location-change / new-sequence) → NO last frame ──────────────────────────────
{
  for (const link of ["location-change", "new-sequence", "New-Sequence"]) {
    const r = build({ sceneOver: { continuesFrom: link } });
    ok(!r.referenceImages.includes(LAST_FRAME), `C: '${link}' break does NOT send the last frame`);
    ok(!r.prompt.includes(LAST_FRAME_CONTINUITY_NOTE), `C: '${link}' break does NOT add the continuity note`);
    ok(r.previousFrameSceneId === null, `C: '${link}' break leaves previousFrameSceneId null`);
  }
}

// ── D. text-only mode (skipReferences) → NO last frame, no note ─────────────────────────────────────
{
  const r = build({ sceneOver: { skipReferences: true } });
  ok(r.referenceKind === "text_only" && r.referenceImages.length === 0, "D: skipReferences → text_only, no reference images");
  ok(!r.prompt.includes(LAST_FRAME_CONTINUITY_NOTE), "D: text-only mode does not add the continuity note");
  ok(r.previousFrameSceneId === null, "D: text-only mode leaves previousFrameSceneId null");
}

// ── E. graceful when there is no previous / no last-frame URL ───────────────────────────────────────
{
  const rNoPrev = build({ prev: null });
  ok(!rNoPrev.referenceImages.includes(LAST_FRAME) && rNoPrev.previousFrameSceneId === null, "E: no previous scene → no last frame, no crash");
  const rNoUrl = build({ prev: previous({ lastFrameUrl: null }) });
  ok(!rNoUrl.prompt.includes(LAST_FRAME_CONTINUITY_NOTE) && rNoUrl.previousFrameSceneId === null, "E: previous with no lastFrameUrl → no last frame, no note");
  ok(rNoUrl.referenceImages.length > 0, "E: the rest of the reference set (characters + location) is still sent normally");
  const rEmpty = build({ prev: previous({ lastFrameUrl: "   " }) });
  ok(!rEmpty.referenceImages.includes("   ") && rEmpty.previousFrameSceneId === null, "E: whitespace-only lastFrameUrl is treated as absent");
}

// ── F. Seedance cap: never exceed REFERENCE_IMAGE_CAP; last frame survives above crowds/extras ───────
{
  // 25 characters + last-frame + 3 base + 2 extra + 6 crowds = 37 raw → capped to 30, tail dropped first.
  const many = Array.from({ length: 25 }, (_, i) => mkChar("c" + i, "Person" + i));
  const crowds = Array.from({ length: 6 }, (_, i) => mkCrowd("k" + i, "Crowd" + i));
  const r = build({ characters: [...many, ...crowds], loc: location([styledUrl("loc-extra1"), styledUrl("loc-extra2")]) });
  ok(r.referenceImages.length === REFERENCE_IMAGE_CAP, "F: Seedance reference set is capped at REFERENCE_IMAGE_CAP (30)");
  ok(r.referenceImages.includes(LAST_FRAME), "F: with the cap hit, the last frame is KEPT (prioritized above crowds/extras)");
  ok(r.previousFrameSceneId === "s1", "F: previousFrameSceneId set because the last frame survived the cap");
  // 25 chars are never dropped; they all remain.
  ok(many.every(c => r.referenceImages.includes(styledUrl("char-" + c.characterId))), "F: no character reference is dropped by the cap");
}

// ── G. Stage 72 — PARALLEL order (or omitted chainMode) → NO previous_frame ref, no note ─────────────
{
  for (const mode of ["parallel", null, undefined] as const) {
    const r = mode === undefined ? build({ omitChainMode: true }) : build({ chainMode: mode });
    const label = mode === undefined ? "omitted" : String(mode);
    ok(!r.referenceImages.includes(LAST_FRAME), `G: chainMode ${label} does NOT send the previous last frame`);
    ok(!r.prompt.includes(LAST_FRAME_CONTINUITY_NOTE), `G: chainMode ${label} does NOT add the continuity note`);
    ok(r.previousFrameSceneId === null, `G: chainMode ${label} leaves previousFrameSceneId null`);
    ok(!r.retryRefs.some(x => x.kind === "previous_frame"), `G: chainMode ${label} has no previous_frame retryRef`);
    ok(r.referenceImages.length > 0, `G: chainMode ${label} still sends characters + location normally`);
  }
  const rChain = build({ chainMode: "chain" });
  ok(rChain.referenceImages.includes(LAST_FRAME), "G: explicit chainMode 'chain' sends the last frame (control)");
  ok(LAST_FRAME_CONTINUITY_NOTE.toLowerCase().includes("camera"), "G: the continuity note demands a NEW camera on the same instant");
}

console.log(`\nAll ${pass} Stage 62 assertions passed.`);
