/**
 * SIMPLIFIED EPISODE PIPELINE (text → images → video).
 *
 *   4. Episode script  — PLAIN screenplay TEXT (Claude Opus 5, streaming). No JSON scene schema.
 *   5. Shot list       — exactly 5 scenes × 5 beats (JSON, streaming); a beat is a FREEZE-FRAME (one picture,
 *                        0–1 verbs), never a clip. Persisted as 25 Scene rows
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

/**
 * Shot SIZE only (no angles — over-the-shoulder / POV / low angle are not sizes). "two-shot" is an optional
 * suffix for a size framing two people. Legacy stored values ("close-up", "over-the-shoulder") normalize to
 * "close" / "medium" on read (normalizeShotType).
 */
export const SHOT_TYPES = ["wide", "medium", "close", "extreme close-up", "wide two-shot", "medium two-shot", "close two-shot"] as const;
export type ShotType = (typeof SHOT_TYPES)[number];

export interface ShotListBeat {
  shot: ShotType;
  /** ONE freeze-frame — what is visible in the panel at a single instant (0–1 verbs), English. */
  action: string;
  /** Link to the next beat, English (what state the cut lands in). */
  cut: string;
}
export interface ShotListScene {
  title: string;
  /** ONE-word CAPS theme tag of the row (LAMP / DEBT / AMPULES …). */
  tag: string;
  /** Short English location line. */
  location: string;
  /** Latin character names present in the scene. */
  characters: string[];
  beats: ShotListBeat[];
}
export interface ShotList {
  scenes: ShotListScene[];
  /** LOCATION LAYOUT — one English line, key objects with camera-relative directions (no location name). */
  layout: string;
  /** CHARACTER SHEET per cast member (Latin name → 1–2 English sentences of appearance in this episode). */
  characterSheets: Record<string, string>;
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
  /** ROW theme tag (one CAPS word) — the same on all 5 beats of the row; grid prompt "ROW N TAG:". */
  rowTag?: string | null;
  /** Episode LOCATION LAYOUT line (camera-relative directions) — duplicated on every beat (no Episode column). */
  layout?: string | null;
  /** CHARACTER SHEETs of the cast present in this row (name → appearance text) — merged across beats by the grid. */
  castSheets?: Record<string, string> | null;
  /** Sliced grid panel (S3) — the COMPOSITION reference for this beat. The start frame is re-rendered from it; the
   *  panel itself is never used as the final start frame or upscaled into video. Set by the grid slice job. */
  gridPanelUrl?: string | null;
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
  return `You are a director breaking a finished episode script into a STORYBOARD SHOT LIST of 25 freeze-frames for an AI image/video pipeline.

Return ONLY valid JSON (no markdown, no commentary) of this exact shape:
{
  "layout": "<LOCATION LAYOUT — ONE English line, key objects with directions relative to the camera/viewer, NO location name, e.g. 'cot CENTER, cast-iron column LEFT, brazier RIGHT, chalk debt board on the BACK wall, door far LEFT'>",
  "characterSheets": { "<Latin character name>": "<CHARACTER SHEET — 1–2 English sentences: sex, age, build, hair, face, wardrobe in THIS episode, distinctive items>", ... },
  "scenes": [
    {
      "title": "<short scene title, English>",
      "tag": "<ONE word, CAPS, the theme of this row, e.g. LAMP / DEBT / AMPULES / CONFESSION / TOKEN>",
      "location": "<short English location line, e.g. 'Cramped map-maker's workshop, night'>",
      "characters": ["<Latin character name>", ...],
      "beats": [
        { "shot": "wide" | "medium" | "close" | "extreme close-up" | "wide two-shot" | "medium two-shot" | "close two-shot",
          "action": "<ONE FREEZE-FRAME, English: what is visible in the panel at one single instant>",
          "cut": "<how this frame links to the next one, English, one sentence>" }
      ]
    }
  ]
}

HARD RULES:
- EXACTLY 5 scenes, EXACTLY 5 beats per scene (25 beats total). Follow the script's 5 scenes in order. A scene = one ROW of 5 consecutive panels.
- A BEAT IS A FREEZE-FRAME, NOT A CLIP. "action" describes ONE picture — what is visible at one instant: ZERO or ONE verb. A participle / -ing form is allowed as a frozen state ("teeth clamped on the belt", "Nora stepping forward", "Marta's hand takes three ampules"). FORBIDDEN: "then", "and then", "while … then", "starts to", "begins to", "slowly", listing 2+ actions of the same character. If you wrote "then", split it into two beats. If an action is complex, spread it over several beats. Never summarise a stretch of time.
- WHAT A FRAME SHOWS (as elements of the description, not a fixed sentence template, and only when visible in the frame): where each person stands/sits/lies relative to the layout objects (cot, column, board…), what is in their hands, where they look.
- Shot size ONLY: wide / medium / close / extreme close-up, optionally with the suffix "two-shot" (e.g. "medium two-shot", "close two-shot"). NO camera angles as sizes — never over-the-shoulder, POV, low angle, high angle, insert, reverse. Vary sizes; never four identical sizes in a row.
- ROW TAG: every scene gets ONE CAPS word "tag" naming the row's theme (the object or turn the row is about).
- ROW HAND-OFF (the most important seam): beat 1 of scenes 2–5 shows the SAME MOMENT as beat 5 of the previous scene from a DIFFERENT shot size — write it starting with "same moment — ". MECHANICAL TEST: read X.5 and (X+1).1 together — they must describe ONE picture: the SAME people, the SAME frozen action/verb, the same positions, hands and gaze; only the framing wording differs (wider: add what else the layout shows; closer: drop what falls out of frame). Different verbs or different people in X.5 and (X+1).1 = a broken seam. Write (X+1).1 FIRST as a copy of X.5, then adjust only the framing. CORRECT: 1.5 medium: "Nora, kettle in hand, setting it on the floor by the cot; Marta bent over the wound behind her." → 2.1 wide: "same moment — Nora setting the kettle by the cot, Marta bent over the wound, Kemp on the cot." WRONG: 1.5 "Marta lifting the blade away" → 2.1 "Nora setting the kettle down beside the cot, Marta working" (other person, other verb = two different moments). A location change happens ONLY at this row boundary, and both panels already show the new place.
- NO JUMPS IN SPACE WITHIN A ROW: nobody teleports, changes place or turns around unless a beat shows the new state; consecutive beats are consecutive instants of one continuous scene. A person at object A in one beat and at object B two beats later needs a beat showing the move — or start them at B from the row's first beat. This also holds INTO the seam: X.5 must follow directly from X.4.
- NO STATES AHEAD OF THE SCRIPT: never freeze a state the script has not reached at that point — "his chest still" reads as death, a bandage on a wound reads as already treated. Show only what is true at that instant of the script.
- CHARACTER SHEETS = the character at the START of the episode: no items, injuries or wardrobe that only appear later in the script (a bandage the character receives in scene 3 is NOT in the sheet).
- CAST ONLY: everyone who appears in a beat must be from the episode cast, named in LATIN letters verbatim. No unnamed people (no "a guard", "a porter", "a crowd"): if the script needs a one-off figure, use an existing cast member, or show an object / detail instead. Only characters listed in the scene's "characters" may appear in its beats.
- "layout": the geometry of the ONE episode location — main objects with CENTER / LEFT / RIGHT / BACK wall / FOREGROUND / far LEFT directions relative to the viewer. Beats place people relative to these objects.
- "characterSheets": one entry per cast member appearing in this episode — textual appearance down to details (sex, age, build, hair, face, this episode's wardrobe, distinctive items). English.
- All text is ENGLISH. Do NOT prefix the shot size inside "action" — it goes in the "shot" field.
- Dialogue is NOT quoted; a speaking character is a frozen state ("Nora speaking, pointing her pipe at the chalk debt board").`;
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
      beats.push({ shot: last.shot === "close" ? "medium" : "close", action: `Hold: ${last.cut}`, cut: last.cut });
    }
    beats.length = SHOT_LIST_BEATS;
    const characters = Array.isArray(s.characters) ? (s.characters as unknown[]).map((c) => str(c)).filter(Boolean) : [];
    const tag = normalizeRowTag(str(s.tag) || str(s.rowTag));
    scenes.push({ title: str(s.title) || `Scene ${i + 1}`, tag, location: str(s.location) || str(s.setting) || "", characters, beats });
  }
  while (scenes.length < SHOT_LIST_SCENES) {
    const last = scenes[scenes.length - 1];
    scenes.push({ ...last, title: `${last.title} (continued)`, beats: last.beats.map((b) => ({ ...b })) });
  }
  // Episode-level blocks (tolerant: missing → empty, the grid prompt falls back to the location/character data).
  const layout = str(root.layout) || str(root.locationLayout);
  const sheetsRaw = (root.characterSheets ?? root.characters ?? null) as unknown;
  const characterSheets: Record<string, string> = {};
  if (sheetsRaw && typeof sheetsRaw === "object" && !Array.isArray(sheetsRaw)) {
    for (const [name, sheet] of Object.entries(sheetsRaw as Record<string, unknown>)) {
      const n = name.trim(); const t = str(sheet);
      if (n && t) characterSheets[n] = t;
    }
  } else if (Array.isArray(sheetsRaw)) {
    for (const item of sheetsRaw as unknown[]) {
      const o = (item ?? {}) as Record<string, unknown>;
      const n = str(o.name); const t = str(o.sheet) || str(o.appearance) || str(o.description);
      if (n && t) characterSheets[n] = t;
    }
  }
  // Continuity rule: beat 5 of scene N must lead into beat 1 of scene N+1 — enforce softly by writing the
  // link into the cut text when the model left it blank/generic.
  for (let i = 0; i < scenes.length - 1; i++) {
    const last = scenes[i].beats[SHOT_LIST_BEATS - 1];
    const nextFirst = scenes[i + 1].beats[0];
    if (!/[a-z]/i.test(last.cut) || last.cut.length < 12) last.cut = `Ends in the state the next scene opens on: ${nextFirst.action}`;
  }
  return { ok: true, shotList: { scenes, layout, characterSheets } };
}

/* ───────────── Row hand-off (seam) check: X.5 and (X+1).1 must be ONE picture ───────────── */

export interface SeamIssue {
  /** 0-based index of the scene whose beat 5 hands off to the next scene's beat 1. */
  index: number;
  /** Human-readable reason (English, for logs / repair prompt). */
  reason: string;
}

const SAME_MOMENT_RE = /^\s*same\s+moment\s*[—–-]*\s*/i;
const ING_STOPLIST = new Set([
  "during", "nothing", "something", "anything", "everything", "ceiling", "morning", "evening", "thing", "ring", "string",
  "spring", "lightning", "building", "clothing", "bedding", "railing", "awning", "landing", "opening", "being", "king", "wing",
  "sling", "siding", "padding", "stocking", "stockings", "earring", "earrings", "meeting", "painting", "drawing", "writing",
  "lining", "netting", "matting", "carving", "engraving", "shilling", "sterling", "darling", "filling", "coating", "casing",
  "surrounding", "surroundings", "belonging", "belongings", "according", "including", "following", "beginning", "ending",
  "sweeping", "streaming", "flooding", "dripping", "peeling", "leaking", "swelling", "crawling", "sheeting", "rolling", "gleaming",
]);

/** Cast names mentioned in a beat (canonical names; only name tokens unique to one character count). */
function namesInBeat(text: string, castNames: string[]): Set<string> {
  const tokens = new Map<string, string | null>(); // token → canonical name, or null when ambiguous
  for (const name of castNames) {
    for (const t of name.split(/[\s-]+/).map((x) => x.replace(/[^A-Za-z]/g, "").toLowerCase()).filter((x) => x.length >= 3)) {
      tokens.set(t, tokens.has(t) && tokens.get(t) !== name ? null : name);
    }
  }
  const out = new Set<string>();
  for (const w of text.toLowerCase().replace(/['’]s\b/g, "").split(/[^a-z]+/)) {
    const n = tokens.get(w);
    if (n) out.add(n);
  }
  return out;
}

/** Frozen-state verbs of a beat: -ing forms minus a noun stoplist and minus scenery motion (rain, water…). */
function verbsInBeat(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z]+/)) {
    if (w.length >= 6 && w.endsWith("ing") && !ING_STOPLIST.has(w)) out.add(w);
  }
  return out;
}

/** Shot size rank for seam comparison: 3 wide, 2 medium, 1 close, 0 extreme close-up (two-shots share their base). */
function shotWidth(shot: string): number {
  const s = String(shot ?? "").toLowerCase();
  if (s.includes("extreme")) return 0;
  if (s.includes("close")) return 1;
  if (s.includes("wide")) return 3;
  return 2;
}

/**
 * Mechanical seam test (the producer's rule): glue X.5 and (X+1).1 — they must describe one picture at two shot
 * sizes. Different people or different frozen verbs → the seam is broken. Empty verb sets are not compared
 * (a purely static description can match anything).
 */
export function checkRowSeams(shotList: ShotList, castNames: string[]): SeamIssue[] {
  const names = castNames.length ? castNames : Array.from(new Set(shotList.scenes.flatMap((s) => s.characters)));
  const issues: SeamIssue[] = [];
  for (let i = 0; i < shotList.scenes.length - 1; i++) {
    const ba = shotList.scenes[i].beats[SHOT_LIST_BEATS - 1], bb = shotList.scenes[i + 1].beats[0];
    const a = ba?.action ?? "";
    const b = (bb?.action ?? "").replace(SAME_MOMENT_RE, "");
    if (!a || !b) continue;
    const na = namesInBeat(a, names), nb = namesInBeat(b, names);
    // The wider frame may show MORE people (Kemp on the cot appears only in the wide); the closer one only fewer.
    const wa = shotWidth(ba.shot), wb = shotWidth(bb.shot);
    const subset = (x: Set<string>, y: Set<string>) => Array.from(x).every((n) => y.has(n));
    const peopleDiffer = wa === wb ? !(subset(na, nb) && subset(nb, na)) : wa > wb ? !subset(nb, na) : !subset(na, nb);
    const va = verbsInBeat(a), vb = verbsInBeat(b);
    const verbsDiffer = va.size > 0 && vb.size > 0 && !Array.from(va).some((v) => vb.has(v));
    const reasons: string[] = [];
    if (peopleDiffer) reasons.push(`different people (${[...na].join(", ") || "none"} vs ${[...nb].join(", ") || "none"})`);
    if (verbsDiffer) reasons.push(`different verbs (${[...va].join(", ")} vs ${[...vb].join(", ")})`);
    if (reasons.length) issues.push({ index: i, reason: reasons.join("; ") });
  }
  return issues;
}

export function seamRepairSystemPrompt(): string {
  return `You fix broken ROW HAND-OFFS in a 5×5 storyboard shot list (25 freeze-frames, 5 rows). Beat X.5 (last of a row) and beat (X+1).1 (first of the next row) must be ONE picture seen at two shot sizes: the SAME people, the SAME frozen action/verb, the same positions, hands and gaze — only the framing wording differs (wider: add what else the fixed layout shows; closer: drop what falls out of frame). (X+1).1 starts with "same moment — ".

For every seam given, rewrite BOTH beats: keep X.5 a direct continuation of X.4 (nobody changes place or turns around unnoticed), and keep (X+1).1 leading into (X+1).2. Each beat is ONE freeze-frame in English: zero or one verb, no "then", no camera angles, no dialogue quotes, cast names in Latin letters verbatim, only people from the listed cast. Keep the existing shot sizes. Do not freeze states the script has not reached.

Return ONLY JSON: {"seams":[{"index":<given index>,"last":"<new X.5 action>","first":"same moment — <new (X+1).1 action>"}]}`;
}

export function seamRepairUserPrompt(shotList: ShotList, issues: SeamIssue[]): string {
  const blocks = issues.map(({ index, reason }) => {
    const a = shotList.scenes[index], b = shotList.scenes[index + 1];
    const A = a.beats, B = b.beats;
    return [
      `SEAM index ${index} — ROW ${index + 1} ${a.tag || ""} → ROW ${index + 2} ${b.tag || ""} (detected: ${reason})`,
      `Cast row ${index + 1}: ${a.characters.join(", ") || "-"}; cast row ${index + 2}: ${b.characters.join(", ") || "-"}`,
      `${index + 1}.4 ${A[3].shot}: ${A[3].action}`,
      `${index + 1}.5 ${A[4].shot}: ${A[4].action}   ← rewrite`,
      `${index + 2}.1 ${B[0].shot}: ${B[0].action}   ← rewrite`,
      `${index + 2}.2 ${B[1].shot}: ${B[1].action}`,
    ].join("\n");
  });
  return [shotList.layout ? `LAYOUT: ${shotList.layout}` : "", ...blocks, "Rewrite the marked beats now."].filter(Boolean).join("\n\n");
}

/** Apply a repair answer; unknown / empty entries are ignored. Returns how many seams were changed. */
export function applySeamRepair(shotList: ShotList, raw: unknown): number {
  const root = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(root.seams) ? root.seams : Array.isArray(raw) ? (raw as unknown[]) : [];
  let n = 0;
  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>;
    const index = typeof o.index === "number" ? o.index : Number(o.index);
    const last = typeof o.last === "string" ? o.last.trim() : "";
    const first = typeof o.first === "string" ? o.first.trim() : "";
    if (!Number.isInteger(index) || index < 0 || index >= shotList.scenes.length - 1 || !last || !first) continue;
    shotList.scenes[index].beats[SHOT_LIST_BEATS - 1].action = last;
    shotList.scenes[index + 1].beats[0].action = `same moment — ${first.replace(SAME_MOMENT_RE, "")}`;
    n++;
  }
  return n;
}

/**
 * Deterministic fallback when the model cannot repair a seam: (X+1).1 becomes a copy of X.5 (one picture, the
 * other shot size). Loses the wider/closer framing nuance but never leaves two different moments on the seam.
 */
export function forceSeams(shotList: ShotList, issues: SeamIssue[]): void {
  for (const { index } of issues) {
    const last = shotList.scenes[index].beats[SHOT_LIST_BEATS - 1].action;
    shotList.scenes[index + 1].beats[0].action = `same moment — ${last.replace(SAME_MOMENT_RE, "")}`;
  }
}

/** ONE CAPS word (letters/digits/hyphen), max 24 chars; "" when absent. */
export function normalizeRowTag(v: string): string {
  const w = v.trim().replace(/[:\s].*$/, "").replace(/[^A-Za-z0-9-]/g, "");
  return w ? w.toUpperCase().slice(0, 24) : "";
}

/**
 * Shot SIZE normalizer. Angles are not sizes: over-the-shoulder / POV / low / high / insert / reverse collapse
 * to "medium" (or "close" for insert). "two-shot" survives as a suffix on wide / medium / close.
 */
export function normalizeShotType(v: string): ShotType {
  const s = v.toLowerCase().replace(/[_\s]+/g, "-");
  const two = /two-?shot|2-?shot/.test(s);
  if (/extreme|ecu|xcu|macro/.test(s)) return "extreme close-up";
  if (/insert|detail/.test(s)) return "close";
  if (/close|\bcu\b|^cu|-cu\b|tight/.test(s)) return two ? "close two-shot" : "close";
  if (/wide|long|establish|\bws\b|full/.test(s)) return two ? "wide two-shot" : "wide";
  return two ? "medium two-shot" : "medium";
}

/** Flatten the 5×5 shot list into 25 ordered BeatMeta records (number 1..25). */
export function beatsFromShotList(shotList: ShotList): BeatMeta[] {
  const out: BeatMeta[] = [];
  shotList.scenes.forEach((scene, si) => {
    scene.beats.forEach((beat, bi) => {
      const next = bi + 1 < scene.beats.length ? scene.beats[bi + 1] : shotList.scenes[si + 1]?.beats[0] ?? null;
      // CHARACTER SHEETs of this row's cast only (the grid merges them across rows); layout on every beat.
      const castSheets: Record<string, string> = {};
      for (const n of scene.characters) { const sheet = shotList.characterSheets?.[n]; if (sheet) castSheets[n] = sheet; }
      out.push({
        v: 1, sceneIndex: si + 1, beatIndex: bi + 1, sceneTitle: scene.title, location: scene.location,
        characters: scene.characters, shot: beat.shot, action: beat.action, cut: beat.cut,
        nextStart: next ? next.action : null,
        rowTag: scene.tag || null,
        layout: shotList.layout || null,
        castSheets: Object.keys(castSheets).length ? castSheets : null,
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
    rowTag: typeof m.rowTag === "string" && m.rowTag ? m.rowTag : null,
    layout: typeof m.layout === "string" && m.layout ? m.layout : null,
    castSheets: m.castSheets && typeof m.castSheets === "object" && !Array.isArray(m.castSheets)
      ? Object.fromEntries(Object.entries(m.castSheets as Record<string, unknown>).filter(([, v]) => typeof v === "string" && v).map(([k, v]) => [k, String(v)]))
      : null,
    gridPanelUrl: typeof m.gridPanelUrl === "string" && m.gridPanelUrl ? m.gridPanelUrl : null,
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

/** Human shot-size label for the END line ("Medium shot: …"). */
export function shotSizeLabel(shot: string | null | undefined): string {
  const s = normalizeShotType(String(shot ?? "medium"));
  if (s === "wide") return "Wide shot";
  if (s === "close") return "Close-up";
  if (s === "extreme close-up") return "Extreme close-up";
  if (s === "wide two-shot") return "Wide two-shot";
  if (s === "medium two-shot") return "Medium two-shot";
  if (s === "close two-shot") return "Close two-shot";
  return "Medium shot";
}

/** The next clip's opening panel (scene N+1) — becomes the END of clip N. */
export interface NextBeatRef { shot: string | null; action: string }

/** Derive the END target from the following Scene row (beatMeta first, then shotType/action columns). */
export function nextBeatFromSceneRow(row: { beatMeta?: unknown; shotType?: string | null; action?: string | null } | null | undefined): NextBeatRef | null {
  if (!row) return null;
  const nb = parseBeatMeta(row.beatMeta);
  if (nb) return { shot: nb.shot, action: nb.action };
  const action = (row.action ?? "").trim();
  return action ? { shot: row.shotType ?? null, action } : null;
}

export const BEAT_VIDEO_FRAMING =
  "FRAMING: the clip ends on a shot size different from the opening one (wide / medium / close-up). Never return to the opening framing.";

export const BEAT_VIDEO_NEGATIVES =
  "Do not show any wall or area that is not visible in the START FRAME. No new doors, windows or objects on the visible walls. " +
  "No changes to the characters' wardrobe, hair or face mid-shot; nothing worn is removed or added unless stated in ACTIONS. " +
  "No teleporting — every change of position is a visible walk. No slow motion. " +
  "No looking into the camera; no blank stares into nothing — every glance is aimed at a person, object or sound described in ACTIONS.";

/**
 * Step 10 — the animation prompt for ONE beat clip (4–5 s). Structure (fixed, English):
 *   START FRAME (image 1) → Characters (appearance only, image 2..N) → ACTIONS (the movement from freeze-frame N
 *   into freeze-frame N+1 — the only place a movement is described) →
 *   END (= the NEXT panel: its shot size + action; last scene → the final pose, static) → FRAMING → NEGATIVES.
 * `next` = scene N+1 (explicit); when undefined the stored beat.nextStart is used (no shot size known).
 */
export function buildBeatVideoPrompt(input: {
  beat: BeatMeta;
  characterNames: string[];
  hasStartFrame: boolean;
  next?: NextBeatRef | null;
}): string {
  const { beat } = input;
  const chars = input.characterNames.length ? input.characterNames : beat.characters;
  const lines: string[] = [];
  let idx = 1;
  if (input.hasStartFrame) {
    lines.push("START FRAME:");
    lines.push(`image ${idx} — the location, the characters' positions, poses and shot size at the first frame. This is the only source of the space.`);
    idx++;
  } else {
    // Legacy / text-to-video fallback: no start-frame image attached — describe the opening instead.
    lines.push("START FRAME:");
    lines.push(`No start-frame image is attached. Open on a ${shotSizeLabel(beat.shot).toLowerCase()}: ${beat.location}. ${beat.action}`);
  }
  lines.push("");
  if (chars.length) {
    lines.push("Characters (appearance only):");
    chars.forEach((n) => { lines.push(`image ${idx} — ${n}.`); idx++; });
    lines.push("");
  }
  // ACTIONS is the ONLY place where the movement between freeze-frame N (START) and freeze-frame N+1 (END) is described.
  const next = input.next === undefined ? (beat.nextStart ? { shot: null, action: beat.nextStart } : null) : input.next;
  lines.push("ACTIONS:");
  if (next && next.action.trim()) {
    lines.push(`From the START FRAME state, ${beat.action.trim().replace(/[.\s]+$/, "")} → moves continuously into: ${next.action.trim()}`);
  } else {
    lines.push(beat.action.trim());
  }
  lines.push("");
  if (next && next.action.trim()) {
    lines.push(`END: ${next.shot ? `${shotSizeLabel(next.shot)}: ` : ""}${next.action.trim()}`);
  } else {
    const finalPose = (beat.cut || "").trim() || "the characters hold their final positions";
    lines.push(`END: ${shotSizeLabel(beat.shot)}: ${finalPose} The characters hold this final pose — static frame, no further movement.`);
  }
  lines.push("");
  lines.push(BEAT_VIDEO_FRAMING);
  lines.push("");
  lines.push("NEGATIVES:");
  lines.push(BEAT_VIDEO_NEGATIVES);
  return lines.join("\n");
}
