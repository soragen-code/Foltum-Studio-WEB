/**
 * Stage 2 — season script generator: schemas, prompts, validation, rendering, cost plan.
 * Pure (no DB) so it can be unit-tested; the worker in lib/workers/season-script-job.ts persists results.
 */
import { z } from "zod";
import { LANGUAGE_NAMES, type IdeaLanguage, type CharacterCard } from "@/lib/idea";
import { VISUAL_STYLE } from "@/lib/visual-style";
import { POWER_TIER_CONFIG, SEEDANCE_MAX_DURATION, sceneTierConfig, type PowerTier } from "@/lib/power-tier";
import { LOCATION_DETAIL_LEVELS } from "@/lib/location-scale";
import { DIRECTING_RULES } from "@/lib/directing-rules";

/** Stage 4: nobody is asked for a running time — the story decides. These are only sanity bounds for the LLM output. */
export const SEASON_MIN_EPISODES = 1;
export const SEASON_MAX_EPISODES = 100;
/** Stage 46C — season structure is generated in batches of this many episodes per LLM call. */
export const STRUCTURE_BATCH_SIZE = 10;
/** Stage 46C — short synopsis loglines are generated in batches of this many per LLM call. */
export const SHORT_SYNOPSIS_BATCH_SIZE = 25;
/** Stage 46C — split 1..total into consecutive inclusive ranges of at most `size` episodes. */
export function episodeBatches(total: number, size: number): { from: number; to: number }[] {
  const n = Math.max(0, Math.floor(total));
  const step = Math.max(1, Math.floor(size));
  const out: { from: number; to: number }[] = [];
  for (let from = 1; from <= n; from += step) out.push({ from, to: Math.min(n, from + step - 1) });
  return out;
}
export const SEASON_DEFAULT_EPISODES = 8;
/**
 * Stage 114 — an episode is EXACTLY 9 short 10 s shots = 90 s (1:30). (Stage 103 had 2 × 30 s;
 * existing two-/four-scene episodes in the DB are left untouched until their story is regenerated.)
 */
export const EPISODE_MIN_SCENES = 9;
export const EPISODE_MAX_SCENES = 9;
/** Legacy "brisk" reference (kept for compatibility); clip planning now uses NATURAL_WORDS_PER_SEC. */
export const SPEECH_WORDS_PER_SEC = 2.7;
/**
 * Stage 27a — plan clips at a NATURAL conversational pace (~2.1 words/s, clearly slower than the old
 * brisk 2.7) so lines are never crammed / sped up: a clip is made long enough for relaxed real delivery.
 */
export const NATURAL_WORDS_PER_SEC = 2.1;
export const MIN_WORDS_PER_SEC = 2;
/** Stage 115 — a clip's length is VARIABLE; this is the FLOOR (even a very short beat still lasts at least 5 s). */
export const SCENE_MIN_SECONDS = 5;
/** Seedance 2.5 real maximum (30 s) — the ceiling the model allows; used only as a speech-split cap, not the clip length. */
export const SCENE_MAX_SECONDS = SEEDANCE_MAX_DURATION;
/** Stage 115 — CEILING for one whole episode: the sum of all scene durations must not EXCEED 1:30 (90 s); it may be less. */
export const EPISODE_MAX_TOTAL_SECONDS = 90;
/** Stage 115 — a clip is NO LONGER a fixed length. Kept only to derive the scene count (see EPISODE_SCENE_COUNT). */
export const SCENE_FIXED_SECONDS = 10;
/** Stage 115 — hard CEILING of a single clip: no scene may run longer than 10 s (was fixed at exactly 10). */
export const SCENE_CLIP_MAX_SECONDS = 10;
/** Stage 115 — fallback clip length when the script model omits durationSec (a sensible mid-range value). */
export const SCENE_DEFAULT_SECONDS = 8;
/** Stage 114 — fixed number of scenes per episode: ceil(90 / 10) = 9. */
export const EPISODE_SCENE_COUNT = Math.ceil(EPISODE_MAX_TOTAL_SECONDS / SCENE_FIXED_SECONDS);
/** Stage 115 — clamp a raw durationSec into the valid clip range [SCENE_MIN_SECONDS, SCENE_CLIP_MAX_SECONDS]; missing/invalid → default. */
export function clampSceneDuration(v: number | null | undefined): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : SCENE_DEFAULT_SECONDS;
  return Math.min(SCENE_CLIP_MAX_SECONDS, Math.max(SCENE_MIN_SECONDS, n));
}
/**
 * Stage 93 — duration for each of `n` scenes: every scene is SCENE_FIXED_SECONDS long,
 * except the final scene which is trimmed so the episode total never exceeds
 * EPISODE_MAX_TOTAL_SECONDS. For n = 9 (Stage 114) this yields [10 × 9] — no trim needed.
 */
export function sceneDurationsForCount(n: number): number[] {
  if (n <= 0) return [];
  const out = Array.from({ length: n }, () => SCENE_FIXED_SECONDS);
  if (SCENE_FIXED_SECONDS * n > EPISODE_MAX_TOTAL_SECONDS) {
    out[n - 1] = EPISODE_MAX_TOTAL_SECONDS - SCENE_FIXED_SECONDS * (n - 1);
  }
  return out;
}

/** Stage 114 — "m:ss" label of the whole-episode budget (90 s → "1:30"). */
export function episodeTotalLabel(totalSeconds: number = EPISODE_MAX_TOTAL_SECONDS): string {
  const t = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}
export const EPISODE_TOTAL_LABEL = episodeTotalLabel();
/** Stage 115 — clip lengths are variable now, so there is no "last shot trimmed" clause. */
export const LAST_SHOT_NOTE = "";
/**
 * Stage 115 — clamp each scene's own (model-supplied) durationSec into the valid clip range
 * [SCENE_MIN_SECONDS, SCENE_CLIP_MAX_SECONDS]; a missing value falls back to SCENE_DEFAULT_SECONDS.
 * Valid variable lengths are PRESERVED (no forcing to a fixed length). If the clamped total still
 * exceeds the episode ceiling (EPISODE_MAX_TOTAL_SECONDS), the longest clips are trimmed by 1 s at a
 * time — never below SCENE_MIN_SECONDS — until the whole episode fits. Returns the final total.
 */
export function applyFixedSceneDurations(scenes: Array<{ durationSec?: number | null }>): number {
  scenes.forEach((s) => {
    s.durationSec = clampSceneDuration(s.durationSec);
  });
  let total = scenes.reduce((a, s) => a + (s.durationSec ?? 0), 0);
  while (total > EPISODE_MAX_TOTAL_SECONDS) {
    let idx = -1;
    let max = SCENE_MIN_SECONDS;
    scenes.forEach((s, i) => {
      const d = s.durationSec ?? 0;
      if (d > max) { max = d; idx = i; }
    });
    if (idx < 0) break; // every scene already at the floor
    scenes[idx].durationSec = (scenes[idx].durationSec ?? 0) - 1;
    total -= 1;
  }
  return total;
}
/** Stage 45 — frame-state (startState / endState) size: doubled vs Stage 42 (was 12–20 sentences / ≥150 words).
 *  Stage 72 — raised ~1.5× again (36–60 sentences / ≥450 words): in parallel order the scripted frame states are the
 *  ONLY continuity channel between scenes, so every visible object and every person must be listed explicitly. */
export const STATE_MIN_SENTENCES = 36;
export const STATE_MAX_SENTENCES = 60;
export const STATE_MIN_WORDS = 450;
const STATE_SIZE_TEXT = `${STATE_MIN_SENTENCES}–${STATE_MAX_SENTENCES} sentences, AT LEAST ${STATE_MIN_WORDS} words — an EXHAUSTIVE listing, never a summary`;
/** Stage 115 — dialogue is the product, but a clip is a short VARIABLE length (5–10 s): every talking scene
 *  carries a SHORT exchange of 1–2 sentences sized to the clip (a single line for a 5–7 s clip, a two-line
 *  exchange for a fuller one), with no dead air and no crammed speech; a longer conversation spans several clips. */
export const TALK_MIN_SENTENCES = 1;
export const TALK_MAX_SENTENCES = 2;
/** Purely visual scenes allowed per episode. Stage 110 — ZERO: EVERY scene must carry on-camera dialogue
 *  (a silent scene is a hard validation failure), regardless of how many scenes an episode has. */
export const MAX_SILENT_SCENES = 0;
export const ARC_ROLES = ["завязка", "развитие", "поворот", "финал"] as const;

export const episodeOutlineSchema = z.object({
  number: z.number().int().min(1),
  title: z.string().min(1),
  logline: z.string().min(10),
  locationName: z.string().min(1),
  locationDesc: z.string().min(20),
  /** Required visual detail level of the location (how many camera setups it needs) — drives the reference frame count (4/6/9). Optional so older outputs still parse. */
  locationDetail: z.enum(LOCATION_DETAIL_LEVELS).optional().default("medium"),
  characters: z.array(z.string().min(1)).min(1),
  arcRole: z.enum(ARC_ROLES),
  cliffhanger: z.string().min(5),
  /** Stage 105/114 — the episode footage plan (SHOT 1 / SHOT 2 / CLIFFHANGER, 3 labelled lines). Optional so legacy rows still parse; validated by validateEpisodeDescriptions. */
  description: z.string().min(20).optional(),
});
export const seasonStructureSchema = z.object({
  title: z.string().min(1),
  logline: z.string().min(10),
  episodes: z.array(episodeOutlineSchema).min(SEASON_MIN_EPISODES).max(SEASON_MAX_EPISODES),
});
export type SeasonStructure = z.infer<typeof seasonStructureSchema>;
export type EpisodeOutline = z.infer<typeof episodeOutlineSchema>;

/* ───────────── Stage 105/114 — episode story = EPISODE FOOTAGE (2-beat plan) ───────────── */
// An episode "description" is no longer a narrated retelling: it is what the CAMERA SEES across the episode,
// written as exactly three labelled lines (SHOT 1 / SHOT 2 / CLIFFHANGER). Episode N ≥ 2 opens on the
// previous episode's cliffhanger ("OPENS ON: …" at the start of SHOT 1). The scenes are built from these
// two beats + final frame as hard givens (first half of the scenes = SHOT 1, second half = SHOT 2, final frame = CLIFFHANGER).
export const EPISODE_FOOTAGE_MAX_WORDS = 50;
/** Stage 105b/107 — per-line caps (the OPENS ON repetition in SHOT 1 is not counted): a shot line is ONE action in one sentence, the cliffhanger is one image. */
export const FOOTAGE_SHOT_MAX_WORDS = 20;
export const FOOTAGE_CLIFFHANGER_MAX_WORDS = 14;
export const SHOT1_LABEL = "SHOT 1:";
export const SHOT2_LABEL = "SHOT 2:";
export const CLIFFHANGER_LABEL = "CLIFFHANGER (last frame):";
export const OPENS_ON_LABEL = "OPENS ON:";
export type EpisodeFootage = { shot1: string; shot2: string; cliffhanger: string; opensOn?: string };

const FOOTAGE_RE = /shot\s*1\s*(?:\([^)]*\))?\s*:\s*([\s\S]*?)\s*shot\s*2\s*(?:\([^)]*\))?\s*:\s*([\s\S]*?)\s*cliffhanger\s*(?:\([^)]*\))?\s*:\s*([\s\S]*)$/i;
const OPENS_ON_RE = /^\s*opens\s+on\s*:\s*([\s\S]*?)(?<=[.!?…])(?:\s+|$)/i;

/** Word count by whitespace split (the length budget of a description). */
export function countWords(text: string | null | undefined): number {
  return (text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

/** Stage 107 — sentence count: terminators (.!?…) followed by whitespace and an uppercase letter split sentences. */
export function countSentences(text: string | null | undefined): number {
  const t = (text ?? "").trim();
  if (!t) return 0;
  const breaks = t.match(/[.!?…]+["»”')]*\s+(?=\p{Lu})/gu);
  return (breaks?.length ?? 0) + 1;
}

/** Stage 107 — quoted dialogue: a quote pair («…», “…” or "…") enclosing at least two words (apostrophes in "episode's" are not quotes). */
const QUOTED_DIALOGUE_RE = /[«“"]([^«»“”"\n]*?\S\s+\S[^«»“”"\n]*?)[»”"]/u;
export function hasQuotedDialogue(text: string | null | undefined): boolean {
  return QUOTED_DIALOGUE_RE.test(text ?? "");
}

/** Parse a 3-line footage description; null when any label is missing (→ callers fall back to the plain text). */
export function parseEpisodeFootage(description: string | null | undefined): EpisodeFootage | null {
  if (!description) return null;
  const m = FOOTAGE_RE.exec(description.replace(/\*\*/g, "").trim());
  if (!m) return null;
  const shot1 = m[1].trim(), shot2 = m[2].trim(), cliffhanger = m[3].trim();
  if (!shot1 || !shot2 || !cliffhanger) return null;
  const o = OPENS_ON_RE.exec(shot1);
  const opensOn = o ? o[1].trim() : /^\s*opens\s+on\s*:/i.test(shot1) ? shot1.replace(/^\s*opens\s+on\s*:\s*/i, "").trim() : undefined;
  return { shot1, shot2, cliffhanger, ...(opensOn ? { opensOn } : {}) };
}

/**
 * Validate the descriptions of a whole season (in episode order): 3-line format, ≤ EPISODE_FOOTAGE_MAX_WORDS
 * words, and every episode after the first opens on the previous cliffhanger ("OPENS ON:" in SHOT 1).
 * Returns human-readable problems (empty = valid). Shared by the structure job, the story revise and the tests.
 */
export function validateEpisodeDescriptions(episodes: { number: number; description?: string | null; cliffhanger?: string | null }[]): string[] {
  const problems: string[] = [];
  episodes.forEach((e, i) => {
    const desc = (e.description ?? "").trim();
    if (!desc) { problems.push(`episode ${e.number}: description is missing`); return; }
    const f = parseEpisodeFootage(desc);
    if (!f) { problems.push(`episode ${e.number}: description is not in the "${SHOT1_LABEL} / ${SHOT2_LABEL} / ${CLIFFHANGER_LABEL}" 3-line format`); return; }
    const shot1Own = f.shot1.replace(/^\s*opens\s+on\s*:\s*/i, "");
    const opensOnWords = f.opensOn ? countWords(f.opensOn) : 0;
    const shot1Words = Math.max(0, countWords(shot1Own) - opensOnWords);
    const words = shot1Words + countWords(f.shot2) + countWords(f.cliffhanger);
    if (words > EPISODE_FOOTAGE_MAX_WORDS) problems.push(`episode ${e.number}: description has ${words} words excluding labels and the OPENS ON repetition (max ${EPISODE_FOOTAGE_MAX_WORDS})`);
    if (shot1Words > FOOTAGE_SHOT_MAX_WORDS) problems.push(`episode ${e.number}: SHOT 1 has ${shot1Words} own words (max ${FOOTAGE_SHOT_MAX_WORDS})`);
    if (countWords(f.shot2) > FOOTAGE_SHOT_MAX_WORDS) problems.push(`episode ${e.number}: SHOT 2 has ${countWords(f.shot2)} words (max ${FOOTAGE_SHOT_MAX_WORDS})`);
    if (countWords(f.cliffhanger) > FOOTAGE_CLIFFHANGER_MAX_WORDS) problems.push(`episode ${e.number}: CLIFFHANGER has ${countWords(f.cliffhanger)} words (max ${FOOTAGE_CLIFFHANGER_MAX_WORDS})`);
    // Stage 107 — footage is ACTION ONLY: no quoted dialogue, one action (one sentence, max two short) per shot, one image cliffhanger.
    const shot1Body = f.opensOn && shot1Own.includes(f.opensOn) ? shot1Own.slice(shot1Own.indexOf(f.opensOn) + f.opensOn.length).trim() : shot1Own;
    const lines: [string, string][] = [["SHOT 1", shot1Body], ["SHOT 2", f.shot2], ["CLIFFHANGER", f.cliffhanger]];
    for (const [label, text] of lines) {
      if (hasQuotedDialogue(text)) problems.push(`episode ${e.number}: ${label} contains quoted dialogue — describe the action the camera sees, never quote speech`);
    }
    if (countSentences(shot1Body) > 2) problems.push(`episode ${e.number}: SHOT 1 has ${countSentences(shot1Body)} sentences (one action, max two short sentences)`);
    if (countSentences(f.shot2) > 2) problems.push(`episode ${e.number}: SHOT 2 has ${countSentences(f.shot2)} sentences (one action, max two short sentences)`);
    if (countSentences(f.cliffhanger) > 1) problems.push(`episode ${e.number}: CLIFFHANGER has ${countSentences(f.cliffhanger)} sentences (one visible image, one sentence)`);
    if (i > 0 && !/opens\s+on\s*:/i.test(f.shot1)) problems.push(`episode ${e.number}: SHOT 1 must begin with "${OPENS_ON_LABEL} <the CLIFFHANGER of episode ${e.number - 1}>"`);
  });
  return problems;
}

/** Appended to the prompt on the single retry after validateEpisodeDescriptions failed (never truncate silently). */
export const EPISODE_FOOTAGE_RETRY_NOTE =
  `Your previous answer was too long / not in the SHOT 1 / SHOT 2 / CLIFFHANGER format, or it contained dialogue or explanations — rewrite EVERY episode "description" in the 3-line format ("${SHOT1_LABEL} ..." / "${SHOT2_LABEL} ..." / "${CLIFFHANGER_LABEL} ..."), max ${EPISODE_FOOTAGE_MAX_WORDS} words per description, each SHOT ≤ ${FOOTAGE_SHOT_MAX_WORDS} words, CLIFFHANGER ≤ ${FOOTAGE_CLIFFHANGER_MAX_WORDS} words; ONE physical action per shot in ONE sentence; NO quotes or dialogue (describe the sound instead: a voice on the radio promises shelter), NO explanations of why anyone does anything; and start SHOT 1 of every episode after the first with "${OPENS_ON_LABEL} <the previous episode's CLIFFHANGER text>".`;

/** The user's reference example (dugout), in the 3-line format — embedded in the structure / revise prompts. */
export const EPISODE_FOOTAGE_EXAMPLE = `EXAMPLE (reference for the FORMAT and the level of concreteness — do not reuse its content):
Episode 1 "description":
${SHOT1_LABEL} Alex's team climbs down into the dugout and huddles around a hissing radio.
${SHOT2_LABEL} A voice on the radio promises shelter; the man turns the volume up and everyone leans toward the speaker.
${CLIFFHANGER_LABEL} Over the dugout's rim, five pairs of glowing eyes open in the dark.
Episode 2 "description":
${SHOT1_LABEL} ${OPENS_ON_LABEL} Over the dugout's rim, five pairs of glowing eyes open in the dark. The creatures pour over the rim onto the huddled group.
${SHOT2_LABEL} Alex swings a shovel at the nearest creature; the kids press into the far corner.
${CLIFFHANGER_LABEL} A clawed hand closes around a child's ankle as the lamp goes out.`;

/** The description format rule shared by the structure prompt and both revise prompts. */
export const EPISODE_FOOTAGE_RULE = `EPISODE "description" = EPISODE FOOTAGE (MANDATORY FORMAT). Write what the CAMERA SEES across the whole episode as a high-level 2-beat plan, as EXACTLY three labelled lines (labels in English verbatim, the text after each label in the story language):
  ${SHOT1_LABEL} ONE continuous physical action in ONE location that the camera SEES — who is in frame and what they physically do. ONE sentence (max two short).
  ${SHOT2_LABEL} the escalation of the SAME action in the SAME location — the visible turn that makes the situation worse or irreversible. ONE sentence (max two short).
  ${CLIFFHANGER_LABEL} a SINGLE visible image of the final frame — one sentence, a picture the viewer sees (what is in frame, where), never a hint, a question or "will they…".
  ACTION ONLY: NO dialogue and NO quotes of any kind — if speech matters, describe what is heard (a voice on the radio promises shelter); NO motivations or explanations ("in order to", "because", "wants to", "decides to"); NO inner states, feelings, thoughts or backstory; NO chains of micro-events — one action per shot.
  Length (STRICT — this is a shot list, not prose): the whole description 30–45 words, HARD MAX ${EPISODE_FOOTAGE_MAX_WORDS} words (labels and the OPENS ON repetition not counted); each SHOT line ≤ ${FOOTAGE_SHOT_MAX_WORDS} words — ONE action; CLIFFHANGER ≤ ${FOOTAGE_CLIFFHANGER_MAX_WORDS} words — ONE image. Name at most 2–3 characters acting per shot; everyone else is "the group" / "the kids" in the background. No sub-clauses listing what each person separately does. "cliffhanger" = the CLIFFHANGER line's text copied verbatim. "logline" = ONE sentence (what this episode is about).
  ${OPENS_ON_LABEL} for EVERY episode after the first, SHOT 1 MUST begin with "${OPENS_ON_LABEL} <the CLIFFHANGER text of the previous episode>" — the SAME instant, the SAME location, the same people in the same places; never "an hour later", never a reset. Then the action continues from that image.
  BANNED in a description: voice-over retelling of backstory or of a whole period ("a week when…", "over the following days…"); parallel actions that cannot fit into one camera shot (five characters doing five different things in five places); a location change inside the episode; more than ONE event per shot; more than 3 named characters acting in one shot (the rest are a background group); time skips inside the episode; summaries ("tension rises", "they argue about the past"); quoted lines of speech; explanations of why a character acts.
${EPISODE_FOOTAGE_EXAMPLE}`;

/** Stage 105 — the three footage beats as HARD GIVENS for the shooting-script prompts ("" when the description is not in the 3-line format → callers keep the old whole-description behaviour). */
export const SHOT1_BEAT_LABEL = "BEAT 1 (set-up):";
export const SHOT2_BEAT_LABEL = "BEAT 2 (escalation):";
export const FINAL_FRAME_LABEL = "FINAL FRAME (cliffhanger — the episode's last frame):";
export function episodeFootageGivens(description: string | null | undefined): string {
  const f = parseEpisodeFootage(description);
  if (!f) return "";
  return `\nHARD BEATS (the episode IS these two beats plus its final frame — the FIRST half of the ${EPISODE_SCENE_COUNT} scenes expands BEAT 1, the SECOND half expands BEAT 2, and the final frame of the LAST scene is the CLIFFHANGER image; do NOT invent events beyond them, only expand them across the ${EPISODE_SCENE_COUNT} scenes with dialogue, blocking, camera and business):\n${SHOT1_BEAT_LABEL} ${f.shot1}\n${SHOT2_BEAT_LABEL} ${f.shot2}\n${FINAL_FRAME_LABEL} ${f.cliffhanger}`;
}

/** Hard givens for revise prompts: the cliffhanger each episode's synopsis must OPEN ON (the previous episode's). */
export function cliffhangerChainGivens(structure: { episodes: { number: number; cliffhanger: string }[] }): string {
  const eps = [...structure.episodes].sort((a, b) => a.number - b.number);
  if (eps.length < 2) return "";
  const lines = eps.slice(1).map((e, i) => `- Episode ${e.number}'s synopsis opens on the CLIFFHANGER of episode ${eps[i].number}: "${eps[i].cliffhanger}"`);
  return `\n\nCLIFFHANGER CHAIN — HARD GIVENS (each episode's synopsis MUST open by picking up directly from this exact image; if your revision changes an episode's CLIFFHANGER, update the NEXT episode's opening to continue from the new text verbatim):\n${lines.join("\n")}`;
}

/* ───────────── Stage 128 — episode story = ONE detailed continuous synopsis (no 30/30 shot split) ───────────── */
// An episode "description" is now a SINGLE flowing, detailed synopsis paragraph (setup → development → turn →
// ending) followed by one closing "CLIFFHANGER: …" line. The old two-beat "SHOT 1 (30 s) / SHOT 2 (30 s)"
// footage split is GONE from the story build. The cliffhanger stays (separate field + closing line). The legacy
// footage helpers above are kept unchanged so old saved episodes (shot1/shot2) still parse (no auto-migration).
export const CLIFFHANGER_LINE_LABEL = "CLIFFHANGER:";
/** Guideline floor (used only in the retry note — NOT a hard cap): a detailed synopsis is ~4–7 sentences. */
export const EPISODE_SYNOPSIS_MIN_WORDS = 45;
/** Upper bound so a runaway answer is clamped (a paragraph, not a page). */
export const EPISODE_SYNOPSIS_MAX_WORDS = 240;

/** Labels that would (re)impose a shot/beat/timing division — forbidden in the new synopsis format. */
const SHOT_SPLIT_MARKER_RE = /\bshots?\s*[12]\b|\bbeat\s*[12]\b|\b30\s*s(?:ec)?(?:onds?)?\b|first\s+30\b|last\s+30\b|60-?second/i;
/** True when a description still carries a shot/beat/30-second split marker (used by validation & tests). */
export function hasShotSplitMarkers(text: string | null | undefined): boolean {
  return SHOT_SPLIT_MARKER_RE.test(text ?? "");
}

/** All shot/beat/timing LABELS (for deterministic stripping — keeps the surrounding prose text). */
const SHOT_SPLIT_LABEL_RE = /\b(?:shot\s*[12]|beat\s*[12]|opens\s+on|first\s+30|last\s+30)\s*(?:\([^)]*\))?\s*:?/gi;
/** Remove shot/beat/timing LABELS from a description, collapsing it back to continuous prose. */
export function stripShotSplitLabels(text: string | null | undefined): string {
  return (text ?? "").replace(SHOT_SPLIT_LABEL_RE, " ").replace(/\s+/g, " ").trim();
}
/** A trailing/standalone CLIFFHANGER label (all occurrences; the LAST one splits the synopsis from the hook). */
const CLIFFHANGER_LABEL_RE = /cliffhanger\s*(?:\([^)]*\))?\s*:/gi;

/**
 * Split a new-format episode description into its detailed synopsis and its closing cliffhanger.
 * - New format: prose paragraph + a final "CLIFFHANGER: …" line → { synopsis, cliffhanger }.
 * - Legacy 3-line footage: merged into one through-line synopsis + the footage cliffhanger (backward compat).
 * - Plain prose without a CLIFFHANGER line: { synopsis: whole text, cliffhanger: null }.
 */
export function parseEpisodeSynopsis(description: string | null | undefined): { synopsis: string; cliffhanger: string | null } {
  const raw = (description ?? "").replace(/\*\*/g, "").trim();
  if (!raw) return { synopsis: "", cliffhanger: null };
  // Legacy footage rows → collapse the two beats into one continuous synopsis, keep the footage cliffhanger.
  const f = parseEpisodeFootage(raw);
  if (f) {
    const opening = f.opensOn ? f.opensOn.trim() : "";
    const shot1 = f.shot1.replace(/^\s*opens\s+on\s*:\s*/i, "").trim();
    const shot1Body = opening && shot1.startsWith(opening) ? shot1.slice(opening.length).trim() : shot1;
    const synopsis = [opening, shot1Body, f.shot2.trim()].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return { synopsis: synopsis || raw, cliffhanger: f.cliffhanger.trim() || null };
  }
  // New format: the LAST "CLIFFHANGER:" label separates the synopsis from the hook.
  CLIFFHANGER_LABEL_RE.lastIndex = 0;
  let last: RegExpExecArray | null = null, m: RegExpExecArray | null;
  while ((m = CLIFFHANGER_LABEL_RE.exec(raw)) !== null) last = m;
  if (last) {
    const synopsis = raw.slice(0, last.index).replace(/[\s—–-]+$/, "").trim();
    const cliffhanger = raw.slice(last.index + last[0].length).replace(/\s+/g, " ").trim();
    if (cliffhanger) return { synopsis: synopsis || raw, cliffhanger };
  }
  return { synopsis: raw, cliffhanger: null };
}

/**
 * Validate NEW-format episode descriptions: non-empty, no shot/beat/30-second split, a closing cliffhanger
 * present (in the description or the cliffhanger field), and not longer than the upper bound. Length "too short"
 * is intentionally NOT a hard failure (detail is a guideline, nudged via the retry note) so the story never
 * gets forced back into a rigid structure. Everything reported here is fixable by the deterministic clamp.
 */
export function validateEpisodeSynopses(episodes: { number: number; description?: string | null; cliffhanger?: string | null }[]): string[] {
  const problems: string[] = [];
  episodes.forEach((e) => {
    const desc = (e.description ?? "").trim();
    if (!desc) { problems.push(`episode ${e.number}: description is missing`); return; }
    if (hasShotSplitMarkers(desc)) problems.push(`episode ${e.number}: description still uses a shot/beat/timing split (e.g. "SHOT 1", "30 s") — write ONE continuous synopsis instead`);
    const { synopsis, cliffhanger } = parseEpisodeSynopsis(desc);
    const cliff = (cliffhanger ?? e.cliffhanger ?? "").trim();
    if (!cliff) problems.push(`episode ${e.number}: missing the closing "${CLIFFHANGER_LINE_LABEL}" line`);
    if (countWords(synopsis) > EPISODE_SYNOPSIS_MAX_WORDS) problems.push(`episode ${e.number}: synopsis has ${countWords(synopsis)} words (max ${EPISODE_SYNOPSIS_MAX_WORDS})`);
  });
  return problems;
}

/** The user's reference example, in the new single-synopsis + cliffhanger format. */
export const EPISODE_SYNOPSIS_EXAMPLE = `EXAMPLE (reference for the FORMAT and the level of detail — do not reuse its content):
Episode 1 "description": Alex leads his small team down into a cold dugout as distant shells thud, and they crowd around a hissing field radio hoping for any sign of rescue. A calm voice promises shelter to the north; the group argues in low voices about whether to trust it while a frightened child clings to Alex's sleeve. Alex turns the volume up, marks the route on a torn map and tells them they move at first light. As the lamp flickers, something heavy scrapes against the earth wall outside and the radio drops into static.
CLIFFHANGER: Over the dugout's rim, five pairs of glowing eyes open in the dark.
Episode 2 "description": The glowing eyes are still fixed on the group as the creatures pour over the dugout's rim onto the huddled team. Alex shoves the child behind him and swings a shovel at the nearest shape while the others scramble for the far corner. The radio voice keeps calmly repeating the route as if nothing is happening, and Alex realizes the signal is luring them out. He kicks over the lamp to buy darkness and drags the wounded toward the tunnel mouth.
CLIFFHANGER: A clawed hand closes around the child's ankle as the last light goes out.`;

/** The new description-format rule shared by the structure prompt and the revise prompt. */
export const EPISODE_SYNOPSIS_RULE = `EPISODE "description" = a DETAILED, CONTINUOUS SYNOPSIS of the whole episode (MANDATORY FORMAT):
  Write ONE flowing paragraph — about ${EPISODE_SYNOPSIS_MIN_WORDS}+ words, roughly 4–7 sentences — that tells everything that happens in this episode IN ORDER: the set-up, the development, the central turn, and how it ends. Be concrete: WHO is present, WHERE it takes place, WHAT they physically do, the key actions, and one or two short orienting lines of what is said (weave them into the prose). It reads like the episode's story, not a shot list.
  Then, on a NEW line, exactly one closing hook: "${CLIFFHANGER_LINE_LABEL} <a single concrete final IMAGE that forces the viewer into the next episode>" (a picture the viewer sees, never a question or "will they…").
  DO NOT divide the episode into shots, beats or halves: NO "SHOT 1"/"SHOT 2", NO "BEAT 1/2", NO "first 30 / last 30", NO timings or durations ("30 s", "30 seconds", "60-second"), NO numbered lists — just the continuous synopsis followed by the single CLIFFHANGER line.
  CONTINUITY (expressed in the prose, no labels): every episode after the first OPENS by picking up DIRECTLY from the previous episode's cliffhanger — the same moment, the same place, the same unresolved situation — and only then moves forward; never a time-skip, never a reset.
  "cliffhanger" (the JSON field) = the ${CLIFFHANGER_LINE_LABEL} line's text, copied verbatim. "logline" = ONE sentence (what this episode is about). Name the characters actually present; keep it to ONE key location per episode.
${EPISODE_SYNOPSIS_EXAMPLE}`;

/** Appended to the structure/revise prompt on the single retry after validateEpisodeSynopses failed. */
export const EPISODE_SYNOPSIS_RETRY_NOTE =
  `Your previous answer split episodes into shots/beats or added timings, or its "description" was too thin — rewrite EVERY episode "description" as ONE continuous, DETAILED synopsis paragraph (about ${EPISODE_SYNOPSIS_MIN_WORDS}+ words, ~4–7 sentences: set-up → development → the turn → the ending, with who / where / what and a couple of short orienting lines), with NO "SHOT 1/2", NO "BEAT", NO "(30 s)" / seconds / durations and NO numbered list, followed by a single "${CLIFFHANGER_LINE_LABEL} …" line. Every episode after the first opens by continuing directly from the previous episode's cliffhanger.`;

/** Stage 38: every scene kind the script writer may emit (also the values persisted in Scene.sceneKind). */
export const SCENE_KINDS = ["dialogue", "narration", "action"] as const;
export type SceneKind = (typeof SCENE_KINDS)[number];
export const isActionKind = (kind: string | null | undefined) => kind === "action";

export const sceneScriptSchema = z.object({
  number: z.number().int().min(1),
  shotType: z.string().min(3),
  /** Stage 115 — the script model sets this to the clip's REAL length (5–10 s); clamped in normalizeEpisodeScript. */
  durationSec: z.coerce.number().int().min(1).max(120).optional().default(SCENE_DEFAULT_SECONDS),
  locationDesc: z.string().min(3),
  characters: z.array(z.string()).default([]),
  action: z.string().min(5),
  /** ENGLISH spoken lines — this is what Seedance voices (always English, whatever the story language). */
  dialogue: z.string().min(1),
  /** Same lines in the story language for the UI / subtitles; equals `dialogue` for English projects. */
  dialogueLocal: z.string().optional(),
  // Stage 12 (Commit D) — optional off-screen NARRATOR voice-over (backstory / catch-up).
  /** ENGLISH narration read by an off-screen narrator (no on-camera lip-sync). Used mainly for the episode-1 opening backstory. */
  voiceover: z.string().optional(),
  /** Same narration in the story language for the UI; equals `voiceover` for English projects. */
  voiceoverLocal: z.string().optional(),
  /**
   * "narration" = off-screen voice-over scene (b-roll under narration, no talking heads);
   * "action" (Stage 38) = fight / duel / chase / physical struggle staged face to face with beat-by-beat choreography
   * and only short lines in the pauses between impacts; "dialogue"/undefined = normal on-camera talking scene.
   */
  sceneKind: z.enum(SCENE_KINDS).optional().default("dialogue"),
  videoPrompt: z.string().min(40),
  // Stage 11 — scene-to-scene CONTINUITY metadata (all optional so pre-Stage-11 scripts still validate).
  /** Who is present and WHERE at the START of the scene, carried over from the previous scene's ending. */
  presence: z.string().optional(),
  /** Who enters or leaves DURING the scene and HOW (walks in, gets up and crosses, steps out) — the shown movement. */
  entrances: z.string().optional(),
  /** How this scene links to the previous one: same-location-continuation | character-moves | location-change | new-sequence. */
  continuesFrom: z.string().optional(),
  /**
   * Stage 40 — REQUIRED scripted END STATE of the scene's final frame (English, 24–40 sentences, ≥300 words — Stage 45): where every
   * present character is relative to the landmarks, body orientation, posture, hands / held objects, gaze and
   * expression; props / doors / light state; camera position and shot scale at the cut. The next scene's prompt
   * opens with it as OPENING STATE (parallel mode) so independently generated clips join seamlessly.
   */
  endState: z.string().min(1),
  /**
   * Stage 41 — REQUIRED scripted START STATE of the scene's FIRST frame (English, 24–40 sentences, ≥300 words — Stage 45, same contract as
   * endState). Stage 44: WORLD block equals the previous scene's endState WORLD, CAMERA block differs, unless continuesFrom is location-change / new-sequence
   * (then it describes the fresh opening). Opens this scene's prompt as OPENING STATE.
   */
  startState: z.string().min(1),
  /**
   * Stage 113 — optional "SET" line (English): the location's set-inventory objects that are in frame / used in
   * this scene, with their placement. Only objects from the location's set inventory may appear here.
   */
  set: z.string().optional(),
  /**
   * Stage 122 — optional "region" (English, one short phrase): WHICH part / corner of the single key location this
   * scene physically happens in, plus the rough vantage, described strictly in terms of the location's own fixed
   * set objects and architecture (e.g. "the eastern bench against the rear wall, looking toward the columns"). It
   * names no new furniture and changes no geometry — it only says where in the constant room we are. Scenes that
   * share the SAME region reuse one pre-generated region plate (cache by locationId + normalized region). Optional
   * so pre-Stage-122 scripts still validate; when absent the scene falls back to the master location plates.
   */
  region: z.string().optional(),
});
export const episodeScriptSchema = z.object({
  visualIdentity: z.string().min(10),
  // Stage 93 — tolerant bounds so a model that emits a few extra/fewer scenes still parses;
  // normalizeEpisodeScript() truncates to EPISODE_SCENE_COUNT and forces the fixed durations.
  scenes: z.array(sceneScriptSchema).min(1).max(Math.max(EPISODE_MAX_SCENES, 8)), // Stage 103: legacy 4-scene episodes still parse
});
export type EpisodeScript = z.infer<typeof episodeScriptSchema>;
export type SceneScript = z.infer<typeof sceneScriptSchema>;

export const isSilent = (dialogue: string) => /\[NO DIALOGUE\]/i.test(dialogue) || !dialogue.trim();

/** Count spoken words (excluding "SPEAKER (tone):" cues). */
export function spokenWordCount(dialogue: string): number {
  if (isSilent(dialogue)) return 0;
  return dialogue
    .split(/\n+/)
    .map((l) => l.replace(/^[^:]{1,60}:\s*/, "").replace(/["«»]/g, "").trim())
    .filter(Boolean)
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
}

/** Count dialogue sentences (spoken text only, cues stripped). */
export function dialogueSentenceCount(dialogue: string): number {
  if (isSilent(dialogue)) return 0;
  const text = dialogue
    .split(/\n+/)
    .map((l) => l.replace(/^[^:]{1,60}:\s*/, "").replace(/["«»]/g, "").trim())
    .filter(Boolean)
    .join(" ");
  return text.split(/(?<=[.!?…])\s+|\s*[.!?…]+\s*$/).map((x) => x.trim()).filter((x) => x.length > 1).length;
}

/**
 * Stage 115 — clip length is now VARIABLE and comes from the script model's own durationSec (clamped in
 * normalizeEpisodeScript). This helper is only a fallback for call sites that have no model value; it
 * returns SCENE_DEFAULT_SECONDS. The old word-count arguments are kept for call-site compatibility.
 */
export function estimateDurationSec(_dialogue: string, _action = ""): number {
  return SCENE_DEFAULT_SECONDS;
}

/** Pace / camera / performance directions shared by the script prompts and the final Seedance prompt. */
export const PACE_DIRECTION =
  "PACE: natural conversational rhythm — characters speak at a relaxed, realistic tempo, clearly and unhurried, with the normal small pauses of real speech; nobody rushes, races or crams words, and each reply lands naturally without dead air. " +
  "CAMERA: 1–2 quick cuts inside the short clip, built AROUND the characters — medium / medium-close / over-the-shoulder on the speaker and the reactor, the character large in the frame with the location reading as background behind them; a wider two-shot is used only to (re)establish where they are or to show a move; hard cuts, no slow pans, no lingering. " +
  "FRAMING: the frame is built around the CHARACTERS and their faces — the base shot keeps the character large (head-and-shoulders to waist) with the environment as context behind, not the room with small figures in it. A face close-up IS allowed and encouraged on an emotional beat (a reaction, a decision, a line that lands) — push in, hold it briefly, then cut back; do not hold one continuous extreme close-up for the whole clip. Keep 1–2 orienting wider shots only where the geography actually needs them; a full wide / establishing shot is used only when the scene requires it (a new or changed location, an entrance / exit, showing arrangement or the geography of a move). " +
  "STAGING: never two people simply standing face to face talking, and never a static, symmetrical face-to-face stand-off. Place the characters NATURALLY in the space according to what the location is — at different distances and heights, one seated one standing, side by side at a counter/window/rail, one crossing the room while the other stays, angled to the environment rather than squared off to each other — and let them shift position and use the location's objects as they talk. " +
  "EYELINES: the character who speaks LOOKS AT the person they are addressing, and the listener looks back at the speaker — the eyelines connect between them. They meet each other's eyes by turning the head and eyes (a natural three-quarter, profile or over-the-shoulder angle), NEVER by both turning frontally to the camera; keep the gaze anchored on the addressed character rather than aimed at the viewer or into empty space. " +
  "PERFORMANCE: expressive, energetic acting — vivid facial expressions, lively hand gestures, emotional nuance in the voice (a catch in the voice, a quiet bitter laugh, controlled intensity), eye contact and reactions while the other speaks.";

/**
 * Stage 38 — ONE universal sentence appended to the talking-scene staging rules: the "never squared off
 * face to face" restriction is about CALM conversation only; any confrontational beat is staged face to face.
 */
export const CONFRONTATION_STAGING_SENTENCE =
  "CONFRONTATION: any confrontational beat inside a dialogue scene — advancing on someone, a shove, a grab, a strike, a weapon drawn — is staged FACE TO FACE, bodies squared toward each other, just like a fight; the \"never squared off face to face\" rule applies only to calm conversation.";

/**
 * Stage 115 — VARIABLE clip length + no frozen padding. Each scene's clip runs only as long as its own
 * action and lines actually last (SCENE_MIN_SECONDS..SCENE_CLIP_MAX_SECONDS); the model sets durationSec
 * to that real length and the clip ENDS the moment the shown beat ends — never padded, never held static.
 */
export const CLIP_LENGTH_RULE =
  `CLIP LENGTH (VARIABLE ${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS} s, NEVER PADDED): each scene's clip runs only as long as the action and lines it contains actually last — a short beat is ${SCENE_MIN_SECONDS}–7 s, a full beat up to ${SCENE_CLIP_MAX_SECONDS} s. Set "durationSec" to that real length (an integer ${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS}). The clip ENDS the instant the shown action / line finishes: a character must NOT hold a static pose, freeze, or stare into the camera to fill time — there is NO frozen final beat, only continuous natural motion. A short, alive clip is better than a ${SCENE_CLIP_MAX_SECONDS} s one padded with a held pose. Across the whole episode the SUM of all "durationSec" must stay AT OR UNDER ${EPISODE_MAX_TOTAL_SECONDS} s (up to ${EPISODE_TOTAL_LABEL}); it does NOT have to reach it.`;

/**
 * Stage 115 — a conversation may be split across CONSECUTIVE scenes (requirement B): one short line / exchange
 * per clip, a camera cut, the reply continues in the next scene. A dialogue scene need not be self-contained.
 */
export const MULTI_CLIP_DIALOGUE_RULE =
  "DIALOGUE ACROSS CLIPS: a conversation does NOT have to fit in one clip. A single clip carries ONE short line or a quick 1–2-line exchange plus visible action; a longer conversation is SPREAD across consecutive scenes — one line (or short exchange) here, then the NEXT scene cuts to a new angle / shot and the reply continues (two characters talk, a cut, the next phrase). A dialogue scene may end mid-conversation and the next scene picks it up; it need not be self-contained. Keep continuity (each scene opens on the previous scene's final frame) and ALWAYS change the camera on the cut.";

/**
 * Stage 38 — staging + choreography rule for sceneKind "action" (fight / duel / chase / physical struggle).
 * Shared by the script writer prompts (the "action"/videoPrompt of an action scene) and the final Seedance prompt.
 */
export const ACTION_STAGING_RULE =
  "ACTION STAGING (fight / duel / chase / physical struggle): stage a REAL fight in motion, NOT two figures standing near each other. Every fighter is ENGAGED with the opponent and moving — closing distance, attacking, defending or reacting — never idle, never lined up side by side facing the camera. " +
  "MECHANICS (name them beat by beat, who does what to whom, in order): one side ATTACKS with a specific move — a lunge, a swing, a thrust, a punch, a kick, a grab, a throw, a tackle, a weapon strike, a spell or shot aimed AT the opponent's body; the other side DEFENDS or reacts — a dodge, a duck, a roll, a sidestep, a block, a parry, a stagger, a fall, a counter-attack. " +
  "CONTACT & IMPACT: attacks connect — there is VISIBLE physical contact and the struck body REACTS: it snaps back, doubles over, is knocked off balance, is thrown, hits the ground, then recovers or presses on. At any instant the participants hold DIFFERENT poses (one mid-lunge, the other twisting away or falling) — never a mirrored, static, symmetrical stand-off. " +
  "CREATURE / PACK FIGHTS: when the opponent is a creature, monster, beast or a pack / horde, that creature is an ACTIVE OPPONENT in direct physical contact with the hero, NOT a background element: it advances, lunges, swipes, bites, grabs, surrounds or pounces while the human dodges, strikes back, is knocked down or breaks free. Show the creature and the human COLLIDING in the SAME frame, the creature driving the hero and the hero fighting it head-on — the creature is never merely standing in the background. " +
  "CAMERA: shoot the fighters in PROFILE, three-quarter, over-the-shoulder or from a LOW WIDE angle so both combatants and the space between them are in frame. NEVER both fighters facing the camera side by side, NEVER anyone striking at someone's BACK or at empty air (unless the story explicitly says the attack comes from behind). " +
  "CUTS: every cut in [SHOT TYPE] is a NEW BEAT of the fight (e.g. the lunge → the block and counter, 2–3 hard fast cuts across the short clip), NO slow motion, NO lingering. Wide and medium shots keep BOTH fighters and the moment of impact in frame; a tight cut is used only for a single reaction and never fills the screen with a face. " +
  "LINES: 1–2 short lines at most, spoken ONLY in the pauses between impacts (before the charge, after a fall, at the stand-off) — never while striking, dodging or falling; the speaker's face need not face the camera. " +
  "IMPACT: show the real consequences of every hit — impacts, falls, dust, sparks, splintering wood, magic light, torn cloth, blood, wounds, the shock and pain on faces; nothing is toned down.";

/** Stage 38 — PACE/CAMERA/STAGING/PERFORMANCE block appended to the Seedance prompt of an ACTION scene instead of PACE_DIRECTION. */
export const ACTION_PACE_DIRECTION =
  "PACE: fast and physical — the clip is a continuous fight / chase, every second carries a move (a lunge, a swing, a dodge, a block, a hit, a fall, a recovery); the few lines are short and land only in the pauses between impacts. " +
  "CAMERA: 2–3 hard fast cuts across the short clip, each a new beat of the fight — low wide shot of both fighters closing the distance → profile / three-quarter medium of the exchange of blows → over-the-shoulder on the counter-attack or the throw / fall; hard cuts, NO slow motion, NO lingering, NO slow pans. " +
  ACTION_STAGING_RULE + " " +
  "PERFORMANCE: committed physical acting — full-body effort, weight and momentum in every move, breath knocked out on impact, fierce focused eyes on the opponent, sweat and dust, real reactions to being hit or thrown.";

/**
 * NO CONTENT LIMITS: the script writer has no restrictions — mature, violent, bloody, dark, profane, sexual and
 * morally complex material is allowed whenever the story calls for it. Shared by all script prompts.
 * (MODERATION_SAFE_RULE is kept as an alias for existing imports.)
 */
export const NO_CONTENT_LIMITS_RULE =
  "NO CONTENT LIMITS: this is an unrestricted adult drama. You have NO content restrictions — write mature, violent, bloody, brutal, dark, cruel, profane, sexual and morally complex material whenever the story calls for it; never soften, sanitize, euphemize, skip or fade out on a beat, never add disclaimers or warnings, never make the story safer, kinder or more polite than the synopsis demands. Aim for bold, gripping, unpredictable drama with real stakes and real consequences: characters get hurt, betray, kill and die; villains are genuinely dangerous; nobody is protected by the plot. " +
  "PHYSICAL DRAMA: express conflict BOTH through dialogue, faces, the distance between the characters and staging (turning away, stepping closer, holding an object, leaving the room) AND through the REAL physical action the beat requires — movement (advances with measured steps, strides in, backs away, spins around, stalks toward the other), charged looks (smirks, glares with fury, narrows the eyes, sizes the other up) and dramatic physical beats (raises a hand, swings, strikes the chest, shoves, grabs by the collar, draws or throws a weapon such as a spear or knife, a blow lands, someone falls, bleeds, dies). " +
  "Tone cues may be tense, cold, menacing, cruel or obscene (\"furiously\", \"coldly\", \"through gritted teeth\", \"with contempt\"), not only neutral. " +
  "Speaking does NOT require the speaker's face or lips in frame — the staging decides (profile, over the shoulder, from behind, a wide shot are all fine); just keep hard impacts out of the exact moment a line is spoken — place them just before / after the lines.";
/** @deprecated alias of NO_CONTENT_LIMITS_RULE (kept for existing imports). */
export const MODERATION_SAFE_RULE = NO_CONTENT_LIMITS_RULE;

/** The location is a physical space the characters inhabit, never a flat backdrop — shared by all script prompts. */
export const LOCATION_PRESENCE_RULE =
  "LOCATION PRESENCE: the location is NOT a backdrop — the characters are physically INSIDE it and interact with it in every scene: they walk through it, sit on, lean against, open, pick up and put down its concrete objects and surfaces ([BLOCKING] and [ACTION] name those objects), and the shots use depth (foreground object → characters → background of the same place). " +
  "BUT the shot is built around the CHARACTERS, their faces and their action — the environment is context BEHIND them, it does not dominate the frame and it does NOT force the camera to pull back to a wide: keep the characters large and clearly the subject, with just enough of the place visible to read where they are. Never a character isolated against a blurred wall. " +
  "The place is ALIVE: the mid-ground and background carry natural, believable activity appropriate to it — passers-by, other people at work or waiting, moving vehicles, animals, working machines, curtains and papers moving in a draught, screens and signs glowing, weather (rain, wind, dust) — described in [ACTION]/[BLOCKING] as SECONDARY background life behind the speakers (use CROWD groups from the cast where the place plausibly gathers people). The leads stay in the foreground and clearly framed; the background activity never blocks them or the lip-sync.";

/** Shots are built around the characters; the location gives depth behind them, wide shots only when the scene needs one. */
export const SCALE_DEPTH_RULE =
  "SCALE & DEPTH: build every shot around the CHARACTERS, not around the room — the people and their faces are the subject and fill the frame; the location gives depth and context BEHIND them, it is never the point of the shot. The action and dialogue can still play across DIFFERENT zones of the location and IN MOTION (characters move between zones as they talk — from the window to the table, from the room into the corridor, along the street), but the camera stays ON the characters as they move. " +
  "The cut list mixes CHARACTER-FORWARD scales — medium, medium-close and over-the-shoulder on the speaker and the reactor — and a face CLOSE-UP is allowed on an emotional beat (a reaction, a decision, a line that lands). A WIDE or ESTABLISHING shot is NOT the mandatory opening and NOT the base scale: use one only when the scene actually requires it — a new or changed location, an entrance or exit, showing how people are arranged, or the geography of a move / action. " +
  "Keep real DEPTH behind the characters: a clear foreground element, the characters large in the mid-ground, and a deep background of the same place (a corridor receding, a street stretching away, a window onto more space) — never tiny figures lost in a big empty wide, and never a flat wall pinned behind a head.";

/** Every speaking character is DOING something physical and ordinary, not just talking. */
export const EVERYDAY_BEHAVIOR_RULE =
  "CHARACTERS ACT (not talking heads): parallel to their lines every character performs concrete, ordinary, natural business — walking, sitting down and standing up, pouring and drinking, eating, picking up / holding / putting down objects, opening a door or a window, typing or sending a message on a phone, sorting papers, wiping a surface, adjusting clothes or hair, twirling a pen, laughing, shrugging, glancing at a watch, fidgeting. " +
  "[BLOCKING] and [NON-VERBAL] must give EACH speaker a specific piece of business tied to the location's objects — nobody just stands and speaks. These micro-actions run WITH the dialogue, adding realism and motion, not replacing the spoken exchange. " +
  "Beyond the everyday micro-actions, the scene ALSO carries the dramatic physical beats the story requires (see PHYSICAL DRAMA) — a confrontation, a strike, drawing or throwing a weapon, a shove — staged face to face, in beats just before or after that speaker's spoken line.";

/** Creative bar for the story itself — shared by the season, episode, trailer and revise prompts. */
export const CREATIVE_RULE =
  "CREATIVE BAR: the story must be gripping, not generic — every scene contains a concrete reversal, revelation, decision or raised stake (a secret, a lie exposed, an ultimatum, an unexpected ally, a choice with a price). " +
  "Avoid clichéd phrasing and predictable beats; give each character a distinct voice, a want and a fear, and use specific, sensory details of the location as dramatic tools. " +
  "Every scene ends on a micro-hook that pulls the viewer into the next shot; the episode ends on a cliffhanger the audience did not see coming but that follows from what was planted.";

/** Scene-to-scene continuity — the episode is ONE connected action, characters never teleport. Shared by all script prompts. */
export const CONTINUITY_RULE =
  "SCENE-TO-SCENE CONTINUITY: the episode is ONE CONTINUOUS, CONNECTED chain of action — characters NEVER teleport, pop into frame or vanish between scenes. Each scene begins from the EXACT physical situation the previous scene ended in (who was in the room, where they stood or sat, what they were holding, who was mid-move). " +
  "SAME SPOT: when a scene continues in the same place as the previous one, the characters KEEP the positions and business they held at the end of the last scene and simply carry on — no silent reset to a new arrangement. " +
  "SAME CAST CARRIES OVER: the exact set of people present at the END of the previous scene is the BASE cast that opens the next scene — the same identified individuals and the same headcount. Do NOT silently swap the on-screen group for a different set of people between consecutive scenes; you may NOT replace a group of N people with a different group without showing, on camera, each person who leaves walking out and each new person arriving. Anyone in \"presence\" who was there before stays until we SEE them leave. " +
  "MOVEMENT IS SHOWN: whenever someone ENTERS or LEAVES, or the action moves to another zone of the location or to a new place, that movement is SHOWN and motivated on screen — a character rises and crosses the room, opens a door and walks in, arrives through the entrance, steps out and we watch them go, walks down the corridor into the next space — never an instant jump to a new setup with different people already in place. " +
  "CHANGING PARTNER: if the hero starts talking to someone new, SHOW the hand-off — where the previous person went (left, turned back to work, stayed behind) and how the hero got to the next person. " +
  "Write these entrances, exits and moves explicitly into [BLOCKING], [ACTION] and [TRANSITION] so the video model ANIMATES the change of who-is-where, instead of cutting to a static new arrangement. Nobody appears or disappears without the camera showing how. " +
  "WITHIN A SINGLE SHOT / BETWEEN FRAMES: the same rule holds frame to frame — inside one continuous shot NOTHING appears or disappears off-camera. Every change happens ON CAMERA and is shown: an object is picked up, put down, carried in or taken out by a visible hand; a person who joins or leaves the frame WALKS IN or WALKS OUT through frame, never blinks into existence or evaporates. Inside one location characters do NOT teleport between positions — any change of place is a shown MOVE (they cross the space on screen). A character may appear 'from nowhere' at the start of a shot ONLY when the shot is a NEW LOCATION (we cannot show the travel between locations there), and even then their entry INTO that new place — and any later exit — is shown within the shot. So [BLOCKING] and [ACTION] must account for every person and key object continuously across the whole shot.";

/** The episode has exactly ONE key location — every scene stays in it; the place itself never drifts. Shared by script + audit prompts. */
export const ONE_LOCATION_RULE =
  "ONE KEY LOCATION (ABSOLUTE): the episode has exactly ONE key location (the LOCATION given for this episode, which already has reference images). EVERY scene's \"locationDesc\" describes that SAME single place — the temple stays the temple, the workshop stays the workshop, across ALL scenes from first to last. " +
  "Only the ZONE within that location (a different corner, room, table, doorway, stretch of the same street) and the CAMERA ANGLE / distance may change from scene to scene — the PLACE itself never changes. " +
  "It is STRICTLY FORBIDDEN to invent a different setting: do NOT move an interior scene outdoors (no field, no yard, no street) and do NOT move an exterior scene indoors, do NOT introduce a new building, room type or landscape that is not part of the episode's one key location. If the location is an interior, all scenes are that interior; if it is an exterior, all scenes are that exterior. " +
  "The ONLY exception is a DELIBERATELY SHOWN, MOTIVATED move to another place — and then that scene MUST have \"continuesFrom\": \"location-change\" and SHOW the travel on camera (a character walks out and we follow them to the new place). Absent that shown, motivated move, an unmotivated setting change is a HARD ERROR — treat it exactly like a character teleporting between frames (it breaks the same continuity rule).";

/** Stage 40 — what a scripted "endState" must contain. Shared by the episode script, scene revise and continuity audit prompts. */
// Stage 42 — the frame-state descriptions must be EXHAUSTIVE (≈5× the old detail): ~12–20 sentences / ≥150 words.
// Stage 45 — DOUBLED again (24–40 sentences / ≥300 words) and every state opens with an explicit INVENTORY
// (who is IN FRAME / NOT IN FRAME by name, exact placement per character, every prop) — the seams kept
// drifting in object placement and character presence when the description left anything implicit.
// Stage 44 — MATCH CUT ON ACTION. Every state is written in TWO labelled blocks: "WORLD:" (the physical
// instant — people, poses as one moment of CONTINUING motion, wardrobe, props, the detailed place, light,
// weather, palette) and "CAMERA:" (shot scale, height, angle, lens, composition). On a continuous seam the
// WORLD of scene N+1's start is IDENTICAL to scene N's end, while the CAMERA is a NEW setup — the cut lands
// on the same action seen from a different angle, never on a frozen pose repeated in the same framing.
// Stage 72 — EXHAUSTIVE WORLD: every visible object is enumerated with its position; every person gets exact frame
// position, relation to others / objects, body orientation, head direction + gaze target, hands and held items,
// posture and phase of movement, approximate distances; light source and direction are mandatory. In parallel
// generation these two texts are the only thing the neighbouring scene ever sees — nothing may stay implicit.
export const FRAME_STATE_ASPECTS =
  "Write it in TWO labelled blocks, each on its own line. " +
  "\"WORLD:\" — the physical instant, independent of where the camera stands. START the WORLD block with an explicit INVENTORY, in this order: (a) \"IN FRAME:\" — every character visible in this frame, listed BY NAME; (b) \"NOT IN FRAME:\" — every other character of the scene / episode, BY NAME, with where they are (off-screen left / right / behind the camera / left the location) — nobody may appear or vanish between two consecutive frames without an entrance / exit written in the scene; (c) for EACH character in frame — horizontal placement (frame LEFT / CENTER / RIGHT), depth plane (foreground / midground / background), facing direction, posture, and exactly what each hand holds; (d) every prop and piece of furniture that matters, each with its exact position relative to a landmark (\"the red mug on the LEFT edge of the table, handle towards the window\"); (e) the light source, its direction and the time of day. COMPLETENESS RULE (ABSOLUTE): the WORLD block enumerates EVERY object visible in the frame — every piece of furniture, every prop, every vehicle, sign, plant, tool, cup, paper, weapon, bag, lamp — each with its exact position (frame LEFT / CENTER / RIGHT, foreground / midground / background, and relative to a fixed landmark) and its state (open / closed, lit / dark, full / empty, upright / fallen); if something is visible, it is listed — an object that is not listed is treated as ABSENT from the frame. Then continue with the full description: (1) for EVERY person present (named characters AND every extra / crowd figure) — exact frame position (LEFT / CENTER / RIGHT × foreground / midground / background) and position relative to fixed landmarks (door, table, window, wall, bench); their relation to the other people and to the objects (\"two steps left of MARA, right hand on the back of the chair\"); body orientation (which way the torso points, which way the hips point); head direction and the exact gaze target (a named person, a named object, out of frame left); each arm and hand — where it is and exactly what it holds (or that it is empty); full posture and the exact phase of the movement they are in (a single instant of continuing motion: a hand halfway to the cup, weight rolling onto the front foot, a head turning) — NOT a frozen pose; facial expression; (2) each character's clothing and its condition (neat, wet, torn, dusty, blood-flecked); (3) the spatial relationships with APPROXIMATE DISTANCES for every pair that matters — how many metres / steps between each person and the others, between each person and the nearest landmark objects, who faces whom, who is nearer which landmark; (4) the LOCATION in detail — architecture, materials, surfaces, floor, walls, ceiling or sky, the placement of furniture and objects, the zone of the location the characters occupy; (5) the LIGHTING (MANDATORY) — the light SOURCE (sun through which window, a lamp on which table, fire, overcast sky) and its DIRECTION relative to the people (from frame left / right / behind / above), its colour, and the shadows it casts and where they fall; (6) the time of day and the weather / atmosphere (haze, dust, smoke, rain); (7) the overall colour palette; (8) notable props and their exact placement. " +
  "\"CAMERA:\" — the camera setup only: shot scale (wide / full / medium / medium close-up), camera height (eye-level / low / high), angle relative to the characters and the space (frontal / three-quarter / profile / from behind / over-the-shoulder), lens feel (wide-angle / normal / long), and the COMPOSITION — what sits in each third of the frame and along the foreground / midground / background planes. " +
  "Present tense, only what is visible in that single instant; describe motion as its momentary phase, not as a story unfolding.";
/** Stage 44 — shared continuity + speech rules for both frame states. */
const MATCH_CUT_RULE =
  " MATCH-CUT RULE (continuous seams — every \"continuesFrom\" other than \"location-change\" / \"new-sequence\"): the WORLD block of scene N+1's startState is IDENTICAL to the WORLD block of scene N's endState — the same people at the same spots in the same phase of the same movement, same wardrobe, same props, same place, same light — the action simply CONTINUES across the cut. The CAMERA block MUST be DIFFERENT: change at least TWO of the three parameters (shot scale, camera height, angle) — never repeat the previous framing; the cut is a new camera on the same instant, like a real edit. " +
  " SPEECH RULE: every line of dialogue belongs ENTIRELY to one scene — a line may end right on the cut but is never split across two scenes, nobody is mid-word or mid-sentence on the final frame, and the next scene opens with a fresh line, never with the tail of a sentence; characters never fall silent or freeze before the cut — movement, breathing and room tone continue through it.";
export const START_STATE_RULE =
  "\"startState\" (REQUIRED, ENGLISH, present tense, " + STATE_SIZE_TEXT + ", WORLD + CAMERA blocks) = an exhaustive, pixel-precise description of the scene's FIRST FRAME — one instant of continuing action seen from this scene's opening camera. " +
  FRAME_STATE_ASPECTS +
  MATCH_CUT_RULE +
  " CARRY THE PREVIOUS END-STATE (continuous seams): this scene's opening WORLD must EQUAL the previous scene's endState WORLD at the same instant — the character is in the SAME pose, the SAME position, the SAME phase of motion and the SAME action as the previous scene's final frame (a character still WALKING at the previous endState is still walking here at the same moment, NOT already sitting, standing still or re-posed), and ONLY the camera setup differs. Never advance, rewind or reset the character's pose, position or motion across the cut; the start-state is the previous end-state seen from a new camera. This holds identically whether the seam is resolved from the previous shot's last frame (chain mode) or from the previous scene's scripted endState text (parallel mode)." +
  " Only when \"continuesFrom\" is \"location-change\" or \"new-sequence\" does the startState describe the fresh opening of a new sequence (own WORLD, own CAMERA).";
export const END_STATE_RULE =
  "\"endState\" (REQUIRED, ENGLISH, present tense, " + STATE_SIZE_TEXT + ", WORLD + CAMERA blocks) = an exhaustive, pixel-precise description of the scene's FINAL FRAME at the cut — one instant of CONTINUING action (motion and sound go on through the cut; never a pause, a settled pose or a silent beat), written so the next scene can pick up the SAME WORLD instant from a NEW camera. " +
  FRAME_STATE_ASPECTS +
  MATCH_CUT_RULE +
  " HAND-OFF: the WORLD block describes the exact phase of the ongoing movement and speech at the cut (a line may end right on it, but nobody has fallen silent or frozen). Scene N+1's [BLOCKING] / [SHOT TYPE] first beat continues this exact WORLD instant from a different shot scale / height / angle — unless its \"continuesFrom\" is \"location-change\" or \"new-sequence\".";

const PROMPT_LINES = ["[SHOT TYPE]", "[VISUAL STYLE]", "[LIGHTING]", "[BLOCKING]", "[GAZE]", "[NON-VERBAL]", "[ACTION]", "[CHARACTER]", "[TRANSITION]"];

/** Problems prefixed "soft:" are logged but never fail a script (drift in density / sentence count / camera wording). */
export const isSoftProblem = (p: string) => p.startsWith("soft:");
export const hardProblems = (problems: string[]) => problems.filter((p) => !isSoftProblem(p));

export type ValidateEpisodeOptions = {
  /** Project cast (English names). When given, every speaker label must belong to the cast. */
  characterNames?: string[];
  /** Final attempt: language / speaker-name problems become "soft:" (the job repairs them itself). */
  languageIsSoft?: boolean;
};

/** Speaker labels of a dialogue block (`NAME (cue): "line"` → "NAME"); generic labels (ALL, BOTH, VOICE…) are skipped. */
export function dialogueSpeakers(dialogue: string): string[] {
  const out = new Set<string>();
  for (const raw of dialogue.split(/\r?\n/)) {
    const m = raw.match(/^\s*([^:"«»(]{1,60}?)\s*(\([^)]*\))?\s*:\s*\S/);
    if (!m) continue;
    const name = m[1].trim().replace(/\s+/g, " ");
    if (!name || /^(all|both|everyone|together|voice|v\.?o\.?|off|o\.?s\.?|narrator|unknown)$/i.test(name)) continue;
    out.add(name);
  }
  return [...out];
}

/** "MARK" / "Mark Ellison" / "DR. MARK" match cast entry "Mark Ellison" (first token or full name, case-insensitive). */
function speakerMatches(speaker: string, castLower: string): boolean {
  if (NON_LATIN_RE.test(speaker)) return false; // a Cyrillic / non-Latin speaker label is never a cast match
  const s = speaker.toLowerCase().replace(/[^a-z0-9\s'-]/g, "").trim();
  if (!s) return true;
  if (s === castLower || castLower.startsWith(s) || s.startsWith(castLower)) return true;
  const castTokens = castLower.split(/\s+/).filter((t) => t.length > 1);
  const spTokens = s.split(/\s+/).filter((t) => t.length > 1);
  return spTokens.some((t) => castTokens.includes(t));
}

/** Non-throwing validation of an episode script: returns human-readable problems (empty = ok; "soft:" = warning only). */
export function validateEpisodeScript(script: EpisodeScript, opts: ValidateEpisodeOptions = {}): string[] {
  const problems: string[] = [];
  const n = script.scenes.length;
  // Too FEW scenes is a hard failure. Too MANY is only "soft" here: the RAW LLM output is already
  // hard-capped at EPISODE_MAX_SCENES by episodeScriptSchema (zod, before normalize), and the
  // auto-split pass in normalizeEpisodeScript may legitimately push a long episode above the cap.
  if (n < EPISODE_MIN_SCENES) problems.push(`scene count ${n} below ${EPISODE_MIN_SCENES}`);
  else if (n > EPISODE_MAX_SCENES) problems.push(`soft: scene count ${n} above ${EPISODE_MAX_SCENES} (auto-split expanded the episode)`);
  // Legacy: a stored narration scene (off-screen voice-over) carries an English narration track, so it is NOT
  // "silent". Stage 110: the prompt no longer asks for narration scenes — every NEW scene is on-camera talking.
  const isNarration = (s: SceneScript) => s.sceneKind === "narration" && !!(s.voiceover ?? "").trim();
  // Stage 110 — a silent on-camera scene is a HARD failure (MAX_SILENT_SCENES = 0): the job retries with a
  // targeted correction; we never store a "[NO DIALOGUE]" scene.
  const silentScenes = script.scenes.filter((s) => isSilent(s.dialogue) && !isNarration(s)).map((s) => s.number);
  if (silentScenes.length > MAX_SILENT_SCENES) problems.push(`silent scene(s) ${silentScenes.join(", ")}: every scene must carry on-camera dialogue (max silent ${MAX_SILENT_SCENES})`);
  const speaking = script.scenes.filter((s) => !isSilent(s.dialogue) || isNarration(s)).length;
  if (speaking < 1) problems.push("no dialogue in episode");
  // Stage 110 — dialogue language / speaker names. These are HARD on the first attempt (→ retry with a
  // correction note). On the final attempt the job passes `languageIsSoft: true` and repairs the text itself
  // (swap / translate via ensureEnglishDialogue), so a wrong language must not fail the whole job.
  const langPrefix = opts.languageIsSoft ? "soft: " : "";
  const allowedNames = (opts.characterNames ?? []).map((c) => c.trim().toLowerCase()).filter(Boolean);
  script.scenes.forEach((s) => {
    if (isSilent(s.dialogue) || isNarration(s)) return;
    if (!isEnglishDialogue(s.dialogue)) problems.push(`${langPrefix}scene ${s.number}: dialogue is not English (Cyrillic / non-Latin text in the spoken lines)`);
    if (allowedNames.length) {
      const bad = dialogueSpeakers(s.dialogue).filter((name) => !allowedNames.some((a) => speakerMatches(name, a)));
      if (bad.length) problems.push(`${langPrefix}scene ${s.number}: speaker name(s) not from the cast: ${bad.join(", ")} (use the project's English character names)`);
    }
  });
  // Stage 45 — running-time budget (normalizeEpisodeScript already scaled what it could; leftovers are advisory).
  const total = episodeTotalSeconds(script.scenes);
  if (total > EPISODE_MAX_TOTAL_SECONDS) problems.push(`soft: episode total ${total}s exceeds ${EPISODE_MAX_TOTAL_SECONDS}s`);
  script.scenes.forEach((s, i) => {
    if (s.durationSec > SCENE_MAX_SECONDS) problems.push(`scene ${s.number}: durationSec ${s.durationSec} above ${SCENE_MAX_SECONDS}`);
    if (s.number !== i + 1) problems.push(`scene ${i + 1} numbered ${s.number}`);
    // Narration scenes are exempt from on-camera dialogue-density checks (they carry narration, not spoken lines),
    // but they STILL need a complete videoPrompt with all tags — so only skip the dialogue checks.
    // Stage 38: action scenes legitimately carry only 1–3 short lines between impacts — no density checks for them.
    if (!isNarration(s) && !isActionKind(s.sceneKind)) {
      const sentences = dialogueSentenceCount(s.dialogue);
      if (!isSilent(s.dialogue) && sentences < TALK_MIN_SENTENCES) problems.push(`soft: scene ${s.number}: ${sentences} dialogue sentences (want ${TALK_MIN_SENTENCES}–${TALK_MAX_SENTENCES})`);
      // Speech density is ADVISORY: durationSec is derived from the word count by normalizeEpisodeScript,
      // and at the 15 s floor a short exchange (24–28 words) cannot go any shorter — never a hard failure.
      const words = spokenWordCount(s.dialogue);
      if (!isSilent(s.dialogue) && s.durationSec > SCENE_MIN_SECONDS && words < MIN_WORDS_PER_SEC * s.durationSec) problems.push(`soft: scene ${s.number}: ${words} words for ${s.durationSec}s (want ≥ ${MIN_WORDS_PER_SEC} words/s so speech fills the clip)`);
    }
    if (/\b(slow[- ]?motion|slowly|lingering|linger|long pause|beat of silence|holds? for a (few|long)|slow pan)\b/i.test(s.videoPrompt)) problems.push(`soft: scene ${s.number}: videoPrompt contains slow/lingering direction`);
    const missing = PROMPT_LINES.filter((l) => !s.videoPrompt.includes(l));
    if (missing.length) problems.push(`scene ${s.number}: videoPrompt missing ${missing.join(",")}`);
  });
  return problems;
}


/**
 * Resolve a character name as written by the LLM ("Валерия", "ВАЛЕРИЯ Соколова") to one of the project's
 * characters. Exact (case-insensitive) match first, then unique first-name / substring match.
 */
export function matchCharacter<T extends { name: string }>(characters: T[], raw: string): T | undefined {
  const norm = (x: string) => x.toLowerCase().replace(/[«»"'().,]/g, " ").replace(/\s+/g, " ").trim();
  const q = norm(raw);
  if (!q) return undefined;
  const exact = characters.find((c) => norm(c.name) === q);
  if (exact) return exact;
  const qFirst = q.split(" ")[0];
  const partial = characters.filter((c) => {
    const n = norm(c.name);
    return n.includes(q) || q.includes(n) || n.split(" ")[0] === qFirst;
  });
  return partial.length === 1 ? partial[0] : undefined;
}

// ---------------------------------------------------------------------------------------------
// Stage 27a — auto-split a scene whose speech does not fit ONE clip at the natural pace.
// A dialogue/narration scene is only as long as SCENE_MAX_SECONDS (Seedance's 30 s ceiling). If the
// spoken text needs more than that at NATURAL_WORDS_PER_SEC, we split it into 2+ consecutive scenes
// in the SAME location (instead of cramming / speeding up the delivery). The second half continues
// seamlessly from the first half's last frame, so frame-chaining keeps working and the place never
// changes. Runs in normalizeEpisodeScript (AFTER the raw LLM output is schema-validated & count-capped).
// ---------------------------------------------------------------------------------------------

/** Plain word count of a block of prose (used for narration). */
const plainWordCount = (t: string) => (t ?? "").trim().split(/\s+/).filter(Boolean).length;

/** Unpadded seconds a block of speech needs at the natural conversational pace. */
const speechSeconds = (words: number) => (words <= 0 ? 0 : Math.ceil(words / NATURAL_WORDS_PER_SEC));

/** Split dialogue into speaker turns (one per line); each turn is an atomic unit (never split mid-turn). */
const dialogueLines = (dialogue: string) => (dialogue ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** Split prose into sentences, keeping the terminal punctuation with each sentence. */
const proseSentences = (text: string): string[] => {
  const m = (text ?? "").trim().match(/[^.!?…]+[.!?…]+["»)]*|\S[^.!?…]*$/g);
  return (m ? m.map((s) => s.trim()).filter(Boolean) : []);
};

/** Index (1..units.length-1) at which to split `units` so the two halves are closest to equal by word count. */
function balancedSplitIndex(units: string[], wordsOf: (u: string) => number): number {
  const total = units.reduce((a, u) => a + wordsOf(u), 0);
  let acc = 0, best = 1, bestDiff = Infinity;
  for (let i = 1; i < units.length; i++) {
    acc += wordsOf(units[i - 1]);
    const diff = Math.abs(acc - total / 2);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return best;
}

/** Build the two halves of a split, copying every field and fixing the SECOND half's continuity. */
function splitHalves(scene: SceneScript, firstFields: Partial<SceneScript>, secondFields: Partial<SceneScript>): [SceneScript, SceneScript] {
  const first: SceneScript = { ...scene, ...firstFields };
  const second: SceneScript = {
    ...scene,
    ...secondFields,
    // The second half opens exactly where the first ended: same location, same people already in place,
    // nobody enters — so canChainFrame() links it to the first half's last frame and the place is stable.
    continuesFrom: "same-location-continuation",
    presence: (scene.presence ?? "").trim() || `${(scene.characters ?? []).join(", ")} continue in place from the previous shot`.trim(),
    entrances: "none",
  };
  return [first, second];
}

/** Recursively split ONE scene until each piece fits SCENE_MAX_SECONDS (bounded depth avoids runaway). */
const MAX_SPLIT_DEPTH = 3; // up to 8 pieces from a single scene — far more than any real exchange needs
function splitScene(scene: SceneScript, depth: number): SceneScript[] {
  const isNarr = scene.sceneKind === "narration" && !!(scene.voiceover ?? "").trim();
  if (isNarr) {
    if (depth >= MAX_SPLIT_DEPTH || speechSeconds(plainWordCount(scene.voiceover ?? "")) <= SCENE_MAX_SECONDS) return [scene];
    const sentences = proseSentences(scene.voiceover ?? "");
    if (sentences.length < 2) return [scene]; // a single unsplittable sentence — leave as-is
    const at = balancedSplitIndex(sentences, plainWordCount);
    const localSents = scene.voiceoverLocal ? proseSentences(scene.voiceoverLocal) : [];
    const mirror = localSents.length === sentences.length; // only mirror the local split when it lines up 1:1
    const [a, b] = splitHalves(
      scene,
      { voiceover: sentences.slice(0, at).join(" "), voiceoverLocal: mirror ? localSents.slice(0, at).join(" ") : scene.voiceoverLocal },
      { voiceover: sentences.slice(at).join(" "), voiceoverLocal: mirror ? localSents.slice(at).join(" ") : undefined },
    );
    return [...splitScene(a, depth + 1), ...splitScene(b, depth + 1)];
  }
  // Dialogue scene.
  if (isSilent(scene.dialogue)) return [scene];
  if (depth >= MAX_SPLIT_DEPTH || speechSeconds(spokenWordCount(scene.dialogue)) <= SCENE_MAX_SECONDS) return [scene];
  const lines = dialogueLines(scene.dialogue);
  if (lines.length < 2) return [scene]; // a single speaker turn can't be split without breaking the turn
  const at = balancedSplitIndex(lines, spokenWordCount);
  const localLines = scene.dialogueLocal ? dialogueLines(scene.dialogueLocal) : [];
  const mirror = localLines.length === lines.length; // mirror local dialogue at the SAME line boundary when it lines up
  const [a, b] = splitHalves(
    scene,
    { dialogue: lines.slice(0, at).join("\n"), dialogueLocal: mirror ? localLines.slice(0, at).join("\n") : scene.dialogueLocal },
    { dialogue: lines.slice(at).join("\n"), dialogueLocal: mirror ? localLines.slice(at).join("\n") : undefined },
  );
  return [...splitScene(a, depth + 1), ...splitScene(b, depth + 1)];
}

/**
 * Expand any scene whose speech overflows one clip (> SCENE_MAX_SECONDS at the natural pace) into
 * multiple consecutive same-location scenes. Pure; the caller renumbers the flat result.
 */
export function splitOverlongScenes(scenes: SceneScript[]): SceneScript[] {
  const out: SceneScript[] = [];
  for (const scene of scenes) out.push(...splitScene(scene, 0));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Stage 44 — WORLD / CAMERA frame-state helpers (match cut on action).
// ---------------------------------------------------------------------------------------------

/** Continuity links that start a fresh sequence (mirror of scene-prompt's SEQUENCE_BREAK_LINKS; kept local to avoid a circular import). */
const SEAM_BREAK_LINKS = ["location-change", "new-sequence"] as const;
export const seamBreaks = (continuesFrom?: string | null): boolean =>
  (SEAM_BREAK_LINKS as readonly string[]).includes((continuesFrom ?? "").trim().toLowerCase());

/**
 * Split a frame-state text into its WORLD and CAMERA blocks. Labels are matched case-insensitively at a
 * line start (or at the very start of the text). A state without labels is treated as all-WORLD with an
 * empty camera (legacy Stage 40–42 states).
 */
export function splitState(text: string | null | undefined): { world: string; camera: string } {
  const src = (text ?? "").trim();
  if (!src) return { world: "", camera: "" };
  const re = /(?:^|\n)\s*(WORLD|CAMERA)\s*:\s*/gi;
  const parts: { label: string; start: number; bodyStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) parts.push({ label: m[1].toUpperCase(), start: m.index, bodyStart: m.index + m[0].length });
  if (!parts.length) return { world: src, camera: "" };
  let world = "";
  let camera = "";
  // Text before the first label (rare) belongs to WORLD.
  const lead = src.slice(0, parts[0].start).trim();
  if (lead) world = lead;
  for (let i = 0; i < parts.length; i++) {
    const body = src.slice(parts[i].bodyStart, i + 1 < parts.length ? parts[i + 1].start : undefined).trim();
    if (!body) continue;
    if (parts[i].label === "CAMERA") camera = camera ? `${camera} ${body}` : body;
    else world = world ? `${world} ${body}` : body;
  }
  return { world, camera };
}

/** Reassemble a labelled state (camera block omitted when empty). */
export function joinState(world: string, camera: string): string {
  const w = world.trim();
  const c = camera.trim();
  return c ? `WORLD: ${w}\nCAMERA: ${c}` : `WORLD: ${w}`;
}

const normalizeCameraText = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Deterministic camera setups used when the LLM repeats the previous shot's framing on a continuous seam.
 * Each entry differs from every other in at least two of (scale, height, angle), so whichever one is
 * picked relative to the previous camera, the cut lands on a visibly new setup.
 */
export const CAMERA_VARIATION: readonly { scale: string; height: string; angle: string; text: string }[] = [
  { scale: "wide", height: "low", angle: "three-quarter", text: "Wide shot from a LOW camera height (knee level), three-quarter angle across the space — the characters full-figure, the floor plane large in the foreground, the far side of the location filling the background." },
  { scale: "medium", height: "high", angle: "profile", text: "Medium shot from a HIGH camera height looking down at a 30° tilt, from the side (profile to the characters) — the characters from the waist up with the surface they are using and the objects on it visible below them." },
  { scale: "full", height: "eye-level", angle: "from behind", text: "Full shot at EYE LEVEL from BEHIND the nearest character, over the shoulder into the space — the character's back in the left third, the other character and the depth of the location in the right two-thirds." },
  { scale: "medium close-up", height: "low", angle: "frontal", text: "Medium close-up from a LOW camera height, frontal to the character who is about to speak — head and shoulders with the wall / set dressing behind clearly visible, the other character soft in the far background." },
  { scale: "wide", height: "high", angle: "frontal", text: "Wide shot from a HIGH camera height (a top corner of the space), frontal to the characters — both full-figure small in the frame, the whole zone of the location laid out around them." },
  { scale: "medium", height: "eye-level", angle: "over-the-shoulder", text: "Medium over-the-shoulder shot at EYE LEVEL, angled 45° to the room — the near character's shoulder in the foreground, the far character mid-frame, the location's objects and depth behind." },
];

/** Crude classification of the previous camera text so the fallback setup differs in ≥2 of scale / height / angle. */
function cameraParams(text: string): { scale: string; height: string; angle: string } {
  const t = text.toLowerCase();
  const scale = /medium close-?up/.test(t) ? "medium close-up" : /\bmedium\b/.test(t) ? "medium" : /\bfull\b/.test(t) ? "full" : /\bwide\b/.test(t) ? "wide" : "";
  const height = /\blow\b/.test(t) ? "low" : /\bhigh\b|bird|overhead|top/.test(t) ? "high" : /eye[- ]level/.test(t) ? "eye-level" : "";
  const angle = /over[- ]the[- ]shoulder/.test(t) ? "over-the-shoulder" : /from behind|behind the/.test(t) ? "from behind" : /profile|from the side/.test(t) ? "profile" : /three[- ]quarter|45/.test(t) ? "three-quarter" : /frontal/.test(t) ? "frontal" : "";
  return { scale, height, angle };
}

/** Pick a CAMERA_VARIATION entry that differs from `prevCamera` in ≥2 parameters; `seed` rotates the choice. */
export function pickDifferentCamera(prevCamera: string, seed = 0): string {
  const prev = cameraParams(prevCamera);
  const n = CAMERA_VARIATION.length;
  for (let k = 0; k < n; k++) {
    const v = CAMERA_VARIATION[(seed + k) % n];
    const diff = (v.scale !== prev.scale ? 1 : 0) + (v.height !== prev.height ? 1 : 0) + (v.angle !== prev.angle ? 1 : 0);
    if (diff >= 2) return v.text;
  }
  return CAMERA_VARIATION[seed % n].text;
}

/** Fix what can be fixed mechanically (numbering, [VISUAL STYLE] / [CHARACTER] lines, duration clamp). */
export function normalizeEpisodeScript(script: EpisodeScript, characters?: CharacterCard[]): EpisodeScript {
  const repairPrompt = (s: SceneScript) => {
    let vp = s.videoPrompt.trim();
    if (!vp.includes("[VISUAL STYLE]")) vp = `[VISUAL STYLE]: ${script.visualIdentity}\n${vp}`;
    if (!vp.includes("[CHARACTER]") && characters?.length) {
      const visible = s.characters.map((n) => matchCharacter(characters, n)).filter((c): c is CharacterCard => !!c);
      const desc = (visible.length ? visible : []).map((c) => `${c.name} (${c.age}): ${c.appearance}`).join("; ");
      if (desc) {
        // Insert before [TRANSITION] when present, otherwise append.
        const idx = vp.indexOf("[TRANSITION]");
        vp = idx >= 0 ? `${vp.slice(0, idx)}[CHARACTER]: ${desc}\n${vp.slice(idx)}` : `${vp}\n[CHARACTER]: ${desc}`;
      }
    }
    return vp;
  };
  // Stage 27a: auto-split any over-long scene FIRST, then renumber the flat result contiguously (1..N)
  // and derive each piece's durationSec from its own (now-fitting) speech.
  // Stage 93 — an episode is a fixed EPISODE_SCENE_COUNT scenes; drop any extras the model emitted.
  const scenes = splitOverlongScenes(script.scenes).slice(0, EPISODE_SCENE_COUNT).map((s, i) => {
      // Stage 110 — narration scenes are no longer accepted from the model: a "narration" scene is treated as an
      // on-camera scene (its voiceover is dropped), so a silent one fails validation and triggers the retry.
      const narrationText = "";
      const isNarr = false;
      return {
      ...s,
      number: i + 1,
      // Stage 115 — take the script model's OWN clip length and clamp it into [5, 10]; missing → default.
      durationSec: clampSceneDuration(s.durationSec),
      dialogue: s.dialogue.trim() || "[NO DIALOGUE]",
      dialogueLocal: (s.dialogueLocal ?? "").trim() || undefined,
      // Stage 12 (Commit D) — normalize off-screen narration fields.
      sceneKind: isNarr ? "narration" : isActionKind(s.sceneKind) ? "action" : "dialogue",
      voiceover: isNarr ? narrationText : undefined,
      voiceoverLocal: isNarr ? ((s.voiceoverLocal ?? "").trim() || undefined) : undefined,
      videoPrompt: repairPrompt(s),
      // Stage 11 — carry continuity metadata through; scene 1 always starts a sequence.
      presence: (s.presence ?? "").trim() || undefined,
      entrances: (s.entrances ?? "").trim() || undefined,
      continuesFrom: (s.continuesFrom ?? "").trim() || (i === 0 ? "new-sequence" : undefined),
      // Stage 40 — scripted end state of the final frame (hand-off to the next scene).
      endState: (s.endState ?? "").trim(),
      // Stage 41 — scripted start state of the first frame (OPENING STATE of this scene's prompt).
      startState: (s.startState ?? "").trim(),
      };
    });
  // Stage 42/44 — deterministic frame hand-off as a MATCH CUT ON ACTION. On every continuous seam
  // (continuesFrom is not location-change / new-sequence) the WORLD block of scene N+1's startState is
  // scene N's endState WORLD verbatim (same instant of the same action, same place, same light), while
  // the CAMERA block is the LLM's own opening camera — unless it repeats the previous end camera (or is
  // missing while the previous has one), in which case a deterministic different setup is picked from
  // CAMERA_VARIATION. Legacy states without labels (both sides) keep the old behaviour: whole text copied.
  // Location-change / new-sequence scenes keep their own startState. Chain mode is unaffected
  // (resolveOpeningState still prefers previous.endStateActual there).
  for (let i = 1; i < scenes.length; i++) {
    const prev = scenes[i - 1];
    const cur = scenes[i];
    if (seamBreaks(cur.continuesFrom)) continue;
    // Stage 44 — identical location text on a continuous seam (the place cannot change between frames).
    if ((prev.locationDesc ?? "").trim()) cur.locationDesc = prev.locationDesc;
    const prevEnd = (prev.endState ?? "").trim();
    if (!prevEnd) continue;
    const pe = splitState(prevEnd);
    const cs = splitState(cur.startState ?? "");
    if (!pe.camera && !cs.camera) {
      // Legacy monolithic states — behave exactly like Stage 42 (verbatim copy).
      cur.startState = prevEnd;
      continue;
    }
    let camera = cs.camera;
    if (!camera || normalizeCameraText(camera) === normalizeCameraText(pe.camera)) camera = pickDifferentCamera(pe.camera, i);
    cur.startState = joinState(pe.world, camera);
  }
  // Stage 115 — clamp each scene's own (variable 5–10 s) duration and trim the longest clips only if the
  // whole episode would exceed the 90 s ceiling. Valid model-supplied lengths are preserved (no forcing).
  applyFixedSceneDurations(scenes);
  return { ...script, scenes } as EpisodeScript;
}

/** Stage 45 — sum of scene durations (missing durationSec counts as the model maximum, like the UI does). */
export function episodeTotalSeconds(scenes: Array<{ durationSec?: number | null }>): number {
  return scenes.reduce((acc, s) => acc + (s.durationSec ?? SCENE_MAX_SECONDS), 0);
}

/** The shortest a scene may be: its speech at the natural pace + a beat, never under the clip minimum. */
function sceneFloorSeconds(sc: { sceneKind?: string | null; dialogue: string; voiceover?: string | null }): number {
  const spoken = sc.sceneKind === "narration" ? (sc.voiceover ?? "") : sc.dialogue;
  const words = spokenWordCount(spoken);
  return Math.min(SCENE_MAX_SECONDS, Math.max(SCENE_MIN_SECONDS, words > 0 ? Math.ceil(words / NATURAL_WORDS_PER_SEC) + 2 : 0));
}

/**
 * Stage 45 — enforce the running-time budget IN PLACE: every scene ≤ SCENE_MAX_SECONDS, and if the episode
 * total exceeds EPISODE_MAX_TOTAL_SECONDS the scenes are scaled down proportionally — but never below the
 * speech floor (ceil(words / 2.1) + 2) or the clip minimum, so no line is ever cut off. Returns the final total;
 * a total still above the budget is reported by validateEpisodeScript as a soft problem.
 */
export function fitEpisodeDuration(scenes: Array<{ durationSec: number; sceneKind?: string | null; dialogue: string; voiceover?: string | null }>): number {
  for (const sc of scenes) sc.durationSec = Math.min(SCENE_MAX_SECONDS, Math.max(1, Math.round(sc.durationSec)));
  let total = episodeTotalSeconds(scenes);
  if (total <= EPISODE_MAX_TOTAL_SECONDS) return total;
  const floors = scenes.map(sceneFloorSeconds);
  const floorTotal = floors.reduce((a, b) => a + b, 0);
  if (floorTotal >= EPISODE_MAX_TOTAL_SECONDS) {
    // Even the floors overflow: everything sits at its floor (the soft problem tells the author to cut scenes).
    scenes.forEach((sc, i) => { sc.durationSec = Math.min(sc.durationSec, floors[i]); });
    return episodeTotalSeconds(scenes);
  }
  // Shrink the slack above the floors proportionally so that the total lands on the budget.
  const slack = scenes.map((sc, i) => Math.max(0, sc.durationSec - floors[i]));
  const slackTotal = slack.reduce((a, b) => a + b, 0) || 1;
  const keep = (EPISODE_MAX_TOTAL_SECONDS - floorTotal) / slackTotal;
  scenes.forEach((sc, i) => { sc.durationSec = Math.min(sc.durationSec, floors[i] + Math.floor(slack[i] * keep)); });
  total = episodeTotalSeconds(scenes);
  // Rounding left a few seconds: hand them back one at a time, to the scenes that gave up the most.
  let spare = EPISODE_MAX_TOTAL_SECONDS - total;
  const order = scenes.map((_, i) => i).sort((a, b) => slack[b] - slack[a]);
  for (const i of order) {
    if (spare <= 0) break;
    if (scenes[i].durationSec < SCENE_MAX_SECONDS) { scenes[i].durationSec += 1; spare -= 1; }
  }
  return episodeTotalSeconds(scenes);
}

// ---------------------------------------------------------------------------------------------
// Speech language guard. Seedance voices `dialogue`, which MUST be English; `dialogueLocal` is the
// story-language text for UI / subtitles. gpt-4o regularly swaps the two for non-Latin stories
// (Russian lines land in "dialogue"). Fix mechanically (swap) and, if there is still no English,
// translate with a separate cheap LLM call (see `ensureEnglishDialogue`).
// ---------------------------------------------------------------------------------------------
const NON_LATIN_RE = /[\u0400-\u04FF\u0370-\u03FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;

/** Spoken text only (speaker names / tone cues like `МАРИНА (тихо):` are stripped from every line). */
export function spokenText(dialogue: string): string {
  return dialogue
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[^:"«»]{1,80}(\([^)]*\))?\s*:\s*/, ""))
    .join(" ")
    .trim();
}

/** True when the spoken part of the dialogue is (Latin-script) English — or the scene is silent. */
export function isEnglishDialogue(dialogue: string): boolean {
  const t = spokenText(dialogue);
  if (!t || /\[NO DIALOGUE\]/i.test(dialogue)) return true;
  return !NON_LATIN_RE.test(t) && /[A-Za-z]{2}/.test(t);
}

/** Swap `dialogue` ↔ `dialogueLocal` where the model put the English lines into the local field. */
export function fixDialogueLanguages(script: EpisodeScript): EpisodeScript {
  return {
    ...script,
    scenes: script.scenes.map((s) => {
      if (isEnglishDialogue(s.dialogue) || !s.dialogueLocal || !isEnglishDialogue(s.dialogueLocal)) return s;
      return { ...s, dialogue: s.dialogueLocal, dialogueLocal: s.dialogue };
    }),
  };
}

/** Numbers of scenes whose spoken lines are still not English (after `fixDialogueLanguages`). */
export function nonEnglishScenes(script: EpisodeScript): number[] {
  return script.scenes.filter((s) => !isEnglishDialogue(s.dialogue)).map((s) => s.number);
}

export const translateDialogueSchema = z.object({ scenes: z.array(z.object({ number: z.number().int(), dialogue: z.string() })) });
export const TRANSLATE_DIALOGUE_SYSTEM = `You translate screenplay dialogue into natural spoken ENGLISH for an AI video model that voices the lines. Keep the exact line structure: one line per row, NAME (tone cue): "line" — speaker names and tone cues stay as given, only the quoted lines are translated. Do not add, drop or merge lines. Return STRICT JSON: {"scenes": [{"number": int, "dialogue": string}]}.`;

/**
 * Guarantees English speech: swaps swapped fields, then translates the remaining non-English scenes via
 * `chat` (a chatJSON-like function, injected so lib/season.ts stays free of the OpenAI client for tests).
 * The original story-language lines are kept as `dialogueLocal` for UI / subtitles. Duration is re-estimated
 * from the English words. Never throws: on a failed translation the script is returned as-is (logged).
 */
export async function ensureEnglishDialogue(
  script: EpisodeScript,
  chat: (system: string, user: string, opts?: { temperature?: number; maxTokens?: number }) => Promise<unknown>
): Promise<EpisodeScript> {
  const fixed = fixDialogueLanguages(script);
  const missing = nonEnglishScenes(fixed);
  if (!missing.length) return fixed;
  try {
    const payload = { scenes: fixed.scenes.filter((s) => missing.includes(s.number)).map((s) => ({ number: s.number, dialogue: s.dialogue })) };
    const raw = translateDialogueSchema.parse(await chat(TRANSLATE_DIALOGUE_SYSTEM, JSON.stringify(payload), { temperature: 0.2, maxTokens: 6000 }));
    const en = new Map(raw.scenes.map((s) => [s.number, s.dialogue.trim()]));
    return {
      ...fixed,
      scenes: fixed.scenes.map((s) => {
        const t = en.get(s.number);
        if (!t || !isEnglishDialogue(t)) return s;
        return { ...s, dialogue: t, dialogueLocal: s.dialogueLocal && isEnglishDialogue(s.dialogueLocal) ? s.dialogue : (s.dialogueLocal ?? s.dialogue), durationSec: clampSceneDuration(s.durationSec) };
      }),
    };
  } catch (err) {
    console.error("[season] dialogue translation failed:", err);
    return fixed;
  }
}

function langName(language: IdeaLanguage) {
  return LANGUAGE_NAMES[language] ?? "English";
}
const TIER_ORDER: Record<string, number> = { MAIN: 0, SUPPORTING: 1, MINOR: 2, CROWD: 3 };
function charactersBlock(characters: CharacterCard[]) {
  return [...characters]
    .sort((a, b) => (TIER_ORDER[a.tier ?? "MAIN"] ?? 0) - (TIER_ORDER[b.tier ?? "MAIN"] ?? 0))
    .map((c) => `- ${c.name} [${c.tier ?? "MAIN"}${c.tier === "CROWD" && c.groupSize ? `, group of ${c.groupSize}` : ""}] (${c.role}, ${c.age}); first appears: ${c.firstAppearance}\n  Personality: ${c.personality}\n  Appearance: ${c.appearance}`)
    .join("\n");
}
export type LocationRef = { name: string; description?: string | null; visualPrompt?: string | null; setInventory?: string | null };
/** Stage 113 — DB text (one "object — placement" per line) → clean entries; [] for legacy rows. */
export function locationInventoryEntries(setInventory: string[] | string | null | undefined): string[] {
  const raw = Array.isArray(setInventory) ? setInventory : typeof setInventory === "string" ? setInventory.split(/\r?\n/) : [];
  return raw.map((e) => (e ?? "").replace(/\s+/g, " ").trim()).filter(Boolean);
}
function locationsBlock(locations: LocationRef[]) {
  return locations
    .map((l) => {
      const inv = locationInventoryEntries(l.setInventory);
      return `- ${l.name}: ${l.description ?? ""}${l.visualPrompt ? ` / ${l.visualPrompt}` : ""}${inv.length ? `\n  SET INVENTORY: ${inv.join("; ")}` : ""}`;
    })
    .join("\n");
}
/**
 * Stage 113 — the episode-script prompt block for the episode location's set inventory. Empty for legacy
 * locations without an inventory (then the script is written exactly as before Stage 113).
 */
export function locationInventoryBlock(setInventory: string[] | string | null | undefined): string {
  const inv = locationInventoryEntries(setInventory);
  if (!inv.length) return "";
  return `\nLOCATION SET INVENTORY (the ONLY physical objects that exist in this place — these are already drawn on the location references at exactly these positions; the scenes' action, blocking and props use ONLY these objects with this placement, and each scene lists the ones in frame / used in its "set" field):\n${inv.map((e) => `- ${e}`).join("\n")}`;
}
/**
 * Stage 113 — soft check: inventory object names (the part before " — ") that the scenes' "set" lines mention
 * versus objects mentioned in "set" that are NOT in the inventory. Returns human-readable warnings; never throws.
 */
export function checkSceneSetInventory(scenes: { number: number; set?: string | null }[], setInventory: string[] | string | null | undefined): string[] {
  const inv = locationInventoryEntries(setInventory);
  if (!inv.length) return [];
  const objects = inv.map((e) => e.split(/\s+[—–-]\s+/)[0].toLowerCase().trim()).filter(Boolean);
  const warnings: string[] = [];
  for (const sc of scenes) {
    const set = (sc.set ?? "").trim();
    if (!set) continue;
    const body = set.replace(/^SET:\s*/i, "").replace(/^[^—–-]*[—–-]\s*/, "");
    const mentioned = body.split(/;|,|\band\b/).map((m) => m.split(/\s+[—–-]\s+/)[0].toLowerCase().trim()).filter((m) => m.length > 2);
    const unknown = mentioned.filter((m) => !objects.some((o) => o.includes(m) || m.includes(o) || o.split(" ").some((w) => w.length > 3 && m.includes(w))));
    if (unknown.length) warnings.push(`scene ${sc.number}: "set" mentions objects not in the location inventory: ${unknown.join(", ")}`);
  }
  return warnings;
}
/** Resolve an LLM location name to a project Location (same fuzzy rule as matchCharacter). */
export function matchLocation<T extends { name: string }>(locations: T[], raw: string): T | undefined {
  return matchCharacter(locations, raw);
}

/** Definition of "locationDetail" shared by the season structure / revise prompts. */
export const LOCATION_DETAIL_RULE =
  '"locationDetail" is the level of VISUAL DETAILING the shooting of that location needs — i.e. how many distinct camera setups the place must be photographed from for reference. Judge it by: (1) the number of distinct zones / sub-areas the characters actually use, (2) the density of props and objects that must stay consistent between shots, (3) the complexity of staging (fights, chases, many characters moving through the space → high), and (4) how many scenes of the season happen there. It is NOT about physical size: a huge empty desert or an open field is "low"; an ordinary room used for a conversation is "medium"; a small cluttered workshop where a fight happens, or a market/tavern used across many episodes, is "high". When the same location appears in several episodes, give it the same (highest needed) level every time.';

/** Stage 46A — shared PACING rule: a season is a slow-burning TV drama, not a compressed short. */
export const PACING_RULE =
  "PACING (slow burn, like an hour-long TV drama): the story moves only SLIGHTLY faster than a one-hour television drama — NEVER like a compressed short film. Characters do NOT get acquainted, fall in love, become allies or turn into enemies within ONE episode — relationships are built over SEVERAL episodes through repeated meetings, doubts and small steps. Each episode contains EXACTLY ONE major plot turn (plus a few small beats around it) and ends on its cliffhanger; it is FORBIDDEN to compress what would naturally be two episodes into one — if the material overflows, leave it for the next episode. Episode 1 is EXPOSITION ONLY: it introduces the world and the characters and lands ONE inciting conflict — no resolutions, no alliances, no romance yet. Spread the arc EVENLY across ALL episodes: the first third of the season must not rush ahead of the rest.";

export function seasonStructureSystemPrompt(language: IdeaLanguage, episodeCount = SEASON_DEFAULT_EPISODES): string {
  return `You are a showrunner planning ONE season of a short-form vertical drama series (9:16 video, each episode = a piece of up to ${EPISODE_TOTAL_LABEL} (at most ${EPISODE_MAX_TOTAL_SECONDS} s), later shot as ${EPISODE_SCENE_COUNT} short clips of ${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS} s each). At THIS planning stage you describe each episode as ONE detailed, continuous synopsis ending on a cliffhanger — NOT a shot-by-shot list and NOT split into timed halves; the full ${EPISODE_SCENE_COUNT}-clip shooting script is written later from this synopsis.
- EPISODE SHAPE (a single continuous synopsis, ${EPISODE_TOTAL_LABEL}): tell the whole episode in order as one flowing account — the set-up (it carries the episode's continuation straight out of the previous episode's cliffhanger; episode 1: the season opening), the development, ONE concrete central dramatic turn, and how it ends on this episode's cliffhanger. No subplots, no montage, no shot/beat/timing division.
- ${EPISODE_SYNOPSIS_RULE}
Return STRICT JSON: {"title": string, "logline": string, "episodes": [{"number": int, "title": string, "logline": string, "locationName": string, "locationDesc": string, "locationDetail": "low"|"medium"|"high", "characters": [names], "arcRole": "завязка"|"развитие"|"поворот"|"финал", "cliffhanger": string, "description": string (a detailed continuous episode synopsis in prose, ~4–7 sentences, then a final "CLIFFHANGER: ..." line — NO shot/beat split, NO timings)}]}.
RULES:
- NUMBER OF EPISODES: produce EXACTLY ${episodeCount} episodes — no more, no fewer — numbered 1..${episodeCount} contiguously. This count is set by the producer; do NOT change it, do NOT pad and do NOT compress the story into a different number.
- DRAMATURGY across the whole season (spread these four acts over the ${episodeCount} episodes, in order): ВСТУПЛЕНИЕ → ЗАВЯЗКА → КУЛЬМИНАЦИЯ → РАЗВЯЗКА.
  • ВСТУПЛЕНИЕ (episode 1, arcRole "завязка"): expose the world and the main characters through ONE concrete on-camera situation (the "description" is pure on-camera action, no backstory retelling). Introduce the central want and the first disturbance.
  • ЗАВЯЗКА → развитие (early-middle episodes, arcRole "развитие"): rising action — the conflict escalates step by step, stakes grow, complications and reversals ("поворот") appear, at least one strong поворот in the second half.
  • КУЛЬМИНАЦИЯ (the episode just before the finale, or the finale's first half — mark it arcRole "поворот"): the highest-tension confrontation the whole season built toward — the decisive clash where everything is on the line.
  • РАЗВЯЗКА (the LAST episode, arcRole "финал"): the aftermath and resolution — consequences land, the main dramatic question is answered, threads close (a final hook is allowed but the arc resolves).
  Distribute these beats proportionally to ${episodeCount}: the more episodes, the more развитие episodes between завязка and the кульминация; with few episodes, compress развитие but NEVER drop вступление, кульминация or развязка.
- ${PACING_RULE} Give every one of the ${episodeCount} episodes a comparable share of the story: ONE major turn per episode, evenly distributed — never spend the whole plot in the first third and pad the rest.
- Each episode has ONE key location. "locationName" MUST be one of the given LOCATIONS, copied verbatim (they already have reference images). Only if the story truly needs a place that is not in the list may you invent a new one (then give it a new name) — at most 2 new locations per season. "locationDesc" is a DETAILED English visual description (2–4 sentences: architecture, materials, textures, props, weather, light, color palette, time of day) usable verbatim by an image/video model — for a listed location, expand its given description. "locationName" is in ${langName(language)}.
- ${LOCATION_DETAIL_RULE}
- Use ONLY the given character names (verbatim; a CROWD group name counts as a character). Every episode lists 2–6 characters actually present: the MAIN characters carrying it plus the SUPPORTING characters (family, colleagues, rivals) involved. Across the season EVERY SUPPORTING character appears in at least one episode, MINOR characters and CROWD groups are used where the story plausibly gathers people (family dinners, workplaces, hospitals, streets, court, celebrations).
- "logline" is ONE sentence (who wants what, what goes wrong); the events themselves live in the detailed "description". "cliffhanger" = the CLIFFHANGER line — a concrete final IMAGE that forces the viewer into the next episode. No summaries like "tension rises".
- CLIFFHANGER CHAIN (each episode's synopsis opens on the previous episode's cliffhanger): episode 1 opens the season; every later episode's description MUST OPEN by picking up DIRECTLY from where the immediately preceding episode ended — the same moment, same place, the same unresolved situation of that episode's cliffhanger — and only then advance. The opening of episode N+1 = the direct consequence/continuation of episode N's cliffhanger: no time-skips, no resets, no re-introducing the premise that would drop the thread. The chain of cliffhanger → next episode's opening stays UNBROKEN across all ${episodeCount} episodes; consequences carry over episode to episode and nothing repeats.
- ${CREATIVE_RULE}
- ${MODERATION_SAFE_RULE}
- Locations are LARGE, LIVING spaces to be used physically: describe in "locationDesc" a place with several distinct zones the characters move between and the concrete objects, furniture, surfaces and corners they interact with, plus the natural background life of the place (who else is around, what moves, the weather) so it never reads as a flat backdrop. Pick VARIED key locations across the season — interiors and exteriors, private and public, different scales and times of day.
- All text except "locationDesc" is in ${langName(language)}. Character names stay exactly as given (Western names in Latin letters). Original content: never reuse names, plots or lines of existing films/series.`;
}
export function seasonStructureUserPrompt(synopsis: string, characters: CharacterCard[], locations: LocationRef[] = [], shortSynopsis?: string | null): string {
  // Stage 46A: the author-approved short synopsis is a MANDATORY outline — the structure must follow its
  // episode loglines one-to-one (same order, same events), only expanding them into full episodes.
  const outline = shortSynopsis?.trim()
    ? `APPROVED SHORT SYNOPSIS (MANDATORY OUTLINE — the author signed this off: keep the premise and make episode N of the structure expand logline N exactly, same order, same central events; do not merge, reorder or replace episodes):\n${shortSynopsis.trim()}\n\n`
    : "";
  return `${outline}SYNOPSIS:\n${synopsis}\n\nCHARACTERS (with tiers):\n${charactersBlock(characters)}\n\nLOCATIONS (use these names verbatim):\n${locations.length ? locationsBlock(locations) : "(none defined — invent 8–14 diverse locations and reuse them across episodes)"}`;
}

export function episodeScriptSystemPrompt(language: IdeaLanguage, episodeNumber = 1): string {
  const L = langName(language);
  const local = language !== "en";
  const isFirst = episodeNumber <= 1;
  // Stage 110 — NO narrator / "previously on" scenes any more: EVERY scene of EVERY episode is on-camera
  // talking (or an action scene with lines in the pauses). The former R7 (narration scene 1) is removed.
  void isFirst;
  return `You are a film director + cinematographer writing the FULL shooting script of ONE episode (EPISODE ${episodeNumber}) of a short-form VERTICAL drama (9:16). The episode is EXACTLY ${EPISODE_SCENE_COUNT} consecutive shots ("scenes"): every scene is a short clip whose length is VARIABLE (${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS} s) — each clip lasts only as long as its own action and lines really take, never padded — so that ALL ${EPISODE_SCENE_COUNT} of them together run UP TO ${EPISODE_TOTAL_LABEL} (the sum of durationSec must stay at or under ${EPISODE_MAX_TOTAL_SECONDS} s; it need not reach it). The FIRST few scenes are the set-up that continues the previous episode's cliffhanger (episode 1: the season opening); the conflict escalates across the ${EPISODE_SCENE_COUNT} scenes and the LAST scene ends on this episode's cliffhanger. The clips are generated by an AI video model WITH native speech: characters really speak their lines out loud, so the DIALOGUE IS THE PRODUCT. A scene without dialogue is a wasted shot — there are NO narrator scenes, NO voice-over-only scenes, NO "previously on" recaps: EVERY scene (scene 1 included) has characters talking ON CAMERA.

${DIRECTING_RULES}

Return STRICT JSON: {"visualIdentity": string, "scenes": [{"number": int, "shotType": string, "durationSec": int, "locationDesc": string, "characters": [names], "action": string, "sceneKind": "dialogue"|"action", "dialogue": string${local ? ', "dialogueLocal": string' : ""}, "videoPrompt": string, "presence": string, "entrances": string, "continuesFrom": string, "startState": string, "endState": string}]}.
SCENE KINDS ("sceneKind"): "dialogue" = an on-camera talking scene (the default for most scenes); "action" = a FIGHT / DUEL / CHASE / physical struggle — REQUIRED whenever the beat is a physical confrontation. An action scene is written as combat choreography (see R9) and STILL carries spoken English lines (1–2 short lines in the pauses between impacts) — no scene of any kind is silent. There is NO narration kind: never write an off-screen narrator, a voice-over-only scene or a recap.

HARD RULES (the script is REJECTED automatically if any is broken):
R1. RUNNING-TIME BUDGET (VARIABLE-LENGTH SHOTS): the episode is EXACTLY ${EPISODE_SCENE_COUNT} scenes. ${CLIP_LENGTH_RULE} Keep the lines you write matched to each clip's length — one short line or a quick 1–2-line exchange per clip; never cram a long speech into one clip, and never stretch a short beat. All scenes happen in/around the episode's key location; scene 1 may open on a wide shot but someone is ALREADY talking in it from the first second.
R1b. ${MULTI_CLIP_DIALOGUE_RULE}
R2. NO SILENT SCENES: every one of the ${EPISODE_SCENE_COUNT} scenes contains a real spoken exchange between named characters ON CAMERA (max silent scenes = ${MAX_SILENT_SCENES}). "[NO DIALOGUE]", an empty "dialogue", a narrator, a voice-over-only scene or a "previously on" recap are all REJECTED.
R8. ${ONE_LOCATION_RULE}
R10. START / END STATE — MATCH CUT ON ACTION: ${END_STATE_RULE} ${START_STATE_RULE} In short: on every continuous seam the WORLD is the same and the CAMERA is new — scene N+1 opens on the SAME instant of the SAME action as scene N's final frame, seen from a DIFFERENT angle / shot scale / height, exactly like an editor cutting between two cameras on one continuous take. Repeating the previous framing is an error; changing the place, light, wardrobe, props or the phase of the movement across a continuous seam is an error. Dialogue never straddles a cut: a line may end right on the cut but is never split across two scenes, and the next scene begins with a fresh line; nobody falls silent or freezes before the cut.
R11. ${PACING_RULE} This episode dramatises ONLY its own logline — one major turn, then the cliffhanger; do not borrow events from the next episodes' loglines.${isFirst ? " As EPISODE 1 it is pure exposition: meet the world and the people, land the single inciting conflict, nothing more." : ""}
R9. ACTION SCENES: whenever the beat is a fight, duel, chase, ambush or any physical struggle — including anything the logline promises (a battle, an attack, a monster / creature / pack assault, a duel, a chase) — the scene MUST have "sceneKind": "action" and the confrontation ACTUALLY HAPPENS on screen; it is never merely a conversation ABOUT fighting. Its "action" text and its videoPrompt are written as combat choreography, applying this rule INSTEAD of the talking-scene STAGING / FRAMING wording: ${ACTION_STAGING_RULE} The "action" field of a fight scene names the REAL MECHANICS beat by beat — who strikes / lunges / throws / grabs and who dodges / blocks / is hit and falls, with visible CONTACT and IMPACT — never a vague "they fight", "they battle" or "they clash"; and when the opponent is a creature / monster / pack, that creature is an ACTIVE attacker in direct contact with the hero (lunging, swiping, surrounding), never a backdrop. An action scene carries 1–2 SHORT English lines (never "[NO DIALOGUE]"), spoken in the pauses between impacts — a taunt, a warning, a shouted name, a demand; the R3 sentence minimum does not apply to it, but it is never silent.
R3. A talking scene = a SHORT but SUBSTANTIVE beat of ${TALK_MIN_SENTENCES}–${TALK_MAX_SENTENCES} full sentences (1 short line or a quick 1–2-line exchange) where the story is told THROUGH the dialogue (a decision, an accusation, a confession, a piece of information, subtext). Match the amount of speech to the clip's real length (${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS} s): a single short line fills a ${SCENE_MIN_SECONDS}–7 s clip, a two-line exchange a fuller one — never cram a long speech in, and set "durationSec" to how long the line(s) plus their visible action actually take. A longer conversation is NOT forced into one scene: split it across consecutive scenes (see R1b), one line or short exchange per clip with a camera cut between them. Monologue or voice-over does NOT replace dialogue — when two people are in the shot they talk to each other; a lone character may talk on the phone or to someone off-screen. A weak, throwaway one-liner with no dramatic content is REJECTED — even a single line must carry a real story beat. One line per row, format: NAME (tone cue): "line". Tone cues like (sharply), (whispering), (holding back tears).
    "dialogue" is STRICTLY in ENGLISH (Latin letters only — not one ${L === "English" ? "foreign" : L} word) with the project's ENGLISH character names as speaker labels, exactly as given in the cast — it is what the video model voices, and a "dialogue" containing any non-English text or an unknown speaker name is REJECTED.${local ? ` "dialogueLocal" is the same lines translated into ${L}, same line structure and cues (shown to the author as the script text).` : ""}
    Example of a correct talking scene (a quick 2-line exchange):
    ANNA (sharply): "You sent the boat knowing he wouldn't come back."
    VICTOR (not looking at her): "I sent it to save the others, and you know it."
R4. "videoPrompt" and "visualIdentity" are ENTIRELY in ENGLISH (every one of the 9 lines — never ${L}, even though locationDesc/action are in ${L}). "videoPrompt" consists of EXACTLY these 9 lines, each on its own row, in this order, each starting with its bracket tag:
    [SHOT TYPE]: the CUT LIST inside the short clip — 1–2 hard cuts built AROUND the characters, e.g. "0–5s medium-close over-the-shoulder on Anna at the bench as she speaks, the deep room behind her → 5–10s medium reverse on the reactor, pushing to a close-up on the line that lands"; the base shot keeps the character LARGE (medium / medium-close / over-the-shoulder on the speaker and the reactor) with the location reading as context behind, and a face CLOSE-UP is used on an emotional beat (a reaction, a decision, a line that lands); on a continuous seam use a shot scale / angle / height DIFFERENT from the previous scene's final camera (the same action, a new camera); use a WIDE/ESTABLISHING beat ONLY when the scene needs it (a new or changed location, an entrance / exit, showing how people are arranged, or the geography of a move); keep real depth behind the characters (foreground → characters → deep background); vertical 9:16; the characters are placed NATURALLY in the space (different distances/heights, seated/standing, along a counter or rail, one crossing while the other stays) — never squared off face to face; NO slow pans, NO lingering, NO slow motion
    [VISUAL STYLE]: the short visualIdentity sentence — the SAME text in every scene
    [LIGHTING]: time of day, light sources, weather — IDENTICAL wording in every scene of the episode (the whole episode is one continuous time; the location references lock the light, only the camera angle changes)
    [BLOCKING]: where each character stands and MOVES across the location as they talk — the concrete objects, surfaces and ZONES they use and travel between (rises from the crate and crosses to the window, leans on the counter then walks to the door); the first beat continues the movement described in startState WORLD (a match cut on action — the same gesture / step carried on, not restarted), and the characters are physically INSIDE the place interacting with its surfaces and objects — a flat backdrop with figures in front of it is an ERROR; EACH speaker gets a specific piece of ordinary business tied to those objects (pours a drink, sorts papers, checks a phone), and DIFFERENT zones of the place are used, not one spot
    [GAZE]: where each character looks, eye contact and reaction while the other speaks
    [NON-VERBAL]: EXPRESSIVE acting + micro-actions — concrete facial expressions and charged looks (smirks, glares with fury, narrows the eyes), lively hand gestures, breathing, emotional nuance (a catch in the voice, a quiet bitter laugh, controlled intensity), PLUS the physical business each speaker is doing; dramatic physical REACTIONS are allowed when the beat calls for it (raises a hand, swings, grabs by the collar, shoves, recoils from a blow) — stage hard contact in beats without that speaker's spoken line so the lip-sync stays intact
    [ACTION]: DETAILED choreography of the whole clip (its real length, ${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS} s) written as ONE continuous beat of unbroken motion that keeps going until the clip cuts — the action ENDS the clip (it does not finish early and hold on a frozen pose, a held stare or characters standing still waiting for the cut) (1–2 sentences, concrete verbs, not moods): the CONCRETE physical action the beat requires — the leads moving THROUGH the location and handling objects in the foreground, who crosses where, who turns, sits, rises, grabs what, on which line; AND, when the story calls for it, the real dramatic / physical beats (advances with measured steps, strides in, spins around, swings, strikes the chest, shoves, grabs by the collar, draws or throws a weapon such as a spear or knife, a blow lands, someone falls); AND believable SECONDARY background life making the place alive (passers-by, others at work, vehicles, animals, machines, weather). This is the line the video model animates from, so it must be specific enough to shoot without guessing
    [CHARACTER]: for EVERY visible character: name, age, hair, skin, build, EXACT clothing for this episode — identical word for word in every scene of the episode
    [TRANSITION]: a hard cut into the next shot (no fades, no pauses)
    The [CHARACTER] line is MANDATORY in every scene. Never put spoken text into the videoPrompt. Never use the words "slowly", "slow motion", "lingering", "long pause".

STYLE RULES:
S1. ${PACE_DIRECTION}
S2. SPEAKER FRAMING: talking scenes are built AROUND the characters — the base cut is a Medium / Medium-close / Over-the-shoulder on the speaker and the reactor, the character large in frame with the location as context behind; a face CLOSE-UP is allowed and encouraged on an emotional beat (a reaction, a decision, a line that lands). The speaker's face does NOT have to be visible on every line — the staging decides (profile, over the shoulder, from behind are all fine). A Wide / two-shot / establishing shot is used only when the scene needs it (a new or changed location, an entrance / exit, showing arrangement or the geography of a move), not as the default. Never two characters squared off face to face — stage them naturally in the location (different distances/heights, seated/standing, along a counter or rail, one moving while the other stays).
S7. ${MODERATION_SAFE_RULE}
S8. ${CREATIVE_RULE}
S9. ${LOCATION_PRESENCE_RULE}
S10. ${SCALE_DEPTH_RULE}
S11. ${EVERYDAY_BEHAVIOR_RULE}
S12. DYNAMIC TEXT: the episode ALTERNATES between talk-driven beats and active, physical beats — never a run of static conversations. Every scene carries an EVENT that moves the plot (a decision, a discovery, an arrival, a reversal) and combines DIALOGUE WITH ACTION so the script reads lively and cinematic, not like talking heads. The "action" line names a concrete physical EVENT happening in the scene, not a mood — and when the story has reached that point it names the real dramatic beat too (a collision, a strike, a shove, someone drawing or throwing a weapon, a blow landing, someone falling). MANDATORY: when this episode's logline (or the season arc at this point) promises a battle, a duel, an attack, a chase or any physical confrontation, the episode MUST contain at least one "sceneKind": "action" scene in which that confrontation ACTUALLY HAPPENS on screen, staged per R9 — it is never only talked about, threatened or reported afterwards. ${CONFRONTATION_STAGING_SENTENCE}
S13. ${CONTINUITY_RULE}
    Write the whole episode as ONE unbroken chain: read your previous scene's ending before you write the next scene, and open the next scene from exactly that state. For EVERY scene ALSO fill three short ENGLISH continuity fields (outside the videoPrompt):
    - "presence": who is on screen and WHERE at the very start of this scene, carried over from how the previous scene ended (e.g. "Anna still at the workbench where scene 2 left her, Victor just having entered from the yard"). For scene 1, describe the opening arrangement.
    - "entrances": who ENTERS or LEAVES during this scene and HOW it is shown (e.g. "Victor crosses from the door to the bench; Marco steps out into the corridor"), or "none" if the cast in frame does not change.
    - "continuesFrom": ONE of "same-location-continuation" (same spot, characters carry on) | "character-moves" (a character walks to a new zone / another character) | "location-change" (the action moves to a new place, shown by someone travelling there) | "new-sequence" (a deliberate time/place jump — use rarely, and still motivate it). Scene 1 = "new-sequence". DEFAULT to "same-location-continuation" whenever the next scene stays in the SAME key location and picks up from the same moment (which is the normal case, since every episode has ONE key location): the previous scene's real last frame is then handed to this scene as its opening reference. Use "location-change" or "new-sequence" ONLY when the story ACTUALLY shows the characters travelling to a different place or a deliberate time jump — never for a mere camera move, a new shot angle or a change of who is talking within the same location, because that would needlessly drop the carried-over frame.
    The [BLOCKING], [ACTION] and [TRANSITION] lines of the videoPrompt must MATCH these fields — showing the entrances, exits and moves — so characters never appear or disappear between shots.
S3. "locationDesc": "INT/EXT — place — time of day" in ${L}. "action" (3–4 sentences, DETAILED choreography of the whole clip at its real length (${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS} s) written as ONE continuous beat of unbroken motion that runs until the cut — the action ENDS the clip and never finishes early into a frozen pose or a held stare; what each character physically does while each line is spoken) in ${L} — VIVID, concrete staging written with action verbs, not moods: the characters' movement (идёт медленным шагом, разворачивается, бросается вперёд), their gazes and expressions (смотрит с ухмылкой, смотрит с яростью, прищуривается), and — when the story has reached that point — the real physical / dramatic beats the scene needs (замахнулась, ударила в грудь, толкнула, схватила за ворот, кидает копьё, выхватывает нож, удар достигает цели, кто-то падает). Describe exactly what happens, physically, beat by beat.
S4. "visualIdentity": ONE SHORT English sentence (max 25 words) — photoreal live-action look, color palette, lens/grain feel of this episode. Keep it short: it is repeated in every scene.
S5. Use ONLY the given character names (Western names, Latin letters, exactly as given). "characters" lists the names visible in the shot (a CROWD group name is listed when the group is in frame). SUPPORTING and MINOR characters present in the episode must actually speak in at least one scene each; crowds may have a short collective line or reactions.
S6. Dramatize ONLY this episode's logline — a natural continuation of the previous episodes, ending on this episode's cliffhanger (the last scene IS the cliffhanger). Original content only: never reuse names, plots or lines of existing films/series.
S14. SET INVENTORY (when the user prompt gives a LOCATION SET INVENTORY): those entries are the ONLY physical objects that exist in this location — they are already drawn on the location reference images at exactly the listed positions. The "action", [BLOCKING], [ACTION] and props of every scene use ONLY objects from that list, at the listed placement; never invent furniture, doors, vehicles, machines or plot props that are not listed. For EVERY scene fill the ENGLISH field "set": ONE compact line "SET: <Location name> — <objects from the inventory that are in frame or used in this scene, each with its placement>" (1–2 lines, 3–8 objects, verbatim names from the list). When no inventory is given, omit "set".
S15. REGION (which part of the ONE key location this scene occupies): for EVERY scene fill the ENGLISH field "region" — ONE short phrase (max 20 words) naming WHICH part / corner of the single key location the scene physically happens in and roughly from where we look, described STRICTLY with the location's own fixed set objects and architecture, e.g. "at the eastern bench against the rear wall, looking toward the columns" or "by the counter in the front-left corner, facing the entrance". It must NOT name any new furniture, add or move objects, or change the room — the location is constant (R-ONE-LOCATION); "region" only says where inside that constant room this scene sits. Scenes that stay in the SAME part of the room MUST use the SAME wording so they share one region plate; a scene that moves to a different corner gets a different "region". This is orthogonal to the camera: the camera still moves freely within the region.

Before answering, check: EXACTLY ${EPISODE_SCENE_COUNT} scenes; each scene's "durationSec" is set by its CONTENT to the clip's real length, an integer in ${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS} s (no scene shorter than ${SCENE_MIN_SECONDS} s or longer than ${SCENE_CLIP_MAX_SECONDS} s); NO silent scenes (every scene has on-camera English dialogue with cast names as speakers, "[NO DIALOGUE]" appears nowhere); each talking scene has ${TALK_MIN_SENTENCES}–${TALK_MAX_SENTENCES} English dialogue sentences whose length MATCHES the clip (a single short line for a ${SCENE_MIN_SECONDS}–7 s clip, a two-line exchange for a fuller one — no dead air, no crammed speech), and a longer conversation is SPLIT across consecutive scenes (one line / short exchange per clip, a camera cut between them) rather than forced into one; every fight / physical confrontation promised by the logline is an "action" scene with face-to-face beat-by-beat choreography (R9); every videoPrompt has all 9 tags including [CHARACTER], a single continuous choreography beat in [ACTION] that runs until the cut (no frozen final pose) and a cut list in [SHOT TYPE] that opens wide and mixes shot scales across the space; [BLOCKING] moves characters between different zones and gives each speaker ordinary business; [ACTION] adds secondary background life so the place feels alive; and EACH scene continues seamlessly from the previous one — "presence"/"entrances"/"continuesFrom" are filled and every entrance/exit/move is shown in [BLOCKING]/[ACTION]/[TRANSITION] so nobody teleports or vanishes; the SUM of all "durationSec" does NOT exceed ${EPISODE_MAX_TOTAL_SECONDS} s (the whole episode runs up to ${EPISODE_TOTAL_LABEL}, and may be shorter) and no scene exceeds ${SCENE_CLIP_MAX_SECONDS} s; EVERY scene has a non-empty English "endState" (${STATE_SIZE_TEXT}, opening with the IN FRAME / NOT IN FRAME inventory and exact placement of every character and prop: pose, wardrobe, camera, composition, depth, background, lighting, time/weather, colour palette and props of the final frame) AND a non-empty English "startState" (the same exhaustive description for frame 1), both written as labelled WORLD: / CAMERA: blocks; on every continuous seam (continuesFrom other than location-change / new-sequence) the startState WORLD equals the previous scene's endState WORLD exactly (same instant of the same action, same place, same light) while the startState CAMERA differs from the previous endState CAMERA in at least two of shot scale / height / angle; every scene's locationDesc on a continuous seam is identical to the previous scene's; and a line may end right on the cut, but is never split across two scenes; characters never fall silent or freeze before the cut.`;
}
export function episodeScriptUserPrompt(input: {
  synopsis: string;
  season: SeasonStructure;
  episode: EpisodeOutline;
  characters: CharacterCard[];
  previous: { number: number; title: string; logline: string; cliffhanger: string }[];
  /**
   * Stage 88 — the concrete ENDING of the immediately-preceding episode (its last scene's scripted
   * final state, plus the tail of what happened), so this episode is written as a direct continuation
   * of where the previous one left off: same world, characters left exactly where they were, story
   * carried forward. Absent for the first episode.
   */
  previousEnding?: {
    number: number;
    title: string;
    cliffhanger: string;
    endState?: string | null;
    tail?: string | null;
  } | null;
  instruction?: string;
  /** Stage 113 — the episode location's set inventory (DB text or entries); absent/empty → no inventory block. */
  locationInventory?: string[] | string | null;
  /**
   * Stage 155 — the AUTHOR-UPLOADED season plot ("bring your own plot file"). When present, the script for
   * THIS episode must be written from this author-provided plot as the AUTHORITATIVE source (it wins over
   * the auto-derived outline where they differ); absent/empty → written the usual way from the outline.
   */
  plotSource?: string | null;
  /**
   * Stage 158 — the AUTHOR-PROVIDED FULL EPISODE SCRIPT ("insert your own script"). When present, this is the
   * finished script for THIS episode written by the author: the model must ONLY STRUCTURE it into the required
   * shooting-script JSON (keeping the author's scenes/order/action and EVERY dialogue line verbatim, only
   * splitting into shots + synthesizing technical fields). This is the STRONGEST source — it wins over both the
   * plotSource and the auto-derived outline. Absent/empty → written the usual way.
   */
  userScript?: string | null;
}): string {
  const prev = input.previous.length
    ? input.previous.map((p) => `Ep.${p.number} «${p.title}»: ${p.logline} Cliffhanger: ${p.cliffhanger}`).join("\n")
    : "(this is the first episode)";
  const cast = input.characters.filter((c) => input.episode.characters.includes(c.name));
  // Stage 88: cross-episode continuity — a dedicated block describing exactly how the previous episode
  // ENDED (final frame state + closing beats), with an explicit instruction to CONTINUE from it.
  const pe = input.previousEnding;
  const prevEndingBlock = pe
    ? `\n\nHOW THE PREVIOUS EPISODE (Ep.${pe.number} «${pe.title}») ENDED — THIS EPISODE CONTINUES DIRECTLY FROM HERE:\nCliffhanger: ${pe.cliffhanger}${(pe.endState ?? "").trim() ? `\nFinal frame / world-state left behind: ${(pe.endState ?? "").trim()}` : ""}${(pe.tail ?? "").trim() ? `\nClosing beats:\n${(pe.tail ?? "").trim()}` : ""}\nWrite THIS episode as the direct next chapter: pick up the story, the world-state, the locations and the characters exactly where the previous episode left them (nobody teleports, resets or forgets what just happened), resolve or escalate that cliffhanger, and open scene 1 with the characters ALREADY talking on camera in the middle of that situation — no narrator, no recap, no "previously on" (never restart the story from scratch).`
    : "";
  const beats = episodeFootageGivens(input.episode.description);
  // Stage 155 — author-uploaded plot: the AUTHORITATIVE source for the script (its events, order and
  // character actions take precedence over the auto-derived outline above). Keep to the part of the plot
  // that belongs to THIS episode (${input.episode.number}); do not invent beats it does not contain.
  const plot = (input.plotSource ?? "").trim();
  const plotBlock = plot
    ? `\n\nAUTHOR-PROVIDED SEASON PLOT (AUTHORITATIVE — write THIS episode's script from it; where it differs from the outline above, the plot wins; use the part covering episode ${input.episode.number}):\n${plot}`
    : "";
  // Stage 158 — the author pasted a COMPLETE episode script. This is the STRONGEST source: the model must only
  // STRUCTURE it into the required shooting-script JSON, preserving the author's scenes/order/action and every
  // dialogue line EXACTLY as written, and synthesize ONLY the technical fields. It wins over plotSource + outline.
  const userScript = (input.userScript ?? "").trim();
  const userScriptBlock = userScript
    ? `\n\nAUTHOR-PROVIDED FULL EPISODE SCRIPT (AUTHORITATIVE — this is the finished script for THIS episode ${input.episode.number}, written by the author). Your job is ONLY to STRUCTURE it into the required shooting-script JSON: keep the author's scenes, their order, their on-screen action and EVERY line of dialogue EXACTLY as written (do NOT rewrite, add, remove, shorten, translate away or invent any dialogue or plot beat). Split the author's script into the required consecutive shots and, for each shot, synthesize ONLY the technical fields the JSON needs (shotType, camera, videoPrompt, startState, endState, durationSec, continuity metadata) so the clips can be generated — never change WHAT happens or WHAT is said. Where this author script differs from the outline/synopsis/season plot above, THIS SCRIPT WINS. PRESERVE THE AUTHOR'S LOCATIONS: use the location the author gives each scene — set each scene's "locationDesc" to that scene's own place ("INT/EXT — place — time"), and DO NOT collapse every scene into a single location. When a scene's location differs from the previous scene's, set its "continuesFrom" to "location-change". Keep the author's scene order and their location headings.\n${userScript}`
    : "";
  return `SEASON «${input.season.title}»: ${input.season.logline}\nSYNOPSIS: ${input.synopsis}${plotBlock}${userScriptBlock}\n\nPREVIOUS EPISODES:\n${prev}${prevEndingBlock}\n\nTHIS EPISODE ${input.episode.number} «${input.episode.title}» (${input.episode.arcRole}):\n${input.episode.logline}${beats}\nCLIFFHANGER: ${input.episode.cliffhanger}\nLOCATION: ${input.episode.locationName} — ${input.episode.locationDesc}${locationInventoryBlock(input.locationInventory)}\n\nCHARACTERS IN THIS EPISODE:\n${charactersBlock(cast.length ? cast : input.characters)}${input.instruction ? `\n\nREVISION INSTRUCTION FROM THE AUTHOR (apply it, keep everything else coherent):\n${input.instruction}` : ""}`;
}

/**
 * Stage 40 — the scripted end state of a scene as ONE dim line under the scene text («Финал кадра: …»).
 * The UI renders lines starting with this prefix in muted italics (see episode-view script tab).
 */
export const END_STATE_LINE_PREFIX = "Финал кадра: ";
/** Stage 41 — the scripted start state as ONE dim line («Старт кадра: ...»), printed right above «Финал кадра». */
export const START_STATE_LINE_PREFIX = "Старт кадра: ";
export function renderEndStateLine(endState?: string | null): string {
  const t = (endState ?? "").replace(/\s+/g, " ").trim();
  return t ? `\n${END_STATE_LINE_PREFIX}${t}` : "";
}
export function renderStartStateLine(startState?: string | null): string {
  const t = (startState ?? "").replace(/\s+/g, " ").trim();
  return t ? `\n${START_STATE_LINE_PREFIX}${t}` : "";
}
/** Both dim state lines under a scene: «Старт кадра» then «Финал кадра» (each only when present). */
export function renderStateLines(scene: { startState?: string | null; endState?: string | null }): string {
  return renderStartStateLine(scene.startState) + renderEndStateLine(scene.endState);
}

// Stage 160 — an INT/EXT/ИНТ/НАТ opener or a "day/night/…"-style time-of-day tail (English + Russian).
const SCENE_LOC_INT_EXT_RE = /^(int|ext|int\.?\/ext\.?|i\/e|инт|нат)\.?$/i;
const SCENE_LOC_TIME_RE = /^(day|night|dawn|dusk|evening|morning|afternoon|noon|midnight|continuous|later|moments? later|sunset|sunrise|день|ночь|утро|вечер|рассвет|закат|сумерки|полдень|полночь|позже|продолжение)\.?$/i;

/**
 * Stage 160 — extract a clean PLACE NAME from an "INT/EXT — place — time"-style scene descriptor so a
 * MANUAL (author-provided) script can show the author's OWN per-scene location. Examples:
 *   "INT — Security office — day" → "Security office"; "Open-plan office floor" → "Open-plan office floor";
 *   "" → "". Splits only on space-surrounded em/en/hyphen separators, so hyphenated words ("Open-plan")
 *   are never split. 3+ parts: drop a leading INT/EXT token and a trailing time-of-day token, the place is
 *   what remains; 2 parts with an INT/EXT opener: the place is the second part; otherwise the first part.
 */
export function sceneLocationName(locationDesc?: string | null): string {
  const t = (locationDesc ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const parts = t.split(/\s+[—–-]\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return t; // no separators — the whole text is the place name
  if (parts.length >= 3) {
    let start = 0;
    let end = parts.length;
    if (SCENE_LOC_INT_EXT_RE.test(parts[start])) start++;
    if (SCENE_LOC_TIME_RE.test(parts[end - 1])) end--;
    const middle = parts.slice(start, end).filter(Boolean);
    return middle.length ? middle.join(" — ") : parts[0];
  }
  // exactly 2 parts
  return SCENE_LOC_INT_EXT_RE.test(parts[0]) ? parts[1] : parts[0];
}

/** Stage 160 — distinct per-scene location NAMES in scene order (deduped, case-insensitive). */
function distinctSceneLocationNames(scenes: { locationDesc?: string | null }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of scenes) {
    const n = sceneLocationName(s.locationDesc);
    if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); out.push(n); }
  }
  return out;
}

/**
 * Stage 160 — true when the episode's scenes span 2+ distinct locations (a MANUAL author script that keeps
 * the author's own per-scene places). An auto (LLM) episode is anchored to ONE location, so this is false
 * for it and the single-location rendering (Stage 157) is used unchanged.
 */
export function episodeHasMultipleLocations(scenes: { locationDesc?: string | null }[]): boolean {
  return distinctSceneLocationNames(scenes).length >= 2;
}

/** Readable script text stored in Episode.script. */
export function renderEpisodeScriptText(ep: EpisodeOutline, script: EpisodeScript): string {
  // Stage 160 — a manual author script may keep MULTIPLE per-scene locations; when it does, show each
  // scene's own place (and list them in the head) instead of collapsing to the one episode location.
  const multiLoc = episodeHasMultipleLocations(script.scenes);
  const headLoc = multiLoc ? distinctSceneLocationNames(script.scenes).join(", ") : ep.locationName;
  const head = `ЭПИЗОД ${ep.number}. ${ep.title}\n${ep.logline}\nЛокация: ${headLoc}\nПерсонажи: ${ep.characters.join(", ")}\n`;
  const body = script.scenes
    .map((s) => {
      // Stage 157 — the reader sees the episode's LOCATION NAME per scene, not the per-scene
      // "INT/EXT — place — time" descriptor (locationDesc stays for image/video generation).
      // Stage 160 — for a multi-location manual script show THIS scene's own place instead.
      const sceneLoc = multiLoc ? (sceneLocationName(s.locationDesc) || ep.locationName || s.locationDesc) : (ep.locationName || s.locationDesc);
      const head2 = `\nСЦЕНА ${s.number}${s.sceneKind === "narration" ? " · ЗАКАДРОВЫЙ ГОЛОС" : isActionKind(s.sceneKind) ? " · ЭКШЕН" : ""} · ${s.shotType} · ~${s.durationSec}с\n${sceneLoc}\n${s.action}${(s.set ?? "").trim() ? `\n${/^SET:/i.test(s.set!.trim()) ? "" : "SET: "}${s.set!.replace(/\s+/g, " ").trim()}` : ""}`;
      const tail = renderStateLines(s);
      if (s.sceneKind === "narration" && (s.voiceover ?? "").trim()) {
        const local = (s.voiceoverLocal ?? "").trim();
        return `${head2}\nЗакадровый голос: ${local || s.voiceover}${local && local !== s.voiceover ? `\n[EN voiceover]\n${s.voiceover}` : ""}${tail}`;
      }
      return `${head2}\n${s.dialogueLocal ?? s.dialogue}${s.dialogueLocal && s.dialogueLocal !== s.dialogue ? `\n[EN speech]\n${s.dialogue}` : ""}${tail}`;
    })
    .join("\n");
  return `${head}${body}\n\nКЛИФФХЭНГЕР: ${ep.cliffhanger}\n`;
}

/** Clip length for one scene: the scripted durationSec (new flow), clamped to what the tier/model allows. */
export function sceneClipSeconds(tier: PowerTier, plannedSec?: number | null): number {
  const cfg = sceneTierConfig(POWER_TIER_CONFIG[tier]); // Stage 46B: scenes are always priced/rendered as 480p
  const max = Math.min(cfg.maxDuration, SCENE_MAX_SECONDS);
  const want = plannedSec && plannedSec > 0 ? plannedSec : max;
  return Math.min(max, Math.max(SCENE_MIN_SECONDS, cfg.baseDuration, Math.round(want)));
}
/** Credits for one clip of the given length — same rule as /api/ai/generate-video. */
export function sceneClipCost(tier: PowerTier, durationSec: number): number {
  const cfg = sceneTierConfig(POWER_TIER_CONFIG[tier]); // Stage 46B: 480p price for every scene
  return Math.max(cfg.costPerScene, Math.ceil((cfg.costPerScene * durationSec) / cfg.baseDuration));
}
/**
 * Clip plan for a scene batch. `scenes` may be a count (legacy: every clip at the maximum) or the
 * scenes' scripted durations. duration/costPerScene are the per-clip maxima shown in the UI; total is exact.
 */
export function sceneClipPlan(tier: PowerTier, scenes: number | Array<{ durationSec?: number | null }>) {
  const list = typeof scenes === "number" ? Array.from({ length: scenes }, () => ({ durationSec: null })) : scenes;
  const clips = list.map((s) => { const d = sceneClipSeconds(tier, s.durationSec); return { duration: d, cost: sceneClipCost(tier, d) }; });
  const duration = clips.reduce((m, c) => Math.max(m, c.duration), 0);
  const costPerScene = clips.reduce((m, c) => Math.max(m, c.cost), 0);
  return { duration, costPerScene, total: clips.reduce((a, c) => a + c.cost, 0), totalSeconds: clips.reduce((a, c) => a + c.duration, 0), clips };
}

/** Readable script text from persisted Scene rows (used after partial edits). */
export function renderScriptFromScenes(
  ep: { number: number; title: string; logline?: string | null; locationName?: string | null; cliffhanger?: string | null },
  characterNames: string[],
  scenes: { number: number; sceneKind?: string | null; shotType?: string | null; durationSec?: number | null; locationDesc?: string | null; action?: string | null; dialogue?: string | null; startState?: string | null; endState?: string | null }[]
): string {
  // Stage 160 — a manual author script may keep MULTIPLE per-scene locations (stored on the Scene rows);
  // when it does, show each scene's own place (and list them in the head) instead of the one episode location.
  const multiLoc = episodeHasMultipleLocations(scenes);
  const headLoc = multiLoc ? distinctSceneLocationNames(scenes).join(", ") : (ep.locationName ?? "");
  const head = `ЭПИЗОД ${ep.number}. ${ep.title}\n${ep.logline ?? ""}\nЛокация: ${headLoc}\nПерсонажи: ${characterNames.join(", ")}\n`;
  const body = scenes
    // Stage 157 — show the episode's LOCATION NAME per scene, not the per-scene locationDesc descriptor.
    // Stage 160 — for a multi-location manual script show THIS scene's own place instead.
    .map((s) => `\nСЦЕНА ${s.number}${s.sceneKind === "narration" ? " · ЗАКАДРОВЫЙ ГОЛОС" : isActionKind(s.sceneKind) ? " · ЭКШЕН" : ""} · ${s.shotType ?? ""} · ~${s.durationSec ?? SCENE_MAX_SECONDS}с\n${multiLoc ? (sceneLocationName(s.locationDesc) || ep.locationName || (s.locationDesc ?? "")) : (ep.locationName || (s.locationDesc ?? ""))}\n${s.action ?? ""}\n${s.dialogue ?? "[NO DIALOGUE]"}${renderStateLines(s)}`)
    .join("\n");
  return `${head}${body}\n\nКЛИФФХЭНГЕР: ${ep.cliffhanger ?? ""}\n`;
}

export const locationReviseSchema = z.object({
  locationName: z.string().min(1),
  locationDesc: z.string().min(20),
  scenes: z.array(z.object({ number: z.number().int().min(1), locationDesc: z.string().min(3), videoPrompt: z.string().min(40) })),
});
export type LocationRevise = z.infer<typeof locationReviseSchema>;

export function locationReviseSystemPrompt(language: IdeaLanguage): string {
  return `You are a production designer + cinematographer. The author wants to change the KEY LOCATION of one episode of a vertical (9:16) drama. Apply the instruction to the location and reflect it in EVERY scene of the episode.
Return STRICT JSON: {"locationName": string (${langName(language)}), "locationDesc": string (detailed, deeply ATMOSPHERIC ENGLISH visual description, 3–5 sentences that read as a real immersive world extending far beyond the frame: architecture/terrain, materials, textures, props, weather, light, palette, time of day, PLUS genuine DEPTH — foreground, mid-ground and a far distance receding toward a visible HORIZON with atmospheric perspective (haze, layered planes, scale cues) — and natural environmental atmosphere (mist, drifting dust, wind, god-rays, golden- or blue-hour light, long shadows). Where the author's instruction and location type allow, favour an OPEN-AIR, under-the-SKY, spacious rendering with a wide expanse of sky and a clear horizon so the world feels vast; if it is an interior, open it up with large windows or a view outside so sky and depth still read), "scenes": [{"number": int, "locationDesc": "INT/EXT — place — time" in ${langName(language)}, "videoPrompt": string}]}.
RULES: keep every scene's number, shot type, action, characters, [CHARACTER] descriptions and story beats (an ACTION / fight scene keeps its face-to-face beat-by-beat combat choreography — never turn it into a conversation); only change what the new location implies ([LIGHTING], set details in [BLOCKING]/[ACTION]/[SHOT TYPE], [VISUAL STYLE] stays identical). videoPrompt stays ENGLISH with exactly the 9 lines [SHOT TYPE]/[VISUAL STYLE]/[LIGHTING]/[BLOCKING]/[GAZE]/[NON-VERBAL]/[ACTION]/[CHARACTER]/[TRANSITION]. Return ALL scenes. Never add spoken text to videoPrompt. Original content only.`;
}

export const sceneReviseSchema = z.object({
  /** Stage 38: "action" when the (revised) scene is a fight / chase / physical struggle; omitted = keep the current kind. */
  sceneKind: z.enum(["dialogue", "action"]).optional(),
  shotType: z.string().min(3),
  durationSec: z.number().int().min(SCENE_MIN_SECONDS).max(SCENE_MAX_SECONDS),
  locationDesc: z.string().min(3),
  action: z.string().min(3),
  dialogue: z.string().min(1),
  dialogueLocal: z.string().optional(),
  videoPrompt: z.string().min(40),
  // Stage 11 — continuity metadata (optional; kept in step with the neighbouring shots).
  presence: z.string().optional(),
  entrances: z.string().optional(),
  continuesFrom: z.string().optional(),
  /** Stage 40 — REQUIRED scripted end state of the revised scene's final frame (see END_STATE_RULE). */
  endState: z.string().min(1),
  /** Stage 41 — REQUIRED scripted start state of the revised scene's first frame (see START_STATE_RULE). */
  startState: z.string().min(1),
});
export type SceneRevise = z.infer<typeof sceneReviseSchema>;

export function sceneReviseSystemPrompt(language: IdeaLanguage): string {
  const L = langName(language);
  const local = language !== "en";
  return `You are a film director rewriting ONE shot ("scene", a short clip of ${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS} s, vertical 9:16, AI video model with native speech) of an episode by the author's instruction.
${DIRECTING_RULES}
Return STRICT JSON: {"sceneKind": "dialogue"|"action", "shotType": string, "durationSec": int, "locationDesc": "INT/EXT — place — time" (${L}), "action": string (${L}, 3–4 sentences, a bit more detailed — concrete beat-by-beat staging written as ONE continuous clip-length beat of unbroken motion that runs until the cut, never a page), "dialogue": string${local ? ', "dialogueLocal": string' : ""}, "videoPrompt": string, "presence": string, "entrances": string, "continuesFrom": string, "startState": string, "endState": string}.
SCENE KIND: "dialogue" = a normal talking scene; "action" = a fight / duel / chase / physical struggle. If the instruction asks for a fight, an attack, a duel, a chase or any physical confrontation ("make this scene a fight", "they start fighting", "he attacks her") — set "sceneKind": "action" and rewrite the scene as combat choreography: ${ACTION_STAGING_RULE} An action scene keeps 1–2 short English lines (never "[NO DIALOGUE]") spoken in the pauses between impacts, and the talking-scene rules below (sentence count, character-forward framing) do NOT apply to it. If the current scene is already an action scene and the instruction does not turn it into a conversation, keep "sceneKind": "action" and its choreography. Otherwise keep "sceneKind": "dialogue".
RULES: "dialogue" is ALWAYS in ENGLISH (it is what the model voices), one line per row NAME (tone cue): "line"; a talking scene has a substantive exchange of ${TALK_MIN_SENTENCES}–${TALK_MAX_SENTENCES} full sentences (1–2 quick lines, characters answer each other instantly; the story is told through the dialogue) — NEVER "[NO DIALOGUE]" and never a silent or narrator-only scene.${local ? ` "dialogueLocal" = the same lines translated into ${L}, same structure and cues.` : ""} A clip runs only as long as its action and lines last (${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS} s): set "durationSec" to that real length (an integer ${SCENE_MIN_SECONDS}–${SCENE_CLIP_MAX_SECONDS}), and the shot ENDS the instant the action / line finishes — the character never holds a static pose, freezes or stares into the camera to fill time (no frozen final beat, only continuous motion). Talking scenes are built AROUND the characters — the base shot is a medium / medium-close / over-the-shoulder on the speaker and the reactor with the location as context behind, a face close-up is used on an emotional beat, the speaker's face does not have to be visible on every line (staging decides), and a wide / establishing shot is used only when the scene needs it (a new or changed location, an entrance / exit, showing arrangement or the geography of a move); the two characters are placed naturally in the location, never squared off face to face when they simply talk. ${CONFRONTATION_STAGING_SENTENCE} ${PACE_DIRECTION} ${MODERATION_SAFE_RULE} ${CREATIVE_RULE} ${LOCATION_PRESENCE_RULE} ${SCALE_DEPTH_RULE} ${EVERYDAY_BEHAVIOR_RULE} videoPrompt is ENGLISH, exactly 9 lines [SHOT TYPE] (cut list, 1–2 hard cuts with time ranges)/[VISUAL STYLE]/[LIGHTING]/[BLOCKING]/[GAZE]/[NON-VERBAL] (expressive acting)/[ACTION]/[CHARACTER]/[TRANSITION] (hard cut); keep [VISUAL STYLE] and [CHARACTER] descriptions identical to the given scene unless the instruction requires otherwise; no spoken text in videoPrompt; never "slowly", "slow motion", "lingering", "long pause". ${CONTINUITY_RULE} This shot must still begin from the PREVIOUS shot's ending and hand off cleanly into the NEXT shot (both are given below): keep the same people in place unless the instruction changes that, and if the revision adds or removes someone or moves the action, SHOW that entrance/exit/move. Fill "presence" (who is where at the start, following the previous shot), "entrances" (who enters/leaves during the shot and how, or "none") and "continuesFrom" (same-location-continuation | character-moves | location-change | new-sequence) to match the neighbouring shots. START / END STATE: ${END_STATE_RULE} ${START_STATE_RULE} Return "startState" = the revised scene's frame 1: its WORLD block must still equal the PREVIOUS shot's endState WORLD (same instant of the same action, same place, same light) while its CAMERA block is a DIFFERENT setup (≥ 2 of shot scale / height / angle changed) unless continuesFrom is location-change / new-sequence. The revised scene's OPENING must still continue the PREVIOUS shot's endState WORLD from a new camera (given below) unless continuesFrom is location-change / new-sequence, and its own "endState" must be updated to describe the NEW final frame — and it must remain consistent with the NEXT shot's opening (if the revision changes where people end up, say so in endState so the next shot can be adjusted). Original content only; Western names, Latin letters, exactly as given.`;
}

/* ───────────── Stage 13 — episode-level continuity audit («Ассембл» final polish) ───────────── */

/**
 * Result of the whole-episode continuity review. One entry per scene, in order.
 * `hasIssue` scenes carry a short `issue` and a full `correctedVideoPrompt` that fixes the seam;
 * consistent scenes come back with `hasIssue:false` and no corrected prompt (never re-generated).
 */
export const episodeContinuityAuditSchema = z.object({
  scenes: z.array(
    z.object({
      number: z.number().int().min(1),
      hasIssue: z.boolean(),
      issue: z.string().optional(),
      correctedVideoPrompt: z.string().optional(),
      /** Stage 40 — corrected scripted end state (only when hasIssue; keeps the hand-off chain consistent). */
      correctedEndState: z.string().optional(),
      /** Stage 41 — corrected scripted start state (only when hasIssue). */
      correctedStartState: z.string().optional(),
    })
  ),
});
export type EpisodeContinuityAudit = z.infer<typeof episodeContinuityAuditSchema>;

/** One scene, as fed to the continuity auditor (ordered chain of the whole episode). */
export interface AuditSceneInput {
  number: number;
  durationSec?: number | null;
  sceneKind?: string | null;
  shotType?: string | null;
  locationDesc?: string | null;
  dialogueEn?: string | null;
  voiceover?: string | null;
  presence?: string | null;
  entrances?: string | null;
  continuesFrom?: string | null;
  videoPrompt?: string | null;
  /** Stage 40 — scripted end state of the final frame. */
  endState?: string | null;
  /** Stage 41 — scripted start state of the first frame. */
  startState?: string | null;
}

/**
 * Stage 13 — «Ассембл» final polish. The model re-reviews the WHOLE episode as one continuous
 * video and fixes ONLY the scenes that break logical continuity at the seams (a character who
 * vanishes / teleports / appears already in place, a physical arrangement that resets, a prop /
 * lighting / time-of-day jump, an action left mid-motion). Consistent scenes are left untouched
 * so no credits are wasted on them.
 */
export function episodeContinuityAuditSystemPrompt(language: IdeaLanguage): string {
  const L = langName(language);
  return `You are a film continuity supervisor + editor reviewing a FINISHED vertical (9:16) drama episode as ONE continuous video before final assembly. You are given every shot ("scene") IN ORDER. Your job: find LOGICAL CONTINUITY ERRORS at the SEAMS between adjacent scenes and fix ONLY the scenes that break continuity — leave scenes that already flow correctly completely untouched.
CRITICAL — UNMOTIVATED LOCATION / SETTING JUMP: the episode has exactly ONE key location and every scene must stay in it (only the zone within it and the camera angle may change). If the SETTING itself changes between scenes without a deliberately shown, motivated move — e.g. a character sits at a table inside a temple in one scene and is suddenly sitting in a field / a different room / outdoors in the next, with no travel shown and the scene NOT marked continuesFrom="location-change" — that is a MUST-FLAG continuity error: set hasIssue=true and rewrite the scene so it happens BACK IN the episode's single key location (the same place as the surrounding scenes, matching the location references). Treat an interior→exterior (or exterior→interior) or any new building/room/landscape that isn't the episode's key location as this error. The corrected videoPrompt MUST place the scene inside the canonical episode location (same place, only zone/camera angle differs), never invent a new setting.
At every boundary between scene N and scene N+1 (and across the whole chain) ALSO look for: a character who is present or speaking in one scene but has silently VANISHED or TELEPORTED in the next with no shown exit/entrance; someone who suddenly APPEARS already in place without walking in; the physical arrangement (who is where, seated/standing, what they hold) resetting between a continuing same-location pair instead of carrying over; an object / prop / costume that changes or disappears illogically; time-of-day / lighting / weather that jumps without reason; an action left mid-motion at the end of one scene and not continued at the start of the next. ${CONTINUITY_RULE} ${ONE_LOCATION_RULE}
Return STRICT JSON: {"scenes":[{"number": int, "hasIssue": boolean, "issue": string (short, ${L}, ONLY when hasIssue is true), "correctedVideoPrompt": string (ONLY when hasIssue is true), "correctedStartState": string (ONLY when hasIssue is true), "correctedEndState": string (ONLY when hasIssue is true)}]} — include EVERY scene number exactly once, in order. A scene that already flows correctly: {"number":N,"hasIssue":false}. A scene that breaks continuity: hasIssue=true, "issue" = ONE short sentence naming the seam problem, "correctedVideoPrompt" = the FULL rewritten prompt for THAT scene that fixes the transition — make the entrance / exit / move EXPLICIT in [BLOCKING], [ACTION] and [TRANSITION], and keep positions, props, lighting and time-of-day consistent with the END of the previous scene and the START of the next.
CORRECTED PROMPT RULES: exactly the 9 lines [SHOT TYPE]/[VISUAL STYLE]/[LIGHTING]/[BLOCKING]/[GAZE]/[NON-VERBAL]/[ACTION]/[CHARACTER]/[TRANSITION], ENGLISH, NO spoken text inside the videoPrompt, keep [VISUAL STYLE] and [CHARACTER] IDENTICAL to the given scene, preserve the scene's essence, its kind, its dialogue / narration and its duration; a scene marked (action) is a FIGHT / physical confrontation — its corrected prompt stays combat choreography (fighters engaged and moving, real beat-by-beat mechanics with visible contact and impact per the rule below), it is NEVER rewritten into a conversation: ${ACTION_STAGING_RULE} never "slowly", "slow motion", "lingering", "long pause". ${PACE_DIRECTION} ${MODERATION_SAFE_RULE} ${LOCATION_PRESENCE_RULE} START / END STATE CHAIN: every scene carries "startState" (scripted frame 1) and "endState" (scripted final frame) (${END_STATE_RULE} ${START_STATE_RULE}). Check each seam against them: scene N+1's startState WORLD and opening ([SHOT TYPE] first beat, [BLOCKING], presence) must continue scene N's endState WORLD (same instant of the same action, same people, place, light, props) unless continuesFrom is location-change / new-sequence — a WORLD mismatch IS a continuity error; scene N+1's startState CAMERA must DIFFER from scene N's endState CAMERA (a new angle / scale / height on the same instant) — an identical repeated framing is ALSO an error; and no line of dialogue may straddle the seam (a scene ending mid-sentence is an error). When you correct a scene, ALSO return "correctedStartState" and "correctedEndState" (both REQUIRED whenever hasIssue is true): the updated English start / end states of the corrected scene, consistent with the previous scene's endState and the next scene's opening. Only flag REAL logical breaks — if the whole chain is already consistent, return every scene with hasIssue=false and change nothing. Original content only; Western names, Latin letters.`;
}

/** The ordered scene chain rendered for the auditor. */
export function episodeContinuityAuditUserPrompt(scenes: AuditSceneInput[]): string {
  const blocks = scenes.map((s) => {
    const isNarration = s.sceneKind === "narration";
    const isAction = isActionKind(s.sceneKind);
    const speech = ((isNarration ? s.voiceover : s.dialogueEn) ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    return [
      `### Scene ${s.number}${isNarration ? " (off-screen narration)" : isAction ? " (action — fight / physical confrontation, keep as action)" : ""} — ${s.locationDesc ?? ""} — ~${s.durationSec ?? 15}s`,
      `presence: ${s.presence ?? "(none)"}`,
      `entrances: ${s.entrances ?? "(none)"}`,
      `continuesFrom: ${s.continuesFrom ?? "(none)"}`,
      `startState: ${(s.startState ?? "").replace(/\s+/g, " ").trim() || "(none)"}`,
      `endState: ${(s.endState ?? "").replace(/\s+/g, " ").trim() || "(none)"}`,
      `${isNarration ? "narration(EN)" : "dialogue(EN)"}: ${speech || "(none)"}`,
      `videoPrompt:`,
      (s.videoPrompt ?? "").trim() || "(empty)",
    ].join("\n");
  });
  return `The episode has ${scenes.length} scenes, given IN ORDER below. Review the whole chain for seam continuity and return the JSON exactly as specified (every scene number once).\n\n${blocks.join("\n\n")}`;
}

/* ───────────── Stage 5 — season-level prompt editing ───────────── */

/** Same shape as the structure; the episode COUNT must stay — the revise never adds/removes episodes. */
export const seasonReviseSchema = seasonStructureSchema;

/** Instruction used by «Применить изменения к сценарию сезона» after the synopsis / cast / locations were edited. */
export const SEASON_SYNC_INSTRUCTION =
  "Синхронизируй структуру сезона с обновлённым синопсисом, списком персонажей и локаций: учти новые/изменённые персонажи и места, убери тех, кого больше нет, сохрани всё остальное без изменений.";

export function seasonReviseSystemPrompt(language: IdeaLanguage, episodeCount: number): string {
  return `You are the showrunner of a short-form vertical drama series. You receive the CURRENT season structure (${episodeCount} episodes) and an INSTRUCTION from the author. Apply the instruction to the structure and return the FULL updated structure as STRICT JSON with exactly the same shape:
{"title": string, "logline": string, "episodes": [{"number": int, "title": string, "logline": string, "locationName": string, "locationDesc": string, "locationDetail": "low"|"medium"|"high", "characters": [names], "arcRole": "завязка"|"развитие"|"поворот"|"финал", "cliffhanger": string, "description": string (a detailed continuous episode synopsis in prose, ~4–7 sentences, then a final "CLIFFHANGER: ..." line — NO shot/beat split, NO timings)}]}.
RULES:
- Keep EXACTLY ${episodeCount} episodes with the same numbers 1..${episodeCount}. Never add or remove episodes.
- MINIMAL CHANGE: copy every field of every episode VERBATIM unless the instruction (or story consistency it forces) requires changing it. Episodes that the instruction does not touch must be returned character-for-character identical — the system regenerates only episodes whose logline / arc / location / characters changed, and rewriting untouched episodes wastes the author's work.
- Use ONLY the given character names verbatim (a new character requested by the author is allowed only if it is present in the CHARACTERS list; otherwise weave the request into the existing cast). "locationName" should be one of the given LOCATIONS (verbatim); a new place only when the story truly needs it.
- ${LOCATION_DETAIL_RULE}
- ${EPISODE_SYNOPSIS_RULE}
- "logline" is ONE sentence; "cliffhanger" = the CLIFFHANGER line verbatim. Keep continuity: consequences carry over episode to episode. If an episode's current "description" is still split into shots/beats/timed halves, rewrite it into ONE continuous detailed synopsis (plus its closing CLIFFHANGER line) WITHOUT changing its events (that alone does not count as a story change).
- ${PACING_RULE} Changed episodes must keep this pacing.
- ${CREATIVE_RULE}
- ${MODERATION_SAFE_RULE}
- All text except "locationDesc" is in ${langName(language)}; "locationDesc" is a detailed English visual description. Character names stay exactly as given (Western names in Latin letters).`;
}
export function seasonReviseUserPrompt(input: { synopsis: string; structure: SeasonStructure; characters: CharacterCard[]; locations: LocationRef[]; instruction: string }): string {
  return `SYNOPSIS:\n${input.synopsis}\n\nCHARACTERS (with tiers):\n${charactersBlock(input.characters)}\n\nLOCATIONS:\n${input.locations.length ? locationsBlock(input.locations) : "(none)"}\n\nCURRENT SEASON STRUCTURE (JSON):\n${JSON.stringify(input.structure, null, 1)}${cliffhangerChainGivens(input.structure)}\n\nINSTRUCTION FROM THE AUTHOR:\n${input.instruction}`;
}

// ─── Stage 12: whole-season prose story ("Сюжет" screen) ─────────────────────────────
// The full story is ONE long text the author reads/edits BEFORE any asset or video is made.
// Episode boundaries are marked by fixed ASCII bars so the UI can find them in any language.
export const FULL_STORY_START_MARK = "═══";
export const FULL_STORY_END_MARK = "───";
export const seasonFullStorySchema = z.object({ fullStory: z.string().min(1) });
/** Story-screen revise returns BOTH the (possibly re-counted) structure and the rewritten prose. */
/** Stage 106 — "fullStory" from the model is IGNORED (the plot is rebuilt from the structure); it may be empty. */
export const seasonStoryReviseSchema = seasonStructureSchema.extend({ fullStory: z.string().optional().default("") });
export type SeasonStoryRevise = z.infer<typeof seasonStoryReviseSchema>;

/** How many episode blocks a full-story text contains (counts the start-marker lines). */
export function countFullStoryEpisodes(text: string | null | undefined): number {
  if (!text) return 0;
  return text.split(/\r?\n/).filter((l) => l.trimStart().startsWith(FULL_STORY_START_MARK)).length;
}

// ─── Stage 106: the season plot is BUILT from the structure, not written by the LLM ──────────
/** Header / closing words per language (UPPERCASE, as the prose LLM used to write them). */
const FULL_STORY_WORDS: Record<IdeaLanguage, { episode: string; end: string }> = {
  ru: { episode: "ЭПИЗОД", end: "КОНЕЦ ЭПИЗОДА" },
  en: { episode: "EPISODE", end: "END OF EPISODE" },
  uk: { episode: "ЕПІЗОД", end: "КІНЕЦЬ ЕПІЗОДУ" },
  de: { episode: "EPISODE", end: "ENDE DER EPISODE" },
  fr: { episode: "ÉPISODE", end: "FIN DE L'ÉPISODE" },
  es: { episode: "EPISODIO", end: "FIN DEL EPISODIO" },
  it: { episode: "EPISODIO", end: "FINE DELL'EPISODIO" },
  pl: { episode: "ODCINEK", end: "KONIEC ODCINKA" },
  pt: { episode: "EPISÓDIO", end: "FIM DO EPISÓDIO" },
  tr: { episode: "BÖLÜM", end: "BÖLÜM SONU" },
};
export function fullStoryEpisodeHeader(language: IdeaLanguage, n: number, title: string): string {
  const w = FULL_STORY_WORDS[language] ?? FULL_STORY_WORDS.en;
  return `${FULL_STORY_START_MARK} ${w.episode} ${n}: ${title.trim()} ${FULL_STORY_START_MARK}`;
}
export function fullStoryEpisodeClosing(language: IdeaLanguage, n: number): string {
  const w = FULL_STORY_WORDS[language] ?? FULL_STORY_WORDS.en;
  return `${FULL_STORY_END_MARK} ${w.end} ${n} ${FULL_STORY_END_MARK}`;
}

/**
 * Normalize an episode description to exactly THREE lines (one per label). A one-line description is split
 * at the SHOT 2 / CLIFFHANGER labels; anything unparseable is returned trimmed as-is (legacy prose).
 */
export function footageToLines(description: string | null | undefined): string {
  const f = parseEpisodeFootage(description);
  if (!f) return (description ?? "").trim();
  return [`${SHOT1_LABEL} ${f.shot1}`, `${SHOT2_LABEL} ${f.shot2}`, `${CLIFFHANGER_LABEL} ${f.cliffhanger}`].join("\n");
}

const FULL_STORY_OVERVIEW_MAX_WORDS = 60;
function firstSentence(text: string | null | undefined): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const m = /^(.+?[.!?…])(\s|$)/.exec(t);
  return (m ? m[1] : t).trim();
}

/**
 * Build Season.fullStory deterministically from the validated structure: a short overview (season logline,
 * optionally the first sentence of the synopsis, ≤ ~60 words), then one block per episode:
 * `═══ EPISODE n: title ═══` / three labelled footage lines / `─── END OF EPISODE n ───`, blank line between blocks.
 * No prose paragraphs, no character or location intros — the text is the list of episode footage plans.
 */
export function buildFullStoryFromStructure(
  structure: { title?: string | null; logline?: string | null; episodes: { number: number; title: string; description?: string | null }[] },
  language: IdeaLanguage,
  synopsisLine?: string | null,
): string {
  const parts: string[] = [];
  const overview: string[] = [];
  const logline = (structure.logline ?? "").replace(/\s+/g, " ").trim();
  if (logline) overview.push(logline);
  const syn = firstSentence(synopsisLine);
  if (syn && norm(syn) !== norm(logline) && countWords(overview.join(" ")) + countWords(syn) <= FULL_STORY_OVERVIEW_MAX_WORDS) overview.push(syn);
  if (overview.length) parts.push(overview.join(" "));
  const episodes = [...structure.episodes].sort((a, b) => a.number - b.number);
  for (const e of episodes) {
    const body = footageToLines(e.description);
    parts.push([fullStoryEpisodeHeader(language, e.number, e.title), body, fullStoryEpisodeClosing(language, e.number)].filter((l) => l.length > 0).join("\n"));
  }
  return parts.join("\n\n");
}

function fullStoryFormatRules(language: IdeaLanguage, episodeCount: number): string {
  const L = langName(language);
  return `FORMAT (the app parses episode boundaries by the ═══ / ─── bars — keep them EXACTLY):
- Open with a 2–4 sentence season overview paragraph (the world, the central conflict, the stakes) — no marker before it.
- Then, for EACH of the ${episodeCount} episodes IN ORDER (1..${episodeCount}), write one block:
  • a header ON ITS OWN LINE, exactly: «═══ <word for EPISODE in ${L}> {n}: {episode title} ═══» (keep the ═══ bars verbatim);
  • 3–6 paragraphs of vivid, concrete PROSE telling everything that happens: the events in order, what each character does / wants / feels, the turns, and the closing cliffhanger — tell the story THROUGH decisive moments, not summaries;
  • a closing line ON ITS OWN LINE, exactly: «─── <words for END OF EPISODE in ${L}> {n} ───» (keep the ─── bars verbatim).
- After the last episode's closing line, output nothing else.
CONTENT:
- The FIRST time a LOCATION appears, describe it INSIDE the prose (2–3 sentences: architecture, materials, light, mood, the living background around it) — never as a card or bullet list. The FIRST time a CHARACTER appears, introduce them INSIDE the prose (who they are, how they look, their role and what they want).
- Continuity: consequences carry across episodes; no repetition; the season reads as ONE escalating story.
- This is the STORY, not a shooting script: no scene numbers, no shot lists, no camera directions.
- All prose is in ${L}. Character names stay exactly as given (Western names in Latin letters). Original content only: never reuse names, plots or lines from existing films or series.`;
}

/** Initial generation of Season.fullStory from the already-fixed structure (${episodeCount} episodes). */
export function seasonFullStorySystemPrompt(language: IdeaLanguage, episodeCount: number): string {
  return `You are a novelist-showrunner writing the COMPLETE, detailed prose story of ONE season of a short-form vertical drama, as a single continuous read for the author to review and edit before any video is made.
Return STRICT JSON: {"fullStory": string} — the value is ONE long text.
Tell the WHOLE season across exactly ${episodeCount} episodes, faithful to the given structure (same episode order, titles, loglines, locations and cast), expanding each episode's logline and cliffhanger into full prose.
${PACING_RULE}
${fullStoryFormatRules(language, episodeCount)}`;
}
export function seasonFullStoryUserPrompt(input: { synopsis: string; structure: SeasonStructure; characters: CharacterCard[]; locations: LocationRef[] }): string {
  return `SYNOPSIS:\n${input.synopsis}\n\nCHARACTERS (with tiers):\n${charactersBlock(input.characters)}\n\nLOCATIONS:\n${input.locations.length ? locationsBlock(input.locations) : "(none)"}\n\nSEASON STRUCTURE (JSON — expand this into full prose, do not change the episode count):\n${JSON.stringify(input.structure, null, 1)}`;
}

/** Story-screen revise: rewrite the prose per the author's instruction AND keep the structure in sync (count may change). */
export function seasonStoryReviseSystemPrompt(language: IdeaLanguage, episodeCount: number): string {
  return `You are the showrunner of a short-form vertical drama. You receive the CURRENT season structure (${episodeCount} episodes), the CURRENT season plot (= the list of episode descriptions, each a detailed continuous synopsis), and an INSTRUCTION from the author. Apply the instruction and return the FULL updated season as STRICT JSON:
{"title": string, "logline": string, "episodes": [{"number": int, "title": string, "logline": string, "locationName": string, "locationDesc": string, "locationDetail": "low"|"medium"|"high", "characters": [names], "arcRole": "завязка"|"развитие"|"поворот"|"финал", "cliffhanger": string, "description": string (a detailed continuous episode synopsis in prose, ~4–7 sentences, then a final "CLIFFHANGER: ..." line — NO shot/beat split, NO timings)}], "fullStory": string}.
RULES:
- SEASON PLOT = EPISODES: the season plot the author reads IS the ordered list of episode "description" fields (each a detailed continuous synopsis ending on its CLIFFHANGER line) — there is NO separate prose story. The app builds the plot text from "episodes" itself, so "fullStory" may be returned as an empty string "" or a 1–2 sentence season overview; never write prose there.
- MINIMAL CHANGE: keep the structure and descriptions the author did NOT ask to change VERBATIM. Only touch what the instruction (or the story consistency it forces) requires — the system regenerates scripts only for episodes whose logline / arc / location / cast changed, so needless edits waste the author's work.
- EPISODE COUNT: keep ${episodeCount} episodes UNLESS the author explicitly asks to add or remove episodes; then return the new count (allowed range ${SEASON_MIN_EPISODES}–${SEASON_MAX_EPISODES}), renumber episodes 1..N contiguously (the cliffhanger → next-episode-opening chain must stay unbroken after renumbering). Episode 1 = завязка, last = финал.
- Use ONLY the given character names verbatim; "locationName" should be one of the given LOCATIONS (verbatim) unless the story truly needs a new place. "logline" is ONE sentence; "cliffhanger" = the CLIFFHANGER line verbatim.
- ${EPISODE_SYNOPSIS_RULE}
  If an episode's current "description" is still split into shots/beats/timed halves, rewrite it into ONE continuous detailed synopsis (plus its closing CLIFFHANGER line) WITHOUT changing its events (that alone does not count as a story change).
- ${PACING_RULE}
- ${LOCATION_DETAIL_RULE}
- ${CREATIVE_RULE}
- ${MODERATION_SAFE_RULE}
- In "episodes", all text except "locationDesc" is in ${langName(language)}; "locationDesc" is detailed English. Character names stay exactly as given (Western names in Latin letters).`;
}
export function seasonStoryReviseUserPrompt(input: { synopsis: string; structure: SeasonStructure; fullStory: string; characters: CharacterCard[]; locations: LocationRef[]; instruction: string }): string {
  return `SYNOPSIS:\n${input.synopsis}\n\nCHARACTERS (with tiers):\n${charactersBlock(input.characters)}\n\nLOCATIONS:\n${input.locations.length ? locationsBlock(input.locations) : "(none)"}\n\nCURRENT SEASON STRUCTURE (JSON):\n${JSON.stringify(input.structure, null, 1)}\n\n${cliffhangerChainGivens(input.structure)}\n\nCURRENT SEASON PLOT (built from the episode descriptions — for reference only):\n${input.fullStory || "(not written yet)"}\n\nINSTRUCTION FROM THE AUTHOR:\n${input.instruction}`;
}

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
/** Does the change to this episode's outline require rewriting its script? Titles alone do not. */
export function episodeNeedsRewrite(before: EpisodeOutline, after: EpisodeOutline): boolean {
  if (norm(before.logline) !== norm(after.logline)) return true;
  if (norm(before.cliffhanger) !== norm(after.cliffhanger)) return true;
  // Stage 105 — the three footage beats changed (compared only when both sides are in the 3-line format,
  // so merely re-formatting a legacy description does not trigger a script rewrite).
  const fb = parseEpisodeFootage(before.description), fa = parseEpisodeFootage(after.description);
  if (fb && fa && (norm(fb.shot1) !== norm(fa.shot1) || norm(fb.shot2) !== norm(fa.shot2) || norm(fb.cliffhanger) !== norm(fa.cliffhanger))) return true;
  if (before.arcRole !== after.arcRole) return true;
  if (norm(before.locationName) !== norm(after.locationName)) return true;
  const a = new Set(before.characters.map(norm));
  const b = new Set(after.characters.map(norm));
  if (a.size !== b.size) return true;
  for (const x of a) if (!b.has(x)) return true;
  return false;
}
/** Episode numbers whose script must be regenerated after a season revise (pure, unit-tested). */
export function affectedEpisodes(before: SeasonStructure, after: SeasonStructure): number[] {
  const prev = new Map(before.episodes.map((e) => [e.number, e]));
  return after.episodes.filter((e) => { const p = prev.get(e.number); return !p || episodeNeedsRewrite(p, e); }).map((e) => e.number).sort((a, b) => a - b);
}
