/**
 * Stage 38 tests — (1) the previous scene's last frame is never sent as a reference;
 * (2) sceneKind "action" with face-to-face combat staging in the final prompt and the schemas.
 * Run: npx tsx scripts/test-stage38.ts
 *
 * Pure-logic only (NO Replicate / network / LLM / DB).
 */
import assert from "node:assert";
import { buildScenePrompt } from "../lib/scene-prompt";
import {
  sceneScriptSchema, sceneReviseSchema, SCENE_KINDS, isActionKind, validateEpisodeScript,
  ACTION_STAGING_RULE, ACTION_PACE_DIRECTION, PACE_DIRECTION, CONFRONTATION_STAGING_SENTENCE,
  renderScriptFromScenes, episodeScriptSystemPrompt, sceneReviseSystemPrompt,
} from "../lib/season";
import { VISUAL_STYLE_ID } from "../lib/visual-style";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };
const styledUrl = (name: string) => "https://media.invalid/" + VISUAL_STYLE_ID + "/" + name + ".webp";

const scene = {
  id: "s3", number: 3, videoPrompt: "[ACTION]: Yara turns to Theo.", sceneKind: null, voiceover: null,
  dialogue: 'YARA: "Now."', dialogueEn: 'YARA: "Now."', language: "en", locationDesc: "Kitchen", continuesFrom: null,
};
const previous = { id: "s2", number: 2, locationDesc: "Kitchen", lastFrameUrl: styledUrl("s2-lastframe") };
const loc = { id: "loc", name: "Kitchen", imageUrl: styledUrl("k-wide"), imageReverse: styledUrl("k-reverse"), imageDetail: styledUrl("k-detail") };
const cast = ["Yara", "Theo"].map(n => ({ characterId: n.toLowerCase(), name: n, tier: "MAIN", imageFront: styledUrl(n.toLowerCase()) }));

// ── a. chained scene with previous.lastFrameUrl → no previous_frame reference, no continuity note ──
{
  const b = buildScenePrompt({ scene, characters: cast, location: loc, previous, provider: "seedance" });
  const kinds = b.retryRefs.map(r => r.kind);
  ok(!kinds.includes("previous_frame"), "a: no previous_frame among the reference kinds");
  ok(!b.referenceImages.includes(previous.lastFrameUrl), "a: previous scene's lastFrameUrl is not among the images");
  ok(b.previousFrameSceneId === null && (b.reference as any).previousFrameSceneId === null, "a: previousFrameSceneId is null (result + diagnostics)");
  ok(!/previous frame|final frame of the previous scene|previous scene/i.test(b.prompt), "a: prompt has no 'previous frame' note");
  ok(JSON.stringify(kinds) === JSON.stringify(["character", "character", "location", "location", "location"]), "a: 2 portraits + 3 location angles only");
  ok(!("image" in b), "a: no first-frame `image` either");
}

// ── b. action scene → action staging block, NO 'never face to face' talking rule ──────────────────
{
  const action = { ...scene, sceneKind: "action", dialogue: 'YARA: "Now."', dialogueEn: 'YARA: "Now."' };
  const b = buildScenePrompt({ scene: action, characters: cast, location: loc, previous, provider: "seedance" });
  ok(b.prompt.includes("ACTION STAGING (fight"), "b: action prompt contains the ACTION STAGING block");
  ok(b.prompt.includes("CHOREOGRAPHY:"), "b: action prompt contains the CHOREOGRAPHY block");
  ok(b.prompt.includes(ACTION_PACE_DIRECTION), "b: action prompt embeds ACTION_PACE_DIRECTION verbatim");
  ok(ACTION_PACE_DIRECTION.includes(ACTION_STAGING_RULE), "b: ACTION_PACE_DIRECTION embeds ACTION_STAGING_RULE");
  ok(!b.prompt.includes("never two people simply standing face to face"), "b: action prompt does NOT carry the talking-scene 'never face to face' rule");
  ok(!b.prompt.includes(PACE_DIRECTION), "b: action prompt does NOT carry the conversational PACE_DIRECTION");
  ok(/ONLY in the pauses between impacts/.test(b.prompt), "b: dialogue preamble says lines land only in the pauses between impacts");
  ok(/opponents face EACH OTHER/.test(b.prompt) && /NEVER both fighters facing the camera side by side/.test(b.prompt), "b: face-to-face combat + no side-by-side-to-camera");
  ok(/NEVER anyone casting, shooting or striking at someone's BACK/.test(b.prompt), "b: no attacks at someone's back / empty air");
  ok(!/NO BLOOD/.test(b.prompt) && /blood, wounds/.test(b.prompt), "b: no-blood softening removed, impact consequences allowed");
  ok(/on camera: "Now\."/.test(b.prompt), "b: the spoken line is still rendered");
  ok(b.referenceImages.length === 5, "b: references unchanged for action scenes (2 portraits + 3 angles)");
}

// ── c. dialogue scene → PACE_DIRECTION + confrontation sentence ──────────────────────────────────
{
  const b = buildScenePrompt({ scene, characters: cast, location: loc, previous, provider: "seedance" });
  ok(b.prompt.includes(PACE_DIRECTION), "c: dialogue prompt embeds PACE_DIRECTION verbatim");
  ok(b.prompt.includes("STAGING: never two people simply standing face to face talking"), "c: dialogue prompt keeps the 'never face to face when simply talking' rule");
  ok(b.prompt.includes(CONFRONTATION_STAGING_SENTENCE), "c: dialogue prompt embeds the CONFRONTATION sentence");
  ok(b.prompt.includes("CONFRONTATION: any confrontational beat"), "c: confrontation sentence text present");
  ok(!b.prompt.includes("ACTION STAGING (fight"), "c: dialogue prompt has no ACTION STAGING block");
  ok(/Whether the speaker's face is in frame depends on the staging/.test(b.prompt), "c: speech preamble — face in frame depends on staging");
  // narration scenes are untouched by the action logic
  const narr = buildScenePrompt({
    scene: { ...scene, sceneKind: "narration", dialogue: "[NO DIALOGUE]", dialogueEn: "[NO DIALOGUE]", voiceover: "For thirty years the light never failed." },
    characters: cast, location: loc, previous, provider: "seedance",
  });
  ok(!narr.prompt.includes("ACTION STAGING (fight") && !narr.prompt.includes(CONFRONTATION_STAGING_SENTENCE), "c: narration prompt has neither action block nor confrontation sentence");
}

// ── d. schemas accept sceneKind "action" ─────────────────────────────────────────────────────────
{
  ok(JSON.stringify(SCENE_KINDS) === JSON.stringify(["dialogue", "narration", "action"]) && isActionKind("action") && !isActionKind("dialogue"), "d: SCENE_KINDS + isActionKind");
  const base = {
    number: 4, shotType: "low wide → profile medium", durationSec: 12, locationDesc: "Courtyard", characters: ["Yara", "Theo"],
    action: "Yara lunges; Theo parries and throws her back.", dialogue: 'YARA: "Now."',
    videoPrompt: "[SHOT TYPE]: 0-5s low wide of both fighters closing the distance\n[VISUAL STYLE]: x\n[LIGHTING]: y\n[BLOCKING]: z\n[GAZE]: eyes on the opponent\n[NON-VERBAL]: strain\n[ACTION]: lunge, parry, throw\n[CHARACTER]: Yara, Theo\n[TRANSITION]: hard cut",
    startState: "Anna stands in the doorway, facing the window, hands empty, wide shot from the corner.", endState: "Anna stands by the window, back to the door, hands on the sill, medium shot from the doorway.",
  };
  const a = sceneScriptSchema.safeParse({ ...base, sceneKind: "action" });
  ok(a.success && a.data.sceneKind === "action", "d: sceneScriptSchema accepts sceneKind 'action'");
  const dflt = sceneScriptSchema.safeParse(base);
  ok(dflt.success && dflt.data.sceneKind === "dialogue", "d: sceneScriptSchema still defaults sceneKind to 'dialogue'");
  ok(!sceneScriptSchema.safeParse({ ...base, sceneKind: "fight" }).success, "d: sceneScriptSchema rejects unknown kinds");
  const r = sceneReviseSchema.safeParse({ sceneKind: "action", shotType: "low wide", durationSec: 16, locationDesc: "Courtyard", action: "Yara lunges.", dialogue: 'YARA: "Now."', videoPrompt: base.videoPrompt, startState: "Anna stands in the doorway, facing the window, hands empty, wide shot from the corner.", endState: "Anna stands by the window, back to the door, hands on the sill, medium shot from the doorway." });
  ok(r.success && r.data.sceneKind === "action", "d: sceneReviseSchema accepts optional sceneKind 'action'");
  const r2 = sceneReviseSchema.safeParse({ shotType: "low wide", durationSec: 16, locationDesc: "Courtyard", action: "Yara lunges.", dialogue: 'YARA: "Now."', videoPrompt: base.videoPrompt, startState: "Anna stands in the doorway, facing the window, hands empty, wide shot from the corner.", endState: "Anna stands by the window, back to the door, hands on the sill, medium shot from the doorway." });
  ok(r2.success && r2.data.sceneKind === undefined, "d: sceneReviseSchema: sceneKind optional");
  ok(!sceneReviseSchema.safeParse({ sceneKind: "narration", shotType: "low wide", durationSec: 16, locationDesc: "Courtyard", action: "Yara lunges.", dialogue: 'YARA: "Now."', videoPrompt: base.videoPrompt, startState: "Anna stands in the doorway, facing the window, hands empty, wide shot from the corner.", endState: "Anna stands by the window, back to the door, hands on the sill, medium shot from the doorway." }).success, "d: sceneReviseSchema does not allow switching to narration");

  // action scenes are exempt from the talking-scene density checks
  const script = { title: "T", synopsis: "S", scenes: [{ ...base, number: 1, sceneKind: "action" as const }] };
  const parsed = sceneScriptSchema.array().parse(script.scenes);
  const problems = validateEpisodeScript({ ...script, scenes: parsed } as any);
  ok(!problems.some(p => /dialogue sentences/.test(p)), "d: validateEpisodeScript: no sentence-density complaint for an action scene");

  // rendering + prompts
  ok(renderScriptFromScenes({ number: 1, title: "T" }, ["Yara", "Theo"], [{ number: 1, sceneKind: "action", shotType: "low wide", durationSec: 16, locationDesc: "Courtyard", action: "Yara lunges.", dialogue: 'YARA: "Now."' }]).includes("СЦЕНА 1 · ЭКШЕН"), "d: rendered script header marks action scenes with · ЭКШЕН");
  const sys = episodeScriptSystemPrompt("ru" as any, 2);
  ok(sys.includes(ACTION_STAGING_RULE) && /"dialogue"\|"narration"\|"action"/.test(sys), "d: episode script prompt explains the action kind and carries ACTION_STAGING_RULE");
  const rev = sceneReviseSystemPrompt("ru" as any);
  ok(rev.includes(CONFRONTATION_STAGING_SENTENCE) && /"sceneKind"/.test(rev), "d: revise prompt returns sceneKind and carries the confrontation sentence");
}

console.log(`\nStage 38: ${pass} checks passed.`);
