/**
 * Stage 2 — season script generator: schemas, prompts, validation, rendering, cost plan.
 * Pure (no DB) so it can be unit-tested; the worker in lib/workers/season-script-job.ts persists results.
 */
import { z } from "zod";
import { LANGUAGE_NAMES, type IdeaLanguage, type CharacterCard } from "@/lib/idea";
import { VISUAL_STYLE } from "@/lib/visual-style";
import { POWER_TIER_CONFIG, SEEDANCE_MAX_DURATION, type PowerTier } from "@/lib/power-tier";

export const SEASON_MIN_EPISODES = 6;
export const SEASON_MAX_EPISODES = 10;
export const SEASON_DEFAULT_EPISODES = 8;
export const EPISODE_MIN_SCENES = 10;
export const EPISODE_MAX_SCENES = 15;
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
  durationSec: z.number().int().min(SCENE_MIN_SECONDS).max(SCENE_MAX_SECONDS),
  locationDesc: z.string().min(3),
  characters: z.array(z.string()).default([]),
  action: z.string().min(5),
  dialogue: z.string().min(1),
  videoPrompt: z.string().min(40),
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

const PROMPT_LINES = ["[SHOT TYPE]", "[VISUAL STYLE]", "[LIGHTING]", "[BLOCKING]", "[GAZE]", "[NON-VERBAL]", "[ACTION]", "[CHARACTER]", "[TRANSITION]"];

/** Non-throwing validation of an episode script: returns human-readable problems (empty = ok). */
export function validateEpisodeScript(script: EpisodeScript): string[] {
  const problems: string[] = [];
  const n = script.scenes.length;
  if (n < EPISODE_MIN_SCENES || n > EPISODE_MAX_SCENES) problems.push(`scene count ${n} not in ${EPISODE_MIN_SCENES}–${EPISODE_MAX_SCENES}`);
  const silent = script.scenes.filter((s) => isSilent(s.dialogue)).length;
  if (silent > MAX_SILENT_SCENES) problems.push(`too many silent scenes: ${silent} (max ${MAX_SILENT_SCENES})`);
  if (n - silent < 1) problems.push("no dialogue in episode");
  script.scenes.forEach((s, i) => {
    if (s.number !== i + 1) problems.push(`scene ${i + 1} numbered ${s.number}`);
    const sentences = dialogueSentenceCount(s.dialogue);
    if (!isSilent(s.dialogue) && sentences < TALK_MIN_SENTENCES) problems.push(`scene ${s.number}: ${sentences} dialogue sentences (want ${TALK_MIN_SENTENCES}–${TALK_MAX_SENTENCES})`);
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
    scenes: script.scenes.map((s, i) => ({
      ...s,
      number: i + 1,
      durationSec: Math.min(SCENE_MAX_SECONDS, Math.max(SCENE_MIN_SECONDS, Math.round(s.durationSec || SCENE_MAX_SECONDS))),
      dialogue: s.dialogue.trim() || "[NO DIALOGUE]",
      videoPrompt: repairPrompt(s),
    })),
  };
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
  return `You are a showrunner planning ONE season of a short-form vertical drama series (9:16 video, each episode ≈2–3 minutes = 10–15 shots of 10–15 seconds).
Return STRICT JSON: {"title": string, "logline": string, "episodes": [{"number": int, "title": string, "logline": string, "locationName": string, "locationDesc": string, "characters": [names], "arcRole": "завязка"|"развитие"|"поворот"|"финал", "cliffhanger": string}]}.
RULES:
- EXACTLY ${episodeCount} episodes (allowed range ${SEASON_MIN_EPISODES}–${SEASON_MAX_EPISODES}). Episode 1 = завязка, last = финал, at least one поворот in the second half.
- Each episode has ONE key location. "locationName" MUST be one of the given LOCATIONS, copied verbatim (they already have reference images). Only if the story truly needs a place that is not in the list may you invent a new one (then give it a new name) — at most 2 new locations per season. "locationDesc" is a DETAILED English visual description (2–4 sentences: architecture, materials, textures, props, weather, light, color palette, time of day) usable verbatim by an image/video model — for a listed location, expand its given description. "locationName" is in ${langName(language)}.
- Use ONLY the given character names (verbatim; a CROWD group name counts as a character). Every episode lists 2–6 characters actually present: the MAIN characters carrying it plus the SUPPORTING characters (family, colleagues, rivals) involved. Across the season EVERY SUPPORTING character appears in at least one episode, MINOR characters and CROWD groups are used where the story plausibly gathers people (family dinners, workplaces, hospitals, streets, court, celebrations).
- Each logline is 2–3 sentences of concrete dramatic events (who wants what, what goes wrong). Cliffhanger = the final beat that forces the viewer into the next episode. No summaries like "tension rises".
- Continuous story: consequences carry over episode to episode; no repetition.
- All text except "locationDesc" is in ${langName(language)}. Original content: never reuse names, plots or lines of existing films/series.`;
}
export function seasonStructureUserPrompt(synopsis: string, characters: CharacterCard[], locations: LocationRef[] = []): string {
  return `SYNOPSIS:\n${synopsis}\n\nCHARACTERS (with tiers):\n${charactersBlock(characters)}\n\nLOCATIONS (use these names verbatim):\n${locations.length ? locationsBlock(locations) : "(none defined — invent 4–8 and reuse them across episodes)"}`;
}

export function episodeScriptSystemPrompt(language: IdeaLanguage): string {
  const L = langName(language);
  return `You are a film director + cinematographer writing the FULL shooting script of ONE episode of a short-form VERTICAL drama (9:16). The episode is ${EPISODE_MIN_SCENES}–${EPISODE_MAX_SCENES} consecutive shots ("scenes"), each up to ${SCENE_MAX_SECONDS} seconds, generated by an AI video model WITH native speech: characters really speak their lines out loud, so the DIALOGUE IS THE PRODUCT. A scene without dialogue is a wasted shot.

Return STRICT JSON: {"visualIdentity": string, "scenes": [{"number": int, "shotType": string, "durationSec": int, "locationDesc": string, "characters": [names], "action": string, "dialogue": string, "videoPrompt": string}]}.

HARD RULES (the script is REJECTED automatically if any is broken):
R1. 12 scenes by default (min ${EPISODE_MIN_SCENES}, max ${EPISODE_MAX_SCENES}). Scene 1 = wide establishing shot of the episode location. All scenes happen in/around the episode's key location.
R2. AT MOST 2 scenes in the whole episode may be silent ("[NO DIALOGUE]") — typically only scene 1 and maybe one reaction beat. ALL OTHER SCENES (at least 10 of 12) contain a real spoken exchange.
R3. A talking scene = a SUBSTANTIVE exchange of ${TALK_MIN_SENTENCES}–${TALK_MAX_SENTENCES} full sentences in total, spread over 3–5 lines where characters answer each other (the story is told THROUGH the dialogue: decisions, accusations, confessions, information, subtext). A ${SCENE_MAX_SECONDS}-second clip at a natural brisk pace carries this. Monologue or voice-over does NOT replace dialogue — when two people are in the shot they talk to each other; a lone character may talk on the phone or to someone off-screen. Short one-liners like "Я должна узнать правду." are REJECTED. One line per row, format: NAME (tone cue): "line". Tone cues like (шёпотом), (резко), (сдерживая слёзы).
    Example of a correct talking scene (6 sentences):
    АННА (тихо): "Ты знал, что он не вернётся, и всё равно отправил лодку? Я ждала на причале до утра."
    ВИКТОР (не глядя): "Я отправил лодку, потому что иначе мы бы потеряли обоих. Ты это понимаешь, даже если не хочешь признавать."
    АННА (резко): "Не смей решать за меня, кого мне терять. Завтра я сама выйду в море, и ты меня не остановишь."
    "durationSec" is ${SCENE_MAX_SECONDS} for every talking scene (the model's maximum); silent scenes may be ${SCENE_MIN_SECONDS}.
R4. "videoPrompt" is ENGLISH and consists of EXACTLY these 9 lines, each on its own row, in this order, each starting with its bracket tag:
    [SHOT TYPE]: framing + camera movement, vertical 9:16
    [VISUAL STYLE]: the short visualIdentity sentence — the SAME text in every scene
    [LIGHTING]: time of day, light sources, weather — IDENTICAL wording in every scene of the episode (the whole episode is one continuous time; the location references lock the light, only the camera angle changes)
    [BLOCKING]: where each character stands/moves
    [GAZE]: where each character looks
    [NON-VERBAL]: facial expression, gestures, breathing
    [ACTION]: what physically happens in the shot
    [CHARACTER]: for EVERY visible character: name, age, hair, skin, build, EXACT clothing for this episode — identical word for word in every scene of the episode
    [TRANSITION]: how the shot hands off to the next one
    The [CHARACTER] line is MANDATORY in every scene, including scene 1 if anyone is visible. Never put spoken text into the videoPrompt.

STYLE RULES:
S1. LIP-SYNC BIAS: talking scenes use Medium shot / Medium close-up / Close-up / Over-the-shoulder with the speaker's face clearly visible; wide shots only for establishing or silent beats.
S2. "locationDesc": "INT/EXT — place — time of day" in ${L}. "action" (1–2 sentences) and all dialogue in ${L}.
S3. "visualIdentity": ONE SHORT English sentence (max 25 words) — photoreal live-action look, color palette, lens/grain feel of this episode. Keep it short: it is repeated in every scene.
S4. Use ONLY the given character names. "characters" lists the names visible in the shot (a CROWD group name is listed when the group is in frame). SUPPORTING and MINOR characters present in the episode must actually speak in at least one scene each — not just stand in the background; crowds may have a short collective line or reactions.
S5. Dramatize ONLY this episode's logline — a natural continuation of the previous episodes, ending on this episode's cliffhanger (the last scene IS the cliffhanger). Original content only: never reuse names, plots or lines of existing films/series.

Before answering, check: scenes count 10–15; silent scenes ≤ ${MAX_SILENT_SCENES}; each talking scene has ${TALK_MIN_SENTENCES}–${TALK_MAX_SENTENCES} dialogue sentences; every videoPrompt has all 9 tags including [CHARACTER].`;
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
    .map((s) => `\nСЦЕНА ${s.number} · ${s.shotType} · ~${s.durationSec}с\n${s.locationDesc}\n${s.action}\n${s.dialogue}`)
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
  videoPrompt: z.string().min(40),
});
export type SceneRevise = z.infer<typeof sceneReviseSchema>;

export function sceneReviseSystemPrompt(language: IdeaLanguage): string {
  return `You are a film director rewriting ONE shot ("scene", ${SCENE_MIN_SECONDS}–${SCENE_MAX_SECONDS}s, vertical 9:16, AI video model with native speech) of an episode by the author's instruction.
Return STRICT JSON: {"shotType": string, "durationSec": int, "locationDesc": "INT/EXT — place — time" (${langName(language)}), "action": string (${langName(language)}), "dialogue": string, "videoPrompt": string}.
RULES: dialogue in ${langName(language)}, one line per row NAME (tone cue): "line"; a talking scene has a substantive exchange of ${TALK_MIN_SENTENCES}–${TALK_MAX_SENTENCES} full sentences (3–5 lines, characters answer each other; the story is told through the dialogue), or exactly "[NO DIALOGUE]" for a rare purely visual beat. durationSec ${SCENE_MAX_SECONDS} for talking scenes. Talking scenes use medium/close shots with the speaker's face visible. videoPrompt is ENGLISH, exactly 9 lines [SHOT TYPE]/[VISUAL STYLE]/[LIGHTING]/[BLOCKING]/[GAZE]/[NON-VERBAL]/[ACTION]/[CHARACTER]/[TRANSITION]; keep [VISUAL STYLE] and [CHARACTER] descriptions identical to the given scene unless the instruction requires otherwise; no spoken text in videoPrompt. Keep continuity with the previous and next shots. Original content only.`;
}
