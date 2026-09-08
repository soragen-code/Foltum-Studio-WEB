import assert from "node:assert/strict";
import { test } from "node:test";
import { VISUAL_STYLE_ID } from "../lib/visual-style";
const Module = require("node:module");
const originalLoad = Module._load;
let row: any, provider: any, refunds: number, publications: number, reads: number, cancels: number;
let pending: Promise<void>[], uploadFailure = false, lookupFailure = false;
let submissions = 0, lastVideoInput: any = null;
let klingSubmissions = 0, lastKlingInput: any = null;
let lipsyncSubmissions = 0, lastLipsyncInput: any = null, audioExtractions = 0;
let sceneDialogue = 'Theo: "We have met."';
let clock = 1_000_000;
const base = () => ({ predictionId: "existing", sceneId: "scene", projectId: "project", userId: "test", cost: 1, startedAt: clock - 600_000, diagnostics: [{ phase: "video", predictionId: "existing", status: "processing", input: { generate_audio: true } }] });
const matches = (where: any) => {
  if (where.id !== row.id) return false;
  if (typeof where.status === "string" && where.status !== row.status) return false;
  if (where.status?.in && !where.status.in.includes(row.status)) return false;
  if (typeof where.resultData === "string" && where.resultData !== row.resultData) return false;
  if (where.resultData?.contains && !row.resultData.includes(where.resultData.contains)) return false;
  return true;
};
const db: any = {
  generationJob: {
    findUnique: async () => ({ ...row }),
    update: async ({ data }: any) => { row = { ...row, ...data }; return row; },
    updateMany: async ({ where, data }: any) => {
      if (!matches(where)) return { count: 0 };
      row = { ...row, ...data, updatedAt: new Date(clock) }; return { count: 1 };
    },
  },
  sceneCharacter: { findMany: async () => [{ characterId: "theo", character: { name: "Theo", imageFront: "https:" + `//media.invalid/${VISUAL_STYLE_ID}/theo.webp` } }] },
  scene: { findFirst: async () => null, findUnique: async () => ({ id: "scene", episodeId: "episode", number: 7, language: "en", videoPrompt: "[ACTION]: Theo stands.", dialogue: sceneDialogue }), update: async () => { publications++; return {}; } },
  user: { update: async () => { refunds++; } }, creditTransaction: { create: async () => ({}) },
  $transaction: async (fn: any) => fn(db),
};
const mocks: any = {
  "@/lib/db": { prisma: db },
  "@/lib/replicate": {
    getPredictionState: async () => { reads++; if (lookupFailure) throw Error("status GET unavailable"); return provider; },
    cancelVideoPrediction: async () => { cancels++; provider = { status: "canceled" }; },
    startVideoPrediction: async (input: any) => { submissions++; lastVideoInput = input; assert.equal(input.generate_audio, true); return "existing"; },
    startKlingPrediction: async (input: any) => { klingSubmissions++; lastKlingInput = input; assert.ok(input.start_image, "Kling needs a start_image"); assert.equal(input.generate_audio, undefined); return "existing"; },
    startLipsyncPrediction: async (input: any) => { lipsyncSubmissions++; lastLipsyncInput = input; assert.ok(input.video && input.audio, "lipsync needs both video and audio"); return "lipsync-pred"; },
    KLING_MODEL: "kwaivgi/kling-v2.1",
    LIPSYNC_MODEL: "sync/lipsync-2",
  },
  "@/lib/jobs": { runInBackground: (fn: any) => pending.push(fn()), updateJob: async () => {}, heartbeatJob: async () => {} },
  "@/lib/s3-upload": {
    uploadRemoteToS3: async () => { if (uploadFailure) throw Error("temporary storage failure"); return "https:" + "//storage.invalid/video.mp4"; },
    uploadBufferToS3: async () => "https:" + "//storage.invalid/frame.jpg",
  },
  "@/lib/ffmpeg": { extractLastFrameBuffer: async () => Buffer.from("frame"), extractAudioBuffer: async () => { audioExtractions++; return Buffer.from("speech"); } },
  "@/lib/aws-config": { getBucketConfig: () => ({ folderPrefix: "media/" }) },
};
Module._load = function(id: string, ...args: any[]) { return mocks[id] ?? originalLoad.call(this, id, ...args); };
const { runVideoJob, resumeVideoJob, VIDEO_DEADLINE_MS } = require("../lib/workers/video-job");
Module._load = originalLoad;
const reset = () => {
  clock = 1_000_000; row = { id: "job", type: "video", status: "processing", resultData: JSON.stringify(base()), updatedAt: new Date(0) };
  refunds = publications = reads = cancels = submissions = klingSubmissions = lipsyncSubmissions = audioExtractions = 0;
  lastKlingInput = lastVideoInput = lastLipsyncInput = null; sceneDialogue = 'Theo: "We have met."'; pending = []; uploadFailure = lookupFailure = false;
};
const check = async () => { clock += 10_000; await resumeVideoJob({ ...row }); await Promise.all(pending.splice(0)); };
const originalNow = Date.now;
test("recovery: очередь -> processing дольше прежнего лимита -> succeeded; одна публикация", async () => {
  Date.now = () => clock;
  try {
    reset(); provider = { status: "starting" }; await check(); assert.equal(row.status, "processing");
    provider = { status: "processing" }; await check(); assert.equal(cancels, 0); assert.equal(refunds, 0);
    provider = { status: "succeeded", url: "https:" + "//provider.invalid/video" }; await check();
    assert.equal(row.status, "completed"); assert.equal(publications, 1);
    await check(); assert.equal(publications, 1); assert.equal(refunds, 0);
    assert.equal(JSON.parse(row.resultData).predictionId, "existing"); assert.equal(submissions, 0);
  } finally { Date.now = originalNow; }
});
test("recovery: параллельные poll/worker не финализируют дважды", async () => {
  Date.now = () => clock;
  try {
    reset(); provider = { status: "succeeded", url: "https:" + "//provider.invalid/video" };
    const stale = { ...row };
    await Promise.all([resumeVideoJob(stale), resumeVideoJob(stale)]); await Promise.all(pending);
    assert.equal(reads, 1); assert.equal(publications, 1);
    await resumeVideoJob(stale); assert.equal(publications, 1);
  } finally { Date.now = originalNow; }
});
test("recovery: failed/canceled и повторный poll возвращают кредит только один раз", async () => {
  Date.now = () => clock;
  try {
    for (const error of ["output video copyright restriction", "output audio copyright restriction", "flagged as sensitive E005", "high demand E003"]) {
      reset(); provider = { status: "failed", error }; const old = { ...row };
      await Promise.all([resumeVideoJob(old), resumeVideoJob(old)]); await resumeVideoJob(old);
      assert.equal(row.status, "failed"); assert.equal(refunds, 1); assert.ok(row.error.includes(error));
    }
  } finally { Date.now = originalNow; }
});
test("recovery: временный GET сбой не завершает задачу; просроченный lease восстанавливается", async () => {
  Date.now = () => clock;
  try {
    reset(); lookupFailure = true; await check(); assert.equal(row.status, "processing"); assert.equal(refunds, 0);
    lookupFailure = false; row.resultData = JSON.stringify({ ...base(), leaseToken: "dead", leaseUntil: clock - 1, finalizing: true });
    provider = { status: "succeeded", url: "https:" + "//provider.invalid/video" }; await check(); assert.equal(row.status, "completed");
  } finally { Date.now = originalNow; }
});
test("recovery: прерванная загрузка повторяет только сохранение, не генерацию", async () => {
  Date.now = () => clock;
  try {
    reset(); uploadFailure = true; provider = { status: "succeeded", url: "https:" + "//provider.invalid/video" };
    await check(); assert.equal(row.status, "processing"); assert.equal(publications, 0); assert.equal(refunds, 0);
    uploadFailure = false; await check(); assert.equal(row.status, "completed"); assert.equal(publications, 1);
  } finally { Date.now = originalNow; }
});
test("recovery: конечный лимит требует подтверждённой отмены, поздний succeeded сохраняется", async () => {
  Date.now = () => clock;
  try {
    reset(); const state = base(); state.startedAt = clock - VIDEO_DEADLINE_MS; row.resultData = JSON.stringify(state);
    provider = { status: "processing" }; await check(); assert.equal(cancels, 1); assert.equal(row.status, "failed"); assert.match(row.error, /timeout/);
    reset(); row.resultData = JSON.stringify({ ...base(), startedAt: clock - VIDEO_DEADLINE_MS });
    provider = { status: "succeeded", url: "https:" + "//provider.invalid/video" }; await check(); assert.equal(row.status, "completed"); assert.equal(cancels, 0);
  } finally { Date.now = originalNow; }
});

test("submission: prediction сохраняется и функция возвращается без ожидания", async () => {
  reset();
  await runVideoJob({ jobId: "job", sceneId: "scene", projectId: "project", userId: "test", cost: 1 });
  assert.equal(submissions, 1); assert.equal(reads, 0); assert.equal(refunds, 0);
  assert.equal(row.status, "processing"); assert.equal(JSON.parse(row.resultData).predictionId, "existing");
});

test("submission: заданная длительность (15 с) передаётся в Seedance без изменений", async () => {
  reset();
  await runVideoJob({ jobId: "job", sceneId: "scene", projectId: "project", userId: "test", cost: 3, duration: 15 });
  assert.equal(submissions, 1);
  assert.equal(lastVideoInput.duration, 15);
  assert.equal(lastVideoInput.generate_audio, true);
});

test("submission (kling): маршрутизируется в Kling со start_image, без generate_audio, длительность ≤ 10", async () => {
  reset();
  await runVideoJob({ jobId: "job", sceneId: "scene", projectId: "project", userId: "test", cost: 8, duration: 15, provider: "kling" });
  // Kling path used, Seedance NOT used
  assert.equal(klingSubmissions, 1);
  assert.equal(submissions, 0);
  assert.ok(lastKlingInput.start_image, "start_image must be supplied to Kling");
  assert.equal(lastKlingInput.duration, 10); // capped from 15 to Kling's max
  assert.equal(lastKlingInput.generate_audio, undefined); // Kling has no native audio
  assert.equal(row.status, "processing");
  assert.equal(JSON.parse(row.resultData).predictionId, "existing");
});

test("submission (kling): 5 с сохраняется как есть (в пределах enum)", async () => {
  reset();
  await runVideoJob({ jobId: "job", sceneId: "scene", projectId: "project", userId: "test", cost: 1, duration: 5, provider: "kling" });
  assert.equal(klingSubmissions, 1);
  assert.equal(lastKlingInput.duration, 5);
});

test("submission (default): без provider используется Seedance с аудио", async () => {
  reset();
  await runVideoJob({ jobId: "job", sceneId: "scene", projectId: "project", userId: "test", cost: 3, duration: 15 });
  assert.equal(klingSubmissions, 0);
  assert.equal(submissions, 1);
  assert.equal(lastVideoInput.generate_audio, true);
});

test("pipeline (kling+диалог): video -> native speech -> lipsync -> completed; одна публикация", async () => {
  Date.now = () => clock;
  try {
    reset();
    await runVideoJob({ jobId: "job", sceneId: "scene", projectId: "project", userId: "test", cost: 8, duration: 10, provider: "kling" });
    // Stage 1: only the silent Kling video was submitted; pipeline armed.
    assert.equal(klingSubmissions, 1); assert.equal(submissions, 0); assert.equal(lipsyncSubmissions, 0);
    let s = JSON.parse(row.resultData);
    assert.equal(s.lipsync, true); assert.equal(s.stage, "video");

    // Kling video succeeds -> Seedance native-speech run is submitted (generate_audio on).
    provider = { status: "succeeded", url: "https:" + "//provider.invalid/kling-video" }; await check();
    assert.equal(submissions, 1); assert.equal(lastVideoInput.generate_audio, true);
    assert.equal(klingSubmissions, 1); assert.equal(lipsyncSubmissions, 0);
    s = JSON.parse(row.resultData);
    assert.equal(s.stage, "audio"); assert.equal(s.klingVideoUrl, "https:" + "//provider.invalid/kling-video");
    assert.equal(row.status, "processing"); assert.equal(publications, 0);

    // Speech clip succeeds -> its audio is extracted and lipsync is submitted (video + audio).
    provider = { status: "succeeded", url: "https:" + "//provider.invalid/speech-video" }; await check();
    assert.equal(audioExtractions, 1); assert.equal(lipsyncSubmissions, 1);
    assert.ok(lastLipsyncInput.video && lastLipsyncInput.audio, "lipsync gets both video and audio URLs");
    s = JSON.parse(row.resultData);
    assert.equal(s.stage, "lipsync"); assert.ok(s.speechAudioUrl);
    assert.equal(row.status, "processing"); assert.equal(publications, 0);

    // Lipsync succeeds -> final synced clip is published exactly once.
    provider = { status: "succeeded", url: "https:" + "//provider.invalid/synced" }; await check();
    assert.equal(row.status, "completed"); assert.equal(publications, 1);
    await check(); assert.equal(publications, 1); // idempotent; no extra work
    assert.equal(klingSubmissions, 1); assert.equal(submissions, 1); assert.equal(lipsyncSubmissions, 1);
  } finally { Date.now = originalNow; }
});

test("pipeline (kling без диалога): один этап, прямая финализация без speech/lipsync", async () => {
  Date.now = () => clock;
  try {
    reset(); sceneDialogue = ""; // silent scene: no lipsync pipeline
    await runVideoJob({ jobId: "job", sceneId: "scene", projectId: "project", userId: "test", cost: 8, duration: 10, provider: "kling" });
    assert.equal(klingSubmissions, 1);
    const s = JSON.parse(row.resultData);
    assert.ok(!s.lipsync); assert.ok(!s.stage);
    provider = { status: "succeeded", url: "https:" + "//provider.invalid/silent-kling" }; await check();
    assert.equal(row.status, "completed"); assert.equal(publications, 1);
    assert.equal(submissions, 0); assert.equal(lipsyncSubmissions, 0); assert.equal(audioExtractions, 0);
  } finally { Date.now = originalNow; }
});

test("pipeline (kling+диалог): сбой этапа speech не переплачивает Kling и восстанавливается", async () => {
  Date.now = () => clock;
  try {
    reset();
    await runVideoJob({ jobId: "job", sceneId: "scene", projectId: "project", userId: "test", cost: 8, duration: 10, provider: "kling" });
    provider = { status: "succeeded", url: "https:" + "//provider.invalid/kling-video" }; await check();
    // Now on the audio stage. If the speech run FAILS, the job fails once with a refund —
    // and Kling was submitted only once (no re-pay of the successful video stage).
    provider = { status: "failed", error: "speech run failed" }; await check();
    assert.equal(row.status, "failed"); assert.equal(refunds, 1);
    assert.equal(klingSubmissions, 1); assert.equal(lipsyncSubmissions, 0);
  } finally { Date.now = originalNow; }
});
