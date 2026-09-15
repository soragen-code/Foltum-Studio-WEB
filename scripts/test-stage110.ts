/**
 * Stage 110 — dialogue back in every scene, "Regenerate script" removed. (The Stage 110 keyframe-mode i2v prompt
 * was dropped again in Stage 111 — see test-stage111.ts.)
 * Run: timeout 120 npx tsx --tsconfig tsconfig.json scripts/test-stage110.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  MAX_SILENT_SCENES,
  episodeScriptSystemPrompt,
  episodeScriptSchema,
  normalizeEpisodeScript,
  validateEpisodeScript,
  hardProblems,
  dialogueSpeakers,
  type EpisodeScript,
} from "../lib/season";

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
  passed++; console.log(`ok: ${msg}`);
}
const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

/* ---------------------------------------------------------------- (a) Stage 111 superseded the keyframe-mode i2v prompt
   (buildKeyframeVideoPrompt / image-to-video) — the video path is covered by test-stage111.ts. */
const worker = read("lib/workers/video-job.ts");
ok(!/applySeriesIntro/.test(worker), "video-job no longer applies the Stage 87 series-intro (b-roll / no talking on scene 1)");
ok(/buildKeyframeRequest/.test(read("lib/keyframe.ts")) && /WAVESPEED_SEEDREAM_EDIT/.test(read("lib/keyframe.ts")), "Seedream keyframe request builder untouched");

/* ---------------------------------------------------------------- (b) script prompt */
ok(MAX_SILENT_SCENES === 0, "MAX_SILENT_SCENES === 0");
for (const [lang, epNo] of [["ru", 1], ["ru", 2], ["en", 3]] as const) {
  const sys = episodeScriptSystemPrompt(lang, epNo);
  ok(!/R7\./.test(sys) && !/OPENING NARRATION/.test(sys), `ep${epNo}/${lang}: no R7 / OPENING NARRATION rule`);
  ok(!/previously on/i.test(sys) || /NO "previously on"/.test(sys), `ep${epNo}/${lang}: no "previously on" intro requested`);
  ok(!/"sceneKind": "narration"/.test(sys) && !/"dialogue"\|"narration"\|"action"/.test(sys), `ep${epNo}/${lang}: narration kind not offered in the schema`);
  ok(!/NO character mouths moving/.test(sys) && !/NO talking heads/.test(sys), `ep${epNo}/${lang}: no mouths-closed / b-roll directive`);
  ok(/R2\. NO SILENT SCENES/.test(sys), `ep${epNo}/${lang}: R2 reworded — no silent scenes`);
  ok(/"dialogue" is STRICTLY in ENGLISH/.test(sys) && /ENGLISH character names/.test(sys), `ep${epNo}/${lang}: dialogue strictly English with English cast names`);
  ok(/\[ACTION\]: DETAILED choreography of the whole 10 s clip written as ONE continuous 0–10s beat/.test(sys), `ep${epNo}/${lang}: [ACTION] asks for one continuous 0–10s choreography beat`);
  ok(/"action" \(2–3 sentences, DETAILED choreography of the full 10 s clip written as ONE continuous 0–10s beat/.test(sys), `ep${epNo}/${lang}: S3 action field is one 10 s choreography beat`);
  ok(/An action scene carries 1–2 SHORT English lines \(never "\[NO DIALOGUE\]"\)/.test(sys), `ep${epNo}/${lang}: action scenes still carry lines`);
}
ok(/dialogueLocal/.test(episodeScriptSystemPrompt("ru", 1)) && !/dialogueLocal/.test(episodeScriptSystemPrompt("en", 1)), "dialogueLocal requested only for non-English stories");
const seasonSrc = read("lib/season.ts");
ok(/SCENE_KINDS = \["dialogue", "narration", "action"\]/.test(seasonSrc), "\"narration\" kept in SCENE_KINDS for stored-data compat");
ok(!/off-screen NARRATOR briefly recapping/.test(seasonSrc), "user prompt no longer asks scene 1 to open with a narrator recap");
const jobSrc = read("lib/workers/season-script-job.ts");
ok(/export function episodeRetryNote/.test(jobSrc) && /\+ episodeRetryNote\(state\)/.test(jobSrc), "episode retry appends a targeted CORRECTION note");
ok(/validateEpisode\(raw, ep\.number, cards, \{ finalAttempt \}\)/.test(jobSrc) && /forceEnglishDialogue\(script\)/.test(jobSrc), "job: attempt-aware validation + translate fallback on the final attempt");
ok(/import \{ translateDialogue \} from "@\/lib\/voiceover"/.test(jobSrc), "job reuses translateDialogue from lib/voiceover");
const scenesJob = read("lib/workers/scenes-job.ts");
ok(/const MAX_SILENT_SCENES = 0;/.test(scenesJob) && !/only \$\{MIN_SILENT_SCENES\}–\$\{MAX_SILENT_SCENES\} scenes are purely visual/.test(scenesJob), "scenes-job aligned: zero silent scenes");

/* ---------------------------------------------------------------- (c) validation */
const videoPrompt = [
  "[SHOT TYPE]: 0–10s wide, Mark from the door to the desk → 10–20s medium two-shot → 20–30s reaction on Elena; vertical 9:16",
  "[VISUAL STYLE]: photoreal live-action, cold teal-and-amber palette",
  "[LIGHTING]: late evening, single desk lamp and grey rain light from the window",
  "[BLOCKING]: Mark enters from the corridor door and crosses to the desk; Elena rises and steps to the window",
  "[GAZE]: Mark locks eyes with Elena on his first line; Elena looks away to the window",
  "[NON-VERBAL]: Mark's jaw tight; Elena's hands flat on the desk",
  "[ACTION]: 0–10s Mark pushes the door open and crosses to the desk. 10–20s Elena rises and slams the logbook. 20–30s Mark grabs the radio handset.",
  "[CHARACTER]: Mark Ellison, 40, dark hair, navy rain jacket; Elena Voss, 36, red hair tied back, grey sweater",
  "[TRANSITION]: hard cut into the next shot",
].join("\n");
const goodDialogue = 'MARK (low): "You were at the pier last night. I saw the lantern."\nELENA (sharply): "Then you saw nothing that concerns you. Go home, Mark."\nMARK: "I can\'t. Not until you tell me where the boat went."\nELENA (quiet): "It went where boats go when nobody is meant to follow. Leave it."\nMARK: "I won\'t leave it."';
const baseScene = {
  shotType: "Wide", durationSec: 30, locationDesc: "INT — office — night", characters: ["Mark", "Elena"],
  action: "Mark enters and crosses to the desk. Elena rises.", sceneKind: "dialogue", dialogue: goodDialogue,
  videoPrompt: videoPrompt, presence: "both at the desk", entrances: "none", continuesFrom: "same-location-continuation",
  startState: "WORLD: Mark at the door. CAMERA: wide.", endState: "WORLD: Elena at the window. CAMERA: medium.",
};
const mk = (over: Partial<typeof baseScene>[]): EpisodeScript =>
  normalizeEpisodeScript(episodeScriptSchema.parse({ visualIdentity: "photoreal cinematic", scenes: over.map((o, i) => ({ ...baseScene, ...o, number: i + 1 })) }));
const cast = ["Mark Ellison", "Elena Voss"];
const nScenes = (over: Partial<typeof baseScene> = {}) => Array.from({ length: 9 }, () => ({ ...over }));
const good = mk(nScenes());
ok(hardProblems(validateEpisodeScript(good, { characterNames: cast })).length === 0, `a good 9-scene English script passes (${JSON.stringify(validateEpisodeScript(good, { characterNames: cast }))})`);
const silent = mk([{}, { dialogue: "[NO DIALOGUE]" }]);
ok(hardProblems(validateEpisodeScript(silent, { characterNames: cast })).some((p) => /silent scene\(s\) 2/.test(p)), "a [NO DIALOGUE] scene is a HARD failure");
const empty = mk([{ dialogue: "   " }, {}]);
ok(hardProblems(validateEpisodeScript(empty)).some((p) => /silent scene\(s\) 1/.test(p)), "an empty dialogue is a HARD failure (normalize → [NO DIALOGUE])");
const narr = mk([{ sceneKind: "narration", voiceover: "Long ago the harbour was full of ships.", dialogue: "[NO DIALOGUE]" } as never, {}]);
ok(narr.scenes[0].sceneKind === "dialogue" && !narr.scenes[0].voiceover, "a model-emitted narration scene is normalized to an on-camera scene (voiceover dropped)");
ok(hardProblems(validateEpisodeScript(narr)).some((p) => /silent scene\(s\) 1/.test(p)), "…and rejected as silent");
const cyr = mk([{ dialogue: 'MARK (тихо): "Ты была на пирсе вчера ночью."\nELENA (резко): "Иди домой, Марк."\nMARK: "Не уйду."' }, {}]);
ok(hardProblems(validateEpisodeScript(cyr, { characterNames: cast })).some((p) => /scene 1: dialogue is not English/.test(p)), "Cyrillic dialogue is a HARD failure on the first attempt");
ok(!hardProblems(validateEpisodeScript(cyr, { characterNames: cast, languageIsSoft: true })).some((p) => /not English/.test(p)) && validateEpisodeScript(cyr, { characterNames: cast, languageIsSoft: true }).some((p) => /^soft: scene 1: dialogue is not English/.test(p)), "…and only SOFT on the final attempt (job translates it)");
const cyrName = mk([{ dialogue: 'МАРК (тихо): "You were at the pier."\nELENA: "Go home, Mark. Go home now and forget it."\nМАРК: "I cannot forget it, not this time."' }, {}]);
ok(hardProblems(validateEpisodeScript(cyrName, { characterNames: cast })).some((p) => /speaker name\(s\) not from the cast: МАРК/.test(p)), "a Cyrillic speaker name is rejected");
const wrongName = mk(nScenes({ dialogue: goodDialogue.replace(/MARK/g, "JOHN") }));
ok(hardProblems(validateEpisodeScript(wrongName, { characterNames: cast })).some((p) => /speaker name\(s\) not from the cast: JOHN/.test(p)), "an unknown English speaker name is rejected when the cast is given");
ok(hardProblems(validateEpisodeScript(wrongName)).length === 0, "…but not when no cast is passed (legacy callers)");
ok(dialogueSpeakers('DR. MARK (low): "a"\nElena Voss: "b"\nALL: "c"\nno colon line').join("|") === "DR. MARK|Elena Voss", "dialogueSpeakers extracts labels and skips generic ALL");
ok(hardProblems(validateEpisodeScript(mk(nScenes({ dialogue: goodDialogue.replace(/MARK/g, "MARK ELLISON").replace(/ELENA/g, "Dr. Elena") })), { characterNames: cast })).length === 0, "full names / title prefixes still match the cast");

/* ---------------------------------------------------------------- (d) UI */
const view = read("app/project/[id]/episode/[episodeId]/episode-view.tsx");
ok(!/Regenerate script/.test(view) && !/regenerate-script/.test(view), "episode-view: \"Regenerate script\" button gone");
ok(/data-testid="generate-script"/.test(view) && /Generate script/.test(view) && /data-testid="no-script"/.test(view), "\"Generate script\" kept for the no-script state");
for (const f of ["app/project/[id]/_components/season-stage.tsx", "app/project/[id]/_components/episode-footage.tsx"]) {
  if (fs.existsSync(path.join(__dirname, "..", f))) ok(!/Regenerate script/.test(read(f)), `${f}: no "Regenerate script"`);
}

console.log(`\nStage 110: all ${passed} checks passed.`);
