/**
 * Stage 27c tests — the shared pure prompt builder (lib/scene-prompt.ts).
 * Run: npx tsx scripts/test-stage27c.ts
 *
 * Pure-logic only (NO Replicate / network / LLM / DB): proves that buildScenePrompt — the single
 * source of truth shared by the video worker and the "show full prompt" preview — assembles the
 * final Seedance prompt deterministically, honours the scene's model, and (crucial for the preview)
 * NEVER leaks a real reference URL into the prompt text: references appear only as [ImageN] notes.
 */
import assert from "node:assert";
import { buildScenePrompt, MAX_REFERENCE_IMAGES, REFERENCE_IMAGE_CAP } from "../lib/scene-prompt";
import { VISUAL_STYLE_ID } from "../lib/visual-style";

let pass = 0;
const ok = (c: unknown, m: string) => {
  assert(c, m);
  console.log("ok:", m);
  pass++;
};

// A styled character asset URL (its pathname must contain VISUAL_STYLE_ID to count as styled).
const styledUrl = (name: string) => "https://media.invalid/" + VISUAL_STYLE_ID + "/" + name + ".webp";
const noUrl = (s: string) => !/https?:\/\//i.test(s);

const baseScene = {
  id: "scene-1",
  number: 2,
  videoPrompt: "[ACTION]: Two friends talk by the window.",
  sceneKind: null as string | null,
  voiceover: null as string | null,
  dialogue: 'YARA: "Hello there."\nTHEO: "Good to see you."',
  dialogueEn: null as string | null,
  language: "en" as string | null,
  locationDesc: "A sunlit apartment",
  continuesFrom: null as string | null,
};

// ── 1. character_references branch: styled speaking characters → [ImageN] notes, no real URLs ──────
{
  const built = buildScenePrompt({
    scene: baseScene,
    characters: [
      { characterId: "yara", name: "Yara", tier: "MAIN", imageFront: styledUrl("yara") },
      { characterId: "theo", name: "Theo", tier: "MAIN", imageFront: styledUrl("theo") },
    ],
    location: null,
    previous: null, // number=2 but no previous row → cannot chain
    provider: "seedance",
  });
  ok(built.referenceKind === "character_references", "styled characters resolve to character_references");
  ok(built.prompt.includes("[Image1]"), "prompt carries the [Image1] reference note");
  ok(built.prompt.includes("[Image2]"), "prompt carries the [Image2] reference note");
  ok(noUrl(built.prompt), "prompt text contains NO real reference URL (only [ImageN] placeholders)");
  ok(built.referenceImages.length === 2, "referenceImages holds the two styled character URLs (returned separately, not in the prompt)");
  ok(built.model === "seedance" && built.modelSlug === "bytedance/seedance-2.5", "provider seedance → 2.5 slug");
  ok(built.prompt.includes("PACE: natural conversational rhythm"), "prompt includes the shared PACE_DIRECTION");
  ok(built.prompt.includes('"Hello there."') && built.prompt.includes('"Good to see you."'), "dialogue lines are voiced verbatim");
  ok(built.dialogue.includes("Hello there") && !built.isNarration, "resolved dialogue set, not a narration scene");
}

// ── 2. new_scene_reference branch: no styled refs, no chain → single [Image1] still note; legacy provider ─
{
  const built = buildScenePrompt({
    scene: { ...baseScene, id: "scene-2" },
    characters: [], // nothing styled
    location: null,
    previous: null,
    provider: "seedance-2.0",
  });
  ok(built.referenceKind === "new_scene_reference" && built.newSceneReference, "no refs / no chain resolves to new_scene_reference");
  ok(built.prompt.includes("[Image1]"), "new-scene reference still adds an [Image1] note");
  ok(!built.prompt.includes("[Image2]"), "new-scene reference adds exactly one note");
  ok(typeof built.referencePrompt === "string" && built.referencePrompt!.length > 0, "referencePrompt (Flux still) is provided for the worker");
  ok(noUrl(built.prompt), "new_scene_reference prompt text contains NO URL");
  ok(built.model === "seedance" && built.modelSlug === "bytedance/seedance-2.5", "legacy provider seedance-2.0 is ignored → Seedance 2.5 slug (Stage 33)");
}

// ── 3. Stage 36: same-location adjacent styled last frame → reference mode, previous frame LAST ─────
{
  const prevFrame = styledUrl("prev-lastframe");
  const built = buildScenePrompt({
    scene: { ...baseScene, id: "scene-3", number: 3, locationDesc: "A sunlit apartment" },
    characters: [{ characterId: "yara", name: "Yara", tier: "MAIN", imageFront: styledUrl("yara") }],
    location: null,
    previous: { id: "scene-2", number: 2, locationDesc: "A sunlit apartment", lastFrameUrl: prevFrame },
    provider: "seedance",
  });
  ok(built.referenceKind === "character_references", "adjacent same-location styled frame resolves to character_references (no first-frame mode)");
  ok(!("image" in built), "no `image` (first-frame) field is returned");
  ok(built.referenceImages[built.referenceImages.length - 1] === prevFrame, "the previous last frame is the LAST reference image");
  ok(built.retryRefs[built.retryRefs.length - 1].kind === "previous_frame", "…with kind previous_frame");
  ok(built.previousFrameSceneId === "scene-2", "previousFrameSceneId reports the chained scene");
  ok(built.prompt.includes("[Image1]") && built.prompt.includes("[Image2] the final frame of the previous scene"), "notes: portrait then the previous-frame continuity note");
  ok(noUrl(built.prompt), "prompt text contains NO URL");
}

// ── 4. narration branch: off-screen narrator, no on-camera dialogue path ────────────────────────────
{
  const built = buildScenePrompt({
    scene: { ...baseScene, id: "scene-4", sceneKind: "narration", voiceover: "Long ago, the city slept." },
    characters: [],
    location: null,
    previous: null,
    provider: "seedance",
  });
  ok(built.isNarration && built.dialogue === "", "narration scene has no spoken dialogue");
  ok(built.prompt.includes("PACE: natural conversational rhythm"), "narration prompt still includes PACE_DIRECTION");
  ok(noUrl(built.prompt), "narration prompt text contains NO URL");
}

// ── 5. determinism: identical inputs → byte-identical prompt (pure, no side effects) ─────────────────
{
  const input = {
    scene: baseScene,
    characters: [{ characterId: "yara", name: "Yara", tier: "MAIN", imageFront: styledUrl("yara") }],
    location: null,
    previous: null,
    provider: "seedance" as const,
  };
  const a = buildScenePrompt(input).prompt;
  const b = buildScenePrompt(input).prompt;
  ok(a === b, "buildScenePrompt is deterministic (identical inputs → identical prompt)");
}

// ── 6. resolvedDialogueEn (worker path) overrides stored dialogue verbatim, no translation ──────────
{
  const built = buildScenePrompt({
    scene: { ...baseScene, dialogue: 'YARA: "stored line"' },
    characters: [{ characterId: "yara", name: "Yara", tier: "MAIN", imageFront: styledUrl("yara") }],
    location: null,
    previous: null,
    provider: "seedance",
    resolvedDialogueEn: 'YARA: "translated line"',
  });
  ok(built.prompt.includes("translated line") && !built.prompt.includes("stored line"), "resolvedDialogueEn (worker-translated) is used verbatim when provided");
}

// ── 7. unknown provider falls back to the default model ─────────────────────────────────────────────
{
  const built = buildScenePrompt({ scene: baseScene, characters: [], location: null, previous: null, provider: "nonsense" });
  ok(built.model === "seedance" && built.modelSlug === "bytedance/seedance-2.5", "unknown provider normalizes to the default (seedance 2.5)");
}

// ── 8. Stage 31 promptOverride: replaces the TEXT verbatim, keeps the reference/chaining plan ───────
{
  const override = "MY CUSTOM PROMPT — verbatim, no softening, no notes.";
  // 8a. character_references scene with an override: prompt is the override text, NO [ImageN] notes,
  //     but referenceImages / referenceKind are still computed as usual (override changes text only).
  const built = buildScenePrompt({
    scene: { ...baseScene, promptOverride: override },
    characters: [
      { characterId: "yara", name: "Yara", tier: "MAIN", imageFront: styledUrl("yara") },
      { characterId: "theo", name: "Theo", tier: "MAIN", imageFront: styledUrl("theo") },
    ],
    location: null,
    previous: null,
    provider: "seedance",
  });
  ok(built.prompt === override, "override replaces the final prompt text verbatim");
  ok(built.basePrompt === override, "override also becomes the basePrompt (no softening applied)");
  ok(!built.prompt.includes("[Image1]") && !built.prompt.includes("[Image2]"), "override prompt carries NO [ImageN] notes");
  ok(built.referenceKind === "character_references" && built.referenceImages.length === 2, "reference plan (character_references + 2 images) is still computed under an override");

  // 8b. override keeps the reference set (incl. the previous frame) while replacing the text — no notes.
  const prevFrame = styledUrl("prev-lastframe");
  const chained = buildScenePrompt({
    scene: { ...baseScene, id: "scene-3", number: 3, locationDesc: "A sunlit apartment", promptOverride: override },
    characters: [{ characterId: "yara", name: "Yara", tier: "MAIN", imageFront: styledUrl("yara") }],
    location: null,
    previous: { id: "scene-2", number: 2, locationDesc: "A sunlit apartment", lastFrameUrl: prevFrame },
    provider: "seedance",
  });
  ok(chained.prompt === override && chained.referenceKind === "character_references" && chained.referenceImages.includes(prevFrame), "override keeps the reference set (previous frame included) while replacing the text");
  ok(!chained.prompt.includes("[Image"), "override: images are sent but no [ImageN] notes are appended");

  // 8c. whitespace-only override is treated as no override (auto prompt is used).
  const blank = buildScenePrompt({
    scene: { ...baseScene, promptOverride: "   \n  " },
    characters: [{ characterId: "yara", name: "Yara", tier: "MAIN", imageFront: styledUrl("yara") }],
    location: null,
    previous: null,
    provider: "seedance",
  });
  ok(blank.prompt.includes("[Image1]"), "whitespace-only override is ignored → auto prompt with [ImageN] notes");

  // 8d. no override (undefined) keeps the auto prompt unchanged.
  const auto = buildScenePrompt({
    scene: { ...baseScene },
    characters: [{ characterId: "yara", name: "Yara", tier: "MAIN", imageFront: styledUrl("yara") }],
    location: null,
    previous: null,
    provider: "seedance",
  });
  ok(auto.prompt.includes("[Image1]") && auto.prompt !== override, "absent override → normal auto-assembled prompt");
}

ok(REFERENCE_IMAGE_CAP === 30 && MAX_REFERENCE_IMAGES === REFERENCE_IMAGE_CAP, "REFERENCE_IMAGE_CAP is 30 (Stage 36 provider maximum; MAX_REFERENCE_IMAGES alias kept)");

// ── Stage 36: full reference set — ALL scene characters (mentioned first), ALL location angles, crowds ─
{
  const many = ["Ann", "Bob", "Cid", "Dee", "Eve", "Fay"].map(n => ({ characterId: n.toLowerCase(), name: n, tier: "MAIN", imageFront: styledUrl(n.toLowerCase()) }));
  const crowd = [{ characterId: "crowd", name: "Market crowd", tier: "CROWD", imageFront: styledUrl("crowd") }];
  const loc = { id: "loc", name: "Old market", imageUrl: styledUrl("loc-wide"), imageReverse: styledUrl("loc-reverse"), imageDetail: styledUrl("loc-detail") };
  const built = buildScenePrompt({
    scene: { ...baseScene, id: "scene-lean", videoPrompt: "[ACTION]: Fay argues with Eve by the stall.", dialogue: 'Fay: "Enough."' },
    characters: [...many, ...crowd],
    location: loc,
    previous: null,
    provider: "seedance",
  });
  ok(built.referenceKind === "character_references", "lean: still character_references");
  const kinds = (built.reference as any).kinds as string[];
  ok(kinds.filter(k => k === "character").length === 6, "all 6 individual scene characters are sent (no 4-character cap)");
  ok(kinds.filter(k => k === "location").length === 3, "all 3 location angles are sent");
  ok(built.referenceImages[6] === loc.imageUrl, "the wide `imageUrl` angle comes first among the location angles");
  ok(built.referenceImages.length === 10 && built.referenceImages.length <= REFERENCE_IMAGE_CAP, "6 portraits + 3 angles + 1 crowd = 10 references, within the cap");
  const firstTwo = [built.referenceImages[0], built.referenceImages[1]].sort();
  ok(firstTwo[0] === styledUrl("eve") && firstTwo[1] === styledUrl("fay"), "characters mentioned in the scene are ranked first (linked order kept among them)");
  ok(kinds.filter(k => k === "crowd").length === 1, "crowd group is included after the location angles");
  ok(built.prompt.includes("[Image10]") && !built.prompt.includes("[Image11]"), "exactly 10 [ImageN] notes");
  ok(built.previousFrameSceneId === null, "no previous frame when not chained");
}

// ── Stage 36: skipReferences → text_only (no images, no notes, no Flux still) — for chained scenes too ─
{
  const built = buildScenePrompt({
    scene: { ...baseScene, id: "scene-skip", skipReferences: true },
    characters: [{ characterId: "yara", name: "Yara", tier: "MAIN", imageFront: styledUrl("yara") }],
    location: null,
    previous: null,
    provider: "seedance",
  });
  ok(built.referenceKind === "text_only" && built.referenceImages.length === 0 && !built.newSceneReference, "skipReferences → text_only, no images, no Flux still");
  ok(!built.prompt.includes("[Image1]"), "text_only prompt has no [ImageN] notes");
  ok(built.hasOverride === false, "hasOverride is reported (false without an override)");

  const prevFrame = styledUrl("prev-lastframe");
  const chained = buildScenePrompt({
    scene: { ...baseScene, id: "scene-skip-chain", number: 3, skipReferences: true, locationDesc: "Kitchen" },
    characters: [],
    location: null,
    previous: { id: "prev", number: 2, locationDesc: "Kitchen", lastFrameUrl: prevFrame },
    provider: "seedance",
  });
  ok(chained.referenceKind === "text_only" && chained.referenceImages.length === 0 && chained.previousFrameSceneId === null, "skipReferences on a formerly chained scene → text_only, zero images (previous frame not sent)");
}

console.log(`\nStage 27c: ${pass} checks passed.`);
