/**
 * Stage 2 — season script generator: schemas, prompts, validation, rendering, cost plan.
 * Pure (no DB) so it can be unit-tested; the worker in lib/workers/season-script-job.ts persists results.
 */
import { z } from "zod";
import { LANGUAGE_NAMES, type IdeaLanguage, type CharacterCard } from "@/lib/idea";
import { VISUAL_STYLE } from "@/lib/visual-style";
import { POWER_TIER_CONFIG, type PowerTier } from "@/lib/power-tier";

export const SEASON_MIN_EPISODES = 6;
export const SEASON_MAX_EPISODES = 10;
export const SEASON_DEFAULT_EPISODES = 8;
export const EPISODE_MIN_SCENES = 10;
export const EPISODE_MAX_SCENES = 15;
export const SCENE_MIN_SECONDS = 10;
export const SCENE_MAX_SECONDS = 15;
/** Spoken words that fit into a ≤15s clip (≈2.5 words/s incl. pauses). */
export const TALK_MIN_WORDS = 18;
export const TALK_MAX_WORDS = 40;
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

const PROMPT_LINES = ["[SHOT TYPE]", "[VISUAL STYLE]", "[LIGHTING]", "[BLOCKING]", "[GAZE]", "[NON-VERBAL]", "[ACTION]", "[CHARACTER]", "[TRANSITION]"];

/** Non-throwing validation of an episode script: returns human-readable problems (empty = ok). */
export function validateEpisodeScript(script: EpisodeScript): string[] {
  const problems: string[] = [];
  const n = script.scenes.length;
  if (n < EPISODE_MIN_SCENES || n > EPISODE_MAX_SCENES) problems.push(`scene count ${n} not in ${EPISODE_MIN_SCENES}–${EPISODE_MAX_SCENES}`);
  const silent = script.scenes.filter((s) => isSilent(s.dialogue)).length;
  if (silent > Math.ceil(n / 4)) problems.push(`too many silent scenes: ${silent}`);
  if (n - silent < 1) problems.push("no dialogue in episode");
  script.scenes.forEach((s, i) => {
    if (s.number !== i + 1) problems.push(`scene ${i + 1} numbered ${s.number}`);
    const words = spokenWordCount(s.dialogue);
    if (!isSilent(s.dialogue) && (words < TALK_MIN_WORDS - 6 || words > TALK_MAX_WORDS + 8)) problems.push(`scene ${s.number}: ${words} spoken words (want ${TALK_MIN_WORDS}–${TALK_MAX_WORDS})`);
    const missing = PROMPT_LINES.filter((l) => !s.videoPrompt.includes(l));
    if (missing.length) problems.push(`scene ${s.number}: videoPrompt missing ${missing.join(",")}`);
  });
  return problems;
}

/** Fix what can be fixed mechanically (numbering, [VISUAL STYLE] line, duration clamp). */
export function normalizeEpisodeScript(script: EpisodeScript): EpisodeScript {
  return {
    ...script,
    scenes: script.scenes.map((s, i) => ({
      ...s,
      number: i + 1,
      durationSec: Math.min(SCENE_MAX_SECONDS, Math.max(SCENE_MIN_SECONDS, Math.round(s.durationSec || SCENE_MAX_SECONDS))),
      dialogue: s.dialogue.trim() || "[NO DIALOGUE]",
      videoPrompt: s.videoPrompt.includes("[VISUAL STYLE]") ? s.videoPrompt.trim() : `[VISUAL STYLE]: ${script.visualIdentity}\n${s.videoPrompt.trim()}`,
    })),
  };
}

function langName(language: IdeaLanguage) {
  return LANGUAGE_NAMES[language] ?? "English";
}
function charactersBlock(characters: CharacterCard[]) {
  return characters
    .map((c) => `- ${c.name} (${c.role}, ${c.age}); first appears: ${c.firstAppearance}\n  Personality: ${c.personality}\n  Appearance: ${c.appearance}`)
    .join("\n");
}

export function seasonStructureSystemPrompt(language: IdeaLanguage, episodeCount = SEASON_DEFAULT_EPISODES): string {
  return `You are a showrunner planning ONE season of a short-form vertical drama series (9:16 video, each episode ≈2–3 minutes = 10–15 shots of 10–15 seconds).
Return STRICT JSON: {"title": string, "logline": string, "episodes": [{"number": int, "title": string, "logline": string, "locationName": string, "locationDesc": string, "characters": [names], "arcRole": "завязка"|"развитие"|"поворот"|"финал", "cliffhanger": string}]}.
RULES:
- EXACTLY ${episodeCount} episodes (allowed range ${SEASON_MIN_EPISODES}–${SEASON_MAX_EPISODES}). Episode 1 = завязка, last = финал, at least one поворот in the second half.
- Each episode has ONE key location. "locationDesc" is a DETAILED English visual description (2–4 sentences: architecture, materials, textures, props, weather, light, color palette, time of day) usable verbatim by an image/video model. "locationName" is in ${langName(language)}.
- Use ONLY the given character names (verbatim). Every episode lists 2–4 characters actually present.
- Each logline is 2–3 sentences of concrete dramatic events (who wants what, what goes wrong). Cliffhanger = the final beat that forces the viewer into the next episode. No summaries like "tension rises".
- Continuous story: consequences carry over episode to episode; no repetition.
- All text except "locationDesc" is in ${langName(language)}. Original content: never reuse names, plots or lines of existing films/series.`;
}
export function seasonStructureUserPrompt(synopsis: string, characters: CharacterCard[]): string {
  return `SYNOPSIS:\n${synopsis}\n\nCHARACTERS:\n${charactersBlock(characters)}`;
}

export function episodeScriptSystemPrompt(language: IdeaLanguage): string {
  return `You are a film director + cinematographer writing the FULL shooting script of ONE episode of a short-form VERTICAL drama (9:16). The episode is ${EPISODE_MIN_SCENES}–${EPISODE_MAX_SCENES} consecutive shots ("scenes"), each ${SCENE_MIN_SECONDS}–${SCENE_MAX_SECONDS} seconds, generated by an AI video model WITH native speech (characters really speak their lines; lip-sync matters).
Return STRICT JSON: {"visualIdentity": string, "scenes": [{"number": int, "shotType": string, "durationSec": int, "locationDesc": string, "characters": [names], "action": string, "dialogue": string, "videoPrompt": string}]}.
RULES:
1. 12 scenes by default (min ${EPISODE_MIN_SCENES}, max ${EPISODE_MAX_SCENES}). Scene 1 = wide establishing shot of the episode location. All scenes happen in/around the episode's key location.
2. DIALOGUE. At most 1/4 of scenes are "[NO DIALOGUE]". Every other scene is a REAL exchange of 2–3 lines where characters answer each other, ${TALK_MIN_WORDS}–${TALK_MAX_WORDS} spoken words in total (fits ${SCENE_MAX_SECONDS}s). Format, one line per row: NAME (tone cue): "line". Tone cues like (шёпотом), (резко), (сдерживая слёзы). Dialogue and "action"/"locationDesc" in ${langName(language)}.
3. LIP-SYNC BIAS: talking scenes use Medium shot / Medium close-up / Close-up / Over-the-shoulder with the speaker's face clearly visible; wide shots only for establishing or silent beats.
4. "locationDesc": "INT/EXT — place — time of day" in ${langName(language)}.
5. "videoPrompt" is ENGLISH, EXACTLY 9 lines in this order: [SHOT TYPE]: ... (framing + camera movement, vertical 9:16) / [VISUAL STYLE]: ${VISUAL_STYLE} — repeat the same visualIdentity sentence in every scene / [LIGHTING]: ... / [BLOCKING]: ... / [GAZE]: ... / [NON-VERBAL]: ... / [ACTION]: ... / [CHARACTER]: exact identical physical description of every visible character (age, hair, skin, build, EXACT clothing for this episode) word for word in every scene / [TRANSITION]: how it hands off to the next shot. Never put spoken text into the videoPrompt.
6. Use ONLY the given character names. "characters" lists names visible in the shot.
7. Dramatize ONLY this episode's logline from a natural continuation of the previous episodes to this episode's cliffhanger (the last scene IS the cliffhanger). Original content only.`;
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

/** Clip plan for a scene batch — same rule as /api/ai/generate-video (15s where the model allows). */
export function sceneClipPlan(tier: PowerTier, sceneCount: number) {
  const cfg = POWER_TIER_CONFIG[tier];
  const duration = Math.min(30, Math.max(SCENE_MAX_SECONDS, cfg.baseDuration, Math.ceil(60 / Math.max(1, sceneCount))));
  const costPerScene = Math.max(cfg.costPerScene, Math.ceil((cfg.costPerScene * duration) / cfg.baseDuration));
  return { duration, costPerScene, total: costPerScene * sceneCount, totalSeconds: duration * sceneCount };
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
RULES: dialogue in ${langName(language)}, one line per row NAME (tone cue): "line"; a talking scene has ${TALK_MIN_WORDS}–${TALK_MAX_WORDS} spoken words in total, or exactly "[NO DIALOGUE]". Talking scenes use medium/close shots with the speaker's face visible. videoPrompt is ENGLISH, exactly 9 lines [SHOT TYPE]/[VISUAL STYLE]/[LIGHTING]/[BLOCKING]/[GAZE]/[NON-VERBAL]/[ACTION]/[CHARACTER]/[TRANSITION]; keep [VISUAL STYLE] and [CHARACTER] descriptions identical to the given scene unless the instruction requires otherwise; no spoken text in videoPrompt. Keep continuity with the previous and next shots. Original content only.`;
}
