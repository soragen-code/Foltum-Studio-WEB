/**
 * Stage 47 — Kling 3.0 video provider (pure unit tests, no network).
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage47.ts
 */
import assert from "node:assert";
import {
  buildKlingPayload, clampKlingDuration, klingDurationNote, capKlingReferences, mapKlingStatus, mapKlingFailure,
  klingTaskToPredictionState, startKlingVideo, KLING_CREATE_PATH, KLING_MODEL_NAME, KLING_MAX_REFERENCE_IMAGES,
  KLING_MIN_DURATION, KLING_MAX_DURATION, KLING_MISSING_KEY_MESSAGE, KLING_API_BASE_DEFAULT,
} from "../lib/kling";
import {
  VIDEO_PROVIDERS, DEFAULT_VIDEO_PROVIDER, KLING_VIDEO_MODEL, VIDEO_PROVIDER_LABEL,
  isVideoProvider, normalizeVideoProvider, videoModelBadge,
} from "../lib/video-provider";
import { videoProviderSchema } from "../lib/validations";
import { classifyProviderError } from "../lib/generation-diagnostics";

let n = 0;
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); n++; };

async function main() {
  /* --- provider ids --- */
  ok("providers list", VIDEO_PROVIDERS.length === 2 && VIDEO_PROVIDERS[0] === "seedance" && VIDEO_PROVIDERS[1] === "kling");
  ok("default is seedance", DEFAULT_VIDEO_PROVIDER === "seedance");
  ok("kling model id shared", KLING_VIDEO_MODEL === KLING_MODEL_NAME && KLING_MODEL_NAME === "kling-v3");
  ok("isVideoProvider seedance", isVideoProvider("seedance"));
  ok("isVideoProvider kling", isVideoProvider("kling"));
  ok("isVideoProvider rejects", !isVideoProvider("sora") && !isVideoProvider(null) && !isVideoProvider(1));
  ok("normalize null → seedance", normalizeVideoProvider(null) === "seedance");
  ok("normalize garbage → seedance", normalizeVideoProvider("runway") === "seedance");
  ok("normalize kling", normalizeVideoProvider("kling") === "kling");
  ok("badge kling", videoModelBadge("kling-v3") === "Kling 3.0" && VIDEO_PROVIDER_LABEL.kling === "Kling 3.0");
  ok("badge seedance (slug)", videoModelBadge("seedance") === "Seedance 2.5");
  ok("badge seedance (null)", videoModelBadge(null) === "Seedance 2.5");

  /* --- zod --- */
  ok("schema accepts kling", videoProviderSchema.safeParse({ videoProvider: "kling" }).success);
  ok("schema accepts seedance", videoProviderSchema.safeParse({ videoProvider: "seedance" }).success);
  ok("schema rejects unknown", !videoProviderSchema.safeParse({ videoProvider: "pika" }).success);
  ok("schema rejects missing", !videoProviderSchema.safeParse({}).success);
  ok("schema rejects null body", !videoProviderSchema.safeParse(null).success);

  /* --- duration clamp --- */
  ok("clamp range", KLING_MIN_DURATION === 3 && KLING_MAX_DURATION === 15);
  ok("clamp 30 → 15", clampKlingDuration(30) === 15);
  ok("clamp 1 → 3", clampKlingDuration(1) === 3);
  ok("clamp 8 → 8", clampKlingDuration(8) === 8);
  ok("clamp rounds", clampKlingDuration(7.6) === 8);
  ok("clamp NaN → min", clampKlingDuration(NaN) === 3);
  ok("note for 30", klingDurationNote(30) === "Kling: длительность ограничена 15 с");
  ok("no note for 10", klingDurationNote(10) === null);
  ok("no note for 15", klingDurationNote(15) === null);

  /* --- references cap + order --- */
  const urls = Array.from({ length: 10 }, (_, i) => `https://cdn/x${i + 1}.jpg`);
  const capped = capKlingReferences(urls);
  ok("refs cap = 7", KLING_MAX_REFERENCE_IMAGES === 7 && capped.length === 7);
  ok("refs keep order/head", capped[0] === urls[0] && capped[6] === urls[6]);
  ok("refs empty ok", capKlingReferences([]).length === 0);
  ok("refs drop blanks", capKlingReferences(["", "https://cdn/a.jpg"]).length === 1);

  /* --- payload --- */
  const payload = buildKlingPayload({ prompt: "A girl walks [Image1]", referenceImages: urls, durationSeconds: 30 });
  ok("payload endpoint", KLING_CREATE_PATH === "/omni-video/kling-3.0-omni" && KLING_API_BASE_DEFAULT === "https://api-singapore.klingai.com");
  ok("payload prompt first", payload.contents[0].type === "prompt" && (payload.contents[0] as any).text === "A girl walks [Image1]");
  ok("payload refer_image count", payload.contents.filter((c) => c.type === "refer_image").length === 7);
  ok("payload refer_image ids", (payload.contents[1] as any).id === "Image1" && (payload.contents[7] as any).id === "Image7" && (payload.contents[1] as any).url === urls[0]);
  ok("payload aspect 9:16", payload.settings.aspect_ratio === "9:16");
  ok("payload duration clamped int", payload.settings.duration === 15 && Number.isInteger(payload.settings.duration));
  ok("payload audio native", payload.settings.audio === "native");
  ok("payload 720p", payload.settings.resolution === "720p");
  ok("payload single shot", payload.settings.multi_shot === false);
  ok("payload no watermark", payload.options?.watermark_info?.enabled === false);
  ok("payload has no legacy fields", !("image_list" in payload) && !("model_name" in payload) && !("prompt" in payload));
  const textOnly = buildKlingPayload({ prompt: "p", referenceImages: [], durationSeconds: 5 });
  ok("text-only payload", textOnly.contents.length === 1 && textOnly.settings.duration === 5);
  const neg = buildKlingPayload({ prompt: "p", negativePrompt: "blur", referenceImages: [], durationSeconds: 5 });
  ok("negative folded into prompt", (neg.contents[0] as any).text.includes("Avoid: blur"));

  /* --- status mapping --- */
  ok("status submitted → starting", mapKlingStatus("submitted") === "starting");
  ok("status processing", mapKlingStatus("processing") === "processing");
  ok("status succeed", mapKlingStatus("succeed") === "succeeded");
  ok("status succeeded", mapKlingStatus("succeeded") === "succeeded");
  ok("status failed", mapKlingStatus("failed") === "failed");
  ok("status unknown → processing", mapKlingStatus("weird") === "processing" && mapKlingStatus(undefined) === "processing");

  const done = klingTaskToPredictionState({ id: "t1", status: "succeeded", create_time: 1000, update_time: 2000, outputs: [{ type: "video", url: "https://kling/out.mp4", duration: "10" }] });
  ok("task succeeded → url", done.status === "succeeded" && done.url === "https://kling/out.mp4");
  ok("task timestamps", done.startedAt === new Date(1000).toISOString() && done.completedAt === new Date(2000).toISOString());
  const failed = klingTaskToPredictionState({ id: "t2", status: "failed", message: "Task failed due to risk control" });
  ok("task failed → error", failed.status === "failed" && !!failed.error);
  ok("risk control → moderation", classifyProviderError(failed.error) === "moderation");
  ok("plain failure not moderation", classifyProviderError(mapKlingFailure("internal error")) !== "moderation");
  ok("missing task → processing", klingTaskToPredictionState(null).status === "processing");
  const running = klingTaskToPredictionState({ id: "t3", status: "processing" });
  ok("running has no url/completedAt", running.status === "processing" && !running.url && running.completedAt === null);

  /* --- missing key --- */
  const saved = process.env.KLING_API_KEY;
  delete process.env.KLING_API_KEY;
  let msg = "";
  try { await startKlingVideo({ prompt: "p", referenceImages: [], durationSeconds: 5 }); } catch (e: any) { msg = e?.message ?? ""; }
  if (saved !== undefined) process.env.KLING_API_KEY = saved;
  ok("missing key rejects", msg === KLING_MISSING_KEY_MESSAGE);

  console.log(`stage47: ${n} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
