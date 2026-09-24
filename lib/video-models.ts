/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  VIDEO MODEL CATALOG — single, extensible source of truth for the video-scene
 *  model selector (family + version) and the per-provider request-body builder.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every WaveSpeed video model the app can submit to is listed here with the exact
 * slug(s), the parameters it accepts, and how to shape its request body. The video
 * worker (lib/workers/video-job.ts) resolves the chosen model id to a slug + body
 * via `buildVideoRequest`, and the UI (episode-view) renders the two-level picker
 * from `VIDEO_FAMILIES`.
 *
 * Design rules:
 *  - The DEFAULT is Seedance 2.5 — its request body is byte-for-byte identical to
 *    the pre-selector behaviour (reference_images[] for t2v; image/last_image for
 *    i2v; resolution/duration/aspect_ratio/generate_audio). Backward compatibility
 *    is mandatory: any missing / unknown / legacy id resolves to Seedance 2.5.
 *  - The single WAVESPEED_API_KEY grants access to ALL four families — no per-family
 *    keys.
 *  - Prompts are ALWAYS English; the shared transport (wavespeedSubmit) translates
 *    body.prompt before dispatch, so builders here never touch language.
 *  - NEVER send a provider a key it does not support (each builder emits only the
 *    keys that family accepts).
 *  - Families without multi-reference support (Kling / MiniMax / Veo) degrade
 *    gracefully: for text-to-video they send the text prompt only; for
 *    image-to-video they send the first frame (and, where supported, the last frame).
 *
 * Slugs verified against https://api.wavespeed.ai/api/v3/<slug> (2026-09-24; Kling ≥2.5 use
 *  a /text-to-video | /image-to-video suffix, Kling 2.1 keeps the -t2v-master / -i2v-standard form).
 */

export type VideoFamilyId = "seedance" | "kling" | "minimax" | "veo";

/** How the request body is shaped for a given model (per-provider dialect). */
export type VideoBodyStyle = "seedance" | "kling" | "minimax" | "veo";

export interface VideoModelDef {
  /** Stable catalog id, stored in Scene.videoModel and sent as `videoModelId`. */
  id: string;
  /** Russian-facing version label (shown in the UI version dropdown). */
  label: string;
  /** Family this version belongs to. */
  family: VideoFamilyId;
  /** Text-to-video slug (reference-image / text-prompt mode). Undefined ⇒ no t2v. */
  slugT2V?: string;
  /** Image-to-video slug (first / last frame mode). Undefined ⇒ no i2v. */
  slugI2V?: string;
  /** True only for families that accept a multi-image `reference_images[]` array (Seedance). */
  refImages: boolean;
  /** Body dialect used by `buildVideoRequest`. */
  bodyStyle: VideoBodyStyle;
  /** Allowed resolutions (first = default). Empty ⇒ resolution key omitted (provider-fixed). */
  resolutions: string[];
  /**
   * Allowed durations in seconds. When `fixedDurations` is false it is treated as
   * an inclusive [min, max] range; when true it is the discrete set the provider
   * accepts (the requested duration is snapped to the nearest allowed value).
   */
  durations: number[];
  fixedDurations: boolean;
  /** Allowed aspect ratios (first = default). Empty ⇒ aspect_ratio key omitted. */
  aspectRatios: string[];
  /** Whether the model can bake native audio (generate_audio). */
  audio: boolean;
}

/** Family display metadata for the UI (grouping + Russian labels). */
export const VIDEO_FAMILY_LABELS: Record<VideoFamilyId, string> = {
  seedance: "Seedance (ByteDance)",
  kling: "Kling (Kwaivgi)",
  minimax: "MiniMax (Hailuo)",
  veo: "Veo (Google)",
};

/**
 * THE CATALOG. Order matters — the first Seedance entry is the global default and the
 * families render in this order in the picker.
 */
export const VIDEO_MODEL_CATALOG: VideoModelDef[] = [
  /* ── Seedance (ByteDance) — DEFAULT ─────────────────────────────────────── */
  {
    id: "seedance-2.5",
    label: "Seedance 2.5 — со звуком (по умолчанию)",
    family: "seedance",
    slugT2V: "bytedance/seedance-2.5/text-to-video",
    slugI2V: "bytedance/seedance-2.5/image-to-video",
    refImages: true,
    bodyStyle: "seedance",
    resolutions: ["720p", "480p"],
    durations: [4, 30],
    fixedDurations: false,
    aspectRatios: ["9:16", "16:9", "1:1"],
    audio: true,
  },

  /* ── Kling (Kwaivgi) ────────────────────────────────────────────────────── */
  {
    id: "kling-v2.1",
    label: "Kling 2.1",
    family: "kling",
    slugT2V: "kwaivgi/kling-v2.1-t2v-master",
    slugI2V: "kwaivgi/kling-v2.1-i2v-standard",
    refImages: false,
    bodyStyle: "kling",
    resolutions: [],
    durations: [5, 10],
    fixedDurations: true,
    aspectRatios: ["9:16", "16:9", "1:1"],
    audio: false,
  },
  {
    id: "kling-v2.5-turbo-pro",
    label: "Kling 2.5 Turbo Pro",
    family: "kling",
    slugT2V: "kwaivgi/kling-v2.5-turbo-pro/text-to-video",
    slugI2V: "kwaivgi/kling-v2.5-turbo-pro/image-to-video",
    refImages: false,
    bodyStyle: "kling",
    resolutions: [],
    durations: [5, 10],
    fixedDurations: true,
    aspectRatios: ["9:16", "16:9", "1:1"],
    audio: false,
  },
  {
    id: "kling-v2.5-turbo-std",
    label: "Kling 2.5 Turbo Standard",
    family: "kling",
    // No text-to-video endpoint for the Std tier on WaveSpeed (verified 2026-09-24).
    slugI2V: "kwaivgi/kling-v2.5-turbo-std/image-to-video",
    refImages: false,
    bodyStyle: "kling",
    resolutions: [],
    durations: [5, 10],
    fixedDurations: true,
    aspectRatios: ["9:16", "16:9", "1:1"],
    audio: false,
  },
  {
    id: "kling-v2.6-pro",
    label: "Kling 2.6 Pro",
    family: "kling",
    slugT2V: "kwaivgi/kling-v2.6-pro/text-to-video",
    slugI2V: "kwaivgi/kling-v2.6-pro/image-to-video",
    refImages: false,
    bodyStyle: "kling",
    resolutions: [],
    durations: [5, 10],
    fixedDurations: true,
    aspectRatios: ["9:16", "16:9", "1:1"],
    audio: false,
  },
  {
    id: "kling-v2.6-std",
    label: "Kling 2.6 Standard",
    family: "kling",
    slugT2V: "kwaivgi/kling-v2.6-std/text-to-video",
    slugI2V: "kwaivgi/kling-v2.6-std/image-to-video",
    refImages: false,
    bodyStyle: "kling",
    resolutions: [],
    durations: [5, 10],
    fixedDurations: true,
    aspectRatios: ["9:16", "16:9", "1:1"],
    audio: false,
  },
  {
    id: "kling-v3.0-pro",
    label: "Kling 3.0 Pro",
    family: "kling",
    slugT2V: "kwaivgi/kling-v3.0-pro/text-to-video",
    slugI2V: "kwaivgi/kling-v3.0-pro/image-to-video",
    refImages: false,
    bodyStyle: "kling",
    resolutions: [],
    durations: [5, 10],
    fixedDurations: true,
    aspectRatios: ["9:16", "16:9", "1:1"],
    audio: false,
  },
  {
    id: "kling-v3.0-std",
    label: "Kling 3.0 Standard",
    family: "kling",
    slugT2V: "kwaivgi/kling-v3.0-std/text-to-video",
    slugI2V: "kwaivgi/kling-v3.0-std/image-to-video",
    refImages: false,
    bodyStyle: "kling",
    resolutions: [],
    durations: [5, 10],
    fixedDurations: true,
    aspectRatios: ["9:16", "16:9", "1:1"],
    audio: false,
  },

  /* ── MiniMax (Hailuo) ───────────────────────────────────────────────────── */
  {
    id: "hailuo-02-standard",
    label: "Hailuo 02 Standard (768p)",
    family: "minimax",
    slugT2V: "minimax/hailuo-02/standard",
    slugI2V: "minimax/hailuo-02/standard",
    refImages: false,
    bodyStyle: "minimax",
    resolutions: [],
    durations: [6, 10],
    fixedDurations: true,
    aspectRatios: [],
    audio: false,
  },
  {
    id: "hailuo-02-pro",
    label: "Hailuo 02 Pro (1080p)",
    family: "minimax",
    slugT2V: "minimax/hailuo-02/pro",
    slugI2V: "minimax/hailuo-02/pro",
    refImages: false,
    bodyStyle: "minimax",
    resolutions: [],
    durations: [6, 10],
    fixedDurations: true,
    aspectRatios: [],
    audio: false,
  },
  {
    id: "hailuo-02-fast",
    label: "Hailuo 02 Fast (512p)",
    family: "minimax",
    slugT2V: "minimax/hailuo-02/fast",
    slugI2V: "minimax/hailuo-02/fast",
    refImages: false,
    bodyStyle: "minimax",
    resolutions: [],
    durations: [6, 10],
    fixedDurations: true,
    aspectRatios: [],
    audio: false,
  },

  /* ── Veo (Google) ───────────────────────────────────────────────────────── */
  {
    id: "veo3",
    label: "Veo 3 — со звуком",
    family: "veo",
    slugT2V: "google/veo3",
    slugI2V: "google/veo3",
    refImages: false,
    bodyStyle: "veo",
    resolutions: ["720p", "1080p"],
    durations: [8],
    fixedDurations: true,
    aspectRatios: ["9:16", "16:9"],
    audio: true,
  },
  {
    id: "veo3-fast",
    label: "Veo 3 Fast — со звуком",
    family: "veo",
    slugT2V: "google/veo3-fast",
    slugI2V: "google/veo3-fast",
    refImages: false,
    bodyStyle: "veo",
    resolutions: ["720p", "1080p"],
    durations: [8],
    fixedDurations: true,
    aspectRatios: ["9:16", "16:9"],
    audio: true,
  },
  {
    id: "veo3.1",
    label: "Veo 3.1 — со звуком",
    family: "veo",
    slugT2V: "google/veo3.1/text-to-video",
    slugI2V: undefined,
    refImages: false,
    bodyStyle: "veo",
    resolutions: ["720p", "1080p"],
    durations: [4, 6, 8],
    fixedDurations: true,
    aspectRatios: ["9:16", "16:9"],
    audio: true,
  },
];

/** Default model id — the current production behaviour (Seedance 2.5). */
export const DEFAULT_VIDEO_MODEL_ID = "seedance-2.5";

const CATALOG_BY_ID = new Map(VIDEO_MODEL_CATALOG.map((m) => [m.id, m]));

/**
 * Coerce any incoming value to a known catalog id. Legacy stored values
 * ("seedance", "seedance-2.0", null, anything unknown) resolve to Seedance 2.5,
 * so existing scenes / callers behave exactly as before.
 */
export function normalizeVideoModelId(v: unknown): string {
  if (typeof v === "string" && CATALOG_BY_ID.has(v)) return v;
  return DEFAULT_VIDEO_MODEL_ID;
}

/** Resolve a (possibly legacy) id to its catalog definition (never null). */
export function getVideoModel(id: unknown): VideoModelDef {
  return CATALOG_BY_ID.get(normalizeVideoModelId(id))!;
}

/** True when the id is a real catalog id (used for validation / logging). */
export function isKnownVideoModelId(v: unknown): boolean {
  return typeof v === "string" && CATALOG_BY_ID.has(v);
}

/** Grouped view for the UI: families in catalog order, each with its versions. */
export const VIDEO_FAMILIES: {
  id: VideoFamilyId;
  label: string;
  versions: { id: string; label: string }[];
}[] = (["seedance", "kling", "minimax", "veo"] as VideoFamilyId[]).map((fam) => ({
  id: fam,
  label: VIDEO_FAMILY_LABELS[fam],
  versions: VIDEO_MODEL_CATALOG.filter((m) => m.family === fam).map((m) => ({ id: m.id, label: m.label })),
}));

/** Snap a requested duration to what the model accepts (nearest allowed / clamped range). */
export function resolveDuration(def: VideoModelDef, requested: number): number {
  const want = Number.isFinite(requested) ? Math.round(requested) : def.durations[0];
  if (def.fixedDurations) {
    // Discrete set — pick the nearest allowed value (ties → the larger, more forgiving one).
    let best = def.durations[0];
    let bestDist = Math.abs(want - best);
    for (const d of def.durations) {
      const dist = Math.abs(want - d);
      if (dist < bestDist || (dist === bestDist && d > best)) { best = d; bestDist = dist; }
    }
    return best;
  }
  // [min, max] range.
  const [min, max] = def.durations;
  return Math.max(min, Math.min(max, want));
}

/** Snap a requested resolution to one the model supports (empty list ⇒ omit resolution). */
export function resolveResolution(def: VideoModelDef, requested?: string | null): string | undefined {
  if (!def.resolutions.length) return undefined;
  if (requested && def.resolutions.includes(requested)) return requested;
  return def.resolutions[0];
}

/** Snap a requested aspect ratio to one the model supports (empty list ⇒ omit aspect_ratio). */
export function resolveAspectRatio(def: VideoModelDef, requested?: string | null): string | undefined {
  if (!def.aspectRatios.length) return undefined;
  if (requested && def.aspectRatios.includes(requested)) return requested;
  return def.aspectRatios[0];
}

export interface BuildVideoRequestInput {
  def: VideoModelDef;
  /** "t2v" = text/reference-driven scene; "i2v" = first/last-frame keyframe clip. */
  mode: "t2v" | "i2v";
  prompt: string;
  /** Multi-image references (Seedance t2v only). Ignored by families without refImages. */
  referenceImages?: string[];
  /** First frame (i2v). */
  image?: string;
  /** Last frame (i2v), where the family supports it. */
  lastImage?: string;
  /** Requested duration (seconds) — snapped to the model's allowed values. */
  duration?: number;
  /** Requested resolution — snapped to the model's supported list (or omitted). */
  resolution?: string;
  /** Requested aspect ratio — snapped to the model's supported list (or omitted). */
  aspectRatio?: string;
  /** Ask for native audio (honoured only where the model supports it). */
  generateAudio?: boolean;
  /** Optional negative prompt (Veo). */
  negativePrompt?: string;
  /** Optional seed. */
  seed?: number;
}

/**
 * Resolve the WaveSpeed slug and the provider-specific request body for a given model + inputs.
 * Only keys the provider actually accepts are emitted. Throws if the model has no slug for the mode.
 */
export function buildVideoRequest(input: BuildVideoRequestInput): { slug: string; body: Record<string, unknown> } {
  const { def, mode } = input;
  const slug = mode === "i2v" ? (def.slugI2V ?? def.slugT2V) : (def.slugT2V ?? def.slugI2V);
  if (!slug) throw new Error(`Video model "${def.id}" has no slug for mode "${mode}"`);

  const duration = resolveDuration(def, Number(input.duration ?? def.durations[0]));
  const resolution = resolveResolution(def, input.resolution);
  const aspectRatio = resolveAspectRatio(def, input.aspectRatio);
  const wantAudio = def.audio && input.generateAudio !== false;

  const body: Record<string, unknown> = { prompt: input.prompt };

  switch (def.bodyStyle) {
    case "seedance": {
      // Identical to the pre-selector Seedance behaviour.
      if (resolution) body.resolution = resolution;
      body.duration = duration;
      if (aspectRatio) body.aspect_ratio = aspectRatio;
      body.generate_audio = wantAudio;
      if (mode === "i2v") {
        if (input.image) body.image = input.image;
        if (input.lastImage) body.last_image = input.lastImage;
      } else if (def.refImages && input.referenceImages?.length) {
        body.reference_images = input.referenceImages;
      }
      break;
    }
    case "kling": {
      // Kling: prompt + duration (+ aspect_ratio for t2v); i2v carries a start image.
      body.duration = duration;
      if (mode === "i2v") {
        if (input.image) body.image = input.image;
      } else if (aspectRatio) {
        body.aspect_ratio = aspectRatio;
      }
      break;
    }
    case "minimax": {
      // Hailuo 02: prompt + duration (fixed resolution per variant). i2v carries first (+ end) frame.
      body.duration = duration;
      body.enable_prompt_expansion = true;
      if (mode === "i2v") {
        if (input.image) body.image = input.image;
        if (input.lastImage) body.end_image = input.lastImage;
      }
      break;
    }
    case "veo": {
      // Veo: prompt + aspect_ratio + resolution + duration + audio (+ negative_prompt / seed).
      if (aspectRatio) body.aspect_ratio = aspectRatio;
      if (resolution) body.resolution = resolution;
      body.duration = duration;
      body.generate_audio = wantAudio;
      if (input.negativePrompt) body.negative_prompt = input.negativePrompt;
      if (Number.isFinite(input.seed as number)) body.seed = input.seed;
      if (mode === "i2v" && input.image) body.image = input.image;
      break;
    }
  }

  return { slug, body };
}
