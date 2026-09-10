/**
 * Stage 13 — «Ассембл» final polish selection logic (pure, unit-tested).
 *
 * Given the whole-episode continuity audit (see `episodeContinuityAudit*` in lib/season.ts)
 * and the current scenes, decide which scenes must be RE-GENERATED. Only scenes the auditor
 * flagged with a real, changed corrected prompt qualify; consistent scenes are never touched
 * (no credits wasted). Idempotent + double-charge safe: a scene that already has an active
 * video job is still selected (so the UI keeps showing it) but marked `needsCharge:false`.
 */

export interface AuditSceneResult {
  number: number;
  hasIssue: boolean;
  issue?: string;
  correctedVideoPrompt?: string;
  /** Stage 40 — corrected scripted end state (optional; kept in step with the corrected prompt). */
  correctedEndState?: string;
}

export interface PolishSceneInput {
  id: string;
  number: number;
  videoPrompt?: string | null;
  /** True when a video job for this scene is already pending/processing (regen already running). */
  hasActiveJob?: boolean;
}

export interface PolishSelection {
  sceneId: string;
  number: number;
  issue: string;
  correctedVideoPrompt: string;
  /** Stage 40 — corrected end state to store alongside the prompt (null = keep the current one). */
  correctedEndState: string | null;
  /** false when a job is already active for this scene → do not charge / re-create it. */
  needsCharge: boolean;
}

/** A corrected prompt shorter than this is treated as junk and ignored (keeps the old clip). */
export const MIN_CORRECTED_PROMPT_LEN = 40;

/**
 * Select the scenes to re-generate from an audit result.
 * - keeps only `hasIssue` scenes whose `correctedVideoPrompt` is substantial AND actually differs
 *   from the current prompt (a no-op correction is skipped so no credit is spent),
 * - skips audit entries for scene numbers that don't exist (backward/forward compatible),
 * - marks scenes with an active job `needsCharge:false` for idempotent double-charge protection.
 */
export function selectPolishScenes(
  audit: AuditSceneResult[] | null | undefined,
  scenes: PolishSceneInput[]
): PolishSelection[] {
  const byNumber = new Map<number, PolishSceneInput>();
  for (const s of scenes) byNumber.set(s.number, s);
  const out: PolishSelection[] = [];
  const seen = new Set<number>();
  for (const a of audit ?? []) {
    if (!a || a.hasIssue !== true) continue;
    if (seen.has(a.number)) continue; // dedupe repeated numbers from the model
    const corrected = (a.correctedVideoPrompt ?? "").trim();
    if (corrected.length < MIN_CORRECTED_PROMPT_LEN) continue;
    const scene = byNumber.get(a.number);
    if (!scene) continue; // audit referenced a scene that isn't in the episode
    if (corrected === (scene.videoPrompt ?? "").trim()) continue; // no real change
    seen.add(a.number);
    out.push({
      sceneId: scene.id,
      number: scene.number,
      issue: (a.issue ?? "").trim() || "Логическая нестыковка на стыке сцен",
      correctedVideoPrompt: corrected,
      correctedEndState: (a.correctedEndState ?? "").trim() || null,
      needsCharge: scene.hasActiveJob !== true,
    });
  }
  return out;
}
