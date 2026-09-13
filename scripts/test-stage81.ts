/**
 * Stage 81 — NEW-SHOT CAMERA MOVE (pure, no ffmpeg / network / credits).
 *
 * A continuing scene used to inherit the static end framing of the previous scene (the camera
 * "froze" on the seam). applyNewShotCameraMove appends a directive giving every carried-over scene
 * its own camera motion from frame 1. Scene 1 / parallel ("none") is left untouched, a manual
 * override is untouched, and the transform is idempotent. Run: npx tsx scripts/test-stage81.ts
 */
import assert from "node:assert";
import {
  applyNewShotCameraMove, newShotCameraMoveLine, cameraMoveForScene, NEW_SHOT_CAMERA_MOVES,
  applySeamDirectives, applyReframeDirective, type Continuity,
} from "../lib/prompt-seam";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };

const base = `[SHOT TYPE] medium shot.\n\nDialogue (EN): "Hello."`;

// 1. A last_frame scene gets the camera-move directive appended once.
{
  const out = applyNewShotCameraMove(base, 2, { hasOverride: false, continuity: "last_frame" as Continuity });
  ok(out.includes("NEW-SHOT CAMERA MOVE:"), "1: directive appended for last_frame continuity");
  ok(out.includes(cameraMoveForScene(2)), "1: contains the scene's chosen camera move");
  ok(out.startsWith(base), "1: original prompt kept intact at the top");
}

// 2. text_only continuity also gets the directive (chained scene, frame not ready).
{
  const out = applyNewShotCameraMove(base, 3, { hasOverride: false, continuity: "text_only" as Continuity });
  ok(out.includes("NEW-SHOT CAMERA MOVE:"), "2: directive appended for text_only continuity");
}

// 3. Scene 1 / parallel ("none") is left untouched.
{
  const out = applyNewShotCameraMove(base, 1, { hasOverride: false, continuity: "none" as Continuity });
  ok(out === base, "3: continuity 'none' returns the prompt unchanged");
}

// 4. Manual override is never modified.
{
  const out = applyNewShotCameraMove(base, 2, { hasOverride: true, continuity: "last_frame" as Continuity });
  ok(out === base, "4: manual override returned unchanged");
}

// 5. Idempotent — applying twice yields identical text.
{
  const once = applyNewShotCameraMove(base, 2, { hasOverride: false, continuity: "last_frame" as Continuity });
  const twice = applyNewShotCameraMove(once, 2, { hasOverride: false, continuity: "last_frame" as Continuity });
  ok(once === twice, "5: idempotent (applied twice → identical)");
}

// 6. The move rotates by scene number (variety) and wraps around the list.
{
  ok(cameraMoveForScene(1) === NEW_SHOT_CAMERA_MOVES[0], "6: scene 1 → first move");
  ok(cameraMoveForScene(2) !== cameraMoveForScene(1), "6: scene 2 differs from scene 1");
  ok(cameraMoveForScene(1 + NEW_SHOT_CAMERA_MOVES.length) === cameraMoveForScene(1), "6: move cycles by list length");
  // guard: bad scene number falls back to the first move (no crash).
  ok(cameraMoveForScene(0 as number) === NEW_SHOT_CAMERA_MOVES[0], "6: non-positive scene number → first move");
}

// 7. The directive tells the camera to be moving from frame 1 and NOT to inherit the static frame.
{
  const line = newShotCameraMoveLine(2);
  ok(/first frame/i.test(line) && /does NOT hold/i.test(line) && /keeps moving/i.test(line), "7: line asserts motion-from-frame-1 and no static inheritance");
}

// 8. Full seam pipeline order (seam → reframe → camera move) composes and stays idempotent.
{
  const refs = [{ kind: "previous_frame" }, { kind: "character" }];
  const step1 = applyReframeDirective(applySeamDirectives(base, { hasOverride: false }), refs, { hasOverride: false });
  const full = applyNewShotCameraMove(step1, 4, { hasOverride: false, continuity: "last_frame" as Continuity });
  ok(full.includes("RE-FRAME") && full.includes("NEW-SHOT CAMERA MOVE:"), "8: reframe + camera move both present");
  const again = applyNewShotCameraMove(
    applyReframeDirective(applySeamDirectives(full, { hasOverride: false }), refs, { hasOverride: false }),
    4, { hasOverride: false, continuity: "last_frame" as Continuity },
  );
  ok(again === full, "8: whole pipeline idempotent");
}

console.log(`\nStage 81: ${pass} checks passed`);
