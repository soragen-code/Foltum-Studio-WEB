/**
 * Stage 166 — episode-script prompt strings + pure helpers for the reworked EPISODE SCRIPT generation.
 *
 * This is a LEAF module: it imports NOTHING (at runtime) from lib/season.ts, only `import type` (erased at
 * compile time). All numeric bounds are LITERALS in the strings and the local constants below, so season.ts can
 * import from here at module top-level WITHOUT a runtime circular-dependency (TDZ) hazard. season.ts holds the
 * canonical exported numeric constants (EPISODE_MIN_SCENES, SCENE_MIN_SECONDS, …); the values here mirror them.
 */
import type { EpisodeScript, SceneScript } from "../season";

// ---------------------------------------------------------------------------
// Prompt version — stamped onto Episode.promptVersion when a script is generated.
// ---------------------------------------------------------------------------
/** Bumped whenever the episode-script prompt CONTRACT changes; written to Episode.promptVersion. */
export const EPISODE_SCRIPT_PROMPT_VERSION = "6.4.3";

// ---------------------------------------------------------------------------
// Numeric bounds (LITERAL mirrors of the season.ts constants — kept in step by tests).
// ---------------------------------------------------------------------------
export const STAGE166_MIN_SCENES = 5;
export const STAGE166_MAX_SCENES = 8;
export const STAGE166_SCENE_MIN_SEC = 3;
export const STAGE166_SCENE_MAX_SEC = 15;
export const STAGE166_EP_MIN_SEC = 70;
export const STAGE166_EP_MAX_SEC = 100;
export const STAGE166_MAX_SILENT_SCENES = 1;
/** Dialogue polish: average spoken line length must stay AT OR UNDER this many words (Stage 172 — fuller, more lifelike lines). */
export const DIALOGUE_MAX_AVG_WORDS = 16;
/** A state checklist must be AT LEAST this many words (the LLM critic, not the count, is the real gate). */
export const STATE_CHECKLIST_MIN_WORDS = 150;

// ---------------------------------------------------------------------------
// Time-skip enum (Stage 7 of the request) — sourced from seasonMap when present (Stage 3), else "none".
// ---------------------------------------------------------------------------
export const TIME_SKIP_VALUES = ["none", "minutes", "hours", "days", "weeks"] as const;
export type TimeSkip = (typeof TIME_SKIP_VALUES)[number];
export const isTimeSkip = (v: unknown): v is TimeSkip =>
  typeof v === "string" && (TIME_SKIP_VALUES as readonly string[]).includes(v);

// ---------------------------------------------------------------------------
// STATE CHECKLIST (replaces the old ~450-word sentence-counted state text).
// The five items the checklist MUST cover; the critic judges the same five.
// ---------------------------------------------------------------------------
export const STATE_CHECKLIST_ITEMS = [
  "POSITION of each character",
  "EMOTION on each face",
  "PROP state",
  "LIGHT / TIME",
  "CAMERA",
] as const;
export type StateChecklistItem = (typeof STATE_CHECKLIST_ITEMS)[number];

/**
 * The structured-checklist instruction the script prompt asks each startState / endState to satisfy. It replaces
 * the old "36–60 sentences / ≥450 words" size rule with an explicit 5-item checklist (≥150 words). Written as ONE
 * long literal so season.ts can splice it into START_STATE_RULE / END_STATE_RULE without importing numbers.
 */
export const STATE_CHECKLIST_TEXT =
  "a STRUCTURED CHECKLIST (NOT a free paragraph and NOT a sentence count), AT LEAST 150 words, that explicitly covers, item by item, ALL FIVE of these headings: " +
  "(1) POSITION of each character — for every named character in the frame, exactly where they are (frame LEFT / CENTER / RIGHT, foreground / midground / background) relative to a fixed landmark, their body orientation, posture and what each hand holds; " +
  "(2) EMOTION on each face — for every character in the frame, the precise facial expression and the emotion it reads as (never just 'neutral'); " +
  "(3) PROP state — every prop and piece of furniture that matters, each with its position relative to a landmark and its state (open / closed, lit / dark, full / empty, upright / fallen); " +
  "(4) LIGHT / TIME — the light source and its direction, the shadows it casts, the colour of the light, plus the time of day and weather / atmosphere; " +
  "(5) CAMERA — the shot scale (wide / full / medium / medium close-up), camera height (eye-level / low / high), the angle relative to the characters, and what sits in each third of the frame. " +
  "List every visible object; an object that is not listed is treated as ABSENT from the frame. Cover EVERY one of the five headings — a missing heading is a validation failure, not a stylistic choice.";

// ---------------------------------------------------------------------------
// Stage-5 rule strings spliced into the episode-script system prompt.
// ---------------------------------------------------------------------------
/** Rule 1 — content-driven scene count and per-scene / whole-episode durations. */
export const SCENE_COUNT_DURATION_RULE =
  "SCENE COUNT & DURATION (CONTENT-DRIVEN, not fixed): the episode is 5–8 scenes — as many as the story needs, never a fixed count. " +
  "Each scene's clip runs a VARIABLE 3–15 s, set by how long its own action and lines really take (a short beat is 3–6 s, a full beat up to 15 s); set \"durationSec\" to that real integer length. " +
  "The WHOLE episode (the sum of all \"durationSec\") must land between 70 and 100 s — aim for the middle of that band, never under 70 s and never over 100 s.";

/** Rule 3 — Scene 1 HOOK: conflict / threat / question in the first ~3 s; no exposition, no "character enters". */
export const SCENE_HOOK_RULE =
  "SCENE 1 HOOK (REQUIRED): scene 1 opens on a HOOK — a conflict, a threat or a burning question that lands within the first ~3 seconds and forces the viewer to keep watching. " +
  "Put that hook in scene 1's \"hook\" field (one short line naming the conflict / threat / question). " +
  "Scene 1 must NOT open with exposition (explaining who people are, backstory, the situation, setting the scene, establishing context) and must NOT open with a character simply ENTERING / arriving / walking in / a door opening. Start IN the tension, mid-conflict, on the sharpest line.";

/** Rule 4 — last scene CLIFFHANGER: type from seasonMap.cliffhangerType when present, else a generic unresolved image. */
export const LAST_SCENE_CLIFFHANGER_RULE =
  "LAST SCENE CLIFFHANGER (REQUIRED): the FINAL scene ends on a cliffhanger built as an explicit, concrete UNRESOLVED IMAGE — a picture the viewer sees (a raised hand about to strike, a door half-open, a phone lighting up with a name) that forces them into the next episode, never a question or a fade-out. " +
  "When the season map supplies a cliffhangerType for this episode, the final image must be OF THAT TYPE; when none is supplied, use a generic unresolved image (an action interrupted at its peak, an arrival not yet seen, a reveal one beat away).";

/** Rule 5 — exactly one emotional peak; other scenes build toward it. */
export const EMOTIONAL_PEAK_RULE =
  "EMOTIONAL PEAK (REQUIRED, exactly ONE): the episode has exactly one emotional peak — the single scene where the conflict boils over hardest. " +
  "Put its scene number in the episode-level \"peakSceneIndex\" field. Every OTHER scene builds toward that peak (rising tension before it, fallout after it); no second peak competes with it.";

/** Rule 7 — optional time skip before a scene (from seasonMap); when non-none, the first beat establishes the jump. */
export const TIME_SKIP_RULE =
  "TIME SKIP (optional, default none): a scene may carry a \"timeSkipBefore\" of none | minutes | hours | days | weeks, taken from the season map for this episode; when the season map says nothing, it is \"none\". " +
  "When \"timeSkipBefore\" is anything other than none, that scene's FIRST beat is an ESTABLISHING beat that shows the jump in time (a changed light / clock / meal / weather / wardrobe that makes the elapsed time legible) before the dialogue resumes.";

/** Rule 2 — silent scenes: up to 2, valid ONLY with a visualBeat; non-silent scenes still open on the speaker close-up. */
export const SILENT_SCENE_RULE =
  "SILENT SCENES (max 1): at most ONE scene in the episode may be silent (no spoken dialogue), and only when the story truly needs a wordless beat — the story is driven FIRST by the characters talking to each other, so almost every scene is a talking scene. A silent scene is valid ONLY if it carries a \"visualBeat\" field — a short description of what the viewer READS from the image with no dialogue (a look, an object, a gesture that tells the story wordlessly). A silent scene with no \"visualBeat\" is REJECTED. " +
  "There is NO narrator and NO voice-over. Every NON-silent scene still OPENS on a close-up of the character who starts speaking.";

// ---------------------------------------------------------------------------
// Dialogue polish pass (Rule 6) — a SEPARATE LLM pass over the generated dialogue.
// ---------------------------------------------------------------------------
export const DIALOGUE_POLISH_SYSTEM =
  "You are a dialogue polisher for a short-form vertical drama. You are given the episode's scenes with their spoken dialogue. " +
  "Rewrite the dialogue so it drives the story FORWARD through the characters talking to each other, keeping the SAME speakers and the SAME story beats, applying these rules: " +
  "(1) REMOVE any line where a character explains their own motive / feelings aloud ('I'm doing this because…', 'I feel…', 'the reason I…') — replace it with a line that IMPLIES the motive through subtext, action or a concrete detail. " +
  "(2) Make the conversation SUBSTANTIVE and LIFELIKE: a real back-and-forth where the characters actually answer each other — a line, a genuine reply, then a rejoinder — not one lone line per side. You MAY lengthen a scene's exchange (add a reply / rejoinder line so it reads like a real conversation) as long as you keep the same speakers and the same beat; never make a spoken scene silent and never drop the scene's beat. " +
  "(3) Let each line run its NATURAL spoken length — there is NO hard word cap. Lines may be full and lifelike, and a longer line is fine whenever the beat calls for it (dialogue should read like real, substantive speech, not clipped fragments); only cut empty filler, hedges and throat-clearing so every line carries real meaning. Match a line's length to how long it is actually spoken on screen — a line should take about as long to say aloud as its moment in the clip allows, never so long it could not be spoken in the time available. " +
  "(4) Favour SUBTEXT over on-the-nose statement: characters say less than they mean, but the exchange still clearly moves the plot (a reveal, a decision, an escalation). " +
  "(5) The dialogue stays STRICTLY ENGLISH (Latin letters only), one line per row in the exact format NAME (tone cue): \"line\", using the SAME speaker names as the input. " +
  "Return JSON: { \"scenes\": [ { \"number\": <int>, \"dialogue\": \"<the polished lines, \\n-separated>\" }, … ] } — one entry per NON-silent scene you changed; omit silent scenes.";

/**
 * The user message for the dialogue-polish pass. `voiceProfiles` (Stage 2, read DEFENSIVELY) maps a character
 * name → a short voice/speech description; when present the polisher also makes each character speak in their own
 * voice. When absent that clause is simply omitted (never invented).
 */
export function dialoguePolishUserPrompt(
  script: Pick<EpisodeScript, "scenes">,
  voiceProfiles?: Record<string, string> | null
): string {
  const scenes = script.scenes
    .map((s) => `SCENE ${s.number}${s.sceneKind ? ` (${s.sceneKind})` : ""}:\n${(s.dialogue ?? "").trim() || "[NO DIALOGUE]"}`)
    .join("\n\n");
  const profiles = voiceProfiles && Object.keys(voiceProfiles).length
    ? "\n\nVOICE PROFILES (make each character speak in THEIR own voice / speech tics):\n" +
      Object.entries(voiceProfiles)
        .map(([name, profile]) => `- ${name}: ${profile}`)
        .join("\n")
    : "";
  return `Polish the dialogue of these scenes per the rules. Keep the same speakers, line count and beats; return only the JSON.${profiles}\n\n${scenes}`;
}

// ---------------------------------------------------------------------------
// State-checklist CRITIC (Rule 8) — a targeted LLM judge, NOT regex / sentence counting.
// ---------------------------------------------------------------------------
export const STATE_CHECKLIST_CRITIC_SYSTEM =
  "You are a strict continuity critic. You are given ONE scene's frame-state text (a startState or endState). " +
  "Judge whether it explicitly covers ALL FIVE required checklist items: " +
  "(1) POSITION of each character, (2) EMOTION on each face, (3) PROP state, (4) LIGHT / TIME, (5) CAMERA. " +
  "Return JSON: { \"pass\": <true|false>, \"missingItem\": \"<the FIRST missing item, verbatim from the five names above, or empty string if all present>\" }. " +
  "An item counts as covered only if the text gives the concrete detail for it, not merely names it.";

export function stateChecklistCriticUserPrompt(state: string): string {
  return `Frame-state text to judge:\n\n${(state ?? "").trim() || "(empty)"}`;
}

/** Targeted retry note naming the missing checklist item (appended to the script brief on a critic failure). */
export function stateChecklistRetryNote(missingItem: string, sceneNumber?: number): string {
  const where = sceneNumber ? ` in scene ${sceneNumber}` : "";
  return `Your frame-state${where} is missing the required checklist item "${missingItem}". Rewrite EVERY startState / endState as the 5-item checklist and make sure "${missingItem}" is covered explicitly with concrete detail (≥150 words, all five items: POSITION of each character, EMOTION on each face, PROP state, LIGHT / TIME, CAMERA).`;
}

// ===========================================================================
// PURE HELPERS — asserted directly by scripts/test-stage166.ts (no network / LLM).
// ===========================================================================

/** Scene count is in the content-driven band [5, 8]. */
export const sceneCountInBounds = (n: number): boolean =>
  Number.isInteger(n) && n >= STAGE166_MIN_SCENES && n <= STAGE166_MAX_SCENES;

/** A single scene's duration is in the variable band [3, 15] s. */
export const sceneDurationInBounds = (d: number): boolean =>
  Number.isFinite(d) && d >= STAGE166_SCENE_MIN_SEC && d <= STAGE166_SCENE_MAX_SEC;

/** The whole episode's total duration is in the band [70, 100] s. */
export const episodeDurationTotalInBounds = (total: number): boolean =>
  Number.isFinite(total) && total >= STAGE166_EP_MIN_SEC && total <= STAGE166_EP_MAX_SEC;

/**
 * Resolve the cliffhanger type for the final scene. Read DEFENSIVELY: the seasonMap arrives in Stage 3 and may
 * be entirely absent, or present without a cliffhangerType — in every such case fall back to a generic
 * unresolved-image cliffhanger. `episodeNumber` selects the per-episode entry when the map is keyed by episode.
 */
export function resolveCliffhangerType(
  seasonMap?: { cliffhangerType?: string | null; episodes?: Array<{ number?: number; cliffhangerType?: string | null }> } | null,
  episodeNumber?: number
): string {
  const GENERIC = "unresolved-image";
  if (!seasonMap) return GENERIC;
  if (episodeNumber != null && Array.isArray(seasonMap.episodes)) {
    const ep = seasonMap.episodes.find((e) => e?.number === episodeNumber);
    const t = (ep?.cliffhangerType ?? "").trim();
    if (t) return t;
  }
  const top = (seasonMap.cliffhangerType ?? "").trim();
  return top || GENERIC;
}

/**
 * Resolve the single emotional-peak scene index for an episode. Uses the model's own `peakSceneIndex` when it is a
 * valid 1-based index into the scenes; otherwise defaults to the MIDDLE scene. Always returns a valid index in
 * [1, sceneCount] (or 0 for an empty episode).
 */
export function resolvePeakSceneIndex(script: Pick<EpisodeScript, "scenes"> & { peakSceneIndex?: number | null }): number {
  const n = script.scenes.length;
  if (n <= 0) return 0;
  const raw = script.peakSceneIndex;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= n) return raw;
  return Math.ceil(n / 2); // middle scene
}

/**
 * Resolve a scene's timeSkipBefore. Read DEFENSIVELY: the seasonMap (Stage 3) may be absent or omit the field,
 * in which case the answer is "none". A scene's OWN timeSkipBefore (from the script) takes precedence when valid.
 */
export function resolveTimeSkipBefore(
  scene?: { timeSkipBefore?: string | null } | null,
  seasonMap?: { episodes?: Array<{ number?: number; scenes?: Array<{ number?: number; timeSkipBefore?: string | null }> }> } | null,
  ctx?: { episodeNumber?: number; sceneNumber?: number }
): TimeSkip {
  if (scene && isTimeSkip(scene.timeSkipBefore)) return scene.timeSkipBefore;
  if (seasonMap && Array.isArray(seasonMap.episodes) && ctx?.episodeNumber != null && ctx?.sceneNumber != null) {
    const ep = seasonMap.episodes.find((e) => e?.number === ctx.episodeNumber);
    const sc = ep?.scenes?.find((s) => s?.number === ctx.sceneNumber);
    if (sc && isTimeSkip(sc.timeSkipBefore)) return sc.timeSkipBefore;
  }
  return "none";
}

/** A scene whose timeSkipBefore is not "none" must open with an establishing beat. */
export function requiresEstablishingBeat(scene?: { timeSkipBefore?: string | null } | null): boolean {
  return resolveTimeSkipBefore(scene) !== "none";
}

/**
 * Heuristic: does this opening TEXT read like exposition or a "character enters" opening (both forbidden in
 * scene 1)? Used both as a pre-check hint and by validateEpisodeScript. Kept deliberately conservative.
 */
export function looksLikeExpositionOpening(text: string): boolean {
  const t = (text ?? "").toLowerCase().trim();
  if (!t) return false;
  // "character enters / arrives / walks in", "the door opens", etc.
  if (/\b(enters?|entering|arrives?|arriving|walks?\s+(in|into|up)|steps?\s+(in|into|inside)|comes?\s+(in|into)|the door (opens|swings))\b/.test(t)) return true;
  // Exposition openings: naming/explaining/establishing rather than dropping into conflict.
  if (/\b(let me explain|as you (know|remember)|years ago|it all (began|started)|to understand|for context|meet\s+\w+|this is (the )?story|once upon a time|introduc(e|ing)|backstory|establishing (shot|the))\b/.test(t)) return true;
  return false;
}

/**
 * Average number of words per SPOKEN line in a dialogue block (speaker cues `NAME (tone):` stripped). Silent /
 * empty dialogue → 0. Used to check the ≤12-words polish rule. Self-contained (no season.ts import).
 */
export function averageDialogueLineWords(dialogue: string): number {
  const lines = (dialogue ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[^:"«»(]{1,60}?\s*(\([^)]*\))?\s*:\s*/, "").replace(/["«»]/g, "").trim())
    .filter((l) => l.length > 0 && !/^\[NO DIALOGUE\]$/i.test(l));
  if (!lines.length) return 0;
  const totalWords = lines.reduce((acc, l) => acc + l.split(/\s+/).filter(Boolean).length, 0);
  return totalWords / lines.length;
}

// ===========================================================================
// LLM FUNCTIONS — defensive (never throw); a failure returns the input unchanged / a pass.
// ===========================================================================

/** Minimal shape of lib/ai.ts chatJSON, injected so this module needs no runtime dependency on it. */
export type ChatJSONFn = <T>(system: string, user: string, opts?: { temperature?: number; maxTokens?: number; model?: string }) => Promise<T>;

/**
 * Rule 6 — run a SEPARATE polish pass over the episode's dialogue and store the polished lines back onto the
 * scenes. Defensive: any error (or a malformed response) returns the ORIGINAL script unchanged. Silent scenes
 * are left untouched. Only overwrites a scene's dialogue when the polished text is non-empty and still English.
 */
export async function polishEpisodeDialogue(
  script: EpisodeScript,
  chatJSON: ChatJSONFn,
  opts: { voiceProfiles?: Record<string, string> | null } = {}
): Promise<EpisodeScript> {
  try {
    const isLatin = (s: string) => !/[\u0400-\u04FF\u0500-\u052F]/.test(s); // reject Cyrillic (keep English)
    const res = await chatJSON<{ scenes?: Array<{ number?: number; dialogue?: string }> }>(
      DIALOGUE_POLISH_SYSTEM,
      dialoguePolishUserPrompt(script, opts.voiceProfiles),
      { temperature: 0.4, maxTokens: 8000 }
    );
    const byNumber = new Map<number, string>();
    for (const s of res?.scenes ?? []) {
      if (typeof s?.number === "number" && typeof s?.dialogue === "string") {
        const polished = s.dialogue.trim();
        // Never accept a rewrite that is empty, non-English, or that would SILENCE the scene ("[NO DIALOGUE]").
        if (polished && isLatin(polished) && !/^\[NO DIALOGUE\]$/i.test(polished)) byNumber.set(s.number, polished);
      }
    }
    if (!byNumber.size) return script;
    const scenes = script.scenes.map((sc) => {
      const polished = byNumber.get(sc.number);
      // Never turn a spoken scene silent, never touch a silent scene.
      if (!polished || /^\[NO DIALOGUE\]$/i.test((sc.dialogue ?? "").trim())) return sc;
      return { ...sc, dialogue: polished };
    });
    return { ...script, scenes };
  } catch (err) {
    console.error("[stage166] polishEpisodeDialogue failed (keeping original dialogue):", err);
    return script;
  }
}

/**
 * Rule 8 — verify ONE frame-state checklist with an LLM critic. Returns { pass, missingItem }. Defensive: any
 * error returns { pass: true } (a critic outage must never block the job). An empty state trivially fails.
 */
export async function judgeStateChecklist(
  state: string,
  chatJSON: ChatJSONFn
): Promise<{ pass: boolean; missingItem: string }> {
  const text = (state ?? "").trim();
  if (!text) return { pass: false, missingItem: STATE_CHECKLIST_ITEMS[0] };
  try {
    const res = await chatJSON<{ pass?: boolean; missingItem?: string }>(
      STATE_CHECKLIST_CRITIC_SYSTEM,
      stateChecklistCriticUserPrompt(text),
      { temperature: 0, maxTokens: 400 }
    );
    return { pass: res?.pass !== false, missingItem: (res?.missingItem ?? "").trim() };
  } catch (err) {
    console.error("[stage166] judgeStateChecklist failed (treating as pass):", err);
    return { pass: true, missingItem: "" };
  }
}
