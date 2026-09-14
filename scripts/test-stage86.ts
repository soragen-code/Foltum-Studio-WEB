/**
 * Stage 86 — the "location first / location is the base layer" behavior must also apply to OLD,
 * already-existing projects, keyed on the reference TYPE (location vs character), never on the order
 * records were created / returned by the DB.
 *
 * Two fronts:
 *  A) Pipeline (Stage 84 directive): the LOCATION-AS-BASE-LAYER directive fires whenever the scene has
 *     a location reference. Stage 84 only detected a location when a STYLED location image made it into
 *     the [ImageN] set (built.retryRefs kind === "location"), which — via the protected
 *     isStyledAsset()/VISUAL_STYLE_ID gating in lib/scene-prompt.ts — silently excludes OLD projects
 *     whose location image predates the current style id. Stage 86 adds a type-based, retroactive
 *     detector `sceneHasLocationRef` (location-typed ref OR named locationId OR the location row simply
 *     carrying a real image URL) used by BOTH the worker and the preview route.
 *  B) UI (references-stage): the location block renders FIRST by TYPE (order-first, rendered from the
 *     dedicated `locations` relation — never mixed into the character groups), independent of DB order,
 *     so it holds for old projects too.
 *
 * No protected files are touched; no destructive DB migration.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  sceneHasLocationRef,
  locationRowHasImage,
  applyLocationBaseLayer,
  LOCATION_BASE_LAYER_LINE,
  CONTINUOUS_ACTION_LINE,
} from "../lib/prompt-seam";

let passed = 0;
function ok(label: string, cond: boolean) {
  if (!cond) { console.error("FAIL: " + label); process.exit(1); }
  console.log("ok: " + label);
  passed++;
}

const ROOT = join(__dirname, "..");
const seam = readFileSync(join(ROOT, "lib/prompt-seam.ts"), "utf8");
const worker = readFileSync(join(ROOT, "lib/workers/video-job.ts"), "utf8");
const previewRoute = readFileSync(join(ROOT, "app/api/ai/scenes/[id]/prompt/route.ts"), "utf8");
const refs = readFileSync(join(ROOT, "app/project/[id]/_components/references-stage.tsx"), "utf8");

const URL1 = "https://cdn.prod.website-files.com/5f16d69f1760cdba99c3ce6e/67da88d1ad9a05d5bc6b0ba4_414.png";
const URL2 = "https://lh3.googleusercontent.com/C7CGFBNpuQR23FWQp9At2DTvV4TeVFLe1qVywvtqQBXOFbfVg80YHG8lqbdef4jVHxvj1EpDO8AbOd0IfT3UytzLZVJ4reHiEbg=s0-e365-rw";

// ---- (A1) locationRowHasImage: retroactive, ANY real image URL counts ----------------------
ok("A1: null / undefined location has no image", !locationRowHasImage(null) && !locationRowHasImage(undefined));
ok("A1: empty location row has no image", !locationRowHasImage({}));
ok("A1: a plain imageUrl counts (even without the current style id → covers OLD projects)", locationRowHasImage({ imageUrl: URL1 }));
ok("A1: imageReverse / imageDetail count too", locationRowHasImage({ imageReverse: URL1 }) && locationRowHasImage({ imageDetail: URL1 }));
ok("A1: imageExtra JSON array of URLs counts", locationRowHasImage({ imageExtra: JSON.stringify([URL1, URL2]) }));
ok("A1: non-URL / short junk does NOT count", !locationRowHasImage({ imageUrl: "n/a" }) && !locationRowHasImage({ imageUrl: "" }));
ok("A1: malformed imageExtra never throws and does not count", !locationRowHasImage({ imageExtra: "{not json" }) && !locationRowHasImage({ imageExtra: "[]" }));

// ---- (A2) sceneHasLocationRef: type-based, order-independent, retroactive -------------------
ok("A2: true when a location-typed ref is attached (new/styled projects)",
  sceneHasLocationRef({ retryRefs: [{ kind: "character" }, { kind: "location" }] }));
ok("A2: true when the reference names a locationId (equivalent signal)",
  sceneHasLocationRef({ retryRefs: [{ kind: "character" }], reference: { locationId: "loc_1" } }));
ok("A2: RETROACTIVE — true for an OLD project: no location ref in the set, but the location row has an image",
  sceneHasLocationRef({ retryRefs: [{ kind: "character" }], reference: { locationId: null }, location: { imageUrl: URL1 } }));
ok("A2: false when there is genuinely no location (no ref, no id, no image)",
  !sceneHasLocationRef({ retryRefs: [{ kind: "character" }], reference: { locationId: null }, location: null }));
ok("A2: false with empty inputs",
  !sceneHasLocationRef({}) && !sceneHasLocationRef({ retryRefs: [], reference: null, location: {} }));
// order-independence: character listed FIRST in retryRefs must not affect the location detection
ok("A2: detection ignores position/order of refs (character-first still detects location)",
  sceneHasLocationRef({ retryRefs: [{ kind: "character" }, { kind: "crowd" }, { kind: "location" }] }));

// ---- (A3) directive gating unchanged & driven by the detector -------------------------------
const base = "PROMPT BODY";
ok("A3: directive is appended when a location ref is present", applyLocationBaseLayer(base, { hasOverride: false, hasLocationRef: true }).includes(LOCATION_BASE_LAYER_LINE));
ok("A3: directive is skipped when no location ref", !applyLocationBaseLayer(base, { hasOverride: false, hasLocationRef: false }).includes(LOCATION_BASE_LAYER_LINE));
ok("A3: manual override is never touched", applyLocationBaseLayer(base, { hasOverride: true, hasLocationRef: true }) === base);
ok("A3: idempotent (not appended twice)", (() => { const once = applyLocationBaseLayer(base, { hasOverride: false, hasLocationRef: true }); return applyLocationBaseLayer(once, { hasOverride: false, hasLocationRef: true }) === once; })());

// ---- (A4) helper source keeps the detection type-based, not order-based ---------------------
ok("A4: sceneHasLocationRef checks the location-typed ref", /r\.kind === "location"/.test(seam));
ok("A4: sceneHasLocationRef falls back to the reference locationId", /reference\?\.locationId/.test(seam));
ok("A4: sceneHasLocationRef falls back to the location row image (old projects)", /locationRowHasImage\(input\.location\)/.test(seam));

// ---- (A5) pipeline wiring: worker + preview use the retroactive detector with the location row
ok("A5: worker imports sceneHasLocationRef", /import\s*\{[^}]*sceneHasLocationRef[^}]*\}\s*from\s*"@\/lib\/prompt-seam"/.test(worker));
ok("A5: worker passes the location row into the detector", /sceneHasLocationRef\(\{[\s\S]*?location:\s*episodeLoc\?\.location/.test(worker));
ok("A5: preview route imports sceneHasLocationRef", /import\s*\{[^}]*sceneHasLocationRef[^}]*\}\s*from\s*"@\/lib\/prompt-seam"/.test(previewRoute));
ok("A5: preview route passes the location row into the detector", /sceneHasLocationRef\(\{[\s\S]*?location:\s*scene\.episode\.location/.test(previewRoute));
ok("A5: preview still selects the location image fields (incl. imageExtra) needed by the detector", /location:\s*\{\s*select:\s*\{[^}]*imageUrl[^}]*imageExtra/.test(previewRoute));
// the old inline order-based check must be gone from both callsites
ok("A5: worker no longer uses the old inline retryRefs-only check", !/const hasLocationRef = built\.retryRefs\.some/.test(worker));
ok("A5: preview no longer uses the old inline retryRefs-only check", !/const hasLocationRef = built\.retryRefs\.some/.test(previewRoute));

// ---- (B) UI: location renders first by TYPE, independent of DB order ------------------------
const locStart = refs.indexOf('data-testid="location-references"');
ok("B: location section exists", locStart > 0);
const secOpen = refs.lastIndexOf("<section", locStart);
const secClose = refs.indexOf("</section>", locStart);
const locSection = refs.slice(secOpen, secClose);
ok("B: location section is order-first (rendered first regardless of DB record order)", /order-first/.test(locSection));
ok("B: location section is rendered from the dedicated locations relation", /locations\.map\(\(loc\)/.test(refs));
ok("B: location section highlighted + base-layer emphasis retained (Stage 85)", /border-primary\/40/.test(locSection) && /Базовый слой сцены/.test(locSection));
ok("B: character groups render from the tier groups, never mixed with locations", /groups\.map\(\(g\)/.test(refs) && /data-testid=\{`ref-group-\$\{g\.tier\}`\}/.test(refs));
ok("B: the type-based, retroactive intent is documented for old projects", /regardless of the order records were created/.test(refs) && /OLD projects/.test(refs));

// ---- (C) Stage 84/85 + earlier preserved ---------------------------------------------------
ok("C: Stage 84 directive text unchanged (location is the base layer)", /LOCATION IS THE BASE LAYER/.test(LOCATION_BASE_LAYER_LINE));
ok("C: Stage 82 CONTINUOUS ACTION still present", /CONTINUOUS ACTION:/.test(CONTINUOUS_ACTION_LINE));
ok("C: Stage 85 larger location cards preserved (lg:grid-cols-2 + max-h-80)", /lg:grid-cols-2/.test(locSection) && /max-h-80/.test(locSection));
ok("C: character grid still lg:grid-cols-3", /<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">/.test(refs));

console.log(`\nAll ${passed} Stage 86 checks passed.`);
