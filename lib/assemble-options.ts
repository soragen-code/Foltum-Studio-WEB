/**
 * Stage 46B — production options of the FINAL assembled episode (pure, client-safe: no ffmpeg/fs).
 * Scenes are always rendered at 480p; only the assembled file is scaled to `quality` and `fps`.
 */
export type AssembleQuality = "480p" | "720p" | "1080p";
export type AssembleFps = 30 | 60;
export const ASSEMBLE_QUALITIES: readonly AssembleQuality[] = ["480p", "720p", "1080p"];
export const ASSEMBLE_FPS: readonly AssembleFps[] = [30, 60];
export const DEFAULT_ASSEMBLE_QUALITY: AssembleQuality = "480p";
export const DEFAULT_ASSEMBLE_FPS: AssembleFps = 30;
/** 9:16 output geometry per quality. */
export const ASSEMBLE_DIMENSIONS: Record<AssembleQuality, { width: number; height: number }> = {
  "480p": { width: 480, height: 854 },
  "720p": { width: 720, height: 1280 },
  "1080p": { width: 1080, height: 1920 },
};


export function isAssembleQuality(v: unknown): v is AssembleQuality {
  return typeof v === "string" && (ASSEMBLE_QUALITIES as readonly string[]).includes(v);
}
export function isAssembleFps(v: unknown): v is AssembleFps {
  return typeof v === "number" && (ASSEMBLE_FPS as readonly number[]).includes(v);
}
