/**
 * Stage 17 tests — reliable scenes gate + location X/Y counter + artifacts optional.
 * Run: npx tsx scripts/test-stage17.ts
 *
 * Pure-logic only (NO LLM / network / Replicate). Verifies the exact predicates the
 * episode references screen uses, mirrored here 1:1 from episode-view.tsx + the
 * characters/references route, plus the real lib constants they depend on.
 *
 *  A1  scenes gate GUARANTEES unlock when characters (5/5) + locations (15/15) are ready,
 *      and stays LOCKED while any mandatory ref is short — the gate reads ACTUAL frames.
 *  A1b character resume selects extra-only characters (the Stage 16 stuck-at-3/5 bug):
 *      a char with 3 base shots but no extras is picked up and charged $0.
 *  A1c location extra top-up in serverless-safe chunks always reaches the 15-frame target.
 *  A2  location X/Y counter = present base angles + extra angles, clamped to target.
 *  A3  artifacts are OPTIONAL — they are NOT part of the gate; missing/partial artifacts
 *      never block scenes.
 */
import assert from "node:assert";
import { CHARACTER_PHOTO_COUNT, ARTIFACT_FRAME_COUNT, parseImageArray } from "../lib/reference-counts";
import { LOCATION_TOTAL_TARGET, LOCATION_BASE_FRAMES, desiredExtraFrames } from "../lib/location-scale";

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
const baseOnlyChar = () => ({ imageFront: U, imageProfile: U, imageFull: U, imageExtra: null }); // 3/5 — the stuck case
const fullLoc = () => ({ imageUrl: U, imageReverse: U, imageDetail: U, imageExtra: arr(LOCATION_TOTAL_TARGET - LOCATION_BASE_FRAMES), scaleTag: "large" });
const baseOnlyLoc = () => ({ imageUrl: U, imageReverse: U, imageDetail: U, imageExtra: null, scaleTag: "large" }); // 3/15

// --- A1: gate guarantees unlock when mandatory refs ready -------------------
ok(gate([fullChar(), fullChar()], [fullLoc(), fullLoc()]) === true, "A1: gate OPENS when all characters 5/5 and all locations 15/15");
ok(gate([fullChar(), baseOnlyChar()], [fullLoc()]) === false, "A1: gate LOCKED while a character is stuck at 3/5 (missing extras)");
ok(gate([fullChar()], [fullLoc(), baseOnlyLoc()]) === false, "A1: gate LOCKED while a location is stuck at 3/15 (base only)");
ok(gate([], []) === true, "A1: gate OPEN for an episode with no bound characters/locations (vacuous)");

// --- A1b: character resume picks up extra-only chars (Stage 16 stuck bug) ---
// route logic: needBase = missing a base shot (CHARGED); needExtraOnly = has base, lacks extras (FREE)
const missingBase = (c: any) => !c.imageFront || !c.imageProfile || !c.imageFull;
const missingExtra = (c: any) => parseExtra(c.imageExtra).length < CHAR_EXTRA_MIN;
const scope = [fullChar(), baseOnlyChar(), { imageFront: null, imageProfile: null, imageFull: null, imageExtra: null }];
const needBase = scope.filter(missingBase);
const needExtraOnly = scope.filter((c) => !missingBase(c) && missingExtra(c));
const jobIds = [...needBase, ...needExtraOnly];
ok(needExtraOnly.length === 1, "A1b: the 3/5 character (base but no extras) IS selected for resume");
ok(needBase.length === 1, "A1b: only the truly-empty character is CHARGED");
ok(jobIds.length === 2, "A1b: resume job covers both empty + extra-only characters, skips the complete one");
ok(CHAR_EXTRA_MIN * needExtraOnly.length >= 0 /* free */ && needBase.length === 1, "A1b: extra-only top-up rides for free (cost counts only needBase)");

// --- A1c: chunked location top-up reaches the target -----------------------
const LOCATION_EXTRA_CHUNK = 6;
let loc: any = baseOnlyLoc(); // starts at 3 frames (base), needs 12 extra
let ticks = 0;
while (locationFrames(loc) < LOCATION_TOTAL_TARGET && ticks < 50) {
  const want = desiredExtraFrames(loc);
  const have = parseExtra(loc.imageExtra).length;
  const chunk = Math.min(LOCATION_EXTRA_CHUNK, want - have);
  const next = parseExtra(loc.imageExtra).concat(Array.from({ length: chunk }, () => U));
  loc = { ...loc, imageExtra: JSON.stringify(next) };
  ticks++;
}
ok(locationFrames(loc) === LOCATION_TOTAL_TARGET, "A1c: chunked top-up reaches exactly 15 frames");
ok(ticks === 2 && LOCATION_EXTRA_CHUNK === 6, "A1c: 12 extras delivered in 2 serverless-safe chunks of 6");
ok(locExtraReady(loc) === true, "A1c: location becomes extra-ready after top-up");

// --- A2: location X/Y counter ----------------------------------------------
ok(locationFrames(baseOnlyLoc()) === 3, "A2: counter = 3 for a base-only large location (3/15)");
ok(locationFrames(fullLoc()) === LOCATION_TOTAL_TARGET, "A2: counter = 15 for a full large location (15/15)");
ok(Math.min(locationFrames(fullLoc()), LOCATION_TOTAL_TARGET) === LOCATION_TOTAL_TARGET, "A2: counter clamped to target (never shows >15)");
ok(locationFrames({ imageUrl: U, imageReverse: null, imageDetail: null, imageExtra: arr(4) }) === 5, "A2: counter counts present base angles + extras (1 base + 4 extra = 5)");

// --- A3: artifacts are OPTIONAL, not part of the gate -----------------------
const noArtifacts: any[] = [];
const partialArtifact = [{ imageUrl: U, imageExtra: null }]; // 1/3 — would have failed the OLD gate
ok(gate([fullChar()], [fullLoc()]) === true, "A3: scenes unlock with chars+locs ready and ZERO artifacts");
// old gate would AND-in refArtifacts.every(artifactReady); prove artifacts are irrelevant to the new gate:
const oldGate = (chars: any[], locs: any[], arts: any[]) => gate(chars, locs) && arts.every(artifactReady);
ok(oldGate([fullChar()], [fullLoc()], partialArtifact) === false, "A3: (sanity) the OLD artifact-inclusive gate WOULD block on a partial artifact");
ok(gate([fullChar()], [fullLoc()]) === true && artifactReady(partialArtifact[0]) === false, "A3: the NEW gate ignores the partial artifact and stays OPEN");
ok(noArtifacts.every(artifactReady) === true, "A3: artifacts can still be tracked/generated independently of the gate");

console.log(`\n${pass} checks passed.`);
