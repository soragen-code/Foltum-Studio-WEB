/**
 * Stage 74 — pure unit checks: Seedream 5.0 Pro slugs for every image provider, fixed models (no network, no DB).
 * Run: timeout 90 npx tsx --tsconfig tsconfig.json scripts/test-stage74.ts
 */
import assert from "node:assert/strict";
import { SEEDREAM_MODEL, SEEDREAM_VERSION_ID, SEEDANCE_MODEL } from "../lib/replicate";
import { buildWaveSpeedImageRequest, WAVESPEED_SEEDREAM_T2I, WAVESPEED_SEEDREAM_EDIT } from "../lib/providers/image-provider";
import { MODELARK_IMAGE_MODEL, MODELARK_VIDEO_MODEL } from "../lib/modelark";
import { IMAGE_MODELS, DEFAULT_IMAGE_MODEL, normalizeImageModel } from "../lib/ai-models";

const H = "http" + "s://";
const url = (i: number) => `${H}cdn.example/ref-${i}.jpg`;
let passed = 0;
const t = (name: string, fn: () => void) => { fn(); passed++; console.log("ok -", name); };

t("Replicate: SEEDREAM_MODEL is Seedream 5.0 Pro with a pinned (non-Lite) version", () => {
  assert.equal(SEEDREAM_MODEL, "bytedance/seedream-5-pro");
  assert.match(SEEDREAM_VERSION_ID, /^[0-9a-f]{64}$/);
  assert.notEqual(SEEDREAM_VERSION_ID, "eeb2857d94c49a5bcbc9d6c6057416e1d3b1a2735a16e08e4def9bf7ee22ec71", "Lite pin must be gone");
  assert.equal(SEEDANCE_MODEL, "bytedance/seedance-2.5");
});
t("WaveSpeed: T2I / EDIT constants target the -pro endpoints", () => {
  assert.equal(WAVESPEED_SEEDREAM_T2I, "bytedance/seedream-v5.0-pro");
  assert.equal(WAVESPEED_SEEDREAM_EDIT, "bytedance/seedream-v5.0-pro/edit");
  assert.equal(/lite/i.test(WAVESPEED_SEEDREAM_T2I + WAVESPEED_SEEDREAM_EDIT), false);
});
t("WaveSpeed request builder: t2i → -pro, with refs → -pro/edit (≤10 refs)", () => {
  const a = buildWaveSpeedImageRequest({ prompt: "p", aspect_ratio: "9:16" });
  assert.equal(a.slug, "bytedance/seedream-v5.0-pro"); assert.equal("images" in a.body, false);
  const b = buildWaveSpeedImageRequest({ prompt: "p", image_input: Array.from({ length: 12 }, (_, i) => url(i)) });
  assert.equal(b.slug, "bytedance/seedream-v5.0-pro/edit"); assert.equal((b.body.images as string[]).length, 10);
});
t("ModelArk: image model stays seedream-5-0-260128 (full 5.0), video stays Seedance 2.5", () => {
  assert.equal(MODELARK_IMAGE_MODEL, "seedream-5-0-260128");
  assert.equal(MODELARK_VIDEO_MODEL, "dreamina-seedance-2-5-260628");
});
t("ai-models registry: single image model seedream-5-pro; legacy 'seedream-5-lite' normalizes to it", () => {
  assert.equal(IMAGE_MODELS.length, 1);
  assert.equal(DEFAULT_IMAGE_MODEL, "seedream-5-pro");
  assert.match(IMAGE_MODELS[0].label, /Seedream 5\.0 Pro/);
  assert.equal(normalizeImageModel("seedream-5-lite"), "seedream-5-pro");
  assert.equal(normalizeImageModel(undefined), "seedream-5-pro");
});

console.log(`\nstage74: ${passed} checks passed`);
