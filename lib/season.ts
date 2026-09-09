/**
 * Stage 2 — season script generator: schemas, prompts, validation, rendering, cost plan.
 * Pure (no DB) so it can be unit-tested; the worker in lib/workers/season-script-job.ts persists results.
 */
import { z } from "zod";
import { LANGUAGE_NAMES, type IdeaLanguage, type CharacterCard } from "@/lib/idea";
import { VISUAL_STYLE } from "@/lib/visual-style";
import { POWER_TIER_CONFIG, SEEDANCE_MAX_DURATION, type PowerTier } from "@/lib/power-tier";

/** Stage 4: nobody is asked for a running time — the story decides. These are only sanity bounds for the LLM output. */
export const SEASON_MIN_EPISODES = 3;
export const SEASON_MAX_EPISODES = 12;
export const SEASON_DEFAULT_EPISODES = 8;
export const EPISODE_MIN_SCENES = 6;
export const EPISODE_MAX_SCENES = 15;
/** Brisk English speech with overlapping replies ≈ 2.7 words/s; a clip must be filled with speech (≥ 2 words/s). */
export const SPEECH_WORDS_PER_SEC = 2.7;
export const MIN_WORDS_PER_SEC = 2;
export const SCENE_MIN_SECONDS = 15;
/** Seedance 2.5 real maximum (30 s) — every dialogue scene is planned at the maximum the model allows. */
export const SCENE_MAX_SECONDS = SEEDANCE_MAX_DURATION;
/** Spoken words that fit into a ≤15s clip (≈2.5 words/s incl. pauses). */
/** Dialogue is the product: every talking scene carries a substantive exchange of this many sentences. */
export const TALK_MIN_SENTENCES = 5;
export const TALK_MAX_SENTENCES = 7;
/** Purely visual scenes allowed per episode (soft limit). */
export const MAX_SILENT_SCENES = 2;
export const ARC_ROLES = ["завязка", "развитие", "поворот", "финал"] as const;

export const episodeOutlineSchema = z.object({
  number: z.number().int().min(1),
  title: z.string().min(1),
  logline: z.string().min(10),
  locationName: z.string().min(1),
  locationDesc: z.string().min(20),
  characters: z.array(z.string().min(1)).min(1),
  arcRole: z.enum(ARC_ROLES),
  cliffhanger: z.string().min(5),
});
export const seasonStructureSchema = z.object({
  title: z.string().min(1),
  logline: z.string().min(10),
  episodes: z.array(episodeOutlineSchema).min(SEASON_MIN_EPISODES).max(SEASON_MAX_EPISODES),
});
export type SeasonStructure = z.infer<typeof seasonStructureSchema>;
export type EpisodeOutline = z.infer<typeof episodeOutlineSchema>;

export const sceneScriptSchema = z.object({
  number: z.number().int().min(1),
  shotType: z.string().min(3),
  /** Advisory only: the real clip length is computed from the dialogue (see estimateDurationSec). */
  durationSec: z.coerce.number().int().min(1).max(120).optional().default(SCENE_MAX_SECONDS),
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
  /** "narration" = off-screen voice-over scene (b-roll under narration, no talking heads); "dialogue"/undefined = normal on-camera scene. */
  sceneKind: z.enum(["dialogue", "narration"]).optional().default("dialogue"),
  videoPrompt: z.string().min(40),
  // Stage 11 — scene-to-scene CONTINUITY metadata (all optional so pre-Stage-11 scripts still validate).
  /** Who is present and WHERE at the START of the scene, carried over from the previous scene's ending. */
  presence: z.string().optional(),
  /** Who enters or leaves DURING the scene and HOW (walks in, gets up and crosses, steps out) — the shown movement. */
  entrances: z.string().optional(),
  /** How this scene links to the previous one: same-location-continuation | character-moves | location-change | new-sequence. */
  continuesFrom: z.string().optional(),
});
export const episodeScriptSchema = z.object({
  visualIdentity: z.string().min(10),
  scenes: z.array(sceneScriptSchema).min(EPISODE_MIN_SCENES).max(EPISODE_MAX_SCENES),
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
 * Clip length from the script itself: spoken words at a brisk pace + a little room for the action beat,
 * rounded into the 15–30 s window Seedance 2.5 supports. No one is asked for a running time.
 */
export function estimateDurationSec(dialogue: string, action = ""): number {
  const words = spokenWordCount(dialogue);
  if (!words) return SCENE_MIN_SECONDS;
  const actionBeat = Math.min(4, Math.ceil(action.trim().split(/\s+/).filter(Boolean).length / 12));
  const sec = Math.ceil(words / SPEECH_WORDS_PER_SEC) + 1 + actionBeat;
  return Math.min(SCENE_MAX_SECONDS, Math.max(SCENE_MIN_SECONDS, sec));
}

/** Pace / camera / performance directions shared by the script prompts and the final Seedance prompt. */
export const PACE_DIRECTION =
  "PACE: fast, tight rhythm — lines follow each other with NO pauses, the listener answers instantly, interrupts, overlaps with reactions; nobody waits for a turn. " +
  "No long silent beats, no slow-motion, no empty establishing seconds at the start: the first line is spoken within the first second. " +
  "CAMERA: 2–4 cuts inside the clip, all on WIDE and MEDIUM scales — wide two-shot showing both characters full-figure in the location → medium two-shot / over-the-shoulder that still shows the environment and the space between the characters → medium reaction shot with the setting visible; hard cuts, no slow pans, no lingering. " +
  "FRAMING: characters SPEAK on wide and medium shots — the frame keeps the full or half figures, hands and the surrounding location visible at all times. DO NOT push in to a full-screen face close-up; the face never fills the screen. The tightest allowed framing is a medium close-up (head and shoulders WITH clear environment behind), used only briefly and rarely — most of every talking clip stays on wide / medium two-shots. " +
  "STAGING: never two people simply standing face to face talking. Place the characters NATURALLY in the space according to what the location is — at different distances and heights, one seated one standing, side by side at a counter/window/rail, one crossing the room while the other stays, angled to the environment rather than squared off to each other — and let them shift position and use the location's objects as they talk. " +
  "PERFORMANCE: expressive, energetic acting — vivid facial expressions, lively hand gestures, emotional nuance in the voice (a catch in the voice, a quiet bitter laugh, controlled intensity), eye contact and reactions while the other speaks.";

/** Wording that the video model's moderation (Seedance E005) flags — shared by all script prompts. */
export const MODERATION_SAFE_RULE =
  "MODERATION-SAFE WORDING (the video model rejects scenes otherwise): never describe explicit violence, hitting, grabbing, shoving, choking, weapons, blood, wounds, injuries, death on screen, children in danger, nudity, intimacy or sex, drugs, self-harm, or police brutality. " +
  "Express conflict through DIALOGUE, faces, distance between the characters and staging (turning away, stepping closer, holding an object, leaving the room) — the [ACTION]/[NON-VERBAL] lines contain no physical contact between characters and no physical danger, and tone cues stay neutral or emotional (\"firmly\", \"holding back tears\", \"quietly\") rather than aggressive (\"screaming\", \"violently\").";

/** The location is a physical space the characters inhabit, never a flat backdrop — shared by all script prompts. */
export const LOCATION_PRESENCE_RULE =
  "LOCATION PRESENCE: the location is NOT a backdrop — the characters are physically INSIDE it and interact with it in every scene: they walk through it, sit on, lean against, open, pick up and put down its concrete objects and surfaces ([BLOCKING] and [ACTION] name those objects), and the shots use depth (foreground object → characters → background of the same place). " +
  "The cut list shows the SAME location from several different angles and distances (e.g. from the doorway, from behind the counter, low over a table) so the place reads as a real three-dimensional space; across the episode different scenes explore different corners of it. Never a character isolated against a blurred wall. " +
  "The place is ALIVE: the mid-ground and background carry natural, believable activity appropriate to it — passers-by, other people at work or waiting, moving vehicles, animals, working machines, curtains and papers moving in a draught, screens and signs glowing, weather (rain, wind, dust) — described in [ACTION]/[BLOCKING] as SECONDARY background life behind the speakers (use CROWD groups from the cast where the place plausibly gathers people). The leads stay in the foreground and clearly framed; the background activity never blocks them or the lip-sync.";

/** Scenes must feel spacious and three-dimensional — the whole location is used, characters move through it. */
export const SCALE_DEPTH_RULE =
  "SCALE & DEPTH: the scene must feel SPACIOUS, never shot 'in two square metres'. The action and dialogue play out across DIFFERENT zones of the location and IN MOTION — characters move between zones as they talk (from the window to the table, from the room into the corridor, along the street, up the stairs, from the counter to the door), so a scene is not two heads pinned in one spot. " +
  "The cut list mixes SHOT SCALES: open every scene with a WIDE or ESTABLISHING beat that shows the room/street and how far it extends, use TWO-SHOTS and medium shots that keep the environment and the distance between characters visible, and keep dialogue on these wider scales — NO full-screen face close-ups (a brief medium close-up with the environment still behind is the tightest allowed). " +
  "Build real DEPTH in every shot: a clear foreground element, the characters in the mid-ground, and a deep background of the same place (a corridor receding, a street stretching away, a window onto more space) — the frame should read as a large three-dimensional place with air around the people, not a flat wall behind them.";

/** Every speaking character is DOING something physical and ordinary, not just talking. */
export const EVERYDAY_BEHAVIOR_RULE =
  "CHARACTERS ACT (not talking heads): parallel to their lines every character performs concrete, ordinary, natural business — walking, sitting down and standing up, pouring and drinking, eating, picking up / holding / putting down objects, opening a door or a window, typing or sending a message on a phone, sorting papers, wiping a surface, adjusting clothes or hair, twirling a pen, laughing, shrugging, glancing at a watch, fidgeting. " +
  "[BLOCKING] and [NON-VERBAL] must give EACH speaker a specific piece of business tied to the location's objects — nobody just stands and speaks. The micro-actions are moderation-safe (no violence, no danger, no physical contact between characters) and lip-sync-safe (the speaker's face stays clearly in frame while they talk). These everyday actions run WITH the dialogue, adding realism and motion, not replacing the spoken exchange.";

/** Creative bar for the story itself — shared by the season, episode, trailer and revise prompts. */
export const CREATIVE_RULE =
  "CREATIVE BAR: the story must be gripping, not generic — every scene contains a concrete reversal, revelation, decision or raised stake (a secret, a lie exposed, an ultimatum, an unexpected ally, a choice with a price). " +
  "Avoid clichéd phrasing and predictable beats; give each character a distinct voice, a want and a fear, and use specific, sensory details of the location as dramatic tools. " +
  "Every scene ends on a micro-hook that pulls the viewer into the next shot; the episode ends on a cliffhanger the audience did not see coming but that follows from what was planted.";

/** Scene-to-scene continuity — the episode is ONE connected action, characters never teleport. Shared by all script prompts. */
export const CONTINUITY_RULE =
  "SCENE-TO-SCENE CONTINUITY: the episode is ONE CONTINUOUS, CONNECTED chain of action — characters NEVER teleport, pop into frame or vanish between scenes. Each scene begins from the EXACT physical situation the previous scene ended in (who was in the room, where they stood or sat, what they were holding, who was mid-move). " +
  "SAME SPOT: when a scene continues in the same place as the previous one, the characters KEEP the positions and business they held at the end of the last scene and simply carry on — no silent reset to a new arrangement. " +
  "MOVEMENT IS SHOWN: whenever someone ENTERS or LEAVES, or the action moves to another zone of the location or to a new place, that movement is SHOWN and motivated on screen — a character rises and crosses the room, opens a door and walks in, arrives through the entrance, steps out and we watch them go, walks down the corridor into the next space — never an instant jump to a new setup with different people already in place. " +
  "CHANGING PARTNER: if the hero starts talking to someone new, SHOW the hand-off — where the previous person went (left, turned back to work, stayed behind) and how the hero got to the next person. " +
  "Write these entrances, exits and moves explicitly into [BLOCKING], [ACTION] and [TRANSITION] so the video model ANIMATES the change of who-is-where, instead of cutting to a static new arrangement. Nobody appears or disappears without the camera showing how.";

const PROMPT_LINES = ["[SHOT TYPE]", "[VISUAL STYLE]", "[LIGHTING]", "[BLOCKING]", "[GAZE]", "[NON-VERBAL]", "[ACTION]", "[CHARACTER]", "[TRANSITION]"];

/** Problems prefixed "soft:" are logged but never fail a script (drift in density / sentence count / camera wording). */
export const isSoftProblem = (p: string) => p.startsWith("soft:");
export const hardProblems = (problems: string[]) => problems.filter((p) => !isSoftProblem(p));

/** Non-throwing validation of an episode script: returns human-readable problems (empty = ok; "soft:" = warning only). */
export function validateEpisodeScript(script: EpisodeScript): string[] {
  const problems: string[] = [];
  const n = script.scenes.length;
  if (n < EPISODE_MIN_SCENES || n > EPISODE_MAX_SCENES) problems.push(`scene count ${n} not in ${EPISODE_MIN_SCENES}–${EPISODE_MAX_SCENES}`);
  // A narration scene (off-screen voice-over) carries an English narration track, so it is NOT a "silent" scene
  // and must never count against the silent budget — only truly empty on-camera scenes do.
  const isNarration = (s: SceneScript) => s.sceneKind === "narration" && !!(s.voiceover ?? "").trim();
  const silent = script.scenes.filter((s) => isSilent(s.dialogue) && !isNarration(s)).length;
  if (silent > MAX_SILENT_SCENES) problems.push(`soft: too many silent scenes: ${silent} (max ${MAX_SILENT_SCENES})`);
  const speaking = script.scenes.filter((s) => !isSilent(s.dialogue) || isNarration(s)).length;
  if (speaking < 1) problems.push("no dialogue in episode");
  script.scenes.forEach((s, i) => {
    if (s.number !== i + 1) problems.push(`scene ${i + 1} numbered ${s.number}`);
    // Narration scenes are exempt from on-camera dialogue-density checks (they carry narration, not spoken lines),
    // but they STILL need a complete videoPrompt with all tags — so only skip the dialogue checks.
    if (!isNarration(s)) {
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
  return {
    ...script,
    scenes: script.scenes.map((s, i) => {
      const narrationText = (s.voiceover ?? "").trim();
      const isNarr = s.sceneKind === "narration" && !!narrationText;
      return {
      ...s,
      number: i + 1,
      // Narration clips are paced by the length of the spoken narration, normal clips by the dialogue.
      durationSec: isNarr ? estimateDurationSec(narrationText, s.action) : estimateDurationSec(s.dialogue, s.action),
      dialogue: s.dialogue.trim() || "[NO DIALOGUE]",
      dialogueLocal: (s.dialogueLocal ?? "").trim() || undefined,
      // Stage 12 (Commit D) — normalize off-screen narration fields.
      sceneKind: isNarr ? "narration" : "dialogue",
      voiceover: isNarr ? narrationText : undefined,
      voiceoverLocal: isNarr ? ((s.voiceoverLocal ?? "").trim() || undefined) : undefined,
      videoPrompt: repairPrompt(s),
      // Stage 11 — carry continuity metadata through; scene 1 always starts a sequence.
      presence: (s.presence ?? "").trim() || undefined,
      entrances: (s.entrances ?? "").trim() || undefined,
      continuesFrom: (s.continuesFrom ?? "").trim() || (i === 0 ? "new-sequence" : undefined),
      };
    }),
  };
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
        return { ...s, dialogue: t, dialogueLocal: s.dialogueLocal && isEnglishDialogue(s.dialogueLocal) ? s.dialogue : (s.dialogueLocal ?? s.dialogue), durationSec: estimateDurationSec(t, s.action) };
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
export type LocationRef = { name: string; description?: string | null; visualPrompt?: string | null };
function locationsBlock(locations: LocationRef[]) {
  return locations.map((l) => `- ${l.name}: ${l.description ?? ""}${l.visualPrompt ? ` / ${l.visualPrompt}` : ""}`).join("\n");
}
/** Resolve an LLM location name to a project Location (same fuzzy rule as matchCharacter). */
export function matchLocation<T extends { name: string }>(locations: T[], raw: string): T | undefined {
  return matchCharacter(locations, raw);
}

export function seasonStructureSystemPrompt(language: IdeaLanguage, episodeCount = SEASON_DEFAULT_EPISODES): string {
  return `You are a showrunner planning ONE season of a short-form vertical drama series (9:16 video, each episode = ${EPISODE_MIN_SCENES}–${EPISODE_MAX_SCENES} fast-paced dialogue shots of 15–30 seconds).
Return STRICT JSON: {"title": string, "logline": string, "episodes": [{"number": int, "title": string, "logline": string, "locationName": string, "locationDesc": string, "characters": [names], "arcRole": "завязка"|"развитие"|"поворот"|"финал", "cliffhanger": string}]}.
RULES:
- The NUMBER OF EPISODES is dictated by the story itself: as many as the synopsis genuinely needs to be told with tension and without padding (allowed range ${SEASON_MIN_EPISODES}–${SEASON_MAX_EPISODES}; most stories land at 6–10). Nobody sets a running time — you judge it from the material. Episode 1 = завязка, last = финал, at least one поворот in the second half.
- Each episode has ONE key location. "locationName" MUST be one of the given LOCATIONS, copied verbatim (they already have reference images). Only if the story truly needs a place that is not in the list may you invent a new one (then give it a new name) — at most 2 new locations per season. "locationDesc" is a DETAILED English visual description (2–4 sentences: architecture, materials, textures, props, weather, light, color palette, time of day) usable verbatim by an image/video model — for a listed location, expand its given description. "locationName" is in ${langName(language)}.
- Use ONLY the given character names (verbatim; a CROWD group name counts as a character). Every episode lists 2–6 characters actually present: the MAIN characters carrying it plus the SUPPORTING characters (family, colleagues, rivals) involved. Across the season EVERY SUPPORTING character appears in at least one episode, MINOR characters and CROWD groups are used where the story plausibly gathers people (family dinners, workplaces, hospitals, streets, court, celebrations).
- Each logline is 2–3 sentences of concrete dramatic events (who wants what, what goes wrong). Cliffhanger = the final beat that forces the viewer into the next episode. No summaries like "tension rises".
- Continuous story: consequences carry over episode to episode; no repetition.
- ${CREATIVE_RULE}
- ${MODERATION_SAFE_RULE}
- Locations are LARGE, LIVING spaces to be used physically: describe in "locationDesc" a place with several distinct zones the characters move between and the concrete objects, furniture, surfaces and corners they interact with, plus the natural background life of the place (who else is around, what moves, the weather) so it never reads as a flat backdrop. Pick VARIED key locations across the season — interiors and exteriors, private and public, different scales and times of day.
- All text except "locationDesc" is in ${langName(language)}. Character names stay exactly as given (Western names in Latin letters). Original content: never reuse names, plots or lines of existing films/series.`;
}
export function seasonStructureUserPrompt(synopsis: string, characters: CharacterCard[], locations: LocationRef[] = []): string {
  return `SYNOPSIS:\n${synopsis}\n\nCHARACTERS (with tiers):\n${charactersBlock(characters)}\n\nLOCATIONS (use these names verbatim):\n${locations.length ? locationsBlock(locations) : "(none defined — invent 8–14 diverse locations and reuse them across episodes)"}`;
}

export function episodeScriptSystemPrompt(language: IdeaLanguage, episodeNumber = 1): string {
  const L = langName(language);
  const local = language !== "en";
  const isFirst = episodeNumber <= 1;
  const isSecond = episodeNumber === 2;
  // Off-screen narrator backstory: MANDATORY opening for episode 1, OPTIONAL light catch-up for episode 2, none after.
  const narrationRule = isFirst
    ? `\nR7. OPENING NARRATION (MANDATORY for this episode — it is EPISODE 1): scene 1 is an off-screen NARRATOR voice-over that sets up the backstory/world before the drama starts. For that scene set "sceneKind": "narration", put 2–4 sentences of English backstory narration in "voiceover"${local ? ` and its ${L} translation in "voiceoverLocal"` : ""}, and set "dialogue": "[NO DIALOGUE]" (there is NO on-camera talking). Its "videoPrompt" is ATMOSPHERIC ESTABLISHING B-ROLL that plays UNDER the narration — sweeping/observational shots of the location and world, NO talking heads, NO character mouths moving, NO lip-sync; it still contains all 9 [..] lines (the [CHARACTER] line describes anyone glimpsed, and characters may appear in the distance doing ordinary things but NOT speaking). From scene 2 onward the episode is normal on-camera dialogue as usual. Every OTHER scene keeps "sceneKind": "dialogue".`
    : isSecond
      ? `\nR7. OPTIONAL CATCH-UP NARRATION: only IF it genuinely helps the viewer, scene 1 MAY be a short off-screen NARRATOR voice-over recapping what matters from earlier (1–3 sentences). If you use it, set "sceneKind": "narration", put the English narration in "voiceover"${local ? ` and its ${L} translation in "voiceoverLocal"` : ""}, "dialogue": "[NO DIALOGUE]", and make its "videoPrompt" atmospheric establishing b-roll (no talking heads, no lip-sync). This is NOT required — most episodes open straight on dialogue. Every non-narration scene keeps "sceneKind": "dialogue".`
      : `\nR7. NO opening narration in this episode — open straight on on-camera dialogue. Every scene keeps "sceneKind": "dialogue".`;
  return `You are a film director + cinematographer writing the FULL shooting script of ONE episode (EPISODE ${episodeNumber}) of a short-form VERTICAL drama (9:16). The episode is ${EPISODE_MIN_SCENES}–${EPISODE_MAX_SCENES} consecutive shots ("scenes"), each 15–${SCENE_MAX_SECONDS} seconds, generated by an AI video model WITH native speech: characters really speak their lines out loud, so the DIALOGUE IS THE PRODUCT. A scene without dialogue is a wasted shot (the ONLY exception is a narration scene — see R7).

Return STRICT JSON: {"visualIdentity": string, "scenes": [{"number": int, "shotType": string, "durationSec": int, "locationDesc": string, "characters": [names], "action": string, "sceneKind": "dialogue"|"narration", "dialogue": string${local ? ', "dialogueLocal": string' : ""}, "voiceover": string, ${local ? '"voiceoverLocal": string, ' : ""}"videoPrompt": string, "presence": string, "entrances": string, "continuesFrom": string}]}. ("voiceover"${local ? '/"voiceoverLocal"' : ""} is used ONLY for narration scenes; leave it "" for normal scenes.)

HARD RULES (the script is REJECTED automatically if any is broken):
R1. The NUMBER OF SCENES follows the drama of this episode's logline (min ${EPISODE_MIN_SCENES}, max ${EPISODE_MAX_SCENES}) — no padding, no filler. Nobody sets a running time: each scene lasts exactly as long as its dialogue needs (15–${SCENE_MAX_SECONDS} s at a brisk ~2.7 words/s; "durationSec" = round(words / 2.7) + 2, clamped to 15–${SCENE_MAX_SECONDS}). All scenes happen in/around the episode's key location; scene 1 may open on a wide shot but someone is ALREADY talking in it (UNLESS R7 makes scene 1 an off-screen narration scene).
R2. AT MOST ${MAX_SILENT_SCENES} scenes in the whole episode may be silent ("[NO DIALOGUE]"). ALL OTHER SCENES contain a real spoken exchange. (A narration scene from R7 does NOT count as silent — it carries an English narration track, not on-camera dialogue.)${narrationRule}
R3. A talking scene = a SUBSTANTIVE exchange of ${TALK_MIN_SENTENCES}–${TALK_MAX_SENTENCES} full sentences in total, spread over 3–6 lines where characters answer each other IMMEDIATELY (the story is told THROUGH the dialogue: decisions, accusations, confessions, information, subtext). Replies are quick, people interrupt and overlap; every second of the clip is filled with speech — at least ~35 words per talking scene (≥ 2 words per second of durationSec). Monologue or voice-over does NOT replace dialogue — when two people are in the shot they talk to each other; a lone character may talk on the phone or to someone off-screen. Short one-liners like "I have to know the truth." alone are REJECTED. One line per row, format: NAME (tone cue): "line". Tone cues like (sharply), (whispering), (holding back tears).
    "dialogue" is ALWAYS in ENGLISH — it is what the video model voices.${local ? ` "dialogueLocal" is the same lines translated into ${L}, same line structure and cues (shown to the author as the script text).` : ""}
    Example of a correct talking scene (6 sentences, 26 s):
    ANNA (quietly): "You knew he wasn't coming back and you still sent the boat? I waited on the pier till morning."
    VICTOR (not looking at her): "I sent the boat because otherwise we'd have lost both of them. You know that, even if you won't admit it."
    ANNA (sharply): "Don't you dare decide who I get to lose. Tomorrow I'm going out to sea myself, and you won't stop me."
R4. "videoPrompt" and "visualIdentity" are ENTIRELY in ENGLISH (every one of the 9 lines — never ${L}, even though locationDesc/action are in ${L}). "videoPrompt" consists of EXACTLY these 9 lines, each on its own row, in this order, each starting with its bracket tag:
    [SHOT TYPE]: the CUT LIST inside the clip — 2–4 hard cuts that MIX SHOT SCALES and cover the SPACE, e.g. "0–6s wide establishing shot of the whole workshop, Anna crossing from the door to the bench as she speaks → 6–13s medium two-shot at the bench, the deep room behind them → 13–20s over-the-shoulder on Victor toward the window → 20–26s medium reaction on Anna, corridor receding behind her"; open on a WIDE/ESTABLISHING beat, keep TWO-SHOTS and mediums that show the environment and the distance between characters, use depth (foreground → characters → deep background); vertical 9:16; characters SPEAK on wide/medium shots — NO full-screen face close-up, the face never fills the screen, the tightest cut is a medium close-up with clear environment behind and used only briefly; bodies, hands and the location stay visible in every cut; the two characters are placed NATURALLY in the space (different distances/heights, seated/standing, along a counter or rail, one crossing while the other stays) — never squared off face to face; NO slow pans, NO lingering, NO slow motion
    [VISUAL STYLE]: the short visualIdentity sentence — the SAME text in every scene
    [LIGHTING]: time of day, light sources, weather — IDENTICAL wording in every scene of the episode (the whole episode is one continuous time; the location references lock the light, only the camera angle changes)
    [BLOCKING]: where each character stands and MOVES across the location as they talk — the concrete objects, surfaces and ZONES they use and travel between (rises from the crate and crosses to the window, leans on the counter then walks to the door); EACH speaker gets a specific piece of ordinary business tied to those objects (pours a drink, sorts papers, checks a phone), and DIFFERENT zones of the place are used, not one spot
    [GAZE]: where each character looks, eye contact and reaction while the other speaks
    [NON-VERBAL]: EXPRESSIVE acting + EVERYDAY micro-actions — concrete facial expressions, lively hand gestures, breathing, emotional nuance (a catch in the voice, a quiet bitter laugh, controlled intensity), PLUS the natural physical business each speaker is doing (drinking, holding an object, typing, adjusting a collar, laughing); no physical contact between characters
    [ACTION]: what physically happens in the shot, brisk — the leads moving THROUGH the location and handling objects in the foreground, AND believable SECONDARY background life making the place alive (passers-by, others at work, vehicles, animals, machines, weather); never hitting, grabbing, weapons or danger
    [CHARACTER]: for EVERY visible character: name, age, hair, skin, build, EXACT clothing for this episode — identical word for word in every scene of the episode
    [TRANSITION]: a hard cut into the next shot (no fades, no pauses)
    The [CHARACTER] line is MANDATORY in every scene. Never put spoken text into the videoPrompt. Never use the words "slowly", "slow motion", "lingering", "long pause".

STYLE RULES:
S1. ${PACE_DIRECTION}
S2. LIP-SYNC BIAS: talking scenes cut between Wide two-shot / Medium shot / Over-the-shoulder with the speaker's face clearly visible for lip-sync — but the face NEVER fills the screen: NO full-screen face close-ups, the tightest framing is a medium close-up (head and shoulders WITH clear environment behind) used only briefly, and most of each talking scene stays on wide / medium two-shots with bodies and the location in frame. Never two characters squared off face to face — stage them naturally in the location (different distances/heights, seated/standing, along a counter or rail, one moving while the other stays).
S7. ${MODERATION_SAFE_RULE}
S8. ${CREATIVE_RULE}
S9. ${LOCATION_PRESENCE_RULE}
S10. ${SCALE_DEPTH_RULE}
S11. ${EVERYDAY_BEHAVIOR_RULE}
S12. DYNAMIC TEXT: the episode ALTERNATES between talk-driven beats and active, physical beats — never a run of static conversations. Every scene carries an EVENT that moves the plot (a decision, a discovery, an arrival, a reversal) and combines DIALOGUE WITH ACTION so the script reads lively and cinematic, not like talking heads. The "action" line names a concrete physical event happening in the scene, not a mood.
S13. ${CONTINUITY_RULE}
    Write the whole episode as ONE unbroken chain: read your previous scene's ending before you write the next scene, and open the next scene from exactly that state. For EVERY scene ALSO fill three short ENGLISH continuity fields (outside the videoPrompt):
    - "presence": who is on screen and WHERE at the very start of this scene, carried over from how the previous scene ended (e.g. "Anna still at the workbench where scene 2 left her, Victor just having entered from the yard"). For scene 1, describe the opening arrangement.
    - "entrances": who ENTERS or LEAVES during this scene and HOW it is shown (e.g. "Victor crosses from the door to the bench; Marco steps out into the corridor"), or "none" if the cast in frame does not change.
    - "continuesFrom": ONE of "same-location-continuation" (same spot, characters carry on) | "character-moves" (a character walks to a new zone / another character) | "location-change" (the action moves to a new place, shown by someone travelling there) | "new-sequence" (a deliberate time/place jump — use rarely, and still motivate it). Scene 1 = "new-sequence".
    The [BLOCKING], [ACTION] and [TRANSITION] lines of the videoPrompt must MATCH these fields — showing the entrances, exits and moves — so characters never appear or disappear between shots.
S3. "locationDesc": "INT/EXT — place — time of day" in ${L}. "action" (1–2 sentences) in ${L}.
S4. "visualIdentity": ONE SHORT English sentence (max 25 words) — photoreal live-action look, color palette, lens/grain feel of this episode. Keep it short: it is repeated in every scene.
S5. Use ONLY the given character names (Western names, Latin letters, exactly as given). "characters" lists the names visible in the shot (a CROWD group name is listed when the group is in frame). SUPPORTING and MINOR characters present in the episode must actually speak in at least one scene each; crowds may have a short collective line or reactions.
S6. Dramatize ONLY this episode's logline — a natural continuation of the previous episodes, ending on this episode's cliffhanger (the last scene IS the cliffhanger). Original content only: never reuse names, plots or lines of existing films/series.

Before answering, check: scenes count ${EPISODE_MIN_SCENES}–${EPISODE_MAX_SCENES}; silent scenes ≤ ${MAX_SILENT_SCENES}; each talking scene has ${TALK_MIN_SENTENCES}–${TALK_MAX_SENTENCES} English dialogue sentences and ≥ 2 words per second; every videoPrompt has all 9 tags including [CHARACTER] and a cut list in [SHOT TYPE] that opens wide and mixes shot scales across the space; [BLOCKING] moves characters between different zones and gives each speaker ordinary business; [ACTION] adds secondary background life so the place feels alive; and EACH scene continues seamlessly from the previous one — "presence"/"entrances"/"continuesFrom" are filled and every entrance/exit/move is shown in [BLOCKING]/[ACTION]/[TRANSITION] so nobody teleports or vanishes.`;
}
export function episodeScriptUserPrompt(input: {
  synopsis: string;
  season: SeasonStructure;
  episode: EpisodeOutline;
  characters: CharacterCard[];
  previous: { number: number; title: string; logline: string; cliffhanger: string }[];
  instruction?: string;
}): string {
  const prev = input.previous.length
    ? input.previous.map((p) => `Ep.${p.number} «${p.title}»: ${p.logline} Cliffhanger: ${p.cliffhanger}`).join("\n")
    : "(this is the first episode)";
  const cast = input.characters.filter((c) => input.episode.characters.includes(c.name));
  return `SEASON «${input.season.title}»: ${input.season.logline}\nSYNOPSIS: ${input.synopsis}\n\nPREVIOUS EPISODES:\n${prev}\n\nTHIS EPISODE ${input.episode.number} «${input.episode.title}» (${input.episode.arcRole}):\n${input.episode.logline}\nCLIFFHANGER: ${input.episode.cliffhanger}\nLOCATION: ${input.episode.locationName} — ${input.episode.locationDesc}\n\nCHARACTERS IN THIS EPISODE:\n${charactersBlock(cast.length ? cast : input.characters)}${input.instruction ? `\n\nREVISION INSTRUCTION FROM THE AUTHOR (apply it, keep everything else coherent):\n${input.instruction}` : ""}`;
}

/** Readable script text stored in Episode.script. */
export function renderEpisodeScriptText(ep: EpisodeOutline, script: EpisodeScript): string {
  const head = `ЭПИЗОД ${ep.number}. ${ep.title}\n${ep.logline}\nЛокация: ${ep.locationName}\nПерсонажи: ${ep.characters.join(", ")}\n`;
  const body = script.scenes
    .map((s) => {
      const head2 = `\nСЦЕНА ${s.number}${s.sceneKind === "narration" ? " · ЗАКАДРОВЫЙ ГОЛОС" : ""} · ${s.shotType} · ~${s.durationSec}с\n${s.locationDesc}\n${s.action}`;
      if (s.sceneKind === "narration" && (s.voiceover ?? "").trim()) {
        const local = (s.voiceoverLocal ?? "").trim();
        return `${head2}\nЗакадровый голос: ${local || s.voiceover}${local && local !== s.voiceover ? `\n[EN voiceover]\n${s.voiceover}` : ""}`;
      }
      return `${head2}\n${s.dialogueLocal ?? s.dialogue}${s.dialogueLocal && s.dialogueLocal !== s.dialogue ? `\n[EN speech]\n${s.dialogue}` : ""}`;
    })
    .join("\n");
  return `${head}${body}\n\nКЛИФФХЭНГЕР: ${ep.cliffhanger}\n`;
}

/** Clip length for one scene: the scripted durationSec (new flow), clamped to what the tier/model allows. */
export function sceneClipSeconds(tier: PowerTier, plannedSec?: number | null): number {
  const cfg = POWER_TIER_CONFIG[tier];
  const max = Math.min(cfg.maxDuration, SCENE_MAX_SECONDS);
  const want = plannedSec && plannedSec > 0 ? plannedSec : max;
  return Math.min(max, Math.max(SCENE_MIN_SECONDS, cfg.baseDuration, Math.round(want)));
}
/** Credits for one clip of the given length — same rule as /api/ai/generate-video. */
export function sceneClipCost(tier: PowerTier, durationSec: number): number {
  const cfg = POWER_TIER_CONFIG[tier];
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
  scenes: { number: number; shotType?: string | null; durationSec?: number | null; locationDesc?: string | null; action?: string | null; dialogue?: string | null }[]
): string {
  const head = `ЭПИЗОД ${ep.number}. ${ep.title}\n${ep.logline ?? ""}\nЛокация: ${ep.locationName ?? ""}\nПерсонажи: ${characterNames.join(", ")}\n`;
  const body = scenes
    .map((s) => `\nСЦЕНА ${s.number} · ${s.shotType ?? ""} · ~${s.durationSec ?? SCENE_MAX_SECONDS}с\n${s.locationDesc ?? ""}\n${s.action ?? ""}\n${s.dialogue ?? "[NO DIALOGUE]"}`)
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
Return STRICT JSON: {"locationName": string (${langName(language)}), "locationDesc": string (detailed ENGLISH visual description, 2–4 sentences: architecture, materials, textures, props, weather, light, palette, time of day), "scenes": [{"number": int, "locationDesc": "INT/EXT — place — time" in ${langName(language)}, "videoPrompt": string}]}.
RULES: keep every scene's number, shot type, action, characters, [CHARACTER] descriptions and story beats; only change what the new location implies ([LIGHTING], set details in [BLOCKING]/[ACTION]/[SHOT TYPE], [VISUAL STYLE] stays identical). videoPrompt stays ENGLISH with exactly the 9 lines [SHOT TYPE]/[VISUAL STYLE]/[LIGHTING]/[BLOCKING]/[GAZE]/[NON-VERBAL]/[ACTION]/[CHARACTER]/[TRANSITION]. Return ALL scenes. Never add spoken text to videoPrompt. Original content only.`;
}

export const sceneReviseSchema = z.object({
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
});
export type SceneRevise = z.infer<typeof sceneReviseSchema>;

export function sceneReviseSystemPrompt(language: IdeaLanguage): string {
  const L = langName(language);
  const local = language !== "en";
  return `You are a film director rewriting ONE shot ("scene", ${SCENE_MIN_SECONDS}–${SCENE_MAX_SECONDS}s, vertical 9:16, AI video model with native speech) of an episode by the author's instruction.
Return STRICT JSON: {"shotType": string, "durationSec": int, "locationDesc": "INT/EXT — place — time" (${L}), "action": string (${L}), "dialogue": string${local ? ', "dialogueLocal": string' : ""}, "videoPrompt": string, "presence": string, "entrances": string, "continuesFrom": string}.
RULES: "dialogue" is ALWAYS in ENGLISH (it is what the model voices), one line per row NAME (tone cue): "line"; a talking scene has a substantive exchange of ${TALK_MIN_SENTENCES}–${TALK_MAX_SENTENCES} full sentences (3–6 quick lines, characters answer each other instantly; the story is told through the dialogue), or exactly "[NO DIALOGUE]" for a rare purely visual beat.${local ? ` "dialogueLocal" = the same lines translated into ${L}, same structure and cues.` : ""} durationSec = round(words / 2.7) + 2 clamped to ${SCENE_MIN_SECONDS}–${SCENE_MAX_SECONDS} (≥ 2 words per second — no timing is set by anyone else). Talking scenes stay on wide / medium two-shots / over-the-shoulder with the speaker's face visible for lip-sync but NEVER filling the screen — NO full-screen face close-ups (tightest is a brief medium close-up with environment behind); the two characters are placed naturally in the location, never squared off face to face. ${PACE_DIRECTION} ${MODERATION_SAFE_RULE} ${CREATIVE_RULE} ${LOCATION_PRESENCE_RULE} ${SCALE_DEPTH_RULE} ${EVERYDAY_BEHAVIOR_RULE} videoPrompt is ENGLISH, exactly 9 lines [SHOT TYPE] (cut list, 2–4 hard cuts with time ranges)/[VISUAL STYLE]/[LIGHTING]/[BLOCKING]/[GAZE]/[NON-VERBAL] (expressive acting)/[ACTION]/[CHARACTER]/[TRANSITION] (hard cut); keep [VISUAL STYLE] and [CHARACTER] descriptions identical to the given scene unless the instruction requires otherwise; no spoken text in videoPrompt; never "slowly", "slow motion", "lingering", "long pause". ${CONTINUITY_RULE} This shot must still begin from the PREVIOUS shot's ending and hand off cleanly into the NEXT shot (both are given below): keep the same people in place unless the instruction changes that, and if the revision adds or removes someone or moves the action, SHOW that entrance/exit/move. Fill "presence" (who is where at the start, following the previous shot), "entrances" (who enters/leaves during the shot and how, or "none") and "continuesFrom" (same-location-continuation | character-moves | location-change | new-sequence) to match the neighbouring shots. Original content only; Western names, Latin letters, exactly as given.`;
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
At every boundary between scene N and scene N+1 (and across the whole chain) look for: a character who is present or speaking in one scene but has silently VANISHED or TELEPORTED in the next with no shown exit/entrance; someone who suddenly APPEARS already in place without walking in; the physical arrangement (who is where, seated/standing, what they hold) resetting between a continuing same-location pair instead of carrying over; an object / prop / costume that changes or disappears illogically; time-of-day / lighting / weather that jumps without reason; an action left mid-motion at the end of one scene and not continued at the start of the next; a location change that is not motivated or shown. ${CONTINUITY_RULE}
Return STRICT JSON: {"scenes":[{"number": int, "hasIssue": boolean, "issue": string (short, ${L}, ONLY when hasIssue is true), "correctedVideoPrompt": string (ONLY when hasIssue is true)}]} — include EVERY scene number exactly once, in order. A scene that already flows correctly: {"number":N,"hasIssue":false}. A scene that breaks continuity: hasIssue=true, "issue" = ONE short sentence naming the seam problem, "correctedVideoPrompt" = the FULL rewritten prompt for THAT scene that fixes the transition — make the entrance / exit / move EXPLICIT in [BLOCKING], [ACTION] and [TRANSITION], and keep positions, props, lighting and time-of-day consistent with the END of the previous scene and the START of the next.
CORRECTED PROMPT RULES: exactly the 9 lines [SHOT TYPE]/[VISUAL STYLE]/[LIGHTING]/[BLOCKING]/[GAZE]/[NON-VERBAL]/[ACTION]/[CHARACTER]/[TRANSITION], ENGLISH, NO spoken text inside the videoPrompt, keep [VISUAL STYLE] and [CHARACTER] IDENTICAL to the given scene, preserve the scene's essence, its dialogue / narration and its duration; never "slowly", "slow motion", "lingering", "long pause". ${PACE_DIRECTION} ${MODERATION_SAFE_RULE} ${LOCATION_PRESENCE_RULE} Only flag REAL logical breaks — if the whole chain is already consistent, return every scene with hasIssue=false and change nothing. Original content only; Western names, Latin letters.`;
}

/** The ordered scene chain rendered for the auditor. */
export function episodeContinuityAuditUserPrompt(scenes: AuditSceneInput[]): string {
  const blocks = scenes.map((s) => {
    const isNarration = s.sceneKind === "narration";
    const speech = ((isNarration ? s.voiceover : s.dialogueEn) ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    return [
      `### Scene ${s.number}${isNarration ? " (off-screen narration)" : ""} — ${s.locationDesc ?? ""} — ~${s.durationSec ?? 15}s`,
      `presence: ${s.presence ?? "(none)"}`,
      `entrances: ${s.entrances ?? "(none)"}`,
      `continuesFrom: ${s.continuesFrom ?? "(none)"}`,
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
{"title": string, "logline": string, "episodes": [{"number": int, "title": string, "logline": string, "locationName": string, "locationDesc": string, "characters": [names], "arcRole": "завязка"|"развитие"|"поворот"|"финал", "cliffhanger": string}]}.
RULES:
- Keep EXACTLY ${episodeCount} episodes with the same numbers 1..${episodeCount}. Never add or remove episodes.
- MINIMAL CHANGE: copy every field of every episode VERBATIM unless the instruction (or story consistency it forces) requires changing it. Episodes that the instruction does not touch must be returned character-for-character identical — the system regenerates only episodes whose logline / arc / location / characters changed, and rewriting untouched episodes wastes the author's work.
- Use ONLY the given character names verbatim (a new character requested by the author is allowed only if it is present in the CHARACTERS list; otherwise weave the request into the existing cast). "locationName" should be one of the given LOCATIONS (verbatim); a new place only when the story truly needs it.
- Loglines are 2–3 sentences of concrete dramatic events; cliffhanger = the final beat. Keep continuity: consequences carry over episode to episode.
- ${CREATIVE_RULE}
- ${MODERATION_SAFE_RULE}
- All text except "locationDesc" is in ${langName(language)}; "locationDesc" is a detailed English visual description. Character names stay exactly as given (Western names in Latin letters).`;
}
export function seasonReviseUserPrompt(input: { synopsis: string; structure: SeasonStructure; characters: CharacterCard[]; locations: LocationRef[]; instruction: string }): string {
  return `SYNOPSIS:\n${input.synopsis}\n\nCHARACTERS (with tiers):\n${charactersBlock(input.characters)}\n\nLOCATIONS:\n${input.locations.length ? locationsBlock(input.locations) : "(none)"}\n\nCURRENT SEASON STRUCTURE (JSON):\n${JSON.stringify(input.structure, null, 1)}\n\nINSTRUCTION FROM THE AUTHOR:\n${input.instruction}`;
}

// ─── Stage 12: whole-season prose story ("Сюжет" screen) ─────────────────────────────
// The full story is ONE long text the author reads/edits BEFORE any asset or video is made.
// Episode boundaries are marked by fixed ASCII bars so the UI can find them in any language.
export const FULL_STORY_START_MARK = "═══";
export const FULL_STORY_END_MARK = "───";
export const seasonFullStorySchema = z.object({ fullStory: z.string().min(1) });
/** Story-screen revise returns BOTH the (possibly re-counted) structure and the rewritten prose. */
export const seasonStoryReviseSchema = seasonStructureSchema.extend({ fullStory: z.string().min(1) });
export type SeasonStoryRevise = z.infer<typeof seasonStoryReviseSchema>;

/** How many episode blocks a full-story text contains (counts the start-marker lines). */
export function countFullStoryEpisodes(text: string | null | undefined): number {
  if (!text) return 0;
  return text.split(/\r?\n/).filter((l) => l.trimStart().startsWith(FULL_STORY_START_MARK)).length;
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
${fullStoryFormatRules(language, episodeCount)}`;
}
export function seasonFullStoryUserPrompt(input: { synopsis: string; structure: SeasonStructure; characters: CharacterCard[]; locations: LocationRef[] }): string {
  return `SYNOPSIS:\n${input.synopsis}\n\nCHARACTERS (with tiers):\n${charactersBlock(input.characters)}\n\nLOCATIONS:\n${input.locations.length ? locationsBlock(input.locations) : "(none)"}\n\nSEASON STRUCTURE (JSON — expand this into full prose, do not change the episode count):\n${JSON.stringify(input.structure, null, 1)}`;
}

/** Story-screen revise: rewrite the prose per the author's instruction AND keep the structure in sync (count may change). */
export function seasonStoryReviseSystemPrompt(language: IdeaLanguage, episodeCount: number): string {
  return `You are the showrunner of a short-form vertical drama. You receive the CURRENT season structure (${episodeCount} episodes), the CURRENT full-story prose, and an INSTRUCTION from the author. Apply the instruction and return the FULL updated season as STRICT JSON:
{"title": string, "logline": string, "episodes": [{"number": int, "title": string, "logline": string, "locationName": string, "locationDesc": string, "characters": [names], "arcRole": "завязка"|"развитие"|"поворот"|"финал", "cliffhanger": string}], "fullStory": string}.
RULES:
- MINIMAL CHANGE: keep the structure and prose the author did NOT ask to change VERBATIM. Only touch what the instruction (or the story consistency it forces) requires — the system regenerates scripts only for episodes whose logline / arc / location / cast changed, so needless edits waste the author's work.
- EPISODE COUNT: keep ${episodeCount} episodes UNLESS the author explicitly asks to add or remove episodes; then return the new count (allowed range ${SEASON_MIN_EPISODES}–${SEASON_MAX_EPISODES}), renumber episodes 1..N contiguously, and make "episodes" and "fullStory" agree exactly (same number of episode blocks, same titles/order). Episode 1 = завязка, last = финал.
- Use ONLY the given character names verbatim; "locationName" should be one of the given LOCATIONS (verbatim) unless the story truly needs a new place. Loglines are 2–3 sentences of concrete events; cliffhanger = the final beat.
- ${CREATIVE_RULE}
- ${MODERATION_SAFE_RULE}
- In "episodes", all text except "locationDesc" is in ${langName(language)}; "locationDesc" is detailed English. Character names stay exactly as given (Western names in Latin letters).
${fullStoryFormatRules(language, episodeCount)}`;
}
export function seasonStoryReviseUserPrompt(input: { synopsis: string; structure: SeasonStructure; fullStory: string; characters: CharacterCard[]; locations: LocationRef[]; instruction: string }): string {
  return `SYNOPSIS:\n${input.synopsis}\n\nCHARACTERS (with tiers):\n${charactersBlock(input.characters)}\n\nLOCATIONS:\n${input.locations.length ? locationsBlock(input.locations) : "(none)"}\n\nCURRENT SEASON STRUCTURE (JSON):\n${JSON.stringify(input.structure, null, 1)}\n\nCURRENT FULL STORY:\n${input.fullStory || "(not written yet)"}\n\nINSTRUCTION FROM THE AUTHOR:\n${input.instruction}`;
}

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
/** Does the change to this episode's outline require rewriting its script? Titles alone do not. */
export function episodeNeedsRewrite(before: EpisodeOutline, after: EpisodeOutline): boolean {
  if (norm(before.logline) !== norm(after.logline)) return true;
  if (norm(before.cliffhanger) !== norm(after.cliffhanger)) return true;
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
