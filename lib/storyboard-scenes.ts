/**
 * Stage 220 — PER-SCENE storyboard planner (pure prompt builders + normalizer; no network / DB).
 *
 * The Storyboard episode no longer becomes ~50 discrete LLM beats. Each existing Scene now yields EXACTLY
 * two boards — a START frame and an END frame — plus one start→end image-to-video clip. This module makes
 * ONE `chatJSON` call per episode that, for every scene, returns:
 *   - onScreen[] / entering[] / exiting[]  — WHO is on camera, who walks in, who walks out (names ⊂ cast)
 *   - startFrame / endFrame                — English visual description of the first and the last still
 *   - motion                              — English description of the movement/transition from start to end
 *
 * All prose is ENGLISH (image/video prompts are English-only). Character names are drawn STRICTLY from the
 * passed cast; the normalizer drops any invented name. Dialogue is NOT produced here — it is restored
 * verbatim from the scene's own (English) lines by the worker, so this planner can never paraphrase speech.
 */

/** One scene handed to the planner (already English where dialogue matters). */
export interface ScenePlanInput {
  number: number;
  action?: string | null;
  dialogue?: string | null; // English dialogue (context only — informs the frames/motion, never rewritten)
  startState?: string | null; // scripted start of the FIRST frame
  endState?: string | null; // scripted end of the LAST frame
  presence?: string | null; // who is present at the START (free text)
  entrances?: string | null; // who enters / leaves inside the scene (free text)
  sceneKind?: string | null; // "narration" = voice-over; otherwise dialogue/action
  voiceover?: string | null; // English narration (narration scenes)
  // Stage 230 — a source scene whose dialogue exceeds one clip's speech budget is pre-split into several
  // sequential CONTINUATION parts. Each part is planned as its own two-frame scene, but a continuation part
  // (partIndex > 0) MUST keep the SAME location, the SAME characters and the SAME ongoing action as the
  // preceding part — it is the very next continuous moment, not a new scene.
  continues?: boolean; // true when the source scene was split into more than one part
  partIndex?: number; // 0-based index of this part inside its source scene
  partCount?: number; // total number of parts the source scene was split into
}

/** Normalized per-scene shot plan (one entry per input scene, in the same order). */
export interface ScenePlan {
  number: number;
  onScreen: string[];
  entering: string[];
  exiting: string[];
  startFrame: string;
  endFrame: string;
  motion: string;
}

/** Raw per-scene object as returned by the model (before normalization). */
interface RawScenePlan {
  number?: number;
  onScreen?: unknown;
  entering?: unknown;
  exiting?: unknown;
  startFrame?: unknown;
  endFrame?: unknown;
  motion?: unknown;
}

export function scenePlanSystemPrompt(): string {
  return [
    "You are a cinematography director turning a screenplay's scenes into a two-frame storyboard.",
    "For EACH scene you produce EXACTLY TWO keyframes — a START frame (the scene's opening image) and an END",
    "frame (the scene's closing image) — plus ONE continuous motion description of how the shot moves from the",
    "start frame to the end frame. The start frame will be animated into a single live-action clip whose LAST",
    "frame is the end frame, so the two frames must be the SAME place, the SAME set and the SAME continuous",
    "moment — only the characters' poses/positions and the scripted action advance between them. Never change",
    "the location between the two frames; every movement happens ON camera inside the one clip.",
    "",
    "RULES:",
    "- Write ALL text in ENGLISH only (no other language anywhere).",
    "- Use ONLY the exact character names given in CAST. Never invent, rename, translate or abbreviate a name,",
    "  and never add a character who is not in CAST.",
    "- onScreen = the characters visible in the frame(s). entering = characters who walk INTO frame during the",
    "  clip. exiting = characters who walk OUT of frame during the clip. A name may appear in onScreen and in",
    "  entering/exiting. If nobody enters or exits, use an empty array.",
    "- startFrame / endFrame: a vivid, concrete, filmable description of that single still — who is where, their",
    "  posture, expression and eyeline, what they hold, and the framing (wide / medium / close). Keep the set,",
    "  furniture and lighting identical between the two frames; only poses/positions/action differ.",
    "- motion: describe the continuous physical action, blocking and any camera move from the start frame to the",
    "  end frame. Do NOT include spoken dialogue text here (speech is handled separately) — describe only what is",
    "  seen to move. Show every scripted movement on camera; the camera never cuts inside the clip.",
    "- Preserve the scene's own order and count. Return one object per input scene.",
    "- CONTINUATION PARTS: some scenes carry `continues:true` with `partIndex`/`partCount` — a long scene that",
    "  was split into several consecutive parts (partIndex 0..partCount-1). All parts of one source scene are the",
    "  SAME physical scene running on without interruption: keep the SAME location, the SAME set, furniture and lighting, and the",
    "  SAME characters across all its parts. A continuation part (partIndex > 0) must OPEN exactly where the",
    "  previous part ended (same poses, positions and ongoing action) and simply carry the action forward — it is",
    "  the very next continuous moment, never a new place, a time jump or a fresh cast.",
    "",
    'Return STRICT JSON: {"scenes":[{"number":<int>,"onScreen":[...],"entering":[...],"exiting":[...],"startFrame":"...","endFrame":"...","motion":"..."}]}',
  ].join("\n");
}

export function scenePlanUserPrompt(
  scenes: ScenePlanInput[],
  ctx: { characters: string[]; location?: string | null },
): string {
  const cast = ctx.characters.filter(Boolean);
  const scenesForModel = scenes.map((s) => ({
    number: s.number,
    action: (s.action ?? "").trim() || null,
    dialogue: (s.dialogue ?? "").trim() || null,
    startState: (s.startState ?? "").trim() || null,
    endState: (s.endState ?? "").trim() || null,
    presentAtStart: (s.presence ?? "").trim() || null,
    entrancesExits: (s.entrances ?? "").trim() || null,
    kind: (s.sceneKind ?? "").trim() || null,
    narration: (s.voiceover ?? "").trim() || null,
    // Stage 230 — continuation metadata (present only for scenes split across several parts).
    ...(s.continues
      ? { continues: true, partIndex: s.partIndex ?? 0, partCount: s.partCount ?? 1 }
      : {}),
  }));
  return [
    `CAST (use these names verbatim, nobody else): ${cast.join(", ") || "(none)"}`,
    ctx.location ? `LOCATION (the whole episode plays here): ${ctx.location}` : "",
    "",
    "SCENES (in order — return exactly one plan object per scene, same order and same `number`):",
    JSON.stringify(scenesForModel, null, 2),
    "",
    "For every scene, produce onScreen/entering/exiting (names from CAST), a startFrame and an endFrame still",
    "description, and a start→end motion description. English only. Return the STRICT JSON described above.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Keep only real cast names (exact, case-insensitive), in cast order, deduped. */
function cleanNames(value: unknown, cast: string[]): string[] {
  if (!Array.isArray(value)) return [];
  const wanted = new Set(
    value
      .map((v) => (typeof v === "string" ? v.trim().toLowerCase() : ""))
      .filter(Boolean),
  );
  return cast.filter((c) => wanted.has(c.trim().toLowerCase()));
}

const asText = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * Normalize the model output into one ScenePlan per input scene (same order). Missing scenes are filled with
 * a safe default (whole cast on screen, empty frames) so the worker always gets a complete, aligned array.
 * All names are validated against `cast`; invented names are dropped.
 */
export function normalizeScenePlan(
  raw: { scenes?: RawScenePlan[] } | null | undefined,
  scenes: ScenePlanInput[],
  cast: string[],
): ScenePlan[] {
  const byNumber = new Map<number, RawScenePlan>();
  for (const r of raw?.scenes ?? []) {
    if (typeof r?.number === "number") byNumber.set(r.number, r);
  }
  const list = raw?.scenes ?? [];
  return scenes.map((s, i) => {
    const r = byNumber.get(s.number) ?? list[i] ?? {};
    const onScreen = cleanNames(r.onScreen, cast);
    const entering = cleanNames(r.entering, cast);
    const exiting = cleanNames(r.exiting, cast);
    // A scene must show SOMEONE: fall back to the scripted presence names, else the whole cast.
    const fallbackPresence = cast.filter((c) =>
      new RegExp(`(?<![\\p{L}\\p{N}])${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(
        `${s.presence ?? ""}\n${s.action ?? ""}\n${s.dialogue ?? ""}`,
      ),
    );
    const visible = onScreen.length ? onScreen : fallbackPresence.length ? fallbackPresence : cast.slice();
    const startFrame = asText(r.startFrame) || asText(s.startState) || asText(s.action);
    const endFrame = asText(r.endFrame) || asText(s.endState) || startFrame;
    const motion = asText(r.motion) || asText(s.action) || "The characters hold their positions with small, natural, motivated movement.";
    return { number: s.number, onScreen: visible, entering, exiting, startFrame, endFrame, motion };
  });
}
