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
 * the real `chatJSON` call. Fully non-blocking + idempotent:
 *   - IDEMPOTENT: every scene's shots are `deleteMany`-d and recreated, so re-approving an episode
 *     rebuilds the shot list cleanly (no orphan rows, respects `@@unique([sceneId, index])`).
 *   - NON-BLOCKING: the caller wraps this in try/catch; any failure degrades to "no shots" and the
 *     episode still plays through the legacy scene pipeline (video-job's scene fallback).
 *
 * PlannedShot.index is EPISODE-GLOBAL; `Shot.index` is 0-based WITHIN its scene — so shots are grouped
 * by scene number and RE-INDEXED per scene on persist.
 */
import { prisma } from "@/lib/db";
import { chatJSON, SCRIPT_MODEL } from "@/lib/ai";
import { generateShotPlan, type ShotPlanScene } from "@/lib/shot-plan";
import type { PlannedShot } from "@/lib/prompts/shot-plan";

/** Coerce a Scene.escalationBeats Json value into a clean string[] (defensive: legacy rows are null). */
function toEscalationBeats(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
}

/**
 * Plan and persist the SHOT rows for an approved episode. Idempotent + non-blocking (never throws to a
 * caller that swallows it). Returns a small summary for logging; on any early-out it returns
 * `{ persisted: 0 }` and leaves the episode on the legacy scene path.
 */
export async function persistShotPlanForApprovedEpisode(
  episodeId: string
): Promise<{ persisted: number; valid: boolean; attempts: number }> {
  const episode = await prisma.episode.findUnique({
    where: { id: episodeId },
    include: { scenes: { orderBy: { number: "asc" } } },
  });
  if (!episode || episode.scenes.length === 0) return { persisted: 0, valid: false, attempts: 0 };

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

  const result = await generateShotPlan(
    planScenes,
    { cliffhangerType, model: SCRIPT_MODEL, maxTokens: 16000 },
    (system, user, opts) => chatJSON<unknown>(system, user, { model: opts?.model ?? SCRIPT_MODEL, maxTokens: opts?.maxTokens ?? 16000 }),
  );
  if (!result.shots.length) return { persisted: 0, valid: result.valid, attempts: result.attempts };

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
  return { persisted, valid: result.valid, attempts: result.attempts };
}
