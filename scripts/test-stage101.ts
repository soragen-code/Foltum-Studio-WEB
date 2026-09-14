/**
 * Stage 101 — previous-frame reference = WORLD STATE only.
 * The CONTINUE FROM directive is prepended to the top, forbids copying the reference camera
 * (angle / scale / height), and names a concrete frame-1 camera: the script's CAMERA block when
 * present, otherwise a deterministic opening angle rotated by scene number.
 */
import assert from "node:assert";
import {
  applyReframeDirective,
  applySeamDirectives,
  applyNewShotCameraMove,
  reframeDirective,
  reframePreviousFrameLine,
  extractScriptedCamera,
  openingAngleForScene,
  NEW_SHOT_OPENING_ANGLES,
  MOTION_TO_LAST_FRAME_LINE,
} from "../lib/prompt-seam";
import type { Continuity } from "../lib/prompt-seam";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };

const refs = [{ kind: "character" }, { kind: "previous_frame" }, { kind: "location" }];
const body = `[SHOT TYPE] medium two-shot.\n\n[ACTION] Mara crosses to the window.\n\nDialogue (EN): "Hello."`;

// ── A. directive sits at the TOP of the prompt ───────────────────────────────────────────────────────
{
  const out = applyReframeDirective(body, refs, { hasOverride: false, sceneNumber: 2 });
  ok(out.indexOf("CONTINUE FROM [Image2]:") === 0, "A: directive is the very first thing in the prompt");
  ok(out.indexOf("CONTINUE FROM") < out.indexOf("[SHOT TYPE]"), "A: directive precedes the original prompt body");
  ok(out.endsWith(body), "A: original body kept intact after the directive");
}

// ── B. explicit prohibition of the reference camera ─────────────────────────────────────────────────
{
  const d = reframeDirective(2, { sceneNumber: 2 });
  ok(/FORBIDDEN/.test(d), "B: reference composition/angle/scale/height are FORBIDDEN as frame 1");
  ok(/Frame 1 must NOT match \[Image2\] in angle, scale or height/.test(d), "B: frame 1 must not match [Image2] in angle, scale or height");
  ok(/defines ONLY: who stands where, in what pose \/ phase of movement, wardrobe, props, set dressing, light and time of day/.test(d), "B: [ImageN] defines ONLY the world state");
  ok(!/30–60°/.test(d), "B: vague 'about 30–60°' wording is gone");
}

// ── C. deterministic opening angle rotates by scene number ──────────────────────────────────────────
{
  const a2 = openingAngleForScene(2), a3 = openingAngleForScene(3), a4 = openingAngleForScene(4);
  ok(a2 !== a3 && a3 !== a4 && a2 !== a4, "C: scenes 2/3/4 get different opening angles");
  ok(NEW_SHOT_OPENING_ANGLES.every((a) => /angle|shot|wide/i.test(a) && /height|eye level|looking down|looking up/i.test(a)), "C: every entry names angle + scale + camera height");
  ok(openingAngleForScene(1) === NEW_SHOT_OPENING_ANGLES[0] && openingAngleForScene(7) === NEW_SHOT_OPENING_ANGLES[0], "C: cycles deterministically (1 and 7 coincide)");
  ok(openingAngleForScene(0) === NEW_SHOT_OPENING_ANGLES[0] && openingAngleForScene(NaN) === NEW_SHOT_OPENING_ANGLES[0], "C: invalid scene number falls back to entry 1");
  const d2 = reframeDirective(1, { sceneNumber: 2 }), d3 = reframeDirective(1, { sceneNumber: 3 }), d4 = reframeDirective(1, { sceneNumber: 4 });
  ok(d2 !== d3 && d3 !== d4, "C: directives for scenes 2/3/4 differ");
  ok(d2.includes(`FRAME-1 CAMERA (mandatory): open on ${a2}.`), "C: directive without a scripted camera names the deterministic angle");
}

// ── D. scripted CAMERA block from startState wins ───────────────────────────────────────────────────
{
  const startState = "WORLD: IN FRAME — Mara at the window, Tom by the door.\nCAMERA: low wide from frame-left, camera at knee height, Mara in the right third.";
  ok(extractScriptedCamera(startState) === "low wide from frame-left, camera at knee height, Mara in the right third.", "D: CAMERA block extracted from startState");
  ok(extractScriptedCamera("CAMERA: high angle over the table.\nWORLD: two cups.") === "high angle over the table.", "D: extraction stops at the next labelled block");
  ok(extractScriptedCamera("WORLD: only world.") === null && extractScriptedCamera(null) === null && extractScriptedCamera("") === null, "D: no CAMERA block → null");
  const d = reframeDirective(2, { sceneNumber: 3, startState });
  ok(d.includes("FRAME-1 CAMERA (from the script — mandatory): low wide from frame-left, camera at knee height"), "D: scripted camera embedded as mandatory FRAME-1 CAMERA");
  ok(d.includes(openingAngleForScene(3)), "D: deterministic angle still shown as the fallback");
  const out = applyReframeDirective(body, refs, { hasOverride: false, sceneNumber: 3, startState });
  ok(out.indexOf("CONTINUE FROM [Image2]:") === 0 && out.includes("low wide from frame-left"), "D: applyReframeDirective passes startState through");
}

// ── E. blocking / free-movement wording kept ────────────────────────────────────────────────────────
{
  const d = reframeDirective(1, { sceneNumber: 2 });
  ok(/NOT re-blocked to keep everyone in view/.test(d) && /may pass out of shot/.test(d), "E: camera not re-blocked, people may pass out of shot");
  ok(/from frame 1 the characters keep moving and acting freely for this scene/.test(d), "E: characters keep moving and acting freely from frame 1");
  ok(d.startsWith(reframePreviousFrameLine(1)), "E: base CONTINUE FROM line still opens the directive");
  ok(/STARTING frame/.test(d) && /nothing and nobody new/.test(d), "E: STARTING frame / nothing new wording preserved");
}

// ── F. idempotent, no-ops, backward compatible ──────────────────────────────────────────────────────
{
  const once = applyReframeDirective(body, refs, { hasOverride: false, sceneNumber: 2 });
  const twice = applyReframeDirective(once, refs, { hasOverride: false, sceneNumber: 2 });
  ok(twice === once && once.split("CONTINUE FROM").length === 2, "F: idempotent — exactly one CONTINUE FROM");
  ok(applyReframeDirective(body, refs, { hasOverride: true, sceneNumber: 2 }) === body, "F: manual override → unchanged");
  ok(applyReframeDirective(body, [{ kind: "character" }], { hasOverride: false, sceneNumber: 2 }) === body, "F: no previous_frame ref → unchanged");
  const legacy = applyReframeDirective(body, refs, { hasOverride: false });
  ok(legacy.indexOf("CONTINUE FROM [Image2]:") === 0 && legacy.includes(openingAngleForScene(1)), "F: legacy call shape (no sceneNumber/startState) still works");
  // Pipeline: seam → reframe → camera move, idempotent, seam line still at the end.
  const step1 = applyReframeDirective(applySeamDirectives(body, { hasOverride: false }), refs, { hasOverride: false, sceneNumber: 4 });
  const full = applyNewShotCameraMove(step1, 4, { hasOverride: false, continuity: "last_frame" as Continuity });
  const again = applyNewShotCameraMove(
    applyReframeDirective(applySeamDirectives(full, { hasOverride: false }), refs, { hasOverride: false, sceneNumber: 4 }),
    4, { hasOverride: false, continuity: "last_frame" as Continuity },
  );
  ok(again === full, "F: whole pipeline idempotent with the prepended directive");
  ok(full.indexOf("CONTINUE FROM") === 0 && full.includes(MOTION_TO_LAST_FRAME_LINE), "F: directive on top, seam motion line still present");
}

console.log(`\nStage 101: PASS — ${pass} assertions`);
