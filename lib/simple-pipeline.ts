/**
 * SIMPLIFIED EPISODE PIPELINE (text → images → video).
 *
 *   4. Episode script  — PLAIN screenplay TEXT (Claude Opus 5, streaming). No JSON scene schema.
 *   5. Shot list       — exactly 5 scenes × 5 beats (JSON, streaming). Persisted as 25 Scene rows
 *                        (one per beat, `Scene.beatMeta`) so the per-scene video / start-frame /
 *                        chain / assembly infrastructure works unchanged.
 *   6–9. Images        — master plate (storyboard only), character height refs, 5×5 storyboard grid,
 *                        25 start frames (one per beat).
 *   10. Video          — 25 clips: image 1 = the beat's start frame, images 2..N = characters
 *                        (appearance only). NO location plate.
 *   11. Montage        — existing assemble-episode job (concatenation in beat order).
 *
 * This module is PURE (no DB / network) so it is safe to import from routes, workers and unit scripts.
 * All prompts are English-only; the screenplay itself is written in the project language.
 */
import type { IdeaLanguage } from "@/lib/idea";

export const SHOT_LIST_JOB_TYPE = "shot_list";
export const START_FRAMES_JOB_TYPE = "start_frames";
export const EPISODE_PLATE_JOB_TYPE = "location_image";

/** Visible-output budget for the plain-text screenplay (Opus 5 streams; hidden thinking is capped separately). */
export const SCREENPLAY_MAX_TOKENS = 12000;
export const SHOT_LIST_MAX_TOKENS = 9000;

export const SHOT_LIST_SCENES = 5;
export const SHOT_LIST_BEATS = 5;
export const BEAT_CLIP_SECONDS = 5;

export const SHOT_TYPES = ["wide", "medium", "close-up", "over-the-shoulder"] as const;
export type ShotType = (typeof SHOT_TYPES)[number];

export interface ShotListBeat {
  shot: ShotType;
  /** ONE action lasting 4–5 s, English. */
  action: string;
  /** Link to the next beat, English (what state the cut lands in). */
  cut: string;
}
export interface ShotListScene {
  title: string;
  /** Short English location line. */
  location: string;
  /** Latin character names present in the scene. */
  characters: string[];
  beats: ShotListBeat[];
}
export interface ShotList {
  scenes: ShotListScene[];
}

/** Per-beat metadata stored in `Scene.beatMeta` (one Scene row per beat). */
export interface BeatMeta {
  v: 1;
  sceneIndex: number; // 1..5
  beatIndex: number; // 1..5
  sceneTitle: string;
  location: string;
  characters: string[];
  shot: ShotType;
  action: string;
  cut: string;
  /** The next beat's opening state (END of this clip); null for the very last beat. */
  nextStart: string | null;
  /** Prompt used for the start frame (View Prompt), set by the start-frames job. */
  startFramePrompt?: string | null;
}

const LANG_NAMES: Record<string, string> = {
  en: "English", ru: "Russian", uk: "Ukrainian", de: "German", fr: "French", es: "Spanish", it: "Italian",
  pt: "Portuguese", pl: "Polish", tr: "Turkish", ja: "Japanese", ko: "Korean", zh: "Chinese", ar: "Arabic", hi: "Hindi",
};
export function languageLabel(language: IdeaLanguage | string): string {
  return LANG_NAMES[String(language)] ?? String(language);
}

/* ───────────────────────────── 4. SCREENPLAY (plain text) ───────────────────────────── */

export function episodeScreenplaySystemPrompt(language: IdeaLanguage | string, episodeNumber = 1): string {
  const L = languageLabel(language);
  return `You are a screenwriter and director writing the FULL script of ONE episode (EPISODE ${episodeNumber}) of a short-form VERTICAL drama series (9:16, ~2 minutes of screen time per episode).

OUTPUT FORMAT — PLAIN TEXT screenplay, NOT JSON, NO markdown fences, NO commentary before or after:
- Start with a title line: "EPISODE ${episodeNumber} — <title>".
- Exactly 5 scenes. Each scene opens with a slug line in CAPITALS: "SCENE <n>. <INT./EXT.> <LOCATION> — <TIME OF DAY>".
- Under the slug line: a short action paragraph (what the camera sees), then dialogue in screenplay layout —
  the CHARACTER NAME on its own line in capitals, the spoken line on the next line(s). Parentheticals in (brackets).
- Each scene is 20–30 seconds of screen time: 2–5 short exchanges of dialogue braided with physical action.
- The whole episode happens in ONE location (different spots / angles of the same place are fine).
- Scene 1 opens on a hook that continues the previous episode's cliffhanger (episode 1: the season opening);
  the conflict escalates to one emotional peak; scene 5 ends on THIS episode's cliffhanger.
- Character names are written in LATIN letters exactly as given in the cast list (never translate or transliterate them differently).
- Write the screenplay in ${L}. Keep it concrete, filmable, present tense; no camera jargon, no shot numbers.
- Never truncate: finish all 5 scenes and end with the line "END OF EPISODE ${episodeNumber}".`;
}

export interface ScreenplayPromptInput {
  season: { title: string; logline: string };
  synopsis: string;
  episode: { number: number; title: string; logline?: string | null; cliffhanger?: string | null; description?: string | null; locationName?: string | null; locationDesc?: string | null; characters?: string[] };
  /** Earlier episodes' outlines + full scripts (never truncated). */
  previousEpisodes: { number: number; title: string; logline?: string | null; cliffhanger?: string | null; script?: string | null }[];
  /** Latin names of existing cast (may be empty — the script then names its characters itself). */
  characterNames: string[];
  /** Author revise instruction (rewrite). */
  instruction?: string | null;
  /** Live world-state / bible blocks (optional, already rendered). */
  extraBlocks?: string[];
}

export function episodeScreenplayUserPrompt(input: ScreenplayPromptInput): string {
  const ep = input.episode;
  const prev = input.previousEpisodes
    .filter((p) => p.number < ep.number)
    .sort((a, b) => a.number - b.number)
    .map((p) => {
      const head = `EPISODE ${p.number} — ${p.title}${p.logline ? `\nLogline: ${p.logline}` : ""}${p.cliffhanger ? `\nCliffhanger: ${p.cliffhanger}` : ""}`;
      return p.script?.trim() ? `${head}\nFULL SCRIPT:\n${p.script.trim()}` : head;
    });
  const blocks = [
    `SEASON: ${input.season.title}\nSeason logline: ${input.season.logline}`,
    `SYNOPSIS:\n${input.synopsis.trim()}`,
    input.characterNames.length ? `CAST (use these exact Latin names):\n${input.characterNames.map((n) => `- ${n}`).join("\n")}` : "",
    prev.length ? `PREVIOUS EPISODES (continuity — the new episode must follow directly from them):\n\n${prev.join("\n\n")}` : "",
    `THIS EPISODE (${ep.number}) — OUTLINE:\nTitle: ${ep.title}${ep.logline ? `\nLogline: ${ep.logline}` : ""}${ep.description ? `\nFootage plan:\n${ep.description}` : ""}${ep.locationName ? `\nLocation: ${ep.locationName}${ep.locationDesc ? ` — ${ep.locationDesc}` : ""}` : ""}${ep.characters?.length ? `\nCharacters in this episode: ${ep.characters.join(", ")}` : ""}${ep.cliffhanger ? `\nIntended cliffhanger: ${ep.cliffhanger}` : ""}`,
    ...(input.extraBlocks ?? []).filter((b) => b && b.trim()),
    input.instruction?.trim() ? `AUTHOR INSTRUCTION FOR THIS REWRITE (mandatory):\n${input.instruction.trim()}` : "",
    `Write the full plain-text screenplay of episode ${ep.number} now.`,
  ].filter(Boolean);
  return blocks.join("\n\n");
}

/* ───────────────────────────── 5. SHOT LIST (5 × 5 JSON) ───────────────────────────── */

export function shotListSystemPrompt(): string {
  return `You are a director breaking a finished episode script into a SHOT LIST for an AI video model.

Return ONLY valid JSON (no markdown, no commentary) of this exact shape:
{
  "scenes": [
    {
      "title": "<short scene title, English>",
      "location": "<short English location line, e.g. 'Cramped map-maker's workshop, night'>",
      "characters": ["<Latin character name>", ...],
      "beats": [
        { "shot": "wide" | "medium" | "close-up" | "over-the-shoulder",
          "action": "<ONE continuous physical action lasting 4–5 seconds, English, present tense, who does what where>",
          "cut": "<the state the clip ends in / how it links to the next beat, English, one sentence>" }
      ]
    }
  ]
}

HARD RULES:
- EXACTLY 5 scenes, EXACTLY 5 beats per scene (25 beats total). Follow the script's 5 scenes in order.
- Every beat is ONE action of 4–5 seconds — never two actions, never a summary of a minute.
- All text is ENGLISH. Character names stay in LATIN letters exactly as in the script's cast.
- Only characters listed in the scene's "characters" may appear in its beats.
- Each beat's "shot" is one of: wide, medium, close-up, over-the-shoulder. Vary shots; never four identical shots in a row.
- CONTINUITY: beat 5 of scene N must END in the state that beat 1 of scene N+1 STARTS from ("cut" of 5 = opening of the next scene's beat 1). Within a scene, each "cut" describes the exact pose/position the next beat opens on.
- Dialogue is NOT quoted; describe speaking as an action ("Mira leans in and speaks urgently to Oren").`;
}

export function shotListUserPrompt(input: { scriptText: string; episodeTitle: string; episodeNumber: number; characterNames: string[]; locationName?: string | null }): string {
  return [
    `EPISODE ${input.episodeNumber} — ${input.episodeTitle}`,
    input.locationName ? `Episode location: ${input.locationName}` : "",
    input.characterNames.length ? `Known cast (Latin names): ${input.characterNames.join(", ")}` : "",
    `SCRIPT:\n${input.scriptText.trim()}`,
    `Build the 5 × 5 shot list JSON now.`,
  ].filter(Boolean).join("\n\n");
}

/** Tolerant normalizer: accepts sloppy model output, returns exactly 5×5 or a human-readable problem. */
export function normalizeShotList(raw: unknown): { ok: true; shotList: ShotList } | { ok: false; problem: string } {
  const root = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const scenesRaw = Array.isArray(root.scenes) ? root.scenes : Array.isArray(root.shotList) ? root.shotList : Array.isArray(raw) ? (raw as unknown[]) : null;
  if (!scenesRaw) return { ok: false, problem: "the model returned no scenes" };
  if (scenesRaw.length < SHOT_LIST_SCENES - 1 || scenesRaw.length > SHOT_LIST_SCENES + 1) {
    return { ok: false, problem: `expected ${SHOT_LIST_SCENES} scenes, got ${scenesRaw.length}` };
  }
  const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : fallback);
  const scenes: ShotListScene[] = [];
  for (let i = 0; i < Math.min(scenesRaw.length, SHOT_LIST_SCENES); i++) {
    const s = (scenesRaw[i] ?? {}) as Record<string, unknown>;
    const beatsRaw = Array.isArray(s.beats) ? s.beats : Array.isArray(s.shots) ? s.shots : [];
    if (beatsRaw.length < SHOT_LIST_BEATS - 1 || beatsRaw.length > SHOT_LIST_BEATS + 1) {
      return { ok: false, problem: `scene ${i + 1} has ${beatsRaw.length} beats (expected ${SHOT_LIST_BEATS})` };
    }
    const beats: ShotListBeat[] = [];
    for (let j = 0; j < beatsRaw.length; j++) {
      const b = (beatsRaw[j] ?? {}) as Record<string, unknown>;
      const action = str(b.action) || str(b.description);
      if (!action) return { ok: false, problem: `scene ${i + 1} beat ${j + 1} has no action` };
      beats.push({ shot: normalizeShotType(str(b.shot) || str(b.shotType)), action, cut: str(b.cut) || str(b.transition) || "Hold on the final pose." });
    }
    // 4 beats → pad by splitting the last action's hold; 6 beats → drop the 6th.
    while (beats.length < SHOT_LIST_BEATS) {
      const last = beats[beats.length - 1];
      beats.push({ shot: last.shot === "close-up" ? "medium" : "close-up", action: `Hold: ${last.cut}`, cut: last.cut });
    }
    beats.length = SHOT_LIST_BEATS;
    const characters = Array.isArray(s.characters) ? (s.characters as unknown[]).map((c) => str(c)).filter(Boolean) : [];
    scenes.push({ title: str(s.title) || `Scene ${i + 1}`, location: str(s.location) || str(s.setting) || "", characters, beats });
  }
  while (scenes.length < SHOT_LIST_SCENES) {
    const last = scenes[scenes.length - 1];
    scenes.push({ ...last, title: `${last.title} (continued)`, beats: last.beats.map((b) => ({ ...b })) });
  }
  // Continuity rule: beat 5 of scene N must lead into beat 1 of scene N+1 — enforce softly by writing the
  // link into the cut text when the model left it blank/generic.
  for (let i = 0; i < scenes.length - 1; i++) {
    const last = scenes[i].beats[SHOT_LIST_BEATS - 1];
    const nextFirst = scenes[i + 1].beats[0];
    if (!/[a-z]/i.test(last.cut) || last.cut.length < 12) last.cut = `Ends in the state the next scene opens on: ${nextFirst.action}`;
  }
  return { ok: true, shotList: { scenes } };
}

export function normalizeShotType(v: string): ShotType {
  const s = v.toLowerCase().replace(/[_\s]+/g, "-");
  if (s.includes("over")) return "over-the-shoulder";
  if (s.includes("close") || s.includes("cu")) return "close-up";
  if (s.includes("wide") || s.includes("long") || s.includes("establish")) return "wide";
  return "medium";
}

/** Flatten the 5×5 shot list into 25 ordered BeatMeta records (number 1..25). */
export function beatsFromShotList(shotList: ShotList): BeatMeta[] {
  const out: BeatMeta[] = [];
  shotList.scenes.forEach((scene, si) => {
    scene.beats.forEach((beat, bi) => {
      const next = bi + 1 < scene.beats.length ? scene.beats[bi + 1] : shotList.scenes[si + 1]?.beats[0] ?? null;
      out.push({
        v: 1, sceneIndex: si + 1, beatIndex: bi + 1, sceneTitle: scene.title, location: scene.location,
        characters: scene.characters, shot: beat.shot, action: beat.action, cut: beat.cut,
        nextStart: next ? next.action : null,
      });
    });
  });
  return out;
}

export function parseBeatMeta(v: unknown): BeatMeta | null {
  if (!v) return null;
  let o: unknown = v;
  if (typeof v === "string") { try { o = JSON.parse(v); } catch { return null; } }
  if (!o || typeof o !== "object") return null;
  const m = o as Partial<BeatMeta>;
  if (typeof m.action !== "string" || typeof m.sceneIndex !== "number" || typeof m.beatIndex !== "number") return null;
  return {
    v: 1, sceneIndex: m.sceneIndex, beatIndex: m.beatIndex, sceneTitle: String(m.sceneTitle ?? ""), location: String(m.location ?? ""),
    characters: Array.isArray(m.characters) ? m.characters.map(String) : [], shot: normalizeShotType(String(m.shot ?? "medium")),
    action: m.action, cut: String(m.cut ?? ""), nextStart: typeof m.nextStart === "string" ? m.nextStart : null,
    startFramePrompt: typeof m.startFramePrompt === "string" ? m.startFramePrompt : null,
  };
}

export function beatTitle(meta: Pick<BeatMeta, "sceneIndex" | "beatIndex" | "sceneTitle">): string {
  return `S${meta.sceneIndex}.${meta.beatIndex} · ${meta.sceneTitle}`.trim();
}

/* ───────────────────────────── 9. START FRAME prompt ───────────────────────────── */

export function buildStartFramePrompt(input: { beat: BeatMeta; characterNames: string[]; hasPlate: boolean }): string {
  const { beat } = input;
  const names = input.characterNames.length ? input.characterNames : beat.characters;
  const refLines: string[] = [];
  let idx = 1;
  if (input.hasPlate) { refLines.push(`image ${idx} — LOCATION plate: the exact place; keep its layout, light and palette.`); idx++; }
  names.forEach((n) => { refLines.push(`image ${idx} — ${n}: appearance only (face, hair, wardrobe).`); idx++; });
  return [
    `Cinematic still frame, vertical 9:16, photorealistic, the FIRST frame of a ${BEAT_CLIP_SECONDS}-second shot.`,
    `SHOT: ${beat.shot}. LOCATION: ${beat.location}.`,
    `CHARACTERS IN FRAME: ${names.length ? names.join(", ") : "as described"}.`,
    `MOMENT: ${beat.action}`,
    refLines.length ? `REFERENCES:\n${refLines.join("\n")}` : "",
    `NEGATIVES: no text, no captions, no logos, no watermark, no split screen, no extra people, no distorted anatomy.`,
  ].filter(Boolean).join("\n");
}

/* ───────────────────────────── 10. VIDEO prompt (per beat) ───────────────────────────── */

export const BEAT_VIDEO_NEGATIVES = "no logos, no brand marks, no on-screen text, no subtitles or captions, no watermark, no split screen, no distorted anatomy; no other people in frame than described above; no camera cuts inside the clip.";

export function buildBeatVideoPrompt(input: { beat: BeatMeta; characterNames: string[]; hasStartFrame: boolean }): string {
  const { beat } = input;
  const lines: string[] = [];
  let idx = 1;
  if (input.hasStartFrame) {
    lines.push(`START FRAME: image ${idx} — the first frame of this shot: ${beat.shot} shot, ${beat.location}. Keep its composition, positions and poses at frame 1.`);
    idx++;
  } else {
    lines.push(`START FRAME: ${beat.shot} shot, ${beat.location}. Open exactly on: ${beat.action}`);
  }
  const chars = input.characterNames.length ? input.characterNames : beat.characters;
  if (chars.length) {
    lines.push(`Characters: ${chars.map((n) => `image ${idx++} — ${n}: appearance only`).join("; ")}.`);
  }
  lines.push(`ACTIONS: ${beat.action}`);
  lines.push(`END: ${beat.nextStart ? beat.nextStart : beat.cut}`);
  lines.push(`NEGATIVES: ${BEAT_VIDEO_NEGATIVES}`);
  return lines.join("\n");
}
