import assert from "node:assert/strict";
import { test } from "node:test";
import { canChainFrame, characterImagePrompt, isStyledAsset, styledVisualPrompt, VISUAL_STYLE_ID } from "../lib/visual-style";
import { sanitizeVideoPrompt } from "../lib/sanitize-prompt";
import { buildNativeAudioPrompt, parseDialogue, languageName } from "../lib/voiceover";
import { classifyProviderError, safeDiagnosticInput } from "../lib/generation-diagnostics";

const frame = "https:" + `//test.invalid/videos/${VISUAL_STYLE_ID}/frame.jpg`;
test("стилизация сохраняет действие и художественные термины", () => {
  const action = "[ACTION]: Theo opens the door.\n[TRANSITION]: Camera turns to Mara.";
  const result = styledVisualPrompt(`[VISUAL STYLE]: Photorealistic 35mm film\n${action}`);
  assert.ok(result.includes(action)); assert.ok(!result.includes("Photorealistic 35mm"));
  assert.match(characterImagePrompt("Theo, navy blazer", "front", "Theo"), /softly rounded forms/);
  assert.match(sanitizeVideoPrompt("cinematic noir chiaroscuro, next shot").prompt, /cinematic noir chiaroscuro, next shot/);
  assert.equal(sanitizeVideoPrompt("Mara waits", { keep: ["Mara"] }).prompt, "Mara waits");
  assert.ok(styledVisualPrompt("").includes("softly rounded"));
});
test("continuity: только соседний совместимый кадр в том же месте", () => {
  const scene = { number: 7, locationDesc: "INT Living room" };
  const prev = { number: 6, locationDesc: " INT Living room ", lastFrameUrl: frame };
  assert.ok(canChainFrame(scene, prev));
  assert.ok(!canChainFrame(scene, { ...prev, number: 5 }));
  assert.ok(!canChainFrame(scene, { ...prev, lastFrameUrl: "https:" + "//test.invalid/legacy-frame" }));
  assert.ok(!canChainFrame(scene, { ...prev, locationDesc: "EXT Garden" }));
  assert.ok(!canChainFrame(scene, null)); assert.ok(!isStyledAsset(null));
  assert.ok(!isStyledAsset("https:" + `//test.invalid/old?style=/${VISUAL_STYLE_ID}/`));
});
test("EN/RU, обычные кавычки, неизменные реплики и отсутствие музыки", () => {
  for (const [dialogue, lang, expected] of [["Theo: \"We've met before.\"", "en", "We've met before."], ['Мара: "Мы уже встречались."', "ru", "Мы уже встречались."]]) {
    const p = buildNativeAudioPrompt("soft illustration", dialogue, [], languageName(lang));
    assert.ok(p.includes(`"${expected}"`)); assert.ok(!p.includes(`{${expected}}`));
    assert.match(p, /NO background music/); assert.ok(p.includes(languageName(lang)));
    assert.equal(parseDialogue(dialogue)[0].text, expected);
  }
  assert.deepEqual(parseDialogue(null), []);
  assert.deepEqual(parseDialogue("[NO DIALOGUE]"), []);
  assert.match(buildNativeAudioPrompt("", "[NO DIALOGUE]", []), /ambient sound/);
});
test("ошибки поставщика классифицируются без потери причины и утечек", () => {
  for (const [message, kind] of [
    ["output audio may be related to copyright restrictions", "copyright_audio"],
    ["output video may be related to copyright restrictions", "copyright_video"],
    ["copyright restrictions", "copyright"],
    ["flagged as sensitive (E005)", "moderation"],
    ["high demand (E003)", "overload"], ["Video model timed out", "timeout"],
  ]) assert.equal(classifyProviderError(new Error(message)), kind);
  const safe = JSON.stringify(safeDiagnosticInput({ prompt: "https://x.test/a?X-Amz-Signature=PRIVATE", error: "Bearer PRIVATE token=PRIVATE request cgt-123" }));
  assert.ok(!safe.includes("PRIVATE")); assert.ok(safe.includes("cgt-123"));
});

// Targeted worker integration with mocked paid services. No real generation during tests.
const Module = require("node:module");
const originalLoad = Module._load;
let fixture: any;
const scene = { id: "scene", episodeId: "episode", number: 7, locationDesc: "living room", language: "en", videoPrompt: "[VISUAL STYLE]: Photorealism\n[ACTION]: Theo waits.\n[CHARACTER]: Theo in a navy blazer.", dialogue: 'Theo: "We have met."' };
const mocks: Record<string, any> = {
  "@/lib/db": { prisma: {
    scene: { findUnique: async () => scene, findFirst: async () => fixture.previous, update: async ({ data }: any) => { fixture.saved.push(data); return { ...scene, ...data }; } },
    sceneCharacter: { findMany: async () => [] },
    user: { update: async () => { fixture.refunds++; } }, creditTransaction: { create: async () => ({}) },
  } },
  "@/lib/replicate": {
    startImagePrediction: async (input: any) => { fixture.images.push(input); return "ref-1"; },
    startVideoPrediction: async (input: any) => { fixture.videos.push(input); return "video-1"; },
    getPredictionState: async (id: string) => {
      if (id === "ref-1" && fixture.referenceError) return { status: "failed", error: fixture.referenceError };
      if (id === "video-1" && fixture.timeout) { fixture.clock += 600_000; return { status: "processing" }; }
      return id === "video-1" && fixture.error ? { status: "failed", error: fixture.error } : { status: "succeeded", url: "https:" + "//provider.invalid/media" };
    },
  },
  "@/lib/jobs": {
    updateJob: async (_id: string, data: any) => { if (data.resultData) fixture.state = JSON.parse(data.resultData); },
    completeJob: async (_id: string, data: any) => { fixture.completed = data; },
    failJob: async (_id: string, error: string) => { fixture.failure = error; },
    heartbeatJob: async () => {}, runInBackground: () => {},
  },
  "@/lib/s3-upload": { uploadRemoteToS3: async (_url: string, key: string) => `https://storage.example/${key}`, uploadBufferToS3: async (_b: any, key: string) => `https://storage.example/${key}` },
  "@/lib/ffmpeg": { extractLastFrameBuffer: async () => Buffer.from("frame") },
  "@/lib/aws-config": { getBucketConfig: () => ({ folderPrefix: "media/" }) },
};
Module._load = function (id: string, ...args: any[]) { return mocks[id] ?? originalLoad.call(this, id, ...args); };
const { runVideoJob } = require("../lib/workers/video-job");
Module._load = originalLoad;
const reset = (error?: string, previous?: any) => fixture = { error, previous, images: [], videos: [], saved: [], refunds: 0 };
const run = () => runVideoJob({ jobId: "job", sceneId: "scene", projectId: "project", userId: "test", cost: 1 });
test("worker: новая ссылка вместо старого кадра, звук включён, диагностика сохранена", async () => {
  reset(undefined, { number: 6, locationDesc: "living room", lastFrameUrl: "https:" + "//test.invalid/legacy-frame" });
  await run();
  assert.equal(fixture.images.length, 1); assert.equal(fixture.videos.length, 1);
  assert.equal(fixture.videos[0].generate_audio, true); assert.ok(!fixture.videos[0].image);
  assert.equal(fixture.videos[0].reference_images.length, 1);
  assert.match(fixture.videos[0].prompt, /"We have met\."/);
  assert.equal(fixture.completed.predictionId, "video-1");
  assert.equal(fixture.completed.diagnostics[1].status, "succeeded");
  assert.equal(fixture.refunds, 0);
});
test("worker: совместимый соседний кадр сохраняет continuity без лишнего изображения", async () => {
  reset(undefined, { id: "prev", number: 6, locationDesc: "living room", lastFrameUrl: frame }); await run();
  assert.equal(fixture.images.length, 0); assert.equal(fixture.videos[0].image, frame);
  assert.equal(fixture.videos[0].aspect_ratio, "adaptive");
});
test("worker: отказ не вызывает платные повторы, оригинальная ошибка остаётся", async () => {
  for (const error of ["output video copyright restriction request cgt-1", "output audio copyright restriction", "flagged as sensitive E005", "high demand E003"]) {
    reset(error); await run();
    assert.equal(fixture.videos.length, 1); assert.equal(fixture.videos[0].generate_audio, true);
    assert.ok(fixture.failure.includes(error)); assert.equal(fixture.refunds, 1);
    assert.equal(fixture.state.diagnostics[1].error, error);
    assert.equal(fixture.state.diagnostics[1].predictionId, "video-1");
    assert.ok(!fixture.completed);
  }
});

test("worker: timeout не маскируется как copyright и не перезапускает prediction", async () => {
  reset(); fixture.timeout = true; fixture.clock = 1000;
  const now = Date.now; Date.now = () => fixture.clock;
  try { await run(); } finally { Date.now = now; }
  assert.equal(fixture.videos.length, 1); assert.match(fixture.failure, /timeout/);
  assert.equal(fixture.state.diagnostics[1].status, "timeout");
});
test("worker: отказ референса останавливает видео до списания у видеопоставщика", async () => {
  reset(); fixture.referenceError = "flagged as sensitive E005"; await run();
  assert.equal(fixture.videos.length, 0); assert.equal(fixture.images.length, 1);
  assert.equal(fixture.state.diagnostics[0].errorKind, "moderation");
});
