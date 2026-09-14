import type { PredictionState, SeedanceInput, SeedanceImageToVideoInput } from "@/lib/wavespeed";
import * as wavespeed from "@/lib/wavespeed";

/* ------------------------------------------------------------------ */
/*  Scene-video generation — Seedance 2.5 on WaveSpeed ONLY (Stage 104).*/
/*  Thin wrappers kept so the worker's polling / cancel / diagnostics   */
/*  loop is unchanged.                                                  */
/* ------------------------------------------------------------------ */

function requireKey(): void {
  if (!process.env.WAVESPEED_API_KEY) throw new Error("WaveSpeed provider key not set (WAVESPEED_API_KEY)");
}

/** Submit a scene video (text-to-video with reference images); returns the task id. */
export async function startVideoGeneration(input: SeedanceInput): Promise<string> {
  requireKey();
  return wavespeed.startVideoPrediction(input);
}

/** Submit a scene video as image-to-video (first / last frame keyframes); returns the task id. */
export async function startImageToVideoGeneration(input: SeedanceImageToVideoInput): Promise<string> {
  requireKey();
  return wavespeed.generateSeedanceImageToVideo(input);
}

/** Poll a scene video task (shared PredictionState). */
export async function getVideoGenerationState(id: string): Promise<PredictionState> {
  return wavespeed.getVideoPredictionState(id);
}

/** Best-effort cancel of a scene video task. */
export async function cancelVideoGeneration(id: string): Promise<void> {
  return wavespeed.cancelVideoPrediction(id);
}
