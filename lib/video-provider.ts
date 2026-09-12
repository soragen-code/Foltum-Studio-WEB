/**
 * Stage 47 — per-episode video provider: Seedance 2.5 (Replicate, default) or Kling 3.0 (Kling Open Platform).
 * Pure constants/helpers shared by the schema validation, the video worker and the episode UI.
 */

export const VIDEO_PROVIDERS = ["seedance", "kling"] as const;
export type VideoProvider = (typeof VIDEO_PROVIDERS)[number];

export const DEFAULT_VIDEO_PROVIDER: VideoProvider = "seedance";

/** Value persisted to Scene.videoModel / job state `model` when Kling produced the clip. */
export const KLING_VIDEO_MODEL = "kling-v3";

/** Human-readable provider labels (UI switch + scene badge). */
export const VIDEO_PROVIDER_LABEL: Record<VideoProvider, string> = {
  seedance: "Seedance 2.5",
  kling: "Kling 3.0",
};

export function isVideoProvider(value: unknown): value is VideoProvider {
  return typeof value === "string" && (VIDEO_PROVIDERS as readonly string[]).includes(value);
}

/** Coerce a stored episode value (null / legacy / garbage) to a provider id. */
export function normalizeVideoProvider(value: unknown): VideoProvider {
  return isVideoProvider(value) ? value : DEFAULT_VIDEO_PROVIDER;
}

/** Badge label for a generated scene from its persisted `videoModel`. */
export function videoModelBadge(videoModel: string | null | undefined): string {
  return videoModel === KLING_VIDEO_MODEL ? VIDEO_PROVIDER_LABEL.kling : VIDEO_PROVIDER_LABEL.seedance;
}
