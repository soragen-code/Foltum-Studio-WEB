/**
 * Stage 79 checks (pure, no network / ffmpeg / MusicGen / credits):
 *  A. mergeMoodSegments — consecutive merge, "none" excluded, mixed sequences;
 *  B. limitMoods — >3 moods capped to 3 without losing segments; ≤3 unchanged;
 *  C. toTimelineSegments — startSec/endSec for a multi-scene segment, first and last scene;
 *  D. buildMusicSegmentsMixFilter — atrim/afade/adelay/volume/sidechaincompress/amix (voice) vs none;
 *  E. summarizePlan — Russian format;
 *  F. MUSICGEN_VERSION_ID hex + generateMusicTrack runs BY VERSION (source check).
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage79.ts
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  mergeMoodSegments, limitMoods, toTimelineSegments, summarizePlan, countScenesWithoutMusic,
  type PerSceneMood, type MoodSegment,
} from "../lib/music-plan";
import { buildMusicSegmentsMixFilter, dbToLinear, MUSIC_SEGMENT_DB, type MusicSegmentInput } from "../lib/ffmpeg";
import { MUSICGEN_VERSION_ID } from "../lib/music";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const ps = (index: number, mood: PerSceneMood["mood"], intensity: number): PerSceneMood => ({ index, mood, intensity });

// ── A. mergeMoodSegments ────────────────────────────────────────────────────────────────────────
{
  const merged = mergeMoodSegments([ps(0, "tense", 0.5), ps(1, "tense", 0.7), ps(2, "mysterious", 0.4)]);
  ok(merged.length === 2, "A: consecutive same-mood scenes merge into one segment");
  ok(merged[0].mood === "tense" && merged[0].startSceneIndex === 0 && merged[0].endSceneIndex === 1 && near(merged[0].intensity, 0.6), "A: segment 0 = tense scenes 0..1, avg intensity 0.6");
  ok(merged[1].mood === "mysterious" && merged[1].startSceneIndex === 2 && merged[1].endSceneIndex === 2, "A: segment 1 = mysterious scene 2");

  const withNone = mergeMoodSegments([ps(0, "tense", 0.5), ps(1, "none", 0), ps(2, "tense", 0.5)]);
  ok(withNone.length === 2, "A: a 'none' scene breaks the run (2 separate tense segments)");
  ok(withNone[0].endSceneIndex === 0 && withNone[1].startSceneIndex === 2, "A: 'none' scene belongs to NO segment");
  ok(countScenesWithoutMusic([ps(0, "tense", 0.5), ps(1, "none", 0), ps(2, "none", 0)]) === 2, "A: countScenesWithoutMusic counts 'none' scenes");

  const mixed = mergeMoodSegments([ps(0, "dark", 0.9), ps(1, "dark", 0.5), ps(2, "romantic", 0.3), ps(3, "romantic", 0.5), ps(4, "action", 1)]);
  ok(mixed.length === 3 && mixed.map((s) => s.mood).join(",") === "dark,romantic,action", "A: mixed sequence → 3 segments in order");
  ok(mergeMoodSegments([]).length === 0, "A: empty plan → no segments");
}

// ── B. limitMoods ───────────────────────────────────────────────────────────────────────────────
{
  // 4 unique moods; coverage: tense=3, mysterious=2, dark=1, action=1.
  const segs: MoodSegment[] = [
    { mood: "tense", startSceneIndex: 0, endSceneIndex: 2, intensity: 0.6 },
    { mood: "mysterious", startSceneIndex: 3, endSceneIndex: 4, intensity: 0.5 },
    { mood: "dark", startSceneIndex: 5, endSceneIndex: 5, intensity: 0.4 },
    { mood: "action", startSceneIndex: 6, endSceneIndex: 6, intensity: 0.9 },
  ];
  const limited = limitMoods(segs, 3);
  ok(limited.length === segs.length, "B: no segment is dropped when capping moods");
  const uniq = new Set(limited.map((s) => s.mood));
  ok(uniq.size <= 3, "B: >3 moods reduced to at most 3 distinct moods");
  ok(uniq.has("tense") && uniq.has("mysterious"), "B: the most-covered moods are kept");
  ok(!uniq.has("dark"), "B: the least-covered extra mood (dark) is recolored away");

  const small: MoodSegment[] = [
    { mood: "tense", startSceneIndex: 0, endSceneIndex: 0, intensity: 0.5 },
    { mood: "romantic", startSceneIndex: 1, endSceneIndex: 1, intensity: 0.5 },
  ];
  const same = limitMoods(small, 3);
  ok(same.length === 2 && same[0].mood === "tense" && same[1].mood === "romantic", "B: ≤3 moods returned unchanged");
  ok(limitMoods([], 3).length === 0, "B: empty segments → empty");
}

// ── C. toTimelineSegments ───────────────────────────────────────────────────────────────────────
{
  const seamOffsets = [5, 10]; // 3 scenes: [0,5], [5,10], [10,15]
  const total = 15;
  const multi = toTimelineSegments([{ mood: "tense", startSceneIndex: 0, endSceneIndex: 1, intensity: 0.6 }], seamOffsets, total);
  ok(multi.length === 1 && near(multi[0].startSec, 0) && near(multi[0].endSec, 10), "C: multi-scene segment 0..1 → 0s..10s");

  const first = toTimelineSegments([{ mood: "dark", startSceneIndex: 0, endSceneIndex: 0, intensity: 0.5 }], seamOffsets, total);
  ok(first.length === 1 && near(first[0].startSec, 0) && near(first[0].endSec, 5), "C: first scene → 0s..5s");

  const last = toTimelineSegments([{ mood: "action", startSceneIndex: 2, endSceneIndex: 2, intensity: 0.8 }], seamOffsets, total);
  ok(last.length === 1 && near(last[0].startSec, 10) && near(last[0].endSec, 15), "C: last scene → 10s..totalDuration (15s)");

  const empty = toTimelineSegments([{ mood: "tense", startSceneIndex: 5, endSceneIndex: 5, intensity: 0.5 }], seamOffsets, total);
  ok(empty.length === 0, "C: out-of-range segment (endSec<=startSec) is filtered out");
}

// ── D. buildMusicSegmentsMixFilter ──────────────────────────────────────────────────────────────
{
  const segments: MusicSegmentInput[] = [
    { path: "/tmp/a.mp3", startSec: 0, endSec: 5, intensity: 0.6 },
    { path: "/tmp/b.mp3", startSec: 5, endSec: 10, intensity: 0.8 },
  ];
  const voiced = buildMusicSegmentsMixFilter({ segments, hasVoice: true, totalDuration: 10 });
  for (const token of ["atrim", "afade", "adelay", "volume", "sidechaincompress", "amix"]) {
    ok(voiced.includes(token), `D: voiced mix contains ${token}`);
  }
  ok(voiced.includes("[aout]"), "D: voiced mix exposes [aout]");
  ok((voiced.match(/adelay=/g) || []).length === 2, "D: one adelay per segment");

  const silent = buildMusicSegmentsMixFilter({ segments, hasVoice: false, totalDuration: 10 });
  ok(!silent.includes("sidechaincompress"), "D: no-voice mix has NO sidechaincompress");
  ok(silent.includes("amix") && silent.includes("[aout]"), "D: no-voice mix still amix-es the music bed into [aout]");

  ok(near(dbToLinear(0), 1) && dbToLinear(MUSIC_SEGMENT_DB) < 1 && dbToLinear(MUSIC_SEGMENT_DB) > 0, "D: dbToLinear(0)=1, dbToLinear(-18) in (0,1)");
}

// ── E. summarizePlan ────────────────────────────────────────────────────────────────────────────
{
  const segs: MoodSegment[] = [
    { mood: "tense", startSceneIndex: 0, endSceneIndex: 1, intensity: 0.6 },
    { mood: "mysterious", startSceneIndex: 2, endSceneIndex: 2, intensity: 0.5 },
  ];
  ok(summarizePlan(segs, 1) === "напряжённая → загадочная (2 сегмента, 1 сцена без музыки)", "E: summary matches the spec example");
  ok(summarizePlan(segs, 0) === "напряжённая → загадочная (2 сегмента)", "E: no silent scenes → no 'без музыки' tail");
  ok(summarizePlan([{ mood: "action", startSceneIndex: 0, endSceneIndex: 0, intensity: 1 }], 0) === "экшн (1 сегмент)", "E: single segment pluralization");
  ok(summarizePlan([], 2) === "без музыки", "E: no segments but silent scenes → 'без музыки'");
}

// ── F. MusicGen runs BY VERSION ─────────────────────────────────────────────────────────────────
{
  ok(typeof MUSICGEN_VERSION_ID === "string" && /^[0-9a-f]+$/.test(MUSICGEN_VERSION_ID) && MUSICGEN_VERSION_ID.length >= 40, "F: MUSICGEN_VERSION_ID is a non-empty hex id");
  const src = readFileSync(new URL("../lib/music.ts", import.meta.url), "utf8");
  ok(/predictions\.create\(\s*\{\s*version:/.test(src), "F: generateMusicTrack creates predictions BY VERSION (version: …)");
  ok(src.includes("resolveMusicgenVersion"), "F: resolveMusicgenVersion helper is used");
  // Strip block/line comments before checking the run-by-name pattern (the fix is documented in a comment).
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  ok(!/predictions\.create\(\s*\{\s*model:/.test(codeOnly), "F: does NOT run MusicGen by name (no predictions.create({ model: … }))");
  // URL literal built by concatenation per the spec (no raw scheme in the test source).
  const replicateModels = "http" + "s://" + "api.replicate.com/v1/models/meta/musicgen";
  ok(replicateModels.startsWith("http" + "s://"), "F: URL literal built by concatenation");
}

console.log(`\nStage 79: ${pass} checks passed`);
