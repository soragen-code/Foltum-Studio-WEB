/**
 * Stage 16 tests — reworked reference counts + location angle diversity.
 * Run: npx tsx scripts/test-stage16.ts
 *
 * Pure-logic only (NO LLM / network / Replicate calls). Verifies:
 *  A1  artifact = 3 frames (count + 3 distinct variants + frame prompts differ)
 *  A2  character = 5 FIXED angles (face close-up, LEFT profile, full FRONT, RIGHT profile, full BACK)
 *  A3  location = FIXED 15 frames for every scale (12 extra)
 *  B2  ≥15 DISTINCT location camera formulations (base 3 + extra pool)
 *  B1  extra-angle prompt loosens the hard base-image binding (works with AND without a base image)
 */
import assert from "node:assert";
import {
  CHARACTER_PHOTO_COUNT,
  ARTIFACT_FRAME_COUNT,
  CHARACTER_ANGLE_SET,
} from "../lib/reference-counts";
import {
  desiredTotalFrames,
  desiredExtraFrames,
  LOCATION_BASE_FRAMES,
} from "../lib/location-scale";
import {
  characterImagePrompt,
  CHARACTER_EXTRA_VARIANTS,
  characterExtraAnglePrompt,
  ARTIFACT_VARIANTS,
  artifactImagePrompt,
  LOCATION_ANGLES,
  LOCATION_EXTRA_VARIANTS,
  locationExtraAnglePrompt,
} from "../lib/visual-style";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };

// --- A1: artifact = 3 frames ------------------------------------------------
ok(ARTIFACT_FRAME_COUNT === 3, "A1: artifact = 3 frames");
ok(ARTIFACT_VARIANTS.length === 3, "A1: 3 artifact variants defined");
ok(new Set(ARTIFACT_VARIANTS).size === 3, "A1: artifact variants are distinct");
const a0 = artifactImagePrompt("an antique brass compass", "Compass", 0);
const a1 = artifactImagePrompt("an antique brass compass", "Compass", 1);
const a2 = artifactImagePrompt("an antique brass compass", "Compass", 2);
ok(a0 !== a1 && a1 !== a2 && a0 !== a2, "A1: the 3 artifact frame prompts all differ");
ok(/isolated/i.test(a0) && /context/i.test(a1) && /close-up|detail|macro/i.test(a2), "A1: frame 0 clean, 1 in-context, 2 close-up detail");
ok([a0, a1, a2].every((p) => /No people/i.test(p)), "A1: artifact prompts keep 'no people'");

// --- A2: character = 5 fixed angles -----------------------------------------
ok(CHARACTER_PHOTO_COUNT === 5, "A2: character = 5 photos");
ok(CHARACTER_ANGLE_SET.length === 5 && new Set(CHARACTER_ANGLE_SET).size === 5, "A2: 5 distinct fixed angle slots");
ok(
  JSON.stringify([...CHARACTER_ANGLE_SET]) === JSON.stringify(["face", "leftProfile", "fullFront", "rightProfile", "fullBack"]),
  "A2: fixed angle order = face, leftProfile, fullFront, rightProfile, fullBack",
);
const appearance = "weathered fisherman, grey beard, yellow raincoat";
const front = characterImagePrompt(appearance, "front", "Marco");
const profile = characterImagePrompt(appearance, "profile", "Marco");
const full = characterImagePrompt(appearance, "full", "Marco");
ok(/close-up front portrait|face filling the frame/i.test(front), "A2: base shot 1 = face close-up front portrait");
ok(/left-side profile|left side/i.test(profile) && /LEFT/.test(profile), "A2: base shot 2 = LEFT profile");
ok(/full-body/i.test(full) && /FRONT/.test(full), "A2: base shot 3 = full-body FRONT");
// The 2 extras complete the set: RIGHT profile + full-body BACK.
ok(CHARACTER_EXTRA_VARIANTS.length === 2, "A2: exactly 2 extra angle variants");
const ex0 = characterExtraAnglePrompt(appearance, "Marco", 0);
const ex1 = characterExtraAnglePrompt(appearance, "Marco", 1);
ok(/right-side profile|RIGHT/i.test(ex0) && /RIGHT/.test(ex0), "A2: extra 1 = RIGHT profile");
ok(/BEHIND|back view|from the back/i.test(ex1) && /full-body/i.test(ex1), "A2: extra 2 = full-body BACK");
ok(ex0 !== ex1, "A2: the two extra prompts differ");
// Unity: every character prompt keeps the same appearance description.
ok([front, profile, full, ex0, ex1].every((p) => /fisherman|beard/i.test(p)), "A2: all 5 prompts embed the same appearance (unity)");

// --- A3: location fixed 15 for every scale ----------------------------------
for (const [label, loc] of [["small", { name: "Кабинет" }], ["big", { name: "Склад" }], ["huge", { name: "Ночной город" }]] as const) {
  ok(desiredTotalFrames(loc) === 15, `A3: ${label} location → 15 total`);
  ok(desiredExtraFrames(loc) === 15 - LOCATION_BASE_FRAMES, `A3: ${label} location → 12 extra`);
}

// --- B2: ≥15 distinct location camera formulations --------------------------
ok(LOCATION_EXTRA_VARIANTS.length >= 12, "B2: extra-variant pool covers the 12 extra frames");
ok(new Set(LOCATION_EXTRA_VARIANTS).size === LOCATION_EXTRA_VARIANTS.length, "B2: extra variants are all distinct");
const allFormulations = new Set<string>([...LOCATION_ANGLES.map((a) => a.angle), ...LOCATION_EXTRA_VARIANTS]);
ok(allFormulations.size >= 15, `B2: ≥15 distinct camera formulations total (${allFormulations.size})`);
// The 12 formulations actually used (indices 0..11) are all distinct.
const used = Array.from({ length: 12 }, (_, i) => locationExtraAnglePrompt("a wooden cabin interior", "Cabin", i, { withBaseImage: false }));
ok(new Set(used).size === 12, "B2: the 12 used extra prompts are all distinct");
// Spot-check that genuinely different camera language appears across the set.
const joined = LOCATION_EXTRA_VARIANTS.join(" \n ").toLowerCase();
for (const kw of ["high", "low angle", "corner", "doorway", "detail", "entrance", "length", "window", "overview", "nook"]) {
  ok(joined.includes(kw), `B2: extra variants include a '${kw}' camera formulation`);
}

// --- B1: loosened base-image binding ----------------------------------------
const withImg = locationExtraAnglePrompt("a wooden cabin interior", "Cabin", 2, { withBaseImage: true });
const noImg = locationExtraAnglePrompt("a wooden cabin interior", "Cabin", 0, { withBaseImage: false });
ok(/reference image/i.test(withImg), "B1: re-anchor frame references the base image");
ok(!/reference image/i.test(noImg) && /described below/i.test(noImg), "B1: text-only frame does NOT bind to a base image");
ok([withImg, noImg].every((p) => /DIFFERENT camera position/i.test(p)), "B1: both variants demand a different camera position");
ok([withImg, noImg].every((p) => /identical|stays identical/i.test(p)), "B1: both variants keep the place identical (consistency preserved)");
ok([withImg, noImg].every((p) => /no people/i.test(p)), "B1: location plates stay people-free");

console.log(`\nALL STAGE16 CHECKS PASSED (${pass})`);
