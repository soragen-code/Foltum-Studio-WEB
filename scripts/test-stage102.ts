/**
 * Stage 102 — last-frame vision description: no identity request, refusal detection with retry /
 * fallback, mandatory "CAMERA OF THIS FRAME" line used as an anti-example for frame 1, and refusal
 * hygiene in the video prompt / Scene Script.
 * Run: timeout 90 npx tsx --tsconfig tsconfig.json scripts/test-stage102.ts
 */
import assert from "node:assert";
import {
  isRefusal,
  describeLastFrame,
  buildFrameStateRequest,
  buildNeutralFrameStateRequest,
  FRAME_STATE_MODEL,
  FRAME_STATE_FALLBACK_MODEL,
  type VisionClient,
  type VisionRequest,
} from "../lib/frame-state";
import { extractPreviousCamera, stripPreviousCameraLine, applyReframeDirective, reframeDirective, openingAngleForScene } from "../lib/prompt-seam";
import { assembleSceneScript, previousEndingText } from "../lib/scene-script";

let pass = 0;
const ok = (c: unknown, m: string) => { assert(c, m); console.log("ok:", m); pass++; };
const URL = "http" + "s://media.invalid/last.jpg";

const REFUSAL_1 = "I'm sorry, I can't help with identifying or describing people in images.";
const REFUSAL_2 = "I'm sorry, I can't help with that.";
const GOOD =
  "CAMERA OF THIS FRAME: eye-level frontal medium shot from the south side.\n\n" +
  "The seated figure on the bench, frame-left, leans forward over a grey duffel bag with both hands on the zip. " +
  "The doorway in the centre background opens onto a ruined street with a burnt-out car. " +
  "Rubble and a shallow puddle cover the tiled floor in the foreground. " +
  "Cool daylight enters from the doorway and picks out the dust in the air. " +
  "It is an overcast afternoon.";
const GOOD_STATE = GOOD.split("\n\n")[1];

// ── 1. isRefusal ─────────────────────────────────────────────────────────────────────────────────────
{
  ok(isRefusal(REFUSAL_1), "1: real refusal #1 detected");
  ok(isRefusal(REFUSAL_2), "1: real refusal #2 detected");
  ok(isRefusal("Too short.") && isRefusal("") && isRefusal(null), "1: too short / empty / null count as refusal");
  ok(!isRefusal(GOOD), "1: a proper 5-sentence description is NOT a refusal");
}

// ── 2. buildFrameStateRequest: no identity request, CAMERA OF THIS FRAME required ──────────────────
{
  const req = buildFrameStateRequest(URL, { number: 2, locationDesc: "Ruined metro hall", endState: "WORLD: Mara sits on the bench frame-left with the duffel bag.\nCAMERA: wide frontal." }, [{ name: "Mara" }]);
  const all = JSON.stringify(req);
  ok(!/recognise|recognize/i.test(all), "2: request no longer asks to recognise anyone");
  ok(!/identify them|when you recognise/i.test(all), "2: no identification request");
  ok(all.includes("CAMERA OF THIS FRAME"), "2: request demands the CAMERA OF THIS FRAME first line");
  ok(/AI-generated animated/i.test(all) && /fictional characters/i.test(all), "2: frame declared as an AI-generated animated frame of fictional characters");
  ok(all.includes("Scripted end state for reference") && all.includes("purely by their described positions"), "2: scripted endState passed, names mapped by position only");
  ok(/Never describe faces, hair, skin, body build, clothing or identity/.test(req.messages[0].content as string), "2: faces / hair / clothing / identity excluded");
  ok(req.model === FRAME_STATE_MODEL, "2: normal request uses the primary vision model");
  const neutral = buildNeutralFrameStateRequest(URL, { number: 2 }, FRAME_STATE_FALLBACK_MODEL);
  const nAll = JSON.stringify(neutral);
  ok(neutral.model === FRAME_STATE_FALLBACK_MODEL && !nAll.includes("Mara") && nAll.includes("CAMERA OF THIS FRAME"), "2: neutral request — fallback model, no names, camera line required");
}

// ── 3. describeLastFrame retry strategy ─────────────────────────────────────────────────────────────
function mockClient(answers: Array<string | null>): { client: VisionClient; calls: VisionRequest[] } {
  const calls: VisionRequest[] = [];
  const client: VisionClient = { chat: { completions: { create: async (params) => {
    calls.push(params);
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    return { choices: [{ message: { content: a } }] };
  } } } };
  return { client, calls };
}

// ── 4. extractPreviousCamera / stripPreviousCameraLine ──────────────────────────────────────────────
{
  ok(extractPreviousCamera(GOOD) === "eye-level frontal medium shot from the south side.", "4: previous camera parsed from the first line");
  ok(extractPreviousCamera(GOOD_STATE) === null && extractPreviousCamera(null) === null, "4: no camera line → null");
  ok(stripPreviousCameraLine(GOOD) === GOOD_STATE, "4: camera line stripped, state text kept intact");
  ok(stripPreviousCameraLine(GOOD_STATE) === GOOD_STATE, "4: text without a camera line unchanged");
  ok(!stripPreviousCameraLine(GOOD).includes("CAMERA OF THIS FRAME"), "4: no CAMERA OF THIS FRAME left after stripping");
}

// ── 5. applyReframeDirective with previousEndState ──────────────────────────────────────────────────
{
  const refs = [{ kind: "character" }, { kind: "previous_frame" }];
  const body = "[SHOT TYPE] medium two-shot.\n\n[ACTION] Mara stands up.";
  const out = applyReframeDirective(body, refs, { hasOverride: false, sceneNumber: 2, previousEndState: GOOD });
  ok(out.indexOf("CONTINUE FROM [Image2]:") === 0, "5: directive still on top");
  ok(out.includes("The previous shot ended on: eye-level frontal medium shot from the south side.") && /FORBIDDEN for frame 1/.test(out), "5: previous camera named as FORBIDDEN anti-example");
  ok(out.includes(`open instead from ${openingAngleForScene(2)}`), "5: deterministic angle offered instead (no scripted CAMERA)");
  const scripted = applyReframeDirective(body, refs, { hasOverride: false, sceneNumber: 2, previousEndState: GOOD, startState: "WORLD: x.\nCAMERA: low wide from frame-left." });
  ok(scripted.includes("open instead from low wide from frame-left"), "5: scripted CAMERA block wins in the anti-example");
  const noPrev = reframeDirective(2, { sceneNumber: 2 });
  ok(!noPrev.includes("The previous shot ended on"), "5: no previousEndState → no anti-example sentence");
  ok(!reframeDirective(2, { sceneNumber: 2, previousEndState: GOOD_STATE }).includes("The previous shot ended on"), "5: previousEndState without camera line → no anti-example");
  ok(applyReframeDirective(out, refs, { hasOverride: false, sceneNumber: 2, previousEndState: GOOD }) === out, "5: idempotent");
}

// ── 6. Scene Script OPENING: camera line stripped, refusal falls back to endState ───────────────────
{
  const scene = { number: 2, sceneKind: "dialogue", continuesFrom: "same-location-continuation", action: "Mara stands.", startState: "WORLD: own start." };
  const script = assembleSceneScript(scene, { number: 1, endState: "Scripted: Mara sits on the bench.", endStateActual: GOOD });
  ok(script.includes("OPENING — continues from Scene 1") && script.includes("The seated figure on the bench"), "6: OPENING built from the actual description");
  ok(!script.includes("CAMERA OF THIS FRAME"), "6: OPENING does not contain the CAMERA OF THIS FRAME line");
  const refused = assembleSceneScript(scene, { number: 1, endState: "Scripted: Mara sits on the bench.", endStateActual: REFUSAL_1 });
  ok(refused.includes("Scripted: Mara sits on the bench.") && !/I'm sorry/.test(refused), "6: refusal endStateActual falls back to the scripted endState");
  ok(previousEndingText({ number: 1, endState: "S.", endStateActual: REFUSAL_2 }) === "S.", "6: previousEndingText ignores a refusal");
  const own = assembleSceneScript({ ...scene, endState: "Scripted end.", endStateActual: REFUSAL_1 }, null);
  ok(own.includes("Scripted end.") && !/I'm sorry/.test(own), "6: END STATE block ignores a refusal endStateActual");
}

(async () => {
  const a = mockClient([REFUSAL_1, GOOD]);
  const r1 = await describeLastFrame(URL, { number: 2 }, [{ name: "Mara" }], a.client);
  ok(r1 === GOOD, "3: refusal on attempt 1 → good description from attempt 2 returned");
  ok(a.calls.length === 2, "3: the client was called exactly twice");
  ok(a.calls[1].model === FRAME_STATE_MODEL && !JSON.stringify(a.calls[1]).includes("Mara"), "3: attempt 2 is the neutral request (no names) on the primary model");

  const b = mockClient([REFUSAL_1, REFUSAL_2, REFUSAL_2]);
  const r2 = await describeLastFrame(URL, { number: 2 }, [{ name: "Mara" }], b.client);
  ok(r2 === null, "3: refusing every time → null, never a refusal string");
  ok(b.calls.length === 3 && b.calls[2].model === FRAME_STATE_FALLBACK_MODEL, "3: three attempts, the third on the fallback model");

  const c = mockClient([GOOD]);
  const r3 = await describeLastFrame(URL, { number: 2 }, [], c.client);
  ok(r3 === GOOD && c.calls.length === 1, "3: good answer first time → single call");

  console.log(`\nStage 102: PASS — ${pass} assertions`);
})().catch((err) => { console.error("FAIL:", err instanceof Error ? err.message : err); process.exit(1); });
