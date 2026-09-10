import assert from "node:assert/strict";
import { test } from "node:test";
import { VISUAL_STYLE_ID } from "../lib/visual-style";
const Module = require("node:module");
const originalLoad = Module._load;
let row: any, provider: any, refunds: number, publications: number, reads: number, cancels: number;
let pending: Promise<void>[], uploadFailure = false, lookupFailure = false;
let submissions = 0, lastVideoInput: any = null;
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
  episode: { findUnique: async () => ({ location: null }) },
  user: { update: async () => { refunds++; } }, creditTransaction: { create: async () => ({}) },
  $transaction: async (fn: any) => fn(db),
};
const mocks: any = {
  "@/lib/db": { prisma: db },
  "@/lib/replicate": {
    getPredictionState: async () => { reads++; if (lookupFailure) throw Error("status GET unavailable"); return provider; },
    cancelVideoPrediction: async () => { cancels++; provider = { status: "canceled" }; },
    startVideoPrediction: async (input: any) => { submissions++; lastVideoInput = input; assert.equal(input.generate_audio, true); return "existing"; },
    SEEDANCE_MODEL: "bytedance/seedance-2.5",
  },
  "@/lib/jobs": { runInBackground: (fn: any) => pending.push(fn()), updateJob: async () => {}, heartbeatJob: async () => {}, isCancelRequested: async () => false, markCanceled: async () => {} },
  "@/lib/s3-upload": {
    uploadRemoteToS3: async () => { if (uploadFailure) throw Error("temporary storage failure"); return "https:" + "//storage.invalid/video.mp4"; },
    uploadBufferToS3: async () => "https:" + "//storage.invalid/frame.jpg",
  },
  "@/lib/ffmpeg": { extractLastFrameBuffer: async () => Buffer.from("frame") },
  "@/lib/aws-config": { getBucketConfig: () => ({ folderPrefix: "media/" }) },
};
Module._load = function(id: string, ...args: any[]) { return mocks[id] ?? originalLoad.call(this, id, ...args); };
const { runVideoJob, resumeVideoJob, VIDEO_DEADLINE_MS } = require("../lib/workers/video-job");
Module._load = originalLoad;
const reset = () => {
  clock = 1_000_000; row = { id: "job", type: "video", status: "processing", resultData: JSON.stringify(base()), updatedAt: new Date(0) };
  refunds = publications = reads = cancels = submissions = 0;
  lastVideoInput = null; sceneDialogue = 'Theo: "We have met."'; pending = []; uploadFailure = lookupFailure = false;
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

test("submission (default): без provider используется Seedance 2.5 с аудио", async () => {
  reset();
  await runVideoJob({ jobId: "job", sceneId: "scene", projectId: "project", userId: "test", cost: 3, duration: 15 });
  assert.equal(submissions, 1);
  assert.equal(lastVideoInput.model, "bytedance/seedance-2.5");
  assert.equal(lastVideoInput.generate_audio, true);
});

test("submission (legacy provider seedance-2.0): игнорируется — Seedance 2.5, без ограничения 15 с", async () => {
  reset();
  await runVideoJob({ jobId: "job", sceneId: "scene", projectId: "project", userId: "test", cost: 8, duration: 20, provider: "seedance-2.0" });
  assert.equal(submissions, 1);
  assert.equal(lastVideoInput.model, "bytedance/seedance-2.5"); // Stage 33: single model
  assert.equal(lastVideoInput.duration, 20); // no per-model cap anymore
  assert.equal(lastVideoInput.generate_audio, true);
  const st = JSON.parse(row.resultData);
  assert.equal(st.submittedPrompt, lastVideoInput.prompt); // exact submitted text persisted for diagnostics
  assert.equal(st.referenceWidth, 768);
  // Stage 36: reference mode only — never a first-frame `image`, always the explicit 9:16 ratio.
  assert.equal(lastVideoInput.image, undefined);
  assert.ok(Array.isArray(lastVideoInput.reference_images) && lastVideoInput.reference_images.length === 1);
  assert.equal(lastVideoInput.aspect_ratio, "9:16");
  assert.deepEqual(st.submittedReferences.map((r: any) => r.kind), ["character"]);
  assert.equal(st.refCounts.chained, false);
  assert.equal(row.status, "processing");
  assert.equal(JSON.parse(row.resultData).predictionId, "existing");
});

// Stage 30 — moderation is now FAIL-FAST: no automatic rewrite/resubmit. A Seedance moderation refusal
// goes straight to handleFailure (like any other provider error) even when a retry plan is present.
const chainFrame = "https:" + `//storage.invalid/${VISUAL_STYLE_ID}/prev-lastframe.jpg`;
const moderationState = (retry: any) => JSON.stringify({
  ...base(),
  retry: { basePrompt: "[ACTION]: neutral.", model: "bytedance/seedance-2.5", duration: 5, resolution: "480p", ...retry },
});

test("moderation (fail-fast): a refusal fails the job immediately — no resubmission, refund once", async () => {
  Date.now = () => clock;
  try {
    reset();
    // A retry plan IS present (chained scene) — before Stage 30 this would have triggered a rewrite/resubmit.
    row.resultData = moderationState({ refs: [{ url: chainFrame, kind: "previous_frame", note: "previous frame" }], fallbackRefs: [{ url: "https:" + "//x/portrait.jpg", kind: "character", note: "face" }] });
    provider = { status: "failed", error: "flagged as sensitive E005" };
    await check();
    assert.equal(submissions, 0);                 // NO new prediction was submitted
    assert.equal(row.status, "failed");           // the job fails right away
    assert.equal(refunds, 1);                      // credit refunded exactly once
    assert.match(row.error, /\[moderation\]/);    // moderation-specific message prefix
    assert.match(row.error, /Смотреть промпт/);   // tells the user to open & edit the prompt manually
  } finally { Date.now = originalNow; }
});

test("moderation (Stage 33): override without textual triggers → blames the reference images, exact counts, text-only hint", async () => {
  Date.now = () => clock;
  try {
    reset();
    row.resultData = JSON.stringify({
      ...base(), submittedPrompt: "[ACTION]: Theo looks out of the window.", hasOverride: true,
      referenceKind: "character_references", refCounts: { characters: 2, location: 1, crowd: 0, scene: 0, chained: false }, referenceWidth: 768,
    });
    provider = { status: "failed", error: "flagged as sensitive E005" };
    await check();
    assert.equal(submissions, 0);
    assert.equal(row.status, "failed");
    assert.equal(refunds, 1);
    assert.match(row.error, /^\[moderation\]/);
    assert.match(row.error, /ручной \(override\)/);
    assert.match(row.error, /Отправлено изображений: 3 — портретов: 2, ракурсов локации: 1, массовки: 0, кадр предыдущей сцены: нет/);
    assert.match(row.error, /Отправить без референс‑изображений/);
    assert.match(row.error, /Код провайдера: /);
    assert.doesNotMatch(row.error, /Если блокируется кадр предыдущей сцены/);
  } finally { Date.now = originalNow; }
});

test("moderation (Stage 36): previous frame among the references → explicit hint, counts list it as «да»", async () => {
  Date.now = () => clock;
  try {
    reset();
    row.resultData = JSON.stringify({
      ...base(), submittedPrompt: "[ACTION]: Theo stands.", hasOverride: false,
      referenceKind: "character_references", refCounts: { characters: 1, location: 2, crowd: 0, scene: 0, chained: true }, referenceWidth: 768,
      submittedReferences: [{ url: "https:" + "//x/theo.jpg", kind: "character" }, { url: chainFrame, kind: "previous_frame" }],
    });
    provider = { status: "failed", error: "flagged as sensitive E005" };
    await check();
    assert.equal(row.status, "failed");
    assert.match(row.error, /Отправлено изображений: 4 — портретов: 1, ракурсов локации: 2, массовки: 0, кадр предыдущей сцены: да/);
    assert.match(row.error, /Если блокируется кадр предыдущей сцены — включите «Не использовать кадр предыдущей сцены» в окне «Смотреть промпт» \(портреты и локация останутся\) или перегенерируйте предыдущую сцену/);
    assert.doesNotMatch(row.error, /Первый кадр берётся/);
    assert.match(row.error, /Код провайдера: /);
    // The exact submitted list survives in the persisted state for the UI previews.
    assert.equal(JSON.parse(row.resultData).submittedReferences.length, 2);
  } finally { Date.now = originalNow; }
});

test("moderation (fail-fast): repeated poll of the same refusal refunds only once, still no resubmit", async () => {
  Date.now = () => clock;
  try {
    reset();
    row.resultData = moderationState({ refs: [{ url: "https:" + "//x/full.jpg", kind: "character", note: "full" }], fallbackRefs: [] });
    provider = { status: "failed", error: "flagged as sensitive E005" };
    const old = { ...row };
    await Promise.all([resumeVideoJob(old), resumeVideoJob(old)]); await resumeVideoJob(old);
    assert.equal(submissions, 0);
    assert.equal(row.status, "failed");
    assert.equal(refunds, 1);
  } finally { Date.now = originalNow; }
});
