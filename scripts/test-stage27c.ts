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
import { buildScenePrompt, MAX_REFERENCE_IMAGES } from "../lib/scene-prompt";
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

// ── 2. new_scene_reference branch: no styled refs, no chain → single [Image1] still note, model 2.0 ─
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
  ok(built.model === "seedance-2.0" && built.modelSlug === "bytedance/seedance-2.0", "provider seedance-2.0 → 2.0 slug");
}

// ── 3. adjacent_frame branch: same-location adjacent styled last frame → image-to-video, no notes ───
{
  const prevFrame = styledUrl("prev-lastframe");
  const built = buildScenePrompt({
    scene: { ...baseScene, id: "scene-3", number: 3, locationDesc: "A sunlit apartment" },
    characters: [{ characterId: "yara", name: "Yara", tier: "MAIN", imageFront: styledUrl("yara") }],
    location: null,
    previous: { id: "scene-2", number: 2, locationDesc: "A sunlit apartment", lastFrameUrl: prevFrame },
    provider: "seedance",
  });
  ok(built.referenceKind === "adjacent_frame", "adjacent same-location styled frame resolves to adjacent_frame");
  ok(built.image === prevFrame, "the previous last frame is used as the image-to-video seed");
  ok(!built.prompt.includes("[Image1]"), "adjacent_frame prompt has no [ImageN] notes");
  ok(noUrl(built.prompt), "adjacent_frame prompt text contains NO URL");
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

ok(MAX_REFERENCE_IMAGES === 30, "MAX_REFERENCE_IMAGES is 30 (Seedance reference cap)");

console.log(`\nStage 27c: ${pass} checks passed.`);
