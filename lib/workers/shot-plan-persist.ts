/**
 * Stage 167 — SHOT-PLAN PERSISTENCE at the APPROVAL transition.
 *
 * Moving an episode into the scene breakdown is the practical APPROVAL of its script (the same point
 * where `updateSeasonStateForApprovedEpisode` refreshes the world state — see lib/workers/scenes-job.ts).
 * At that transition we ALSO plan the episode's SHOTS (the atomic units of generation, one level below
 * the scene) and persist them as `Shot` rows, so the per-shot chain (video-job → assembly-job) has
 * something to iterate.
 *
 * The planning itself is the pure `generateShotPlan` (generate → validate → targeted-retry on
 * gpt-6-astra, max 3 attempts) from lib/shot-plan.ts; this worker only supplies the DB reads/writes and
 * the real `chatJSON` call.
 *
 * LOUD FAILURE (Stage167 fix, commit 1/3): there is NO silent legacy scene fallback anymore. If the
 * plan cannot be produced — the planner throws, `result.valid === false`, fewer than MIN_SHOTS valid
 * shots are persisted, or the episode/scenes are missing — the episode is marked
 * `status = "shot_plan_failed"` with a human-readable reason written to `Episode.chainRunNote` (rendered
 * in the episode card UI). Video generation is gated on the shot rows + status downstream
 * (generate-all/route.ts), so a failed plan can NEVER start a video run.
 *
 * IDEMPOTENT: every scene's shots are `deleteMany`-d and recreated, so re-approving an episode rebuilds
 * the shot list cleanly (no orphan rows, respects `@@unique([sceneId, index])`).
 *
 * PlannedShot.index is EPISODE-GLOBAL; `Shot.index` is 0-based WITHIN its scene — so shots are grouped
 * by scene number and RE-INDEXED per scene on persist.
 */
import { prisma } from "@/lib/db";
import { chatJSON, SCRIPT_MODEL } from "@/lib/ai";
import { generateShotPlan, type ShotPlanScene, type ShotPlanCallJSON } from "@/lib/shot-plan";
import type { PlannedShot } from "@/lib/prompts/shot-plan";

/** ТЗ: an episode needs 15–30 shots; the acceptance floor for a usable plan is 15. */
export const MIN_SHOTS = 15;

/** Coerce a Scene.escalationBeats Json value into a clean string[] (defensive: legacy rows are null). */
function toEscalationBeats(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
}

/**
 * Mark the episode as a LOUD shot-plan failure: set `status = "shot_plan_failed"` and write the reason to
 * `chainRunNote` (a UI-visible field). Best-effort — a failed status write is logged, never rethrown.
 */
async function markShotPlanFailed(episodeId: string, reason: string): Promise<void> {
  try {
    await prisma.episode.update({
      where: { id: episodeId },
      data: { status: "shot_plan_failed", chainRunActive: false, chainRunNote: `Shot planning failed: ${reason}` },
    });
  } catch (err: any) {
    console.error(`[shot-plan] failed to mark episode ${episodeId} as shot_plan_failed:`, err?.message ?? err);
  }
}

/** The default JSON caller — the real `chatJSON` against gpt-6-astra. Overridable for tests via `chatJSONFn`. */
const defaultChatJSONFn: ShotPlanCallJSON = (system, user, opts) =>
  chatJSON<unknown>(system, user, { model: opts?.model ?? SCRIPT_MODEL, maxTokens: opts?.maxTokens ?? 16000 });

/**
 * Plan and persist the SHOT rows for an approved episode. Idempotent. On ANY failure (planner throws,
 * `valid === false`, `< MIN_SHOTS` persisted, missing episode/scenes) the episode is marked
 * `shot_plan_failed` with a UI-visible note and `ok` is false — video generation never starts.
 *
 * `chatJSONFn` is optional and defaults to the real `chatJSON`; the acceptance script injects a broken
 * caller to prove the loud-failure path without any paid generation and without a test branch in prod.
 */
export async function persistShotPlanForApprovedEpisode(
  episodeId: string,
  chatJSONFn: ShotPlanCallJSON = defaultChatJSONFn,
): Promise<{ ok: boolean; persisted: number; valid: boolean; attempts: number }> {
  const episode = await prisma.episode.findUnique({
    where: { id: episodeId },
    include: { scenes: { orderBy: { number: "asc" } } },
  });
  if (!episode || episode.scenes.length === 0) {
    await markShotPlanFailed(episodeId, "no approved episode/scenes to plan shots from");
    return { ok: false, persisted: 0, valid: false, attempts: 0 };
  }

  // Build the planner input from the approved scenes (only the fields the shot-plan prompt reads).
  const planScenes: ShotPlanScene[] = episode.scenes.map((s) => ({
    number: s.number,
    action: s.action ?? null,
    dialogue: s.dialogue ?? null,
    keyProp: s.keyProp ?? null,
    escalationBeats: toEscalationBeats(s.escalationBeats),
  }));

  // Stage 3 (seasonMap) cliffhangerType is read DEFENSIVELY — not built yet, so the default
  // expectationFlip is used. When the season map lands, resolve the per-episode cell type here.
  const cliffhangerType: string | null = null;

  let result: Awaited<ReturnType<typeof generateShotPlan>>;
  try {
    result = await generateShotPlan(
      planScenes,
      { cliffhangerType, model: SCRIPT_MODEL, maxTokens: 16000 },
      chatJSONFn,
    );
  } catch (err: any) {
    await markShotPlanFailed(episodeId, `planner error — ${err?.message ?? String(err)}`);
    return { ok: false, persisted: 0, valid: false, attempts: 0 };
  }

  if (!result.valid || !result.shots.length) {
    const firstError = result.errors?.[0]?.message ?? "no valid shots produced";
    await markShotPlanFailed(
      episodeId,
      `planner returned an invalid plan after ${result.attempts} attempt(s) — ${firstError}`,
    );
    return { ok: false, persisted: 0, valid: result.valid, attempts: result.attempts };
  }

  // Map scene number → scene id so global-index shots can be grouped and re-indexed per scene.
  const sceneIdByNumber = new Map<number, string>();
  for (const s of episode.scenes) sceneIdByNumber.set(s.number, s.id);

  // Group the planned shots by their scene, preserving the global order.
  const byScene = new Map<string, PlannedShot[]>();
  for (const shot of result.shots) {
    const sceneId = sceneIdByNumber.get(shot.sceneNumber) ?? episode.scenes[0]?.id;
    if (!sceneId) continue;
    const list = byScene.get(sceneId) ?? [];
    list.push(shot);
    byScene.set(sceneId, list);
  }

  let persisted = 0;
  // Idempotent per scene: wipe + recreate this scene's shots (respects @@unique([sceneId, index])).
  for (const [sceneId, shots] of byScene) {
    await prisma.$transaction(async (tx) => {
      await tx.shot.deleteMany({ where: { sceneId } });
      // RE-INDEX per scene: PlannedShot.index is episode-global; Shot.index is 0-based within the scene.
      await tx.shot.createMany({
        data: shots.map((shot, i) => ({
          sceneId,
          index: i,
          shotType: shot.shotType,
          size: shot.size,
          duration: shot.duration,
          speakerId: shot.speakerId ?? null,
          line: shot.line ?? null,
          reactionOfId: shot.reactionOfId ?? null,
          escalationBeat: typeof shot.escalationBeat === "string" ? shot.escalationBeat : String(shot.escalationBeat ?? ""),
          postFx: shot.postFx,
          matchCutIn: shot.matchCutIn || null,
          matchCutOut: shot.matchCutOut || null,
          promptVersion: result.version,
          status: "pending",
        })),
      });
    });
    persisted += shots.length;
  }

  // Enforce the ТЗ floor: fewer than MIN_SHOTS usable shots is a failure, not a thin-but-valid plan.
  if (persisted < MIN_SHOTS) {
    await markShotPlanFailed(episodeId, `only ${persisted} shots persisted (minimum ${MIN_SHOTS} required)`);
    return { ok: false, persisted, valid: result.valid, attempts: result.attempts };
  }

  return { ok: true, persisted, valid: result.valid, attempts: result.attempts };
}
