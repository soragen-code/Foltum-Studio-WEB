/**
 * Stage 36/37/38 tests — reference mode for every scene, manual prompt override normalization.
 * Stage 38: the previous scene's last frame is NEVER sent as a reference (skipPreviousFrame is obsolete).
 * Run: npx tsx scripts/test-stage36.ts
 *
 * Pure-logic only (NO Replicate / network / LLM / DB).
 */
import assert from "node:assert";
import { buildScenePrompt, REFERENCE_IMAGE_CAP } from "../lib/scene-prompt";
import { normalizePromptOverride } from "../lib/prompt-override";
import { VISUAL_STYLE_ID } from "../lib/visual-style";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };
const styledUrl = (name: string) => "https://media.invalid/" + VISUAL_STYLE_ID + "/" + name + ".webp";

const scene = {
  id: "s3", number: 3, videoPrompt: "[ACTION]: Yara turns to Theo.", sceneKind: null, voiceover: null,
  dialogue: 'YARA: "Now."', dialogueEn: 'YARA: "Now."', language: "en", locationDesc: "Kitchen", continuesFrom: null,
};
const previous = { id: "s2", number: 2, locationDesc: "Kitchen", lastFrameUrl: styledUrl("s2-lastframe") };
const loc = { id: "loc", name: "Kitchen", imageUrl: styledUrl("k-wide"), imageReverse: styledUrl("k-reverse"), imageDetail: styledUrl("k-detail") };
const cast = ["Yara", "Theo", "Ann", "Bob", "Cid"].map(n => ({ characterId: n.toLowerCase(), name: n, tier: "MAIN", imageFront: styledUrl(n.toLowerCase()) }));
const crowd = { characterId: "crowd", name: "Guests", tier: "CROWD", imageFront: styledUrl("guests") };

// ── A. chained scene: cast → all angles → crowd; NO previous frame (Stage 38) ─────────────────────
{
  const b = buildScenePrompt({ scene, characters: [...cast, crowd], location: loc, previous, provider: "seedance" });
  ok(b.referenceKind === "character_references", "chained scene → character_references");
  ok(!("image" in b), "no first-frame `image`");
  const kinds = b.retryRefs.map(r => r.kind);
  ok(JSON.stringify(kinds) === JSON.stringify(["character", "character", "character", "character", "character", "location", "location", "location", "crowd"]), "order: 5 portraits, 3 location angles, crowd — no previous frame");
  ok(b.referenceImages[0] === styledUrl("yara") && b.referenceImages[1] === styledUrl("theo"), "mentioned characters first (Yara, Theo)");
  ok(b.referenceImages[5] === loc.imageUrl, "wide angle first among the location angles");
  ok(!b.referenceImages.includes(previous.lastFrameUrl), "previous frame URL is never sent");
  ok(b.previousFrameSceneId === null && (b.reference as any).previousFrameSceneId === null, "previousFrameSceneId is null in result and diagnostics");
  ok(!(b.reference as any).kinds.includes("previous_frame") && (b.reference as any).mode === "character_references", "diagnostics: mode + kinds (no previous_frame)");
  ok(!b.prompt.includes("final frame of the previous scene"), "no continuity note for a previous frame");
  ok(b.prompt.includes(`[Image6] the location "Kitchen" — wide angle`), "each location angle carries its own note");
  ok(!/https?:\/\//.test(b.prompt), "no URL leaks into the prompt");
}

// ── B. chain broken (location-change) → no previous frame ────────────────────────────────────────
{
  const b = buildScenePrompt({ scene: { ...scene, continuesFrom: "location-change" }, characters: cast, location: loc, previous, provider: "seedance" });
  ok(!b.retryRefs.some(r => r.kind === "previous_frame") && b.previousFrameSceneId === null, "location-change breaks the chain: previous frame not sent");
  ok(b.retryRefs.length === 8, "5 portraits + 3 angles");
}

// ── C. skipReferences on a chained scene → text_only, zero images ────────────────────────────────
{
  const b = buildScenePrompt({ scene: { ...scene, skipReferences: true }, characters: cast, location: loc, previous, provider: "seedance" });
  ok(b.referenceKind === "text_only" && b.referenceImages.length === 0 && b.retryRefs.length === 0, "text_only: nothing sent, not even the previous frame");
  ok(!b.prompt.includes("[Image"), "text_only: no notes");
}

// ── D. override: images still sent, no notes ─────────────────────────────────────────────────────
{
  const b = buildScenePrompt({ scene: { ...scene, promptOverride: "MY PROMPT" }, characters: cast, location: loc, previous, provider: "seedance" });
  ok(b.prompt === "MY PROMPT" && b.referenceImages.length === 8, "override: text replaced verbatim, 8 images still sent (5 portraits + 3 angles)");
}

// ── E. cap: crowds trimmed first, then extra location angles; characters kept ─────────────────────
{
  ok(REFERENCE_IMAGE_CAP === 30, "cap is the provider maximum (30)");
  const many = Array.from({ length: 27 }, (_, i) => ({ characterId: `c${i}`, name: `Char${i}`, tier: "MAIN", imageFront: styledUrl(`c${i}`) }));
  const crowds = [1, 2].map(i => ({ characterId: `g${i}`, name: `Group${i}`, tier: "CROWD", imageFront: styledUrl(`g${i}`) }));
  const b = buildScenePrompt({ scene, characters: [...many, ...crowds], location: loc, previous, provider: "seedance" });
  const kinds = b.retryRefs.map(r => r.kind);
  ok(b.referenceImages.length === 30, "trimmed to 30");
  ok(kinds.filter(k => k === "character").length === 27, "all characters kept");
  ok(!kinds.includes("previous_frame"), "no previous frame even at the cap");
  ok(kinds.filter(k => k === "location").length === 3 && b.referenceImages[27] === loc.imageUrl, "all 3 location angles fit (wide first)");
  ok(kinds.filter(k => k === "crowd").length === 0, "crowds trimmed first");
}

// ── F. normalizePromptOverride ───────────────────────────────────────────────────────────────────
{
  ok(normalizePromptOverride("Сделал проще: вот промпт.\n```text\n[SCENE]: kitchen\n[ACTION]: Yara turns.\n```\nГотово.") === "[SCENE]: kitchen\n[ACTION]: Yara turns.", "```text fence: only the fenced content is kept");
  ok(normalizePromptOverride("intro\n```\nA plain prompt\n```") === "A plain prompt", "bare ``` fence handled");
  ok(normalizePromptOverride("Вот вариант:\nещё строка\n[SHOT TYPE]: medium\n[ACTION]: walks") === "[SHOT TYPE]: medium\n[ACTION]: walks", "preamble before the first [SECTION] header is dropped");
  ok(normalizePromptOverride("[SCENE] kitchen\n\n\n\n[ACTION] turns") === "[SCENE] kitchen\n\n[ACTION] turns", "3+ blank lines collapse to 2");
  ok(normalizePromptOverride("  just a plain prompt  \n") === "just a plain prompt", "plain text is only trimmed");
  ok(normalizePromptOverride("   \n  ") === "", "whitespace → empty (caller resets the override)");
  ok(normalizePromptOverride("Line one\r\n[SCENE]: x\r\n") === "[SCENE]: x", "CRLF normalized");
  ok(normalizePromptOverride("[ACTION]: keep me\nbody") === "[ACTION]: keep me\nbody", "header at the very start: nothing dropped");
}

// ── G. Stage 38: the legacy skipPreviousFrame flag has no effect — same 8 references either way ──
{
  for (const flag of [true, false, undefined]) {
    const b = buildScenePrompt({ scene: { ...scene, skipPreviousFrame: flag }, characters: cast, location: loc, previous, provider: "seedance" });
    const kinds = b.retryRefs.map(r => r.kind);
    ok(b.referenceKind === "character_references" && !kinds.includes("previous_frame") && b.referenceImages.length === 8, `skipPreviousFrame=${flag}: 5 portraits + 3 angles, no previous frame`);
    ok(b.previousFrameSceneId === null && (b.reference as any).previousFrameSceneId === null && (b.reference as any).previousFrameSkipped === undefined, `skipPreviousFrame=${flag}: diagnostics have null previousFrameSceneId and no previousFrameSkipped marker`);
    ok(!b.referenceImages.includes(previous.lastFrameUrl) && !b.prompt.includes("final frame of the previous scene"), `skipPreviousFrame=${flag}: no frame URL, no continuity note`);
  }
}

console.log(`\nStage 36/37/38: ${pass} checks passed.`);
