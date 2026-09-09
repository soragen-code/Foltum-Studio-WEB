/**
 * Stage 9 — mini-trailer script generation must be a SINGLE main LLM call that already returns
 * BOTH English `dialogue` and project-language `dialogueLocal`, with the translation step adding
 * ZERO extra calls in the common case and at most ONE BATCHED call (never one-per-scene). Also
 * verifies the trailer prompt is COMPACT (essence of the heavy season rules, not their full text).
 */
import assert from "node:assert";
import { trailerSystemPrompt, trailerScriptSchema, TRAILER_CRAFT, TRAILER_ACTION } from "../lib/trailer";
import { ensureEnglishDialogue, normalizeEpisodeScript, episodeScriptSystemPrompt, isEnglishDialogue, SCENE_MIN_SECONDS, SCENE_MAX_SECONDS, SCALE_DEPTH_RULE, EVERYDAY_BEHAVIOR_RULE, PACE_DIRECTION, type EpisodeScript } from "../lib/season";

let pass = 0;
const ok = (cond: unknown, msg: string) => { assert(cond, msg); console.log("ok:", msg); pass++; };

const VP = (extra: string) =>
  `[SHOT TYPE]: 0-8s wide two-shot ${extra} -> 8-16s medium over-the-shoulder -> 16-22s medium reaction\n` +
  `[VISUAL STYLE]: photoreal cinematic vertical 9:16\n[LIGHTING]: warm afternoon window light\n` +
  `[BLOCKING]: Mara at the counter, Ethan by the door\n[GAZE]: they hold eye contact\n` +
  `[NON-VERBAL]: Mara wipes the counter, Ethan folds his arms\n[ACTION]: Ethan steps in, sets down a folder\n` +
  `[CHARACTER]: Mara (30s), Ethan (40s)\n[TRANSITION]: hard cut`;

async function main() {
// ---- 1) The trailer prompt is COMPACT: keeps the essence, drops the full heavy rules ----
const tp = trailerSystemPrompt("ru");
ok(/ALWAYS in ENGLISH/.test(tp) && /CUT LIST/.test(tp), "trailer prompt: English speech + cut list");
ok(tp.includes(TRAILER_CRAFT) && tp.includes(TRAILER_ACTION), "trailer prompt embeds the compact craft + action lines");
ok(/NO full-screen face close-up/.test(tp), "trailer prompt keeps the key framing constraint");
ok(!tp.includes(SCALE_DEPTH_RULE) && !tp.includes(EVERYDAY_BEHAVIOR_RULE) && !tp.includes(PACE_DIRECTION), "trailer prompt does NOT inline the full heavy season rules");
ok(tp.length < episodeScriptSystemPrompt("ru").length, "trailer prompt is shorter than the full episode prompt");

// ---- 2) Valid 3-scene structure with English dialogue + local translation, ZERO extra LLM calls ----
const rawScript = {
  title: "Тихий разлом",
  logline: "Двое партнёров скрывают правду, пока сделка не рушится.",
  visualIdentity: "photoreal cinematic, warm palette, shallow depth kept wide",
  locationNames: ["Кофейня", "Крыша"],
  scenes: [1, 2, 3].map((n) => ({
    number: n,
    shotType: "medium two-shot",
    durationSec: 20,
    locationDesc: `ИНТ. Кофейня — день (сцена ${n})`,
    characters: ["Mara", "Ethan"],
    action: "Ethan enters and sets down a folder while Mara keeps working",
    dialogue: `MARA (firmly): "You promised me this would hold."\nETHAN (quietly): "It will, if you trust me one more day."\nMARA (holding back): "Trust is exactly what you spent."`,
    dialogueLocal: `МАРА (твёрдо): «Ты обещал, что это выдержит.»\nИТАН (тихо): «Выдержит, если поверишь мне ещё день.»\nМАРА (сдерживаясь): «Доверие — это как раз то, что ты растратил.»`,
    videoPrompt: VP(`of Mara and Ethan scene ${n}`),
  })),
};
const parsed = trailerScriptSchema.parse(rawScript);
ok(parsed.scenes.length === 3, "schema accepts the 3-scene mini-trailer");

let calls = 0;
const chatSpy = async (_system: string, _user: string) => { calls++; return { scenes: [] }; };
const normalized: EpisodeScript = await ensureEnglishDialogue(
  normalizeEpisodeScript({ visualIdentity: parsed.visualIdentity, scenes: parsed.scenes }),
  chatSpy,
);
ok(calls === 0, "already-English dialogue → translation step makes ZERO extra LLM calls (total = 1 main call)");
ok(normalized.scenes.length === 3 && normalized.scenes.every((s) => isEnglishDialogue(s.dialogue) && s.dialogue.trim().length > 0), "all 3 scenes keep non-empty English dialogue");
ok(normalized.scenes.every((s) => s.dialogueLocal && /[А-Яа-я]/.test(s.dialogueLocal)), "all 3 scenes keep the Russian dialogueLocal for the author");
ok(normalized.scenes.every((s) => s.durationSec >= SCENE_MIN_SECONDS && s.durationSec <= SCENE_MAX_SECONDS), "durationSec normalized locally into 15..max (no LLM)");

// ---- 3) When some dialogue is NOT English, translation is a SINGLE BATCHED call for ALL scenes ----
const ruScenes = [1, 2, 3].map((n) => ({
  number: n,
  shotType: "medium two-shot",
  durationSec: 20,
  locationDesc: `ИНТ. Кофейня — день (сцена ${n})`,
  characters: ["Mara", "Ethan"],
  action: "Ethan enters and sets down a folder while Mara keeps working",
  dialogue: `МАРА (твёрдо): «Ты обещал, что это выдержит.»\nИТАН (тихо): «Ещё один день.»`,
  dialogueLocal: undefined,
  videoPrompt: VP(`scene ${n}`),
}));
let batchCalls = 0;
let seenNumbers: number[] = [];
const batchChat = async (_system: string, user: string) => {
  batchCalls++;
  const payload = JSON.parse(user) as { scenes: { number: number }[] };
  seenNumbers = payload.scenes.map((s) => s.number);
  return { scenes: payload.scenes.map((s) => ({ number: s.number, dialogue: `MARA (firmly): "You promised this would hold."\nETHAN (quietly): "One more day."` })) };
};
const translated = await ensureEnglishDialogue({ visualIdentity: "photoreal cinematic wide", scenes: ruScenes }, batchChat);
ok(batchCalls === 1, "non-English dialogue → EXACTLY ONE batched translation call (not one per scene)");
ok(seenNumbers.length === 3, "the single translation call carries ALL 3 scenes in one batch");
ok(translated.scenes.every((s) => isEnglishDialogue(s.dialogue)), "after batched translation every scene's dialogue is English");

console.log(`\nAll Stage 9 mini-trailer checks passed (${pass} assertions).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
