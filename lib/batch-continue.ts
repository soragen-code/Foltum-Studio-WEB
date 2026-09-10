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
   * Max scenes with a live prediction slot at once (mirrors GENERATE_ALL_CONCURRENCY). Stage 39: scenes
   * are independent and generate in parallel, so callers pass Infinity (no cap) — every kickable scene
   * is (re)started in the same pass, in ascending scene order.
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
  // Stage 39: no sequential gate — a not-done scene is kickable regardless of the state of its
  // predecessors (scenes no longer chain from each other's last frame).

  for (const s of snaps) {
    if (s.hasVideo) {
      done++;
      scenes.push({ sceneId: s.sceneId, number: s.number, status: "done" });
      continue;
    }
    const job = s.latestJob;
    // Genuinely submitted (live prediction) → poll recovery owns it. Never touched, counts as work.
    if (job && (job.status === "pending" || job.status === "processing") && job.hasPrediction) {
      generating++;
      inFlight++;
      scenes.push({ sceneId: s.sceneId, number: s.number, status: "generating" });
      continue;
    }
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

  // Capacity = concurrency − in-flight. With concurrency = Infinity (Stage 39 default) every candidate is
  // kicked in this pass; already-paid resubmits go before fresh-charge retries.
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
