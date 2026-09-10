/**
 * Pure, unit-testable logic for the background «Ассембл» job (episode_assemble).
 *
 * The job walks a fixed phase sequence: analyzing → regen → stitching → done.
 * Its progress and its resultData shape are computed here so both the server
 * orchestrator and the stage19 logic test agree on the contract (no DB / fs / LLM
 * imports live in this module).
 */

export type AssemblePhase = "analyzing" | "regen" | "stitching" | "done";

export const ASSEMBLE_JOB_TYPE = "episode_assemble";

/** JSON stored in GenerationJob.resultData for an episode_assemble job. */
export interface AssembleResultData {
  episodeId: string;
  phase: AssemblePhase;
  issues: { number: number; issue: string }[];
  done: number;
  total: number;
  failed: number;
  videoUrl?: string;
  /** Number of scenes actually fixed (regenerated) — drives the success notice. */
  fixedCount?: number;
}

/** Ordered phases the job moves through. */
export const ASSEMBLE_PHASE_ORDER: AssemblePhase[] = ["analyzing", "regen", "stitching", "done"];

/** The phase that follows `phase` (returns the same terminal phase for 'done'). */
export function nextAssemblePhase(phase: AssemblePhase): AssemblePhase {
  const i = ASSEMBLE_PHASE_ORDER.indexOf(phase);
  if (i < 0 || i >= ASSEMBLE_PHASE_ORDER.length - 1) return "done";
  return ASSEMBLE_PHASE_ORDER[i + 1];
}

/**
 * Coarse overall progress (1-100) for the current phase.
 *  - analyzing: 1-15
 *  - regen:     15-85 (scales with done/total)
 *  - stitching: 90
 *  - done:      100
 */
export function assembleProgress(phase: AssemblePhase, done = 0, total = 0): number {
  switch (phase) {
    case "analyzing":
      return 8;
    case "regen": {
      if (total <= 0) return 15;
      const frac = Math.max(0, Math.min(1, done / total));
      return Math.round(15 + frac * 70);
    }
    case "stitching":
      return 90;
    case "done":
      return 100;
    default:
      return 1;
  }
}

/**
 * Zero flagged issues → skip regeneration and stitch straight away (no credits spent).
 * A single source of truth shared by the orchestrator and the test.
 */
export function shouldStitchWithoutCharge(issueCount: number): boolean {
  return issueCount <= 0;
}

/** Build the resultData JSON for a job update in a consistent shape. */
export function buildAssembleResult(data: AssembleResultData): string {
  return JSON.stringify(data);
}
