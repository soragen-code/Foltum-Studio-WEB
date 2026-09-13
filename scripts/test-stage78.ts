/**
 * Stage 78 checks (pure, no ffmpeg / network / credits):
 *  A. seamless hard-cut graph — tail trim, concat, no xfade;
 *  B. seam prompt directives — idempotent, override untouched;
 *  C. RE-FRAME previous-frame directive;
 *  D. continuity resolution (last_frame / text_only / none).
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage78.ts
 */
import assert from "node:assert";
import {
  buildSeamlessCutGraph, SEAM_TAIL_TRIM_SEC, SEAM_TAIL_TRIM_MIN_CLIP_SEC, SEAM_AUDIO_FADE_SEC,
  SEAMLESS_BLEND_SEC, SEAMLESS_BLEND_MAX_VIDEO_SEC, SEAMLESS_BLEND_MAX_AUDIO_SEC, type MediaInfo,
} from "../lib/ffmpeg";
import {
  applySeamDirectives, applyReframeDirective, reframePreviousFrameLine, resolveContinuity,
  MOTION_TO_LAST_FRAME_LINE, SOFT_END_STATE_PREFIX, TEXT_ONLY_CONTINUITY_MESSAGE,
} from "../lib/prompt-seam";
import { END_STATE_PREFIX, SPEECH_BEFORE_CUT_LINE } from "../lib/scene-prompt";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
const info = (d: number): MediaInfo => ({ duration: d, videoDuration: d, hasVideo: true, hasAudio: true, width: 720, height: 1280, fps: 24 } as MediaInfo);

// ── A. graph ──────────────────────────────────────────────────────────────────────────────────────
{
  ok(SEAM_TAIL_TRIM_SEC === 0.35 && SEAM_TAIL_TRIM_MIN_CLIP_SEC === 1.0 && SEAM_AUDIO_FADE_SEC === 0.03, "A: Stage 78 constants (0.35 trim / 1.0 min / 0.03 afade)");
  ok(SEAMLESS_BLEND_MAX_VIDEO_SEC === 0.12 && SEAMLESS_BLEND_MAX_AUDIO_SEC === 0.08 && SEAMLESS_BLEND_SEC <= 0.08, "A: legacy SEAMLESS_BLEND_* constants unchanged");
  const g = buildSeamlessCutGraph([info(5), info(5), info(5)]);
  ok(g.clipDurations.length === 3 && near(g.clipDurations[0], 4.65) && near(g.clipDurations[1], 4.65) && near(g.clipDurations[2], 5.0), "A: clipDurations (4.65, 4.65, 5.0)");
  ok(near(g.expectedDuration, 14.3), "A: expectedDuration 14.3");
  ok(g.seamOffsets.length === 2 && near(g.seamOffsets[0], 4.65) && near(g.seamOffsets[1], 9.3), "A: seamOffsets [4.65, 9.3]");
  ok(g.blend === 0 && near(g.audioFade, 0.03), "A: blend 0, audioFade 0.03");
  const trims = [...g.filter.matchAll(/\[(\d+):v:0\][^;]*,trim=0:([\d.]+)/g)];
  ok(trims.length === 2 && trims.map((m) => m[1]).join(",") === "0,1", "A: video trim= only on clips 0 and 1, not on the last");
  ok(!/\[2:v:0\][^;]*,trim=/.test(g.filter), "A: last clip has no trim");
  ok(g.filter.includes("concat=n=3:v=1:a=1"), "A: concat=n=3:v=1:a=1");
  ok(!g.filter.includes("xfade") && !g.filter.includes("acrossfade"), "A: no xfade / acrossfade");
  ok(g.filter.includes("afade=t=in") && g.filter.includes("afade=t=out"), "A: audio edge fades present");
  ok(!/\[0:a:0\][^;]*afade=t=in/.test(g.filter) && !/\[2:a:0\][^;]*afade=t=out/.test(g.filter), "A: no fade-in on first head, no fade-out on last tail");
  const short = buildSeamlessCutGraph([info(0.9), info(5)]);
  ok(near(short.clipDurations[0], 0.9) && near(short.expectedDuration, 5.9), "A: 0.9s clip is not trimmed (below 1.0s minimum)");
  assert.throws(() => buildSeamlessCutGraph([info(5)]), /at least 2 clips/);
  ok(true, "A: single clip is rejected (needs at least 2 clips)");
}

// ── B. seam directives ────────────────────────────────────────────────────────────────────────────
{
  const prompt = `[SHOT TYPE] medium shot.\n\n${END_STATE_PREFIX}she reaches for the cup.\n\n${SPEECH_BEFORE_CUT_LINE}\n\nDialogue (EN): "Hello."`;
  const once = applySeamDirectives(prompt, { hasOverride: false });
  ok(!once.includes(SPEECH_BEFORE_CUT_LINE), "B: SPEECH_BEFORE_CUT_LINE removed");
  ok(!once.includes(END_STATE_PREFIX) && once.includes(SOFT_END_STATE_PREFIX + "she reaches for the cup."), "B: END STATE prefix softened, body kept");
  ok(once.split(MOTION_TO_LAST_FRAME_LINE).length === 2 && once.trimEnd().endsWith(MOTION_TO_LAST_FRAME_LINE), "B: motion-to-last-frame line appended once");
  ok(once.includes('Dialogue (EN): "Hello."') && once.includes("[SHOT TYPE] medium shot."), "B: other blocks untouched");
  const twice = applySeamDirectives(once, { hasOverride: false });
  ok(twice === once, "B: idempotent (applied twice → identical)");
  ok(applySeamDirectives(prompt, { hasOverride: true }) === prompt, "B: manual override returned unchanged");
  ok(!once.includes("\n\n\n"), "B: no triple blank lines left behind");
}

// ── C. RE-FRAME previous frame ────────────────────────────────────────────────────────────────────
{
  const line = reframePreviousFrameLine(2);
  ok(line.includes("[Image2]") && line.includes("nothing and nobody new"), "C: reframePreviousFrameLine(2) mentions [Image2] and adds nothing new");
  const refs = [{ kind: "character" }, { kind: "previous_frame" }, { kind: "location" }];
  const p = "Base prompt.";
  const withRef = applyReframeDirective(p, refs, { hasOverride: false });
  ok(withRef.includes(reframePreviousFrameLine(2)) && withRef.startsWith(p), "C: previous_frame at index 1 → [Image2] directive appended");
  ok(applyReframeDirective(withRef, refs, { hasOverride: false }) === withRef, "C: idempotent");
  ok(applyReframeDirective(p, [{ kind: "character" }], { hasOverride: false }) === p, "C: no previous_frame ref → unchanged");
  ok(applyReframeDirective(p, refs, { hasOverride: true }) === p, "C: override → unchanged");
}

// ── D. continuity ─────────────────────────────────────────────────────────────────────────────────
{
  ok(resolveContinuity({ chainMode: "chain", sceneNumber: 2, previousFrameSceneId: "abc", refs: [] }) === "last_frame", "D: previous frame id → last_frame");
  ok(resolveContinuity({ chainMode: "chain", sceneNumber: 3, previousFrameSceneId: null, refs: [{ kind: "previous_frame" }] }) === "last_frame", "D: previous_frame ref → last_frame");
  ok(resolveContinuity({ chainMode: "chain", sceneNumber: 2, previousFrameSceneId: null, refs: [{ kind: "character" }] }) === "text_only", "D: chain mode, scene 2, no frame → text_only");
  ok(resolveContinuity({ chainMode: "chain", sceneNumber: 1, previousFrameSceneId: null, refs: [] }) === "none", "D: chain mode scene 1 → none");
  ok(resolveContinuity({ chainMode: "parallel", sceneNumber: 4, previousFrameSceneId: null, refs: [] }) === "none", "D: parallel mode → none");
  ok(TEXT_ONLY_CONTINUITY_MESSAGE === "Кадр предыдущей сцены не готов — генерация по описанию", "D: Russian text-only message");
}

console.log(`\nStage 78: ${pass} checks passed`);
