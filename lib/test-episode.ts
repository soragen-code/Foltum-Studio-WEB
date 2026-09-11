/**
 * Stage 40 — "test episode" project mode.
 *
 * A test project skips the whole story pipeline (idea → references → characters → structure → scripts):
 * the author brings ONE hand-written (or LLM-invented) Seedance prompt, and we create a one-scene episode
 * around it so the regular scene / video tooling (prompt preview, generation, chain hand-off, assembly)
 * can be exercised end-to-end at the cost of a single clip.
 *
 * Pure helpers only (no DB / network) so they are unit-testable; the routes do the persistence.
 */
import { z } from "zod";
import {
  ACTION_STAGING_RULE,
  END_STATE_RULE,
  START_STATE_RULE,
  EVERYDAY_BEHAVIOR_RULE,
  LOCATION_PRESENCE_RULE,
  MODERATION_SAFE_RULE,
  SCALE_DEPTH_RULE,
  SCENE_KINDS,
  SCENE_MAX_SECONDS,
  renderScriptFromScenes,
  type SceneKind,
} from "@/lib/season";
import { stripMarkup } from "@/lib/idea";
import { resolveProjectName } from "@/lib/project-name";

export const TEST_EPISODE_TITLE = "Тестовая серия";
export const TEST_SEASON_TITLE = "Тест";
export const TEST_PROMPT_MIN_CHARS = 20;
export const TEST_PROMPT_MAX_CHARS = 6000;
export const TEST_DURATION_MIN = 5;
export const TEST_DURATION_MAX = SCENE_MAX_SECONDS;
/** Stage 46A — every test-episode scene is a fixed 30 s clip (server-enforced, client value ignored). */
export const TEST_EPISODE_DURATION_SEC = 30;

export const PROMPT_TAGS = ["[SHOT TYPE]", "[VISUAL STYLE]", "[LIGHTING]", "[BLOCKING]", "[GAZE]", "[NON-VERBAL]", "[ACTION]", "[CHARACTER]", "[TRANSITION]"] as const;

/** Which of the 9 canonical prompt tags are missing from a hand-written prompt (advisory — the prompt is still accepted). */
export function missingPromptTags(prompt: string): string[] {
  return PROMPT_TAGS.filter((t) => !prompt.includes(t));
}

const clampDuration = (n: number) => Math.min(TEST_DURATION_MAX, Math.max(TEST_DURATION_MIN, Math.round(n)));

/** What the "invent a test scene" LLM call returns. */
export const testSceneResultSchema = z.object({
  projectTitle: z.string().optional().nullable(),
  title: z.string().min(1),
  locationDesc: z.string().min(3),
  sceneKind: z.enum(SCENE_KINDS).optional().default("dialogue"),
  videoPrompt: z.string().min(40),
  /** ENGLISH lines, one per row `NAME (tone): "line"`, or exactly "[NO DIALOGUE]". */
  dialogue: z.string().min(1),
  action: z.string().min(5),
  durationSec: z.coerce.number().int().min(1).max(120).optional().default(15),
  endState: z.string().min(1),
  /** Stage 41 — scripted first frame of the test scene. */
  startState: z.string().min(1),
});
export type TestSceneResult = z.infer<typeof testSceneResultSchema>;

export function normalizeTestSceneResult(raw: unknown): TestSceneResult {
  const r = testSceneResultSchema.parse(raw);
  return {
    ...r,
    projectTitle: r.projectTitle ? stripMarkup(r.projectTitle).trim() : null,
    title: stripMarkup(r.title).trim() || TEST_EPISODE_TITLE,
    videoPrompt: r.videoPrompt.trim(),
    dialogue: r.dialogue.trim(),
    durationSec: clampDuration(r.durationSec),
  };
}

export function testSceneSystemPrompt(): string {
  return (
    `You write ONE self-contained test scene for a vertical (9:16) AI video model (Seedance). The scene is generated WITHOUT any character or location reference images, so the prompt itself must fully describe everyone and everything in frame. ` +
    `Return STRICT JSON: {"projectTitle": string, "title": string, "locationDesc": string, "sceneKind": "dialogue"|"narration"|"action", "videoPrompt": string, "dialogue": string, "action": string, "durationSec": int, "startState": string, "endState": string}. ` +
    `"projectTitle" = a SHORT project name (2–4 words) in the language of the user's idea, derived from the idea itself, no quotes. "title" = a short scene title in the same language. ` +
    `"videoPrompt" is ENGLISH, exactly 9 lines, each starting with one tag in this order: ${PROMPT_TAGS.join("/")} — [SHOT TYPE] is a cut list with time ranges (2–4 hard cuts), [CHARACTER] gives a complete visual description (age, build, face, hair, clothing) of EVERY person on screen, since there are no references; no spoken text inside videoPrompt; never "slowly", "slow motion", "lingering", "long pause". ` +
    `"dialogue" is ALWAYS ENGLISH — one line per row NAME (tone cue): "line", 2–5 quick lines that the characters actually say, or exactly "[NO DIALOGUE]" for a purely visual beat. "action" = 2–4 English sentences of what physically happens. "durationSec" = round(spoken words / 2.1) + 2 clamped to ${TEST_DURATION_MIN}–${TEST_DURATION_MAX}. ` +
    `${MODERATION_SAFE_RULE} ${LOCATION_PRESENCE_RULE} ${SCALE_DEPTH_RULE} ${EVERYDAY_BEHAVIOR_RULE} For sceneKind "action": ${ACTION_STAGING_RULE} ` +
    `START / END STATE: ${START_STATE_RULE} (for this single scene startState simply describes frame 1.) ${END_STATE_RULE} Original content only; Western names in Latin letters.`
  );
}

export function testSceneUserPrompt(idea: string, durationSec?: number | null): string {
  const dur = durationSec ? `Target clip length: ${clampDuration(durationSec)} seconds.` : `Pick the clip length yourself (${TEST_DURATION_MIN}–${TEST_DURATION_MAX} s).`;
  return `Scene idea from the author:\n${idea.trim()}\n\n${dur}`;
}

export interface TestEpisodeInput {
  prompt: string;
  projectTitle?: string | null;
  title?: string | null;
  locationDesc?: string | null;
  dialogue?: string | null;
  action?: string | null;
  durationSec?: number | null;
  sceneKind?: string | null;
  endState?: string | null;
  startState?: string | null;
  /** Story language (ISO 639-1) of the author's idea — kept on the project for UI purposes only. */
  language?: string | null;
}

export interface TestEpisodeRecords {
  project: { isTest: true; name: string; stage: "scenes"; charactersApproved: true; synopsisApproved: true; synopsis: string; language: string };
  season: { number: 1; title: string; logline: string };
  episode: { number: 1; title: string; logline: string; locationName: string; locationDesc: string; status: "script_ready"; script: string };
  scene: {
    number: 1;
    videoPrompt: string;
    dialogue: string;
    dialogueEn: string;
    action: string;
    shotType: string;
    durationSec: number;
    sceneKind: SceneKind;
    locationDesc: string;
    endState: string | null;
    startState: string | null;
    language: "en";
    status: "pending";
    continuesFrom: "new-sequence";
  };
}

const firstTagLine = (prompt: string, tag: string) => {
  const line = prompt.split("\n").find((l) => l.trim().startsWith(tag));
  return line ? line.trim().slice(tag.length).replace(/^\s*[:\-–—]\s*/, "").trim() : "";
};

/** Builds the DB-shaped records for a one-scene test episode from the author's prompt. Never throws on optional fields. */
export function buildTestEpisodeRecords(input: TestEpisodeInput): TestEpisodeRecords {
  const prompt = input.prompt.trim();
  if (prompt.length < TEST_PROMPT_MIN_CHARS) throw new Error(`prompt must be at least ${TEST_PROMPT_MIN_CHARS} characters`);
  const sceneKind: SceneKind = (SCENE_KINDS as readonly string[]).includes(input.sceneKind ?? "") ? (input.sceneKind as SceneKind) : "dialogue";
  const dialogue = (input.dialogue ?? "").trim() || "[NO DIALOGUE]";
  const locationDesc = (input.locationDesc ?? "").trim() || firstTagLine(prompt, "[VISUAL STYLE]") || "Test location";
  const action = (input.action ?? "").trim() || firstTagLine(prompt, "[ACTION]") || prompt.slice(0, 300);
  const shotType = firstTagLine(prompt, "[SHOT TYPE]") || "medium";
  // Stage 46A — fixed 30 s regardless of what the client (or the model) suggested.
  const durationSec = TEST_EPISODE_DURATION_SEC;
  const endState = (input.endState ?? "").trim() || null;
  const startState = (input.startState ?? "").trim() || null;
  const title = (input.title ?? "").trim() || TEST_EPISODE_TITLE;
  // Never ask the author for a name: LLM projectTitle → the [ACTION] line / explicit action → the raw prompt.
  const plotForName = (input.action ?? "").trim() || firstTagLine(prompt, "[ACTION]") || (input.title ?? "").trim() || prompt;
  const name = resolveProjectName(input.projectTitle, plotForName);
  const language = (input.language ?? "").trim() || "en";
  const logline = `Тестовая сцена: ${action.slice(0, 160)}`;
  const ep = { number: 1 as const, title, logline, locationName: locationDesc.slice(0, 80), locationDesc, status: "script_ready" as const, script: "" };
  ep.script = renderScriptFromScenes(ep, [], [{ number: 1, sceneKind, shotType, durationSec, locationDesc, action, dialogue, startState, endState }]);
  return {
    project: { isTest: true, name, stage: "scenes", charactersApproved: true, synopsisApproved: true, synopsis: logline, language },
    season: { number: 1, title: TEST_SEASON_TITLE, logline },
    episode: ep,
    scene: { number: 1, videoPrompt: prompt, dialogue, dialogueEn: dialogue, action, shotType, durationSec, sceneKind, locationDesc, startState, endState, language: "en", status: "pending", continuesFrom: "new-sequence" },
  };
}
