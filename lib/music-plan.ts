/**
 * Stage 79 — per-moment thematic soundtrack plan for an assembled episode.
 *
 * Instead of ONE mood for the whole episode (Stage 46B), the assembly picks a mood per SCENE with
 * gpt-4o, merges consecutive same-mood scenes into segments, caps the number of distinct moods, and
 * maps the segments onto the OUTPUT timeline (using the stitch graph's seam offsets) so ffmpeg can
 * lay the right cached track under each stretch of the episode (see lib/ffmpeg.ts buildMusicSegments…).
 *
 * Everything here is PURE except `buildMusicPlan`, which makes the SAME gpt-4o call `pickMood` uses.
 * On any LLM failure the whole episode falls back to a single `pickMood` mood.
 */
import { chatJSON } from "@/lib/ai";
import { MOODS, MOOD_LABELS, pickMood, DEFAULT_MOOD, type Mood } from "@/lib/music";

/** One scene handed to the planner (only the fields the LLM needs to feel the mood). */
export type SceneMoodInput = { index: number; action?: string; dialogue?: string; kind?: string };

/** Per-scene mood decision: a concrete Mood or "none" (silence over that scene). */
export type PerSceneMood = { index: number; mood: Mood | "none"; intensity: number };

/** A run of consecutive scenes sharing one mood. */
export type MoodSegment = { mood: Mood; startSceneIndex: number; endSceneIndex: number; intensity: number };

/** A segment mapped onto the output timeline (seconds). */
export type TimelineSegment = { mood: Mood; startSec: number; endSec: number; intensity: number };

/** Clamp a raw number to the 0..1 intensity range (default 0.6). */
function clampIntensity(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0.6;
  return Math.max(0, Math.min(1, n));
}

/**
 * Ask gpt-4o for a mood + intensity per scene (STRICT JSON). On any failure, fall back to a single
 * `pickMood` mood for EVERY scene at intensity 0.6 (so the episode still gets its Stage 46B soundtrack).
 * Returns one entry per input scene, in input order.
 */
export async function buildMusicPlan(
  scenes: SceneMoodInput[],
  meta: { title?: string | null; logline?: string | null; synopsis?: string | null }
): Promise<PerSceneMood[]> {
  if (scenes.length === 0) return [];
  const context = [meta.title, meta.logline, meta.synopsis].filter(Boolean).join("\n\n").slice(0, 2000);
  const sceneLines = scenes
    .map((s) => {
      const parts = [s.kind ? `kind=${s.kind}` : "", s.action ? `action: ${s.action}` : "", s.dialogue ? `dialogue: ${s.dialogue}` : ""]
        .filter(Boolean)
        .join(" | ");
      return `Scene ${s.index}: ${parts || "(no detail)"}`;
    })
    .join("\n")
    .slice(0, 6000);
  try {
    const raw = await chatJSON<{ scenes?: Array<{ index?: number; mood?: string; intensity?: number }> }>(
      `You choose the background-music mood for EACH scene of a short vertical drama episode, moment by moment. ` +
        `For every scene pick ONE mood from [${MOODS.join(", ")}] or "none" when that scene should play with NO music ` +
        `(a beat of silence). Also give an intensity 0..1 (how loud/present the music should feel). ` +
        `Answer ONLY with JSON {"scenes":[{"index":<scene index>,"mood":<mood|"none">,"intensity":<0..1>}, ...]} covering every scene.`,
      `${context ? context + "\n\n" : ""}Scenes:\n${sceneLines}`,
      { model: "gpt-4o", temperature: 0.2, maxTokens: 900 }
    );
    const byIndex = new Map<number, { mood?: string; intensity?: number }>();
    for (const row of raw?.scenes ?? []) {
      if (row && typeof row.index === "number") byIndex.set(row.index, row);
    }
    return scenes.map((s) => {
      const row = byIndex.get(s.index);
      const rawMood = String(row?.mood ?? "").trim().toLowerCase();
      const mood: Mood | "none" = rawMood === "none" ? "none" : (MOODS as readonly string[]).includes(rawMood) ? (rawMood as Mood) : DEFAULT_MOOD;
      return { index: s.index, mood, intensity: clampIntensity(row?.intensity) };
    });
  } catch (err) {
    console.warn("[music-plan] per-scene plan failed — single mood fallback:", (err as Error).message);
    let mood: Mood;
    try {
      mood = await pickMood(meta);
    } catch {
      mood = DEFAULT_MOOD;
    }
    return scenes.map((s) => ({ index: s.index, mood, intensity: 0.6 }));
  }
}

/**
 * PURE — group CONSECUTIVE scenes with the same mood into segments. Scenes whose mood is "none"
 * belong to NO segment (silence there) and break a run. Intensity of a segment is the average over
 * the scenes it covers.
 */
export function mergeMoodSegments(perScene: PerSceneMood[]): MoodSegment[] {
  const segments: MoodSegment[] = [];
  let cur: { mood: Mood; start: number; end: number; sum: number; count: number } | null = null;
  const flush = () => {
    if (cur) {
      segments.push({ mood: cur.mood, startSceneIndex: cur.start, endSceneIndex: cur.end, intensity: cur.sum / cur.count });
      cur = null;
    }
  };
  for (const s of perScene) {
    if (s.mood === "none") {
      flush();
      continue;
    }
    if (cur && cur.mood === s.mood) {
      cur.end = s.index;
      cur.sum += s.intensity;
      cur.count += 1;
    } else {
      flush();
      cur = { mood: s.mood, start: s.index, end: s.index, sum: s.intensity, count: 1 };
    }
  }
  flush();
  return segments;
}

/**
 * PURE — cap the number of DISTINCT moods to `max`. If there are more unique moods than `max`, keep
 * the `max` most frequent (by scene coverage) and recolor every other segment to the nearest KEPT
 * mood by frequency. Never drops a segment. Adjacent segments that end up the same mood are NOT
 * re-merged (callers that care can re-run mergeMoodSegments; the timeline math handles both).
 */
export function limitMoods(segments: MoodSegment[], max = 3): MoodSegment[] {
  if (segments.length === 0) return [];
  const coverage = new Map<Mood, number>();
  for (const seg of segments) {
    const scenes = seg.endSceneIndex - seg.startSceneIndex + 1;
    coverage.set(seg.mood, (coverage.get(seg.mood) ?? 0) + scenes);
  }
  const unique = [...coverage.keys()];
  if (unique.length <= max) return segments.map((s) => ({ ...s }));
  // Keep the `max` moods with the widest scene coverage (ties broken by mood name for determinism).
  const ranked = [...coverage.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  const kept = ranked.slice(0, max).map(([m]) => m);
  const keptSet = new Set(kept);
  // Nearest kept mood = the most frequent kept mood (deterministic single target).
  const fallback = kept[0];
  return segments.map((seg) => (keptSet.has(seg.mood) ? { ...seg } : { ...seg, mood: fallback }));
}

/**
 * PURE — map mood segments (in SCENE indices) onto the OUTPUT timeline. `seamOffsets` are the cut
 * positions in the output (scene boundaries): scene i spans
 * `[ (i==0?0:seamOffsets[i-1]) .. (seamOffsets[i] ?? totalDuration) ]`. A segment covering scenes
 * a..b spans from the start of scene a to the end of scene b. `scenes` are 0-based here (segment
 * indices are the scene positions used by mergeMoodSegments — the caller passes 0-based indices).
 */
export function toTimelineSegments(segments: MoodSegment[], seamOffsets: number[], totalDuration: number): TimelineSegment[] {
  const sceneStart = (i: number) => (i <= 0 ? 0 : seamOffsets[i - 1] ?? totalDuration);
  const sceneEnd = (i: number) => (seamOffsets[i] ?? totalDuration);
  return segments
    .map((seg) => {
      const startSec = Math.max(0, sceneStart(seg.startSceneIndex));
      const endSec = Math.min(totalDuration, sceneEnd(seg.endSceneIndex));
      return { mood: seg.mood, startSec: Number(startSec.toFixed(6)), endSec: Number(endSec.toFixed(6)), intensity: seg.intensity };
    })
    .filter((s) => s.endSec > s.startSec);
}

/** Count how many scenes have NO music ("none") in a per-scene plan. */
export function countScenesWithoutMusic(perScene: PerSceneMood[]): number {
  return perScene.filter((s) => s.mood === "none").length;
}

/**
 * PURE — a short Russian summary of the plan, e.g.
 * "напряжённая → загадочная (2 сегмента, 1 сцена без музыки)".
 */
export function summarizePlan(segments: MoodSegment[], scenesWithoutMusic = 0): string {
  if (segments.length === 0) return scenesWithoutMusic > 0 ? "без музыки" : "музыка недоступна";
  const chain = segments.map((s) => MOOD_LABELS[s.mood]).join(" → ");
  const segWord = pluralRu(segments.length, "сегмент", "сегмента", "сегментов");
  let tail = `${segments.length} ${segWord}`;
  if (scenesWithoutMusic > 0) {
    const scWord = pluralRu(scenesWithoutMusic, "сцена", "сцены", "сцен");
    tail += `, ${scenesWithoutMusic} ${scWord} без музыки`;
  }
  return `${chain} (${tail})`;
}

/** Russian pluralization helper (1 сегмент / 2 сегмента / 5 сегментов). */
function pluralRu(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
