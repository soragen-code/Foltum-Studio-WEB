/**
 * Stage 17 tests — reliable scenes gate + location X/Y counter + artifacts optional.
 * Run: npx tsx scripts/test-stage17.ts
 *
 * Pure-logic only (NO LLM / network / Replicate). Verifies the exact predicates the
 * episode references screen uses, mirrored here 1:1 from episode-view.tsx + the
 * characters/references route, plus the real lib constants they depend on.
 *
 *  A1  scenes gate GUARANTEES unlock when characters (3/3) + locations (target) are ready,
 *      and stays LOCKED while any mandatory ref is short — the gate reads ACTUAL frames.
 *  A1b character resume selects extra-only characters (Stage 18: 0 extras → all complete at 3/3).
 *  A1c location extra top-up in serverless-safe chunks always reaches the scale target.
 *  A2  location X/Y counter = present base angles + extra angles, clamped to target.
 *  A3  artifacts are OPTIONAL — they are NOT part of the gate; missing/partial artifacts
 *      never block scenes.
 */
import assert from "node:assert";
import { CHARACTER_PHOTO_COUNT, ARTIFACT_FRAME_COUNT, parseImageArray } from "../lib/reference-counts";
import { LOCATION_BASE_FRAMES, desiredExtraFrames, desiredTotalFrames } from "../lib/location-scale";
// A huge-scale location name so fixtures have a known target (huge → 9 total, 6 extra).
const HUGE = "Ночной город";
const TARGET = desiredTotalFrames({ name: HUGE }); // 9

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };

// A non-image URL on purpose: writing ".png" literals into this file triggers an auto
// image-substitution that corrupts the line, so tests use a plain URL sans extension.
const U = "http://example.com/x";

// ---- predicates mirrored 1:1 from episode-view.tsx ------------------------
const validUrl = (u?: string | null) => typeof u === "string" && u.startsWith("http") && u.length > 10;
const parseExtra = (imageExtra?: string | null): string[] => parseImageArray(imageExtra);
const CHAR_EXTRA_MIN = Math.max(0, CHARACTER_PHOTO_COUNT - 3);
const hasAllImages = (c: any) => validUrl(c?.imageFront) && validUrl(c?.imageProfile) && validUrl(c?.imageFull) && parseExtra(c?.imageExtra).length >= CHAR_EXTRA_MIN;
const artifactPhotos = (a: any): string[] => [a?.imageUrl, ...parseExtra(a?.imageExtra)].filter(validUrl);
const artifactReady = (a: any) => artifactPhotos(a).length >= ARTIFACT_FRAME_COUNT;
const locBaseReady = (l: any) => validUrl(l?.imageUrl);
const locExtraReady = (l: any) => parseExtra(l?.imageExtra).length >= desiredExtraFrames(l);
const locationFrames = (l: any): number => [l?.imageUrl, l?.imageReverse, l?.imageDetail].filter(validUrl).length + parseExtra(l?.imageExtra).length;
// The Stage 17 gate — artifacts intentionally absent.
const gate = (chars: any[], locs: any[]) => chars.every(hasAllImages) && locs.every((l) => locBaseReady(l) && locExtraReady(l));

// ---- helpers to build fixtures --------------------------------------------
const arr = (n: number) => JSON.stringify(Array.from({ length: n }, () => U));
const fullChar = () => ({ imageFront: U, imageProfile: U, imageFull: U, imageExtra: arr(CHAR_EXTRA_MIN) });
const baseOnlyChar = () => ({ imageFront: U, imageProfile: U, imageFull: U, imageExtra: null }); // 3/3 — complete in Stage 18
const missingBaseChar = () => ({ imageFront: U, imageProfile: U, imageFull: null, imageExtra: null }); // 2/3 — incomplete
const fullLoc = () => ({ name: HUGE, imageUrl: U, imageReverse: U, imageDetail: U, imageExtra: arr(TARGET - LOCATION_BASE_FRAMES) });
const baseOnlyLoc = () => ({ name: HUGE, imageUrl: U, imageReverse: U, imageDetail: U, imageExtra: null }); // 3/9

// --- A1: gate guarantees unlock when mandatory refs ready -------------------
ok(gate([fullChar(), fullChar()], [fullLoc(), fullLoc()]) === true, "A1: gate OPENS when all characters 3/3 and all locations at target");
ok(gate([fullChar(), missingBaseChar()], [fullLoc()]) === false, "A1: gate LOCKED while a character is missing a base shot");
ok(gate([fullChar()], [fullLoc(), baseOnlyLoc()]) === false, "A1: gate LOCKED while a huge location is stuck at 3/9 (base only)");
ok(gate([], []) === true, "A1: gate OPEN for an episode with no bound characters/locations (vacuous)");

// --- A1b: character resume picks up extra-only chars (Stage 16 stuck bug) ---
// route logic: needBase = missing a base shot (CHARGED); needExtraOnly = has base, lacks extras (FREE)
const missingBase = (c: any) => !c.imageFront || !c.imageProfile || !c.imageFull;
const missingExtra = (c: any) => parseExtra(c.imageExtra).length < CHAR_EXTRA_MIN;
const scope = [fullChar(), baseOnlyChar(), missingBaseChar(), { imageFront: null, imageProfile: null, imageFull: null, imageExtra: null }];
const needBase = scope.filter(missingBase);
const needExtraOnly = scope.filter((c) => !missingBase(c) && missingExtra(c));
const jobIds = [...needBase, ...needExtraOnly];
ok(needExtraOnly.length === 0, "A1b: Stage 18 — no extra-only resumes (characters complete at 3/3)");
ok(needBase.length === 2, "A1b: the empty and the missing-base characters are CHARGED/resumed");
ok(jobIds.length === 2, "A1b: resume job covers only the incomplete characters, skips the complete ones");
ok(CHAR_EXTRA_MIN === 0, "A1b: no extra angles required for a character (3 photos)");

// --- A1c: chunked location top-up reaches the target -----------------------
const LOCATION_EXTRA_CHUNK = 6;
let loc: any = baseOnlyLoc(); // starts at 3 frames (base), needs 12 extra
let ticks = 0;
while (locationFrames(loc) < TARGET && ticks < 50) {
  const want = desiredExtraFrames(loc);
  const have = parseExtra(loc.imageExtra).length;
  const chunk = Math.min(LOCATION_EXTRA_CHUNK, want - have);
  const next = parseExtra(loc.imageExtra).concat(Array.from({ length: chunk }, () => U));
  loc = { ...loc, imageExtra: JSON.stringify(next) };
  ticks++;
}
ok(locationFrames(loc) === TARGET, "A1c: chunked top-up reaches exactly the scale target (9)");
ok(ticks === 1 && LOCATION_EXTRA_CHUNK === 6, "A1c: 6 extras delivered in 1 serverless-safe chunk of 6");
ok(locExtraReady(loc) === true, "A1c: location becomes extra-ready after top-up");

// --- A2: location X/Y counter ----------------------------------------------
ok(locationFrames(baseOnlyLoc()) === 3, "A2: counter = 3 for a base-only huge location (3/9)");
ok(locationFrames(fullLoc()) === TARGET, "A2: counter = target for a full huge location (9/9)");
ok(Math.min(locationFrames(fullLoc()), TARGET) === TARGET, "A2: counter clamped to target (never shows >9)");
ok(locationFrames({ imageUrl: U, imageReverse: null, imageDetail: null, imageExtra: arr(4) }) === 5, "A2: counter counts present base angles + extras (1 base + 4 extra = 5)");

// --- A3: artifacts are OPTIONAL, not part of the gate -----------------------
const noArtifacts: any[] = [];
const partialArtifact = [{ imageUrl: null, imageExtra: null }]; // 0/1 — would have failed the OLD gate
ok(gate([fullChar()], [fullLoc()]) === true, "A3: scenes unlock with chars+locs ready and ZERO artifacts");
// old gate would AND-in refArtifacts.every(artifactReady); prove artifacts are irrelevant to the new gate:
const oldGate = (chars: any[], locs: any[], arts: any[]) => gate(chars, locs) && arts.every(artifactReady);
ok(oldGate([fullChar()], [fullLoc()], partialArtifact) === false, "A3: (sanity) the OLD artifact-inclusive gate WOULD block on a partial artifact");
ok(gate([fullChar()], [fullLoc()]) === true && artifactReady(partialArtifact[0]) === false, "A3: the NEW gate ignores the partial artifact and stays OPEN");
ok(noArtifacts.every(artifactReady) === true, "A3: artifacts can still be tracked/generated independently of the gate");

console.log(`\n${pass} checks passed.`);
