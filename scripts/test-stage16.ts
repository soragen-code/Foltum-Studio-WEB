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

// --- A1: artifact = 1 frame (Stage 18) --------------------------------------
ok((ARTIFACT_FRAME_COUNT as number) === 1, "A1: artifact = 1 frame (Stage 18)");
ok(ARTIFACT_VARIANTS.length >= 1, "A1: artifact variant pool covers the 1 required frame");
ok(new Set(ARTIFACT_VARIANTS).size === ARTIFACT_VARIANTS.length, "A1: artifact variants are distinct");
const a0 = artifactImagePrompt("an antique brass compass", "Compass", 0);
ok(/isolated/i.test(a0), "A1: frame 0 is a clean isolated reference");
ok(/No people/i.test(a0), "A1: artifact prompt keeps 'no people'");

// --- A2: character = 3 fixed angles (Stage 18) ------------------------------
ok((CHARACTER_PHOTO_COUNT as number) === 3, "A2: character = 3 photos");
ok(CHARACTER_ANGLE_SET.length === 3 && new Set(CHARACTER_ANGLE_SET).size === 3, "A2: 3 distinct fixed angle slots");
ok(
  JSON.stringify([...CHARACTER_ANGLE_SET]) === JSON.stringify(["face", "leftProfile", "fullFront"]),
  "A2: fixed angle order = face, leftProfile, fullFront",
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

// --- A3: location frames follow the required detail level (4 / 6 / 9), not the size ---
for (const [label, loc, total] of [["low", { name: "Ночной город", detailLevel: "low" }, 4], ["medium", { name: "Склад", detailLevel: "medium" }, 6], ["high", { name: "Кабинет", detailLevel: "high" }, 9]] as const) {
  ok(desiredTotalFrames(loc) === total, `A3: ${label} location → ${total} total`);
  ok(desiredExtraFrames(loc) === total - LOCATION_BASE_FRAMES, `A3: ${label} location → ${total - 3} extra`);
}

// --- B2: ≥15 distinct location camera formulations --------------------------
ok(LOCATION_EXTRA_VARIANTS.length === 6, "B2 (Stage 44): fixed six-slot extra plan");
ok(new Set(LOCATION_EXTRA_VARIANTS).size === LOCATION_EXTRA_VARIANTS.length, "B2: extra variants are all distinct");
const allFormulations = new Set<string>([...LOCATION_ANGLES.map((a) => a.angle), ...LOCATION_EXTRA_VARIANTS]);
ok(allFormulations.size >= 9, `B2: ≥9 distinct camera formulations total (${allFormulations.size})`);
// The 12 formulations actually used (indices 0..11) are all distinct.
const used = Array.from({ length: 6 }, (_, i) => locationExtraAnglePrompt("a wooden cabin interior", "Cabin", i));
ok(new Set(used).size === 6, "B2: the 6 used extra prompts are all distinct");
// Spot-check that genuinely different camera language appears across the set.
const joined = LOCATION_EXTRA_VARIANTS.join(" \n ").toLowerCase();
for (const kw of ["high", "low angle", "corner", "doorway", "entrance", "length", "window", "light source"]) {
  ok(joined.includes(kw), `B2: extra variants include a '${kw}' camera formulation`);
}

// --- B1: loosened base-image binding ----------------------------------------
const withImg = locationExtraAnglePrompt("a wooden cabin interior", "Cabin", 2, { withBaseImage: true });
const noImg = locationExtraAnglePrompt("a wooden cabin interior", "Cabin", 0, { withBaseImage: false });
ok(/reference image IS this location, already photographed/i.test(withImg), "B1 (Stage 44): extra frame references the photographed base image");
ok(/reference image IS this location, already photographed/i.test(noImg), "B1 (Stage 44): every extra frame binds to the base image (withBaseImage ignored)");
ok([withImg, noImg].every((p) => /another camera position/i.test(p) && /do NOT reproduce the earlier framing/i.test(p)), "B1: both variants demand a different camera position");
ok([withImg, noImg].every((p) => /Same architecture, materials/i.test(p)), "B1: both variants keep the place identical (consistency preserved)");
ok([withImg, noImg].every((p) => /no people/i.test(p)), "B1: location plates stay people-free");

console.log(`\nALL STAGE16 CHECKS PASSED (${pass})`);
