import type { BuildScenePromptResult } from './scene-prompt';
import { applySeamDirectives, applyContinuousAction } from './prompt-seam';
/** Worker + preview share these transforms. A re-angled input must NOT be re-angled again by Seedance. */
export function finalVideoPrompt(built: BuildScenePromptResult): string {
  let prompt = applySeamDirectives(built.prompt, { hasOverride: built.hasOverride });
  const hasLocationRef = built.retryRefs.some(r => r.kind === 'location');
  if (hasLocationRef) prompt += "\nLOCATION: use the attached wide/layout plates as the same physical space, not a backdrop. Preserve its world-space geometry, objects and light; the edited opening frame (when present) is authoritative for the current state.";
  if (built.retryRefs.some(r => r.kind === 'reangle')) {
    prompt = applyContinuousAction(prompt, { hasOverride: false, continuity: 'last_frame' });
    prompt = 'OPENING CAMERA PRIORITY: [Image1] is ALREADY the new camera view of the previous video’s final instant. Match it at frame 1, not the old source camera. Source-world state wins over conflicting reference-plate or scripted placement/wardrobe. Continue motion, action and the exact dialogue immediately.\n' + prompt;
  }
  return prompt;
}
