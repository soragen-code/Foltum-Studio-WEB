/**
 * Stage 89 checks (pure, no network / ffmpeg / MusicGen / credits):
 *
 *  Req 1 — CONTINUOUS cross-scene background music:
 *   A. coalesceMoodSegments — merges ADJACENT same-mood segments; leaves different / non-contiguous alone.
 *   B. Full plan pipeline (merge → limitMoods → coalesce) — recolor-created adjacency is re-merged so a
 *      mood run becomes ONE segment (this is the fix: without coalesce it stayed multiple windows).
 *   C. toTimelineSegments — a coalesced multi-scene segment spans one continuous window across scenes.
 *   D. buildMusicSegmentsMixFilter — a segment covering several scenes fades ONLY at its edges (exactly
 *      one afade-in at st=0 and one afade-out) with a SINGLE atrim to the full length; ducking preserved.
 *   E. buildFinalRenderArgs — each music segment input is fed with `-stream_loop -1` (track loops to length).
 *
 *  Req 2 — QUALITY & SPEED (power tier) selector on the episode top panel:
 *   F. generateVideoSchema accepts an optional powerTier (LOW/MEDIUM/HIGH); routes read + persist it.
 *   G. episode-view.tsx renders the top-panel selector (all three tiers, English labels, threads the
 *      value into generate-video / generate-all) — and adds NO model selector.
 *
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage89.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  mergeMoodSegments, limitMoods, coalesceMoodSegments, toTimelineSegments,
  type PerSceneMood, type MoodSegment,
} from "../lib/music-plan";
import { buildMusicSegmentsMixFilter, buildFinalRenderArgs, type MusicSegmentInput } from "../lib/ffmpeg";
import { generateVideoSchema } from "../lib/validations";
import { POWER_TIERS } from "../lib/power-tier";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const ps = (index: number, mood: PerSceneMood["mood"], intensity: number): PerSceneMood => ({ index, mood, intensity });
const seg = (mood: MoodSegment["mood"], startSceneIndex: number, endSceneIndex: number, intensity: number): MoodSegment => ({ mood, startSceneIndex, endSceneIndex, intensity });
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

// ── A. coalesceMoodSegments ───────────────────────────────────────────────────────────────────
{
  const merged = coalesceMoodSegments([seg("tense", 0, 1, 0.6), seg("tense", 2, 3, 0.4), seg("dark", 4, 4, 0.8)]);
  ok(merged.length === 2, "A: two adjacent same-mood segments coalesce into one");
  ok(merged[0].mood === "tense" && merged[0].startSceneIndex === 0 && merged[0].endSceneIndex === 3, "A: coalesced tense segment spans scenes 0..3");
  ok(near(merged[0].intensity, 0.5), "A: coalesced intensity = scene-weighted average (0.6·2 + 0.4·2)/4 = 0.5");
  ok(merged[1].mood === "dark" && merged[1].startSceneIndex === 4, "A: the differing mood stays a separate segment");

  const diff = coalesceMoodSegments([seg("tense", 0, 0, 0.5), seg("dark", 1, 1, 0.5)]);
  ok(diff.length === 2, "A: different adjacent moods are NOT merged");

  const gap = coalesceMoodSegments([seg("tense", 0, 1, 0.5), seg("tense", 3, 4, 0.5)]);
  ok(gap.length === 2, "A: non-contiguous same-mood segments (a silent scene between) are NOT merged");

  ok(coalesceMoodSegments([]).length === 0, "A: empty input → empty output");
}

// ── B. full pipeline: recolor-created adjacency is re-merged ────────────────────────────────────
{
  // 5 distinct moods, one scene each → limitMoods(3) recolors the 2 least-frequent to the fallback mood,
  // producing ADJACENT same-mood segments that, before Stage 89, stayed separate windows (music dipped
  // at every scene). coalesce must merge them.
  const perScene: PerSceneMood[] = [ps(0, "tense", 0.6), ps(1, "romantic", 0.6), ps(2, "dark", 0.6), ps(3, "action", 0.6), ps(4, "mysterious", 0.6)];
  const limited = limitMoods(mergeMoodSegments(perScene), 3);
  ok(limited.length === 5, "B: limitMoods keeps every segment (never drops), so 5 single-scene segments remain");
  const hasAdjacentDup = limited.some((s, i) => i > 0 && limited[i - 1].mood === s.mood && s.startSceneIndex === limited[i - 1].endSceneIndex + 1);
  ok(hasAdjacentDup, "B: after recolor at least two ADJACENT segments share a mood (the pre-fix bug)");
  const coalesced = coalesceMoodSegments(limited);
  ok(coalesced.length < limited.length, "B: coalesce reduces the segment count by merging the adjacent duplicates");
  ok(coalesced.every((s, i) => i === 0 || coalesced[i - 1].mood !== s.mood || s.startSceneIndex !== coalesced[i - 1].endSceneIndex + 1), "B: no adjacent same-mood segments remain after coalesce");

  // A single-mood episode is ONE continuous segment end to end.
  const single = coalesceMoodSegments(limitMoods(mergeMoodSegments([ps(0, "tense", 0.5), ps(1, "tense", 0.5), ps(2, "tense", 0.5)]), 3));
  ok(single.length === 1 && single[0].startSceneIndex === 0 && single[0].endSceneIndex === 2, "B: an all-same-mood episode → one segment across all scenes");
}

// ── C. toTimelineSegments — continuous window across scenes ─────────────────────────────────────
{
  // seamOffsets: scene 0 ends at 10, scene 1 at 25, scene 2 at 42 (3 scenes, total 42).
  const seamOffsets = [10, 25];
  const timeline = toTimelineSegments([seg("tense", 0, 2, 0.6)], seamOffsets, 42);
  ok(timeline.length === 1, "C: one coalesced segment → one timeline window (not one per scene)");
  ok(near(timeline[0].startSec, 0) && near(timeline[0].endSec, 42), "C: the window spans the whole 3-scene run (0..42) continuously");
}

// ── D. buildMusicSegmentsMixFilter — fades only at segment edges, single atrim, ducking intact ──
{
  const oneSeg: MusicSegmentInput[] = [{ path: "/tmp/music_tense.mp3", startSec: 0, endSec: 42, intensity: 0.6 }];
  const f = buildMusicSegmentsMixFilter({ segments: oneSeg, hasVoice: true, totalDuration: 42 });
  ok(count(f, "atrim=0:") === 1, "D: a multi-scene segment uses a SINGLE atrim over the full length (no per-scene trims)");
  ok(count(f, "afade=t=in") === 1, "D: exactly ONE fade-in (at segment start), not one per scene");
  ok(count(f, "afade=t=out") === 1, "D: exactly ONE fade-out (at segment end), not one per scene");
  ok(f.includes("afade=t=in:st=0"), "D: the fade-in sits at the very start of the segment");
  ok(f.includes("sidechaincompress"), "D: dialogue sidechain-ducking is preserved when hasVoice");
  ok(f.includes("[vmain][ducked]amix"), "D: the voice is mixed back on top of the ducked music bed");

  const noVoice = buildMusicSegmentsMixFilter({ segments: oneSeg, hasVoice: false, totalDuration: 42 });
  ok(!noVoice.includes("sidechaincompress") && noVoice.includes("[musicMixed]anull[aout]"), "D: no voice → music bed is the output, no ducking");
}

// ── E. buildFinalRenderArgs — every music segment input is looped with -stream_loop -1 ──────────
{
  const segs: MusicSegmentInput[] = [
    { path: "/tmp/a.mp3", startSec: 0, endSec: 20, intensity: 0.6 },
    { path: "/tmp/b.mp3", startSec: 20, endSec: 42, intensity: 0.6 },
  ];
  const { args } = buildFinalRenderArgs({ input: "/tmp/joined.mp4", output: "/tmp/out.mp4", quality: "720p", fps: 30, musicSegments: segs, hasVoice: true, durationSec: 42 });
  const joined = args.join(" ");
  ok(count(joined, "-stream_loop -1") === 2, "E: both music segment inputs are fed with -stream_loop -1 (track loops to cover the segment)");
  ok(args.includes("-filter_complex"), "E: the segmented soundtrack goes through -filter_complex");
}

// ── F. schema + routes accept/persist the power tier ────────────────────────────────────────────
{
  const good = generateVideoSchema.safeParse({ projectId: "c".repeat(25), sceneId: "c" + "d".repeat(24), powerTier: "HIGH" });
  ok(good.success && good.data.powerTier === "HIGH", "F: generateVideoSchema accepts a valid powerTier");
  const omitted = generateVideoSchema.safeParse({ projectId: "c".repeat(25), sceneId: "c" + "d".repeat(24) });
  ok(omitted.success, "F: powerTier is optional (omitted still validates)");
  const bad = generateVideoSchema.safeParse({ projectId: "c".repeat(25), sceneId: "c" + "d".repeat(24), powerTier: "ULTRA" });
  ok(!bad.success, "F: an unknown tier is rejected");

  const vroute = readFileSync("app/api/ai/generate-video/route.ts", "utf8");
  ok(/isPowerTier\(parsed\.data\.powerTier\)/.test(vroute) && /data:\s*\{\s*powerTier:\s*requestedTier\s*\}/.test(vroute), "F: generate-video route honors + persists the requested tier");
  const aroute = readFileSync("app/api/ai/episodes/[id]/generate-all/route.ts", "utf8");
  ok(/isPowerTier\(body\?\.powerTier\)/.test(aroute) && /data:\s*\{\s*powerTier:\s*requestedTier\s*\}/.test(aroute), "F: generate-all route honors + persists the requested tier");
}

// ── G. episode-view top-panel selector (English, all tiers, threaded, no model selector) ────────
{
  const view = readFileSync("app/project/[id]/episode/[episodeId]/episode-view.tsx", "utf8");
  ok(view.includes('data-testid="power-tier-picker"'), "G: the top-panel Quality & speed selector is present");
  ok(view.includes("Quality &amp; speed:"), "G: the selector is labeled 'Quality & speed' (English)");
  ok(view.includes("data-testid={`power-tier-${t}`}") && view.includes("POWER_TIERS.map((t)"), "G: the selector renders a button for every POWER_TIER (LOW/MEDIUM/HIGH)");
  ok(POWER_TIERS.length === 3, "G: there are exactly three tiers to choose from");
  ok(/powerTier:\s*powerTierRef\.current/.test(view), "G: the chosen tier is sent with generation requests");
  ok(view.includes("const body: Record<string, unknown> = { projectId: project.id, sceneId, powerTier: powerTierRef.current }"), "G: single-scene generation (also per-frame Edit/Regenerate) sends the tier");
  ok(view.includes("generate-all`, { powerTier: powerTierRef.current }"), "G: «Generate all» sends the tier");
  // NO model selector added (Seedance 2.5 / Seedream 5.0 are fixed). The tier picker itself is a segmented
  // control built from <button> elements — not a dropdown. (The only <select> elements in this file are the
  // pre-existing assemble-dialog quality/fps pickers, which Stage 89 did not touch.)
  // Stage 100 removed the chain-mode picker; the power-tier picker block now ends at the chain-run status span.
  const pickerBlock = view.slice(view.indexOf('data-testid="power-tier-picker"'), view.indexOf('data-testid="chain-run-active"'));
  ok(pickerBlock.includes("<button") && !/\<select\b/.test(pickerBlock), "G: the Quality & speed picker is segmented buttons, not a <select> dropdown");
  ok((view.match(/<select\b/g) || []).length === 3, "G: no NEW model/quality dropdown was added (the 3 <select> are the pre-existing assemble-dialog quality/fps pickers)");
}

console.log(`\nStage 89: ${pass} checks passed`);
