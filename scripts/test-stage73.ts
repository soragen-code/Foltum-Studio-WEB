/**
 * Stage 73 — pure unit checks for the provider layer (no network, no DB).
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage73.ts
 */
import assert from "node:assert/strict";
import { buildModelArkVideoBody, buildModelArkImageBody, mapModelArkTaskState, modelArkImageSize, MODELARK_VIDEO_MODEL, MODELARK_IMAGE_MODEL } from "../lib/modelark";
import { buildWaveSpeedImageRequest, WAVESPEED_SEEDREAM_T2I, WAVESPEED_SEEDREAM_EDIT } from "../lib/providers/image-provider";
import { isGenerationProvider, GENERATION_PROVIDERS } from "../lib/validations";

const H = "http" + "s://";
const url = (i: number) => `${H}cdn.example/ref-${i}.jpg`;
let passed = 0;
const t = (name: string, fn: () => void) => { fn(); passed++; console.log("ok -", name); };

t("ModelArk task succeeded → succeeded + url from content.video_url", () => {
  const st = mapModelArkTaskState({ id: "x", status: "succeeded", content: { video_url: `${H}v/out.mp4` } });
  assert.equal(st.status, "succeeded"); assert.equal(st.url, `${H}v/out.mp4`);
});
t("ModelArk task failed / expired → failed; cancelled → canceled; queued/running → non-terminal", () => {
  assert.equal(mapModelArkTaskState({ status: "failed", error: { code: "InternalError", message: "boom" } }).status, "failed");
  assert.equal(mapModelArkTaskState({ status: "failed", error: { message: "boom" } }).error, "boom");
  assert.equal(mapModelArkTaskState({ status: "expired" }).status, "failed");
  assert.equal(mapModelArkTaskState({ status: "cancelled" }).status, "canceled");
  assert.equal(mapModelArkTaskState({ status: "queued" }).status, "starting");
  assert.equal(mapModelArkTaskState({ status: "running" }).status, "processing");
});
t("ModelArk video body: text first, N refs as reference_image, trimmed to 30 (tail dropped), 9:16, audio on, no watermark", () => {
  const refs = Array.from({ length: 35 }, (_, i) => url(i));
  const body = buildModelArkVideoBody({ prompt: "A scene", reference_images: refs, duration: 8, resolution: "480p", aspect_ratio: "9:16" }) as any;
  assert.equal(body.model, MODELARK_VIDEO_MODEL);
  assert.equal(body.content[0].type, "text"); assert.equal(body.content[0].text, "A scene");
  const imgs = body.content.slice(1);
  assert.equal(imgs.length, 30);
  assert.ok(imgs.every((c: any) => c.type === "image_url" && c.role === "reference_image"));
  assert.equal(imgs[0].image_url.url, url(0)); assert.equal(imgs[29].image_url.url, url(29));
  assert.equal(body.ratio, "9:16"); assert.equal(body.resolution, "480p"); assert.equal(body.duration, 8);
  assert.equal(body.generate_audio, true); assert.equal(body.watermark, false);
  const noRefs = buildModelArkVideoBody({ prompt: "p" }) as any;
  assert.equal(noRefs.content.length, 1); assert.equal(noRefs.ratio, "9:16"); assert.equal(noRefs.resolution, "720p");
});
t("ModelArk image body: ≤14 refs, explicit size closest to aspect, url format, no watermark", () => {
  const body = buildModelArkImageBody({ prompt: "portrait", aspect_ratio: "9:16", image_input: Array.from({ length: 20 }, (_, i) => url(i)) }) as any;
  assert.equal(body.model, MODELARK_IMAGE_MODEL);
  assert.equal(body.image.length, 14); assert.equal(body.image[13], url(13));
  assert.equal(body.size, "1440x2560"); assert.equal(body.response_format, "url");
  assert.equal(body.watermark, false); assert.equal(body.sequential_image_generation, "disabled");
  assert.equal("image" in buildModelArkImageBody({ prompt: "p" }), false);
  assert.equal(modelArkImageSize("1:1"), "2048x2048"); assert.equal(modelArkImageSize("16:9"), "2560x1440");
});
t("WaveSpeed image request: t2i slug without refs, /edit slug with ≤10 refs, Pro sends aspect_ratio+resolution (not size)", () => {
  const a = buildWaveSpeedImageRequest({ prompt: "p", aspect_ratio: "9:16" });
  assert.equal(a.slug, WAVESPEED_SEEDREAM_T2I); assert.equal(a.slug, "bytedance/seedream-v5.0-pro"); // Stage 74: Pro
  // Seedream v5.0 Pro takes aspect_ratio + resolution; `size` is a Lite param the Pro model ignores (→ square).
  assert.equal(a.body.aspect_ratio, "9:16"); assert.equal(a.body.resolution, "2k");
  assert.equal("size" in a.body, false); assert.equal("images" in a.body, false);
  assert.equal(a.body.output_format, "png"); assert.equal(a.body.enable_sync_mode, false);
  const b = buildWaveSpeedImageRequest({ prompt: "p", image_input: Array.from({ length: 12 }, (_, i) => url(i)) });
  assert.equal(b.slug, WAVESPEED_SEEDREAM_EDIT); assert.equal(b.slug, "bytedance/seedream-v5.0-pro/edit"); assert.equal((b.body.images as string[]).length, 10);
  // /edit defaults to 9:16 @ 2k when no aspect is passed, and never sends size.
  assert.equal(b.body.aspect_ratio, "9:16"); assert.equal(b.body.resolution, "2k"); assert.equal("size" in b.body, false);
});
t("isGenerationProvider accepts replicate|wavespeed|modelark and rejects others", () => {
  assert.deepEqual([...GENERATION_PROVIDERS], ["replicate", "wavespeed", "modelark"]);
  for (const p of GENERATION_PROVIDERS) assert.ok(isGenerationProvider(p));
  for (const bad of ["seedance", "kling", "", null, undefined, 1, "Replicate"]) assert.equal(isGenerationProvider(bad), false);
});

console.log(`\nstage73: ${passed} checks passed`);
