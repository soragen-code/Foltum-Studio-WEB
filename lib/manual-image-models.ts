/**
 * Stage 234 — image model catalog for "Manual mode" (/manual) and the "+ Add frame" tile on reference cards.
 *
 * GPT Image 2.0 is the app's proven default (same slugs as lib/providers/image-provider.ts). The other
 * entries are dispatched through the generic WaveSpeed transport (`wavespeedSubmit` / `wavespeedResult`);
 * a wrong/unsupported slug surfaces as a clear provider error and the credit is refunded.
 */
// NOTE: slugs are inlined (identical to WAVESPEED_GPT_IMAGE_T2I / _EDIT in lib/providers/image-provider.ts) so this
// module stays free of server-only imports and can be shared with client components.

export interface ManualImageModelDef {
  id: string;
  label: string;
  /** Text-to-image slug. */
  slugT2I: string;
  /** Image-edit / image-to-image slug (used when reference images are supplied). */
  slugEdit: string;
  /** Max reference images accepted by the edit endpoint. */
  maxRefs: number;
  bodyStyle: "gpt-image" | "seedream" | "nano-banana" | "flux2";
}

export const MANUAL_IMAGE_MODELS: ManualImageModelDef[] = [
  {
    id: "gpt-image-2",
    label: "GPT Image 2.0 (OpenAI) — default",
    slugT2I: "openai/gpt-image-2/text-to-image",
    slugEdit: "openai/gpt-image-2/edit",
    maxRefs: 10,
    bodyStyle: "gpt-image",
  },
  {
    id: "seedream-v5.0-pro",
    label: "Seedream 5.0 Pro (ByteDance)",
    slugT2I: "bytedance/seedream-v5.0-pro",
    slugEdit: "bytedance/seedream-v5.0-pro/edit",
    maxRefs: 10,
    bodyStyle: "seedream",
  },
  {
    id: "nano-banana-pro",
    label: "Nano Banana Pro (Google)",
    slugT2I: "google/nano-banana-pro/text-to-image",
    slugEdit: "google/nano-banana-pro/edit",
    maxRefs: 8,
    bodyStyle: "nano-banana",
  },
  {
    id: "flux-2-pro",
    label: "FLUX.2 Pro (Black Forest Labs)",
    slugT2I: "black-forest-labs/flux-2-pro/text-to-image",
    slugEdit: "black-forest-labs/flux-2-pro/edit",
    maxRefs: 8,
    bodyStyle: "flux2",
  },
];

export const DEFAULT_MANUAL_IMAGE_MODEL_ID = MANUAL_IMAGE_MODELS[0].id;
/** Credits charged per manual photo (and per added reference frame). */
export const MANUAL_PHOTO_COST = 1;
/** Credits charged per second of manual video. */
export const MANUAL_VIDEO_COST_PER_SEC = 1;

const BY_ID = new Map(MANUAL_IMAGE_MODELS.map((m) => [m.id, m]));

export function getManualImageModel(id: unknown): ManualImageModelDef {
  return (typeof id === "string" && BY_ID.get(id)) || MANUAL_IMAGE_MODELS[0];
}

export function isKnownManualImageModelId(id: unknown): boolean {
  return typeof id === "string" && BY_ID.has(id);
}

/**
 * Resolve slug + provider body for a manual image request. 9:16 portrait, PNG output.
 * With references → edit slug + `images`; without → text-to-image slug.
 */
export function buildManualImageRequest(
  modelId: string,
  prompt: string,
  referenceUrls: string[] = [],
): { slug: string; body: Record<string, unknown>; mode: "t2i" | "i2i" } {
  const def = getManualImageModel(modelId);
  const refs = referenceUrls.filter((u) => typeof u === "string" && u.startsWith("http")).slice(0, def.maxRefs);
  const edit = refs.length > 0;
  const slug = edit ? def.slugEdit : def.slugT2I;
  const body: Record<string, unknown> = { prompt };

  switch (def.bodyStyle) {
    case "gpt-image":
      body.aspect_ratio = "9:16";
      body.resolution = "2k";
      body.quality = "high";
      body.output_format = "png";
      body.enable_sync_mode = false;
      if (edit) body.images = refs;
      break;
    case "seedream":
      body.aspect_ratio = "9:16";
      body.resolution = "2k";
      body.output_format = "png";
      body.enable_sync_mode = false;
      if (edit) body.images = refs;
      break;
    case "nano-banana":
      body.aspect_ratio = "9:16";
      body.resolution = "2k";
      body.output_format = "png";
      if (edit) body.images = refs;
      break;
    case "flux2":
      body.aspect_ratio = "9:16";
      body.resolution = "2k";
      body.output_format = "png";
      if (edit) body.images = refs;
      break;
  }
  return { slug, body, mode: edit ? "i2i" : "t2i" };
}
