import type { GenerationProvider } from "@/lib/validations";
import type { PredictionState, SeedanceInput } from "@/lib/replicate";
import * as replicate from "@/lib/replicate";
import * as wavespeed from "@/lib/wavespeed";
import * as modelark from "@/lib/modelark";

/* ------------------------------------------------------------------ */
/*  Stage 73: scene-video generation provider layer (transport only).  */
/*  wavespeed — lib/wavespeed.ts (Stage 70 path), unchanged.           */
/*  modelark  — lib/modelark.ts Seedance 2.5 tasks.                    */
/*  replicate — lib/replicate.ts Seedance 2.5 predictions.             */
/*  All three map into the shared PredictionState so the worker's      */
/*  polling / cancel / diagnostics loop is identical for every provider.*/
/* ------------------------------------------------------------------ */

function requireKey(provider: GenerationProvider): void {
  if (provider === "replicate" && !process.env.REPLICATE_API_TOKEN) throw new Error("Replicate provider key not set (REPLICATE_API_TOKEN)");
  if (provider === "wavespeed" && !process.env.WAVESPEED_API_KEY) throw new Error("WaveSpeed provider key not set (WAVESPEED_API_KEY)");
  if (provider === "modelark" && !process.env.MODELARK_API_KEY) throw new Error("ModelArk provider key not set (MODELARK_API_KEY)");
}

/** Submit a scene video on the given provider; returns the provider task id. */
export async function startVideoGeneration(provider: GenerationProvider, input: SeedanceInput): Promise<string> {
  requireKey(provider);
  if (provider === "modelark") return modelark.startVideoTask(input);
  if (provider === "replicate") return replicate.startVideoPrediction(input);
  return wavespeed.startVideoPrediction(input);
}

/** Poll a scene video task (shared PredictionState). */
export async function getVideoGenerationState(provider: GenerationProvider, id: string): Promise<PredictionState> {
  if (provider === "modelark") return modelark.getVideoTaskState(id);
  if (provider === "replicate") return replicate.getPredictionState(id);
  return wavespeed.getVideoPredictionState(id);
}

/** Best-effort cancel of a scene video task. */
export async function cancelVideoGeneration(provider: GenerationProvider, id: string): Promise<void> {
  if (provider === "modelark") return modelark.cancelVideoTask(id);
  if (provider === "replicate") return replicate.cancelVideoPrediction(id).catch(() => {});
  return wavespeed.cancelVideoPrediction(id);
}
