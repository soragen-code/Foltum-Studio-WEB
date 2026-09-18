/**
 * Stage 167 (task Stage 5+6 replacement) — SHOT ASSEMBLY PIPELINE + CONTINUITY CRITIC (pure helpers).
 *
 * The atomic unit is the SHOT. Once each shot clip is generated (strictly sequentially — shot N+1 only
 * after shot N, earliest ungenerated first, NEVER in parallel), this module describes how the clips are
 * stitched into the finished episode:
 *
 *   - buildConcatPlan(shots)        → the ordered clip list + per-shot ffmpeg postFx filter.
 *   - postFxToFfmpegFilter(postFx)  → slowmo / punchZoom / none → an ffmpeg -vf filter string.
 *   - buildSubtitleSpec(shots,opts) → CENTERED subtitle cues from spoken lines (dialogueLanguage="en").
 *   - musicForBeat(beatType)        → a QUIET music mood for the closing beat type.
 *   - textualContinuityCheck(a,b)   → compares shot A's matchCutOut vs shot B's matchCutIn (pure text).
 *   - compareShotKeyframesVLM(...)  → the VLM continuity path; STRUCTURED so it is NEVER called in tests
 *                                     (it needs real https frame URLs + an injected vision fn).
 *
 * This module is PURE and leaf: it imports only TYPES from the prompt/season modules plus the Mood type
 * from lib/music (a leaf). It performs NO network / ffmpeg / DB work itself — it returns plans/specs the
 * worker (lib/workers/video-job.ts) executes. Keeping it pure makes every path unit-testable offline.
 */
import type { PlannedShot, PostFx } from "@/lib/prompts/shot-plan";
import type { Mood } from "@/lib/music";

/* ───────────────────────── post-fx → ffmpeg filter ───────────────────────── */

/**
 * Map a shot's postFx to an ffmpeg video-filter string (empty string = no filter).
 *   - slowmo    → half-speed video (setpts) so a beat lands harder.
 *   - punchZoom → a slow 1.0→1.12 push-in (zoompan) for emphasis.
 *   - none      → "" (leave the clip untouched).
 * Pure — returns a deterministic filter string; the worker appends it to the per-clip -vf chain.
 */
export function postFxToFfmpegFilter(postFx: PostFx | string | null | undefined): string {
  switch (postFx) {
    case "slowmo":
      return "setpts=2.0*PTS";
    case "punchZoom":
      // zoompan over the whole clip; d is filled per-clip by the worker from the clip frame count.
      return "zoompan=z='min(zoom+0.0009,1.12)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'";
    case "none":
    default:
      return "";
  }
}

/** slowmo stretches the clip; the audio must be time-stretched to match (atempo=0.5). "" otherwise. */
export function postFxToAudioFilter(postFx: PostFx | string | null | undefined): string {
  return postFx === "slowmo" ? "atempo=0.5" : "";
}

/* ───────────────────────── concat plan ───────────────────────── */

export interface ConcatClip {
  /** 0-based order in the finished episode (shots are already an ordered chain). */
  index: number;
  /** The generated clip URL for this shot (null until the shot is generated). */
  videoUrl: string | null;
  duration: number;
  postFx: PostFx | string;
  /** The ffmpeg video filter for this clip's postFx ("" when none). */
  videoFilter: string;
  /** The ffmpeg audio filter for this clip's postFx ("" when none). */
  audioFilter: string;
}

export interface ConcatPlan {
  clips: ConcatClip[];
  /** True when EVERY shot has a generated videoUrl (the episode is ready to concat). */
  ready: boolean;
  /** Sum of the clip durations (pre-postFx). */
  totalDuration: number;
}

/**
 * Build the ordered concat plan from a shot list. Shots are sorted by their `index` (the sequential
 * chain order); each clip carries its postFx-derived ffmpeg filters. Pure — no I/O. When any shot has
 * no videoUrl yet, `ready` is false so the worker knows the episode is not assemblable.
 */
export function buildConcatPlan(
  shots: Array<Pick<PlannedShot, "index" | "duration" | "postFx"> & { videoUrl?: string | null }>
): ConcatPlan {
  const ordered = [...shots].sort((a, b) => a.index - b.index);
  const clips: ConcatClip[] = ordered.map((s) => ({
    index: s.index,
    videoUrl: s.videoUrl ?? null,
    duration: s.duration,
    postFx: s.postFx,
    videoFilter: postFxToFfmpegFilter(s.postFx),
    audioFilter: postFxToAudioFilter(s.postFx),
  }));
  return {
    clips,
    ready: clips.length > 0 && clips.every((c) => !!c.videoUrl),
    totalDuration: clips.reduce((a, c) => a + (c.duration || 0), 0),
  };
}

/* ───────────────────────── subtitles (centered) ───────────────────────── */

export interface SubtitleCue {
  index: number;
  /** Cue start time in seconds (cumulative over the ordered clips). */
  start: number;
  /** Cue end time in seconds. */
  end: number;
  text: string;
}

export interface SubtitleSpec {
  cues: SubtitleCue[];
  language: string;
  /** Subtitles are burned CENTERED (bottom-center, horizontally centered). */
  alignment: "center";
}

const oneLine = (t?: string | null) => (t ?? "").replace(/\s+/g, " ").trim();

/**
 * Build a CENTERED subtitle spec from the shots' spoken lines. Cue timings accumulate over the ordered
 * clip durations, so cue N starts where clip N starts. Silent shots produce no cue. `dialogueLanguage`
 * defaults to "en" (thread it through from the episode; Stage 3 dialogueLanguage read defensively).
 * Pure — returns the cue list; the worker renders it to burned subtitles.
 */
export function buildSubtitleSpec(
  shots: Array<Pick<PlannedShot, "index" | "duration" | "line">>,
  opts: { dialogueLanguage?: string | null } = {}
): SubtitleSpec {
  const language = oneLine(opts.dialogueLanguage) || "en";
  const ordered = [...shots].sort((a, b) => a.index - b.index);
  const cues: SubtitleCue[] = [];
  let cursor = 0;
  for (const s of ordered) {
    const text = oneLine(s.line);
    const dur = s.duration || 0;
    if (text) cues.push({ index: s.index, start: +cursor.toFixed(3), end: +(cursor + dur).toFixed(3), text });
    cursor += dur;
  }
  return { cues, language, alignment: "center" };
}

/* ───────────────────────── quiet music per beat ───────────────────────── */

/**
 * Pick a QUIET music mood for a closing beat type. The music stays low under the dialogue; the mapping
 * biases toward tense / dark / mysterious moods that sit under a cliffhanger without overpowering it.
 * Unknown beat types fall back to the quiet default. Pure.
 */
export function musicForBeat(beatType?: string | null): Mood {
  switch (oneLine(beatType).toLowerCase()) {
    case "expectationflip":
    case "strike":
    case "arrival":
    case "physicalheavy":
      return "tense";
    case "statusreveal":
    case "thirdforce":
      return "dark";
    case "symbolic":
      return "mysterious";
    case "verbal":
    case "physicallight":
      return "melancholic";
    default:
      return "mysterious";
  }
}

/* ───────────────────────── continuity critic ───────────────────────── */

export interface ContinuityResult {
  consistent: boolean;
  reason: string;
}

/** Split a match-cut phrase into comparable tokens (lowercased words, stop-words dropped). */
const STOP = new Set(["the", "a", "an", "and", "of", "to", "on", "in", "at", "with", "her", "his", "their", "into", "from", "as", "is", "are"]);
function tokenize(t?: string | null): Set<string> {
  return new Set(
    oneLine(t)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

/**
 * TEXTUAL continuity check between two adjacent shots: does shot A's matchCutOut share the pose / gaze /
 * prop it hands to shot B's matchCutIn? Returns consistent=true when the two phrases share at least one
 * meaningful token (or when a phrase is empty — nothing to contradict). Pure, offline: this is the check
 * the tests exercise. When it fails, the worker escalates to the VLM path below.
 */
export function textualContinuityCheck(
  prevShot: Pick<PlannedShot, "index" | "matchCutOut">,
  nextShot: Pick<PlannedShot, "index" | "matchCutIn">
): ContinuityResult {
  const out = oneLine(prevShot.matchCutOut);
  const inn = oneLine(nextShot.matchCutIn);
  if (!out || !inn) {
    return { consistent: true, reason: `Shots ${prevShot.index}→${nextShot.index}: no explicit match-cut to compare (treated as continuous).` };
  }
  const a = tokenize(out);
  const b = tokenize(inn);
  const shared = [...a].filter((w) => b.has(w));
  if (shared.length > 0) {
    return { consistent: true, reason: `Shots ${prevShot.index}→${nextShot.index}: match-cut carries "${shared.join(", ")}".` };
  }
  return {
    consistent: false,
    reason: `Shots ${prevShot.index}→${nextShot.index}: matchCutOut ("${out}") and matchCutIn ("${inn}") share no pose/gaze/prop — the cut may jump.`,
  };
}

/**
 * Run the textual continuity check across a whole ordered shot chain, returning one result per adjacent
 * pair. Pure. The worker only invokes the VLM path for the pairs this flags inconsistent.
 */
export function textualContinuityChain(
  shots: Array<Pick<PlannedShot, "index" | "matchCutIn" | "matchCutOut">>
): ContinuityResult[] {
  const ordered = [...shots].sort((a, b) => a.index - b.index);
  const out: ContinuityResult[] = [];
  for (let i = 1; i < ordered.length; i++) out.push(textualContinuityCheck(ordered[i - 1], ordered[i]));
  return out;
}

/* ───────────────────────── VLM continuity path (never called in tests) ───────────────────────── */

/** An injected vision function — compares two image URLs and returns a verdict. Supplied by the worker. */
export type ShotVisionFn = (args: {
  prevFrameUrl: string;
  nextFrameUrl: string;
  question: string;
}) => Promise<{ consistent: boolean; reason: string }>;

/**
 * VLM continuity path: compares the LAST keyframe of shot A against the FIRST keyframe of shot B via an
 * injected vision function (gpt-4o-mini in production). It is STRUCTURED so it is NEVER exercised in the
 * offline tests: it requires two real https frame URLs AND an injected `visionFn`. When either is
 * missing it short-circuits to a skipped (consistent) verdict WITHOUT calling anything. Only the worker,
 * holding real generated frame URLs, ever reaches the vision call.
 */
export async function compareShotKeyframesVLM(
  prevFrameUrl: string | null | undefined,
  nextFrameUrl: string | null | undefined,
  visionFn?: ShotVisionFn | null
): Promise<ContinuityResult> {
  const isRealUrl = (u?: string | null): u is string => typeof u === "string" && /^https?:\/\//i.test(u);
  if (!visionFn || !isRealUrl(prevFrameUrl) || !isRealUrl(nextFrameUrl)) {
    return { consistent: true, reason: "VLM continuity check skipped (no vision function or no real frame URLs)." };
  }
  const verdict = await visionFn({
    prevFrameUrl,
    nextFrameUrl,
    question:
      "These are the last frame of shot A and the first frame of shot B in a continuous scene. Do the character pose, gaze, wardrobe, props and lighting match so the cut is seamless? Answer whether they are consistent and why.",
  });
  return { consistent: !!verdict.consistent, reason: oneLine(verdict.reason) || "VLM verdict." };
}
