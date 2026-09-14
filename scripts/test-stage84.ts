/**
 * Stage 84 — location is the BASE LAYER of the frame: the environment is established FIRST from the
 * location reference, and the characters are placed INTO that already-built location (on top / inside),
 * not the reverse. Implemented as a post-processing prompt directive at the pipeline level (video-job +
 * preview route) so the protected lib/scene-prompt.ts and the [ImageN] reference mapping stay untouched.
 *
 * Covered:
 *  (1) the directive text expresses location-first / base-layer + characters placed into it;
 *  (2) applyLocationBaseLayer gating (only with a location ref, skips override, idempotent);
 *  (3) full transform pipeline order: LOCATION-BASE-LAYER is applied OUTERMOST (after CONTINUOUS ACTION),
 *      and preview == worker (both derive hasLocationRef from refs whose kind === "location");
 *  (4) Stage 79-83 logic preserved (continuity directives still applied, per-scene reset gate intact).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOCATION_BASE_LAYER_LINE,
  applyLocationBaseLayer,
  CONTINUOUS_ACTION_LINE,
  applyContinuousAction,
  applyNewShotCameraMove,
  applySeamDirectives,
  type Continuity,
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

// ---- (1) directive text -----------------------------------------------------
ok("1: directive marks the location as the BASE LAYER", /LOCATION IS THE BASE LAYER/.test(LOCATION_BASE_LAYER_LINE));
ok("1: environment is built FIRST from the location reference", /location reference images first/.test(LOCATION_BASE_LAYER_LINE) && /foundation of the shot/.test(LOCATION_BASE_LAYER_LINE));
ok("1: characters are placed INTO the already-established location (on top / inside)", /placed INTO this already-established location/.test(LOCATION_BASE_LAYER_LINE) && /composited on top of \/ inside it/.test(LOCATION_BASE_LAYER_LINE));
ok("1: location is never rebuilt / re-composed around the characters", /Never rebuild, restyle, relight or re-compose the location around the characters/.test(LOCATION_BASE_LAYER_LINE));
ok("1: not a flat backdrop — location first, people second", /never render them as figures pasted in front of a picture of the place/.test(LOCATION_BASE_LAYER_LINE) && /the location comes first as the base plate, the people occupy it second/.test(LOCATION_BASE_LAYER_LINE));

// ---- (2) gating -------------------------------------------------------------
const base = "SHOT: a room.\n\nAUDIO: quiet.";
ok("2: appended when a location reference is present", applyLocationBaseLayer(base, { hasOverride: false, hasLocationRef: true }).includes(LOCATION_BASE_LAYER_LINE));
ok("2: base prompt kept on top, directive appended at the end", applyLocationBaseLayer(base, { hasOverride: false, hasLocationRef: true }).startsWith(base) );
ok("2: NOT appended when there is no location reference", applyLocationBaseLayer(base, { hasOverride: false, hasLocationRef: false }) === base);
ok("2: manual override is returned unchanged", applyLocationBaseLayer(base, { hasOverride: true, hasLocationRef: true }) === base);
ok("2: idempotent (applied twice = once)", applyLocationBaseLayer(applyLocationBaseLayer(base, { hasOverride: false, hasLocationRef: true }), { hasOverride: false, hasLocationRef: true }).split(LOCATION_BASE_LAYER_LINE).length === 2);

// ---- (3) pipeline order + preview == worker --------------------------------
// Simulate the full transform chain for a CONTINUING scene WITH a location reference.
const cont: Continuity = "last_frame";
let p = "OPENING STATE: x.\n\n[SHOT TYPE] wide.\n\nAUDIO TRACK: room tone.";
p = applySeamDirectives(p, { hasOverride: false });
p = applyNewShotCameraMove(p, 3, { hasOverride: false, continuity: cont });
p = applyContinuousAction(p, { hasOverride: false, continuity: cont });
p = applyLocationBaseLayer(p, { hasOverride: false, hasLocationRef: true });
ok("3: full pipeline contains CONTINUOUS ACTION and LOCATION-BASE-LAYER", p.includes(CONTINUOUS_ACTION_LINE) && p.includes(LOCATION_BASE_LAYER_LINE));
ok("3: LOCATION-BASE-LAYER is applied OUTERMOST (after CONTINUOUS ACTION)", p.indexOf(LOCATION_BASE_LAYER_LINE) > p.indexOf(CONTINUOUS_ACTION_LINE));
ok("3: whole pipeline idempotent end-to-end", applyLocationBaseLayer(applyContinuousAction(p, { hasOverride: false, continuity: cont }), { hasOverride: false, hasLocationRef: true }) === p);

ok("3: worker imports applyLocationBaseLayer", /applyLocationBaseLayer/.test(worker) && /from "@\/lib\/prompt-seam"/.test(worker));
ok("3: worker derives hasLocationRef from refs whose kind === 'location'", /const hasLocationRef = built\.retryRefs\.some\(\(r\) => r\.kind === "location"\)/.test(worker));
ok("3: worker applies the directive after applyContinuousAction", worker.indexOf("applyLocationBaseLayer(prompt") > worker.indexOf("applyContinuousAction(prompt"));
ok("3: preview route imports applyLocationBaseLayer", /applyLocationBaseLayer/.test(previewRoute));
ok("3: preview route derives the same hasLocationRef signal", /const hasLocationRef = built\.retryRefs\.some\(\(r\) => r\.kind === "location"\)/.test(previewRoute));
ok("3: preview route applies applyLocationBaseLayer as the OUTERMOST wrapper", /const prompt = applyLocationBaseLayer\(\s*applyContinuousAction\(/.test(previewRoute));

// ---- (4) does not touch the protected [ImageN] ordering / notes -------------
ok("4: directive explicitly does NOT reorder the [ImageN] reference set", /does NOT reorder the \[ImageN\] reference set/.test(seam));
ok("4: no per-scene reset regressions — video-job still applies continuity directives", /applyContinuousAction\(prompt/.test(worker) && /applyNewShotCameraMove\(prompt/.test(worker));

console.log(`\nStage 84: ${passed} checks passed`);
