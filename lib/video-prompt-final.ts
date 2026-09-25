import type { BuildScenePromptResult } from './scene-prompt';
/** Worker + preview share this transform so the submitted text matches the pre-generation preview. */
export function finalVideoPrompt(built: BuildScenePromptResult): string {
  // Stage 238 — the scene prompt is now a self-contained English template assembled in buildScenePrompt
  // (Setting / Characters / ACTIONS / FRAMING). It is emitted VERBATIM so the text submitted to the model
  // is byte-identical to the prompt shown in the pre-generation preview — no extra directives are appended.
  return built.prompt;
}
