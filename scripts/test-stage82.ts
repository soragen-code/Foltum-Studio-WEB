/**
 * Stage 82 — continuity = persistent world + continuing action, NOT a frozen composition/pose/angle.
 * Pure checks (no ffmpeg / network / credits). Run: npx tsx scripts/test-stage82.ts
 *
 * Three user requirements:
 *  (1) the carried-over frame is only the START of the clip and must not lock characters in place;
 *  (2) when the camera changes angle, characters are NOT dragged back into frame — they may go off-shot;
 *  (3) the whole episode reads as one continuous event while the camera jumps between vantage points;
 *  and appearance/world continuity (faces, wardrobe, location, light, time of day) is preserved.
 */
import assert from "node:assert";
import {
  reframePreviousFrameLine, applyReframeDirective,
  newShotCameraMoveLine, applyNewShotCameraMove,
  CONTINUOUS_ACTION_LINE, applyContinuousAction,
  type Continuity,
} from "../lib/prompt-seam";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };

const base = `[SHOT TYPE] medium shot.\n\nDialogue (EN): "Hello."`;

// ── Req 1: the carried-over frame is only the START, characters not frozen ──────────────────────────
{
  const line = reframePreviousFrameLine(2);
  ok(line.includes("[Image2]"), "1: reframe line references the carried-over [Image2]");
  ok(/STARTING frame/i.test(line), "1: [ImageN] is used as the STARTING frame only");
  ok(/NOT a still to hold/i.test(line) && /not frozen/i.test(line), "1: explicitly NOT a still to hold / not frozen");
  ok(/keep moving and acting/i.test(line), "1: characters keep moving and acting after frame 1");
  // The old freezing wording must be gone.
  ok(!/identical spots in the same phase of movement/i.test(line), "1: old 'identical spots / same phase of movement' wording removed");
  ok(!line.includes("SAME instant"), "1: no 'SAME instant' freeze wording");
}

// ── Req 2: camera angle change does NOT drag characters back into frame ──────────────────────────────
{
  const reframe = reframePreviousFrameLine(1);
  ok(/leave the frame/i.test(reframe) && /pass out of shot/i.test(reframe), "2: reframe allows characters to leave / pass out of shot");
  ok(/NOT re-blocked/i.test(reframe), "2: reframe: camera not re-blocked to keep everyone in view");
  const cam = newShotCameraMoveLine(3);
  ok(/blocking is NOT adjusted to the camera/i.test(cam), "2: camera-move line: blocking not adjusted to the camera");
  ok(/pull(ed)? back into frame/i.test(cam) && /may .*pass out of shot/i.test(cam), "2: characters never pulled back into frame, may go off-shot");
}

// ── Req 3: whole episode is one continuous event; camera jumps vantage points ───────────────────────
{
  ok(/single, unbroken event that runs across the whole episode/i.test(CONTINUOUS_ACTION_LINE), "3: continuous-action line spans the whole episode as one unbroken event");
  ok(/camera jumping to another angle/i.test(CONTINUOUS_ACTION_LINE), "3: cut = camera jumping to another vantage inside the moment");
  ok(/time never resets/i.test(CONTINUOUS_ACTION_LINE) && /nobody is re-posed/i.test(CONTINUOUS_ACTION_LINE), "3: time never resets, nobody re-posed to match a frame");
}

// ── Appearance / world continuity preserved across all three directives ─────────────────────────────
{
  const reframe = reframePreviousFrameLine(1);
  ok(/same faces|same characters with the same faces/i.test(reframe) && /wardrobe/i.test(reframe) && /time of day/i.test(reframe), "world: reframe keeps faces, wardrobe, light, time of day");
  ok(/nothing and nobody new is added/i.test(reframe), "world: reframe adds nobody/nothing new");
  ok(/same characters/i.test(CONTINUOUS_ACTION_LINE) && /wardrobe/i.test(CONTINUOUS_ACTION_LINE) && /light/i.test(CONTINUOUS_ACTION_LINE), "world: continuous-action keeps same characters/light/wardrobe");
}

// ── applyContinuousAction behaviour (continuity gating, idempotent, override untouched) ──────────────
{
  const lf = applyContinuousAction(base, { hasOverride: false, continuity: "last_frame" as Continuity });
  ok(lf.includes(CONTINUOUS_ACTION_LINE) && lf.startsWith(base), "apply: appended for last_frame, base kept on top");
  const to = applyContinuousAction(base, { hasOverride: false, continuity: "text_only" as Continuity });
  ok(to.includes(CONTINUOUS_ACTION_LINE), "apply: appended for text_only continuity");
  ok(applyContinuousAction(base, { hasOverride: false, continuity: "none" as Continuity }) === base, "apply: continuity 'none' unchanged");
  ok(applyContinuousAction(base, { hasOverride: true, continuity: "last_frame" as Continuity }) === base, "apply: manual override unchanged");
  const twice = applyContinuousAction(lf, { hasOverride: false, continuity: "last_frame" as Continuity });
  ok(twice === lf, "apply: idempotent");
}

// ── Full pipeline order (seam → reframe → camera move → continuous action), idempotent ──────────────
{
  const refs = [{ kind: "previous_frame" }, { kind: "character" }];
  const step2 = applyReframeDirective(base, refs, { hasOverride: false });
  const step3 = applyNewShotCameraMove(step2, 5, { hasOverride: false, continuity: "last_frame" as Continuity });
  const full = applyContinuousAction(step3, { hasOverride: false, continuity: "last_frame" as Continuity });
  ok(full.includes("CONTINUE FROM") && full.includes("NEW-SHOT CAMERA MOVE:") && full.includes(CONTINUOUS_ACTION_LINE), "pipeline: all three continuity directives present");
  const again = applyContinuousAction(
    applyNewShotCameraMove(applyReframeDirective(full, refs, { hasOverride: false }), 5, { hasOverride: false, continuity: "last_frame" as Continuity }),
    { hasOverride: false, continuity: "last_frame" as Continuity },
  );
  ok(again === full, "pipeline: idempotent end-to-end");
}

console.log(`\nStage 82: ${pass} checks passed`);
