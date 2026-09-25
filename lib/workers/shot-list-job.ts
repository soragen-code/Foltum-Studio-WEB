/**
 * SIMPLIFIED PIPELINE — step 5: SHOT LIST (5 scenes × 5 beats) from the plain-text episode screenplay.
 *
 * One streaming Claude Opus 5 call (`streamChatJSON`, live preview in `streamedText`) returns
 * `{ scenes: [{ title, location, characters[], beats: [{ shot, action, cut } × 5] } × 5] }`. The result is
 * normalized tolerantly (4–6 scenes/beats → trim/pad; anything else → ONE retry with the problem note) and
 * persisted as 25 Scene rows — ONE ROW PER BEAT (number 1..25, durationSec 5, beatMeta = the beat) — so the
 * existing per-scene video / start-frame / chain / assembly infrastructure works unchanged.
 *
 * Job type: "shot_list" (GenerationJob.resultData = { episodeId, scenes? }).
 */
import { prisma } from "@/lib/db";
import { streamChatJSON, EPISODE_SCRIPT_MODEL } from "@/lib/ai";
import { completeJob, failJob, heartbeatJob, updateJob } from "@/lib/jobs";
import { makeJobStreamWriter, stripJsonForPreview } from "@/lib/stream-progress";
import { matchCharacter } from "@/lib/season";
import {
  SHOT_LIST_JOB_TYPE,
  SHOT_LIST_MAX_TOKENS,
  BEAT_CLIP_SECONDS,
  shotListSystemPrompt,
  shotListUserPrompt,
  normalizeShotList,
  beatsFromShotList,
  beatTitle,
  buildBeatVideoPrompt,
  type ShotList,
} from "@/lib/simple-pipeline";

export { SHOT_LIST_JOB_TYPE };

const HEARTBEAT_MS = 20_000;

async function withHeartbeat<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => { void heartbeatJob(jobId); }, HEARTBEAT_MS);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

export async function runShotListJob(jobId: string, projectId: string, episodeId: string): Promise<void> {
  try {
    const episode = await prisma.episode.findFirst({
      where: { id: episodeId, season: { projectId } },
      select: { id: true, number: true, title: true, script: true, locationName: true, locationDesc: true, season: { select: { project: { select: { characters: { select: { id: true, name: true } } } } } } },
    });
    if (!episode) throw new Error("Episode not found");
    const scriptText = (episode.script ?? "").trim();
    if (!scriptText) throw new Error("The episode has no script yet — write the script first.");
    const characters = episode.season.project.characters;
    const characterNames = characters.map((c) => c.name);

    await updateJob(jobId, { status: "processing", progress: 5, message: "Building the shot list (5 scenes × 5 beats)…", streamedText: null });

    let shotList: ShotList | null = null;
    let problem = "";
    for (let attempt = 1; attempt <= 2 && !shotList; attempt++) {
      const retryNote = attempt > 1 && problem ? `\n\nYour previous answer was rejected: ${problem}. Return EXACTLY 5 scenes with EXACTLY 5 beats each.` : "";
      const raw = await withHeartbeat(jobId, () => streamChatJSON<unknown>(
        shotListSystemPrompt(),
        shotListUserPrompt({ scriptText, episodeTitle: episode.title, episodeNumber: episode.number, characterNames, locationName: episode.locationName }) + retryNote,
        { model: EPISODE_SCRIPT_MODEL, maxTokens: SHOT_LIST_MAX_TOKENS, temperature: 0.5, timeoutMs: 600_000, onDelta: makeJobStreamWriter(jobId, { transform: stripJsonForPreview }) },
      ));
      const res = normalizeShotList(raw);
      if (res.ok) { shotList = res.shotList; break; }
      problem = res.problem;
      console.warn(`[shot-list] attempt ${attempt}/2 rejected: ${problem}`);
      if (attempt < 2) await updateJob(jobId, { progress: 40, message: "Shot list was incomplete — retrying…" });
    }
    if (!shotList) throw new Error(`The shot list could not be built (${problem || "invalid model output"}). Try again.`);

    const beats = beatsFromShotList(shotList);
    await updateJob(jobId, { progress: 80, message: `Saving ${beats.length} beats…` });

    await prisma.$transaction(async (tx) => {
      await tx.scene.deleteMany({ where: { episodeId } });
      for (let i = 0; i < beats.length; i++) {
        const meta = beats[i];
        const linked = meta.characters.map((n) => matchCharacter(characters, n)).filter((c): c is { id: string; name: string } => Boolean(c));
        const uniq = Array.from(new Map(linked.map((c) => [c.id, c])).values());
        await tx.scene.create({
          data: {
            episodeId,
            number: i + 1,
            title: beatTitle(meta),
            action: meta.action,
            shotType: meta.shot,
            durationSec: BEAT_CLIP_SECONDS,
            locationDesc: meta.location,
            videoPrompt: buildBeatVideoPrompt({ beat: meta, characterNames: uniq.length ? uniq.map((c) => c.name) : meta.characters, hasStartFrame: false }),
            status: "pending",
            language: "en",
            dialogue: null,
            beatMeta: meta as unknown as object,
            characters: uniq.length ? { create: uniq.map((c) => ({ characterId: c.id })) } : undefined,
          },
        });
      }
      // Episode location text (used by the master plate) — set from scene 1 of the shot list when empty.
      const first = shotList!.scenes[0];
      const data: { locationName?: string; locationDesc?: string; videoUrl: null; gridUrl: null; gridApproved: boolean } = { videoUrl: null, gridUrl: null, gridApproved: false };
      if (!episode.locationName?.trim() && first?.location) data.locationName = first.location.slice(0, 120);
      if (!episode.locationDesc?.trim() && first?.location) data.locationDesc = first.location;
      await tx.episode.update({ where: { id: episodeId }, data });
    }, { timeout: 60_000 });

    await completeJob(jobId, { episodeId, scenes: beats.length }, `Shot list ready: ${shotList.scenes.length} scenes × ${beats.length / shotList.scenes.length} beats`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[shot-list] job ${jobId} failed:`, msg);
    await failJob(jobId, msg);
  }
}
