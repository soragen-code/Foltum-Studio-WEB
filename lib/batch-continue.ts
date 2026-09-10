/**
 * Stage 8 — batch video auto-continuation planner (pure, DB-free, unit-tested).
 *
 * The episode "Сгенерировать все" flow creates one video GenerationJob per scene and
 * submits their Seedance predictions in the background of a single serverless invocation.
 * That invocation can end (Vercel maxDuration, or a slow per-scene reference-image step)
 * before every prediction is submitted, leaving later jobs "pending" with no predictionId
 * and nothing to resubmit them. This planner decides — from the CURRENT scene/job state —
 * which scenes still need a kick, so the client can drive continuation to completion
 * without the user clicking again.
 *
 * Strict idempotency: a scene that already has a video (or a job with a live prediction the
 * poll-recovery owns) is NEVER re-submitted, so auto-continue can run every few seconds
 * without burning credits twice.
 */

export type BatchSceneStatus = "done" | "generating" | "pending" | "failed";

/** Snapshot of one scene + its latest video job, as read from the DB. */
export interface SceneJobSnapshot {
  sceneId: string;
  number: number;
  /** scene.videoUrl is a valid published URL. */
  hasVideo: boolean;
  /** The most recent video GenerationJob for the scene (or null if none created yet). */
  latestJob: {
    status: string; // pending | processing | completed | failed | ...
    /** resultData holds a Replicate predictionId (submitted → owned by poll recovery). */
    hasPrediction: boolean;
    /** job.error indicates a Seedance moderation refusal ("[moderation] …"). */
    isModeration: boolean;
    updatedAtMs: number;
  } | null;
  /** How many video jobs already exist for this scene (attempt counter, for the retry cap). */
  attempts: number;
}

export interface ContinuationOptions {
  nowMs: number;
  /** A never-submitted (no predictionId) pending/processing job older than this is orphaned → resubmit. */
  kickStaleMs: number;
  /**
   * Max scenes to (re)submit in ONE continue invocation (mirrors GENERATE_ALL_CONCURRENCY = 1).
   * Generation is strictly sequential, so this is 1: only the earliest not-done scene is ever kicked.
   */
  concurrency: number;
  /** Hard cap on total attempts (jobs) per scene, so a broken scene never loops forever. */
  maxAttempts: number;
  /** Manual "retry unfinished": also retry moderation / cap-reached failures once more. */
  retryFailed?: boolean;
  /** Manual retry raises the per-scene attempt ceiling. */
  manualMaxAttempts?: number;
}

export interface ContinuationPlan {
  scenes: Array<{ sceneId: string; number: number; status: BatchSceneStatus; error?: boolean }>;
  /** Orphaned pending jobs to resubmit on the SAME job id (already charged — no new charge). */
  resubmit: string[];
  /** Failed-retryable scenes to charge + start a NEW job for. */
  retry: string[];
  total: number;
  done: number;
  generating: number;
  failed: number; // terminal failures (surfaced, not auto-retried)
  pending: number; // not done, not generating, not terminal-failed (work still to do)
  /** Work still to do (pending + generating). When 0 the batch is finished. */
  remaining: number;
}

/**
 * Classify every scene and pick which ones to kick this invocation.
 * `resubmit` reuses the existing (already-charged) job; `retry` needs a fresh charge + job.
 */
export function planContinuation(snaps: SceneJobSnapshot[], opts: ContinuationOptions): ContinuationPlan {
  const manualMax = opts.manualMaxAttempts ?? opts.maxAttempts + 2;
  const retryFailed = !!opts.retryFailed; // manual "retry unfinished": also (re)charge failed / never-started scenes
  const scenes: ContinuationPlan["scenes"] = [];
  const resubmitCandidates: string[] = [];
  const retryCandidates: string[] = [];
  let done = 0;
  let generating = 0;
  let inFlight = 0; // scenes with a live Replicate prediction (occupy a real generation slot)
  let failed = 0; // terminal failures (surfaced, not acted on by this mode)
  let pending = 0; // scenes this mode WILL act on (kept in `remaining`)
  // Strictly sequential generation: `snaps` is in ascending scene order and each scene must chain from
  // the previous scene's last frame, so ONLY the earliest not-done scene (whose predecessors are all
  // done) may be (re)started in a pass — never a later scene. `gateOpen` is true only up to that
  // earliest not-done scene ("the frontier"); every scene after it is gated and left for a later pass.
  let gateOpen = true;

  for (const s of snaps) {
    if (s.hasVideo) {
      done++;
      scenes.push({ sceneId: s.sceneId, number: s.number, status: "done" });
      continue;
    }
    const job = s.latestJob;
    // Genuinely submitted (live prediction) → poll recovery owns it. Never touched, counts as work,
    // regardless of order. It also occupies the sequential frontier, so it closes the gate.
    if (job && (job.status === "pending" || job.status === "processing") && job.hasPrediction) {
      generating++;
      inFlight++;
      gateOpen = false;
      scenes.push({ sceneId: s.sceneId, number: s.number, status: "generating" });
      continue;
    }
    if (!gateOpen) {
      // A not-done scene behind an unfinished predecessor: it must wait for the chain. Shown as pending
      // but excluded from `remaining` — the frontier scene alone keeps the auto-continue loop alive while
      // it is productive; if the frontier is stuck (terminal), the loop should stop, not poll forever.
      scenes.push({ sceneId: s.sceneId, number: s.number, status: "pending" });
      continue;
    }
    // === The sequential frontier: the earliest not-done scene (all predecessors done). Only this scene
    // may be kicked; after it the gate closes so no later scene starts out of order. ===
    gateOpen = false;
    if (job && (job.status === "pending" || job.status === "processing")) {
      if (opts.nowMs - job.updatedAtMs > opts.kickStaleMs) {
        // Never submitted and gone quiet → orphaned. Resubmit on the SAME (already-charged) job.
        pending++;
        resubmitCandidates.push(s.sceneId);
        scenes.push({ sceneId: s.sceneId, number: s.number, status: "pending" });
      } else {
        // Freshly queued: the background loop is about to submit this scene. Leave it, keep the loop alive.
        generating++;
        scenes.push({ sceneId: s.sceneId, number: s.number, status: "generating" });
      }
      continue;
    }
    if (job && job.status === "failed") {
      // Auto mode never re-charges a failed scene (it is refunded already): surface it, keep going.
      // Manual mode retries it (moderation included) with a fresh charge, up to a hard cap.
      if (retryFailed && s.attempts < manualMax) {
        pending++;
        retryCandidates.push(s.sceneId);
        scenes.push({ sceneId: s.sceneId, number: s.number, status: "pending" });
      } else {
        failed++;
        scenes.push({ sceneId: s.sceneId, number: s.number, status: "failed", error: true });
      }
      continue;
    }
    // No live job (never queued, canceled, or a stray completed-without-video).
    // Auto mode must NOT charge/start it (that only happens via the explicit "Генерировать"/manual retry).
    if (retryFailed && s.attempts < manualMax) {
      pending++;
      retryCandidates.push(s.sceneId);
      scenes.push({ sceneId: s.sceneId, number: s.number, status: "pending" });
    } else {
      // Idle, not part of active work: shown as pending in the UI but excluded from `remaining`
      // so the auto-continue loop can stop.
      scenes.push({ sceneId: s.sceneId, number: s.number, status: "pending" });
    }
  }

  // At most one scene is (re)started per pass (sequential): the gate yields a single frontier candidate,
  // and it is kicked only when no scene holds a live prediction slot (capacity = concurrency − in-flight).
  const capacity = Math.max(0, opts.concurrency - inFlight);
  const resubmit = resubmitCandidates.slice(0, capacity);
  const retry = retryCandidates.slice(0, Math.max(0, capacity - resubmit.length));

  return {
    scenes,
    resubmit,
    retry,
    total: snaps.length,
    done,
    generating,
    failed,
    pending,
    remaining: pending + generating,
  };
}
