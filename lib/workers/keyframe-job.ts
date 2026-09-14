/**
 * Stage 104 — KEYFRAME job worker (GenerationJob.type = "scene-keyframe").
 *
 * Generates the opening still of a scene with Seedream (edit) on WaveSpeed, stores it in S3 and writes
 * Scene.keyframeUrl / keyframePrompt / keyframeStatus / keyframeError. `ensureKeyframe` is the synchronous
 * entry the video worker uses (returns the existing done keyframe or generates one, creating its own job row).
 * A keyframe (re)generation NEVER touches the scene's video / last frame.
 */
import { prisma } from "@/lib/db";
import { getBucketConfig } from "@/lib/aws-config";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { wavespeedSubmit, wavespeedWait } from "@/lib/wavespeed";
import { completeJob, failJob, heartbeatJob, isCancelRequested, updateJob } from "@/lib/jobs";
import { safeProviderError } from "@/lib/generation-diagnostics";
import { KEYFRAME_JOB_TYPE, KEYFRAME_MODEL, buildKeyframeRequest, type KeyframeBuildInput } from "@/lib/keyframe";

export interface KeyframeJobParams {
  jobId: string;
  sceneId: string;
}

const KEYFRAME_TIMEOUT_MS = 240_000;

/**
 * Load everything the pure builder needs: the scene, its cast, the episode location and the continuity image
 * (scene N-1's keyframe; for scene 1 of episode E>1 the last frame — else the keyframe — of the last scene of
 * episode E-1; nothing for scene 1 of episode 1).
 */
export async function loadKeyframeInput(sceneId: string): Promise<{ input: KeyframeBuildInput; projectId: string; episodeId: string }> {
  const scene = await prisma.scene.findUnique({
    where: { id: sceneId },
    include: {
      characters: { include: { character: true } },
      episode: { select: {
        id: true, number: true, seasonId: true,
        location: { select: { id: true, name: true, imageUrl: true, imageReverse: true, imageDetail: true, imageExtra: true } },
        season: { select: { projectId: true } },
      } },
    },
  });
  if (!scene) throw new Error("Scene not found");
  if (!scene.videoPrompt) throw new Error("Scene has no video prompt");

  let continuityImageUrl: string | null = null;
  if (scene.number > 1) {
    const prev = await prisma.scene.findFirst({ where: { episodeId: scene.episodeId, number: scene.number - 1 }, select: { keyframeUrl: true, keyframeStatus: true } });
    continuityImageUrl = prev?.keyframeStatus === "done" && prev.keyframeUrl ? prev.keyframeUrl : null;
  } else if (scene.episode.number > 1) {
    const prevEpisode = await prisma.episode.findFirst({ where: { seasonId: scene.episode.seasonId, number: scene.episode.number - 1 }, select: { id: true } });
    if (prevEpisode) {
      const last = await prisma.scene.findFirst({ where: { episodeId: prevEpisode.id }, orderBy: { number: "desc" }, select: { lastFrameUrl: true, keyframeUrl: true, keyframeStatus: true } });
      continuityImageUrl = last?.lastFrameUrl || (last?.keyframeStatus === "done" ? last.keyframeUrl : null) || null;
    }
  }

  const input: KeyframeBuildInput = {
    scene: {
      id: scene.id, number: scene.number, videoPrompt: scene.videoPrompt, promptOverride: scene.promptOverride,
      startState: scene.startState, continuesFrom: scene.continuesFrom, locationDesc: scene.locationDesc,
    },
    characters: scene.characters.map(l => ({
      characterId: l.characterId, name: l.character.name, tier: l.character.tier, imageFront: l.character.imageFront,
      imageProfile: l.character.imageProfile, imageFull: l.character.imageFull, imageExtra: l.character.imageExtra,
      appearance: l.character.appearance, age: l.character.age,
    })),
    location: scene.episode.location ?? null,
    continuityImageUrl,
  };
  return { input, projectId: scene.episode.season.projectId, episodeId: scene.episode.id };
}

/** Run one keyframe job to completion. Resolves with the stored S3 URL; rejects (after recording the error) on failure. */
export async function runKeyframeJob(params: KeyframeJobParams): Promise<string> {
  const { jobId, sceneId } = params;
  try {
    await updateJob(jobId, { status: "processing", progress: 5, message: "Building the keyframe prompt..." });
    await prisma.scene.update({ where: { id: sceneId }, data: { keyframeStatus: "running", keyframeError: null } });
    const { input, projectId, episodeId } = await loadKeyframeInput(sceneId);
    const request = buildKeyframeRequest(input);
    await prisma.scene.update({ where: { id: sceneId }, data: { keyframePrompt: request.prompt } });
    console.log("[keyframe-job] submit", JSON.stringify({ jobId, sceneId, sceneNumber: input.scene.number, images: request.refs.map(r => r.kind), camera: request.camera }));

    await updateJob(jobId, { progress: 15, message: "Rendering the keyframe (Seedream)..." });
    const taskId = await wavespeedSubmit(KEYFRAME_MODEL, request.body, "Seedream keyframe");
    const url = await wavespeedWait(taskId, {
      timeoutMs: KEYFRAME_TIMEOUT_MS,
      label: "Seedream keyframe",
      shouldCancel: async () => { await heartbeatJob(jobId); return isCancelRequested(jobId); },
    });

    await updateJob(jobId, { progress: 85, message: "Storing the keyframe..." });
    const { folderPrefix } = getBucketConfig();
    const key = `${folderPrefix}public/keyframes/${projectId}/${episodeId}/${sceneId}-${jobId}.jpg`;
    const stored = await uploadRemoteToS3(url, key, "image/jpeg");
    await prisma.scene.update({ where: { id: sceneId }, data: { keyframeUrl: stored, keyframeStatus: "done", keyframeError: null } });
    await completeJob(jobId, { keyframeUrl: stored, prompt: request.prompt, images: request.refs }, "Keyframe ready");
    return stored;
  } catch (err) {
    const message = safeProviderError(err);
    console.error("[keyframe-job] failed:", { jobId, sceneId, error: message });
    await prisma.scene.update({ where: { id: sceneId }, data: { keyframeStatus: "error", keyframeError: message } }).catch(() => {});
    await failJob(jobId, message);
    throw err;
  }
}

/**
 * Return the scene's done keyframe, or generate one now (synchronously, with its own job row so the UI can
 * show progress). `force` regenerates even when a done keyframe exists.
 */
export async function ensureKeyframe(sceneId: string, opts: { force?: boolean } = {}): Promise<string> {
  const scene = await prisma.scene.findUnique({
    where: { id: sceneId },
    select: { id: true, keyframeUrl: true, keyframeStatus: true, episode: { select: { season: { select: { projectId: true } } } } },
  });
  if (!scene) throw new Error("Scene not found");
  if (!opts.force && scene.keyframeStatus === "done" && scene.keyframeUrl) return scene.keyframeUrl;
  const job = await prisma.generationJob.create({
    data: { type: KEYFRAME_JOB_TYPE, status: "processing", progress: 0, message: "Keyframe queued", projectId: scene.episode.season.projectId, sceneId },
  });
  return runKeyframeJob({ jobId: job.id, sceneId });
}
