/** Stage 112: actual video end-frame -> camera-only edit. No scene-still generation. */
import { createHash } from 'node:crypto';
import { extractScriptedCamera, extractPreviousCamera, openingAngleForScene } from './prompt-seam';
import { buildWaveSpeedImageRequest, WAVESPEED_IMAGE_MAX_REFS } from './providers/image-provider';
import type { SceneReference } from './scene-prompt';

export interface Predecessor {
  id: string; number: number; videoUrl: string | null; lastFrameUrl: string | null;
  status: string; locationDesc?: string | null; endState?: string | null; endStateActual?: string | null;
}
/** Shared by worker, preview and ingress. Missing expected predecessor is NOT the series opening. */
export async function resolveVideoPredecessor(db: any, scene: { episodeId: string; number: number }): Promise<Predecessor | null> {
  let previous;
  if (scene.number > 1) {
    previous = await db.scene.findFirst({ where: { episodeId: scene.episodeId, number: scene.number - 1 } });
  } else {
    const ep = await db.episode.findUnique({ where: { id: scene.episodeId }, select: { number: true, seasonId: true } });
    if (!ep) throw new Error('Episode not found');
    if (ep.number === 1) return null;
    const prevEp = await db.episode.findFirst({ where: { seasonId: ep.seasonId, number: ep.number - 1 }, select: { id: true } });
    if (prevEp) previous = await db.scene.findFirst({ where: { episodeId: prevEp.id }, orderBy: { number: 'desc' } });
  }
  if (!previous) throw new Error('Previous scene is missing. Finish the previous episode script and video first.');
  return previous;
}
export function assertPredecessorReady(previous: Predecessor | null) {
  if (!previous) return;
  if (previous.status !== 'generated' || !previous.videoUrl)
    throw new Error('Finish the previous scene video before generating this scene.');
  if (!previous.lastFrameUrl)
    throw new Error('The previous video has no extracted last frame. Regenerate the previous video to recover its last frame, then retry this scene.');
}
export interface ReangleInput {
  sceneId: string; number: number; startState?: string | null; videoPrompt?: string | null; promptOverride?: string | null;
  previous: Predecessor; refs: SceneReference[]; castState?: unknown;
}
export function buildReangleRequest(input: ReangleInput) {
  assertPredecessorReady(input.previous);
  const camera = extractScriptedCamera(input.promptOverride) || extractScriptedCamera(input.startState)
    || extractScriptedCamera(input.videoPrompt)
    || /\[SHOT TYPE\]:\s*([^\n]+)/i.exec(input.promptOverride || input.videoPrompt || '')?.[1]?.trim()
    || openingAngleForScene(input.number);
  // Only the selected next-shot camera is used. No scripted world/action may replace the photographed instant.
  const supporting = input.refs.filter(r => ['character', 'crowd', 'location'].includes(r.kind));
  if (supporting.length + 1 > WAVESPEED_IMAGE_MAX_REFS)
    throw new Error('Camera re-angle needs more reference images than Seedream supports. Reduce the scene cast before retrying.');
  const refs = [{ url: input.previous.lastFrameUrl!, kind: 'state_source', note: 'Actual final frame of the completed previous video; authoritative world state.' }, ...supporting];
  const prompt = [
    'CAMERA-ONLY EDIT of Image1. Reconstruct the EXACT SAME INSTANT in 3D from a genuinely different camera. Move ONLY THE CAMERA, never the world or people. No time passes.',
    `NEXT SCENE CAMERA: ${camera}. Make the angle clearly different from Image1 (opposite side or at least 60 degrees around the subjects), with a distinct height or shot scale. If the requested camera duplicates Image1, move to the opposite side while retaining its requested lens/scale.`,
    `SOURCE CAMERA (do not reproduce): ${extractPreviousCamera(input.previous.endStateActual) || 'infer the camera from Image1'}.`,
    'Preserve world-space positions and distances of every person and object, poses and motion phase, gaze targets, occupied/empty hands, held items, faces, anatomy, hair, clothing, materials, geometry, doors, windows, lighting direction and shadows in world space. Project that unchanged world from the new camera; screen positions naturally change. Reveal previously occluded surfaces using the identity and wide/layout references. Never mirror, flip, crop, zoom the source as a substitute for a new viewpoint. Do not add/remove people or objects or pose them toward the camera. Image1 overrides any differing pose, wardrobe, light or arrangement in supporting reference plates.',
    ...refs.map((r, i) => `Image${i + 1}: ${r.note}`),
    'Photorealistic single vertical film frame, no captions, labels or montage.',
  ].join('\n');
  const request = buildWaveSpeedImageRequest({ prompt, aspect_ratio: '9:16', image_input: refs.map(r => r.url) });
  const hash = createHash('sha256').update(JSON.stringify({ version: 112, sceneId: input.sceneId,
    previousId: input.previous.id, video: input.previous.videoUrl, frame: input.previous.lastFrameUrl,
    state: input.previous.endStateActual, camera, startState: input.startState, promptOverride: input.promptOverride, videoPrompt: input.videoPrompt, castState: input.castState, request, refs })).digest('hex');
  return { ...request, hash, camera, refs, cacheId: `reangle-${hash}` };
}
export type ReangleRequest = ReturnType<typeof buildReangleRequest>;
export interface ReangleCache { phase: 'claimed' | 'submitted' | 'ready' | 'failed'; predictionId?: string; url?: string; error?: string }
export interface ReangleStore {
  read(): Promise<ReangleCache | null>;
  claim(failed?: ReangleCache): Promise<boolean>;
  save(value: ReangleCache): Promise<void>;
}
export class TerminalReangleError extends Error {}
/** Persist-before-poll. An ambiguous submission is never blindly repeated (even after a job retry). */
export async function obtainReangle(request: ReangleRequest, store: ReangleStore, io: {
  submit(): Promise<string>; wait(id: string): Promise<string>; upload(url: string): Promise<string>;
}): Promise<{ url: string; cacheHit: boolean }> {
  const validateOutput = (url?: string): string => {
    if (!url || url === request.refs[0].url || !/^https?:\/\//.test(url))
      throw new Error('Camera edit returned an invalid or source frame. Check the image task before retrying.');
    return url;
  };
  let state = await store.read();
  if (state?.phase === 'ready' && state.url) return { url: validateOutput(state.url), cacheHit: true };
  if (!state || state.phase === 'failed') {
    if (!await store.claim(state ?? undefined)) state = await store.read();
    else {
      // If submit or checkpoint throws, leave 'claimed': service may already have accepted a paid task.
      const predictionId = await io.submit();
      state = { phase: 'submitted', predictionId };
      await store.save(state);
    }
  }
  if (state?.phase === 'failed') throw new Error(state.error || 'Camera re-angle failed. Check the image provider task before retrying.');
  if (state?.phase === 'ready' && state.url) return { url: validateOutput(state.url), cacheHit: true };
  if (!state?.predictionId) throw new Error('Camera re-angle is already preparing or its submission needs recovery. Wait for the active job; if it stopped, contact support to recover the image task. No replacement was submitted.');
  let output: string;
  try { output = await io.wait(state.predictionId); }
  catch (error) {
    // Only a CONFIRMED terminal provider failure allows a later user retry to submit a replacement.
    if (error instanceof TerminalReangleError) await store.save({ phase: 'failed', predictionId: state.predictionId, error: error.message });
    throw error;
  } // network/timeout keeps the ID: a retry inspects the SAME task
  validateOutput(output);
  const url = validateOutput(await io.upload(output));
  await store.save({ ...state, phase: 'ready', url });
  return { url, cacheHit: false };
}
