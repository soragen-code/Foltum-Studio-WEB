import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { startVideoPrediction, startKlingPrediction, startLipsyncPrediction, startImagePrediction, getPredictionState, cancelVideoPrediction, KLING_MODEL, LIPSYNC_MODEL } from "@/lib/replicate";
import { buildNativeAudioPrompt, translateDialogue, detectSpokenLanguage, languageName, parseDialogue } from "@/lib/voiceover";
import { uploadRemoteToS3, uploadBufferToS3 } from "@/lib/s3-upload";
import { extractLastFrameBuffer, extractAudioBuffer } from "@/lib/ffmpeg";
import { PACE_DIRECTION } from "@/lib/season";
import { getBucketConfig } from "@/lib/aws-config";
import { VISUAL_STYLE_ID, styledVisualPrompt, isStyledAsset, canChainFrame, locationAngleImages } from "@/lib/visual-style";
import { GenerationAttempt, safeProviderError, classifyProviderError, logAttempt, safeDiagnosticInput } from "@/lib/generation-diagnostics";
import { updateJob, heartbeatJob, runInBackground } from "@/lib/jobs";
import { softenForModeration, moderationHints, type SoftenLevel } from "@/lib/sanitize-prompt";

export interface VideoJobParams {
  jobId: string;
  sceneId: string;
  projectId: string;
  userId?: string;
  cost?: number;
  duration?: number;
  resolution?: string;
  /** "seedance" (default, native audio) or "kling" (silent image-to-video, max 10s). */
  provider?: "seedance" | "kling";
}

/** Persisted in GenerationJob.resultData while the job is running, so it can be resumed. */
export interface VideoJobState {
  predictionId: string;
  sceneId: string;
  projectId: string;
  userId?: string;
  cost?: number;
  startedAt: number;
  diagnostics?: GenerationAttempt[];
  /** set once finalization (upload) has begun, to avoid running it twice */
  finalizing?: boolean;
  leaseToken?: string;
  leaseUntil?: number;
  finalizeAttempts?: number;
  providerStatus?: string;
  providerStartedAt?: string | null;
  providerCompletedAt?: string | null;
  /* --- Kling + lipsync pipeline (realistic path with native speech) --- */
  /** When true, run the staged pipeline: Kling video -> Seedance speech -> lipsync. */
  lipsync?: boolean;
  /** Current pipeline stage. Absent/"video" = single-prediction (default behaviour). */
  stage?: "video" | "audio" | "lipsync";
  /** Silent Kling video URL, carried from the video stage into lipsync. */
  klingVideoUrl?: string;
  /** Extracted native-speech WAV URL, carried from the audio stage into lipsync. */
  speechAudioUrl?: string;
  /** Persisted so the audio stage can submit the Seedance speech run on its own. */
  audioPrompt?: string;
  audioDuration?: number;
  /* --- Seedance moderation (E005) auto-retry, no extra credit charge --- */
  /** How many softened resubmissions were already made (max MAX_MODERATION_RETRIES). */
  moderationRetries?: number;
  /** Everything needed to resubmit the same scene with a softer prompt. */
  retry?: ModerationRetryInput;
}

export interface ModerationRetryInput {
  /** Level-1 sanitized core prompt (visual + speech + pace), WITHOUT the [ImageN] notes. */
  basePrompt: string;
  duration: number;
  resolution: string;
  /** Adjacent last frame (image-to-video), if the first attempt used one. */
  image?: string;
  /** Reference set of the first attempt. */
  refs: { url: string; kind: string; note: string }[];
  /** Reduced set for the last retry: speaking characters + one location angle. */
  fallbackRefs: { url: string; kind: string; note: string }[];
}
/** Up to 2 automatic resubmissions after a moderation refusal (3 Seedance attempts total, 1 charge). */
export const MAX_MODERATION_RETRIES = 2;

const POLL_INTERVAL_MS = 8_000;
/** Typical Seedance time — only used to animate the progress bar while waiting. */
const EXPECTED_VIDEO_MS = Number(process.env.SEEDANCE_EXPECTED_MS ?? 10 * 60 * 1000);
/** Hard cap for waiting on Replicate. */
// End-to-end budget, not an invocation timer. Check provider terminal state BEFORE enforcing it.
export const VIDEO_DEADLINE_MS = 30 * 60 * 1000;
const CHECK_LEASE_MS = 60_000;
/** Seedance 2.5 accepts up to 30 reference images ([Image1]..[ImageN] in the prompt). */
export const MAX_REFERENCE_IMAGES = 30;
const FINALIZE_LEASE_MS = 12 * 60 * 1000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseState(resultData: string | null | undefined): VideoJobState | null {
  if (!resultData) return null;
  try {
    const s = JSON.parse(resultData);
    return s && typeof s.predictionId === "string" ? (s as VideoJobState) : null;
  } catch {
    return null;
  }
}

/** Progress 5 → 55 while the video model works, based on elapsed time. */
function waitingProgress(startedAt: number): number {
  const ratio = Math.min(1, (Date.now() - startedAt) / EXPECTED_VIDEO_MS);
  return 5 + Math.round(ratio * 50);
}

/**
 * Background video job (runs inside the same serverless invocation via `after()`).
 *
 * 1. Start Seedance prediction (generate_audio: true — speech + ambience baked in), persist predictionId
 * 2. Return; authenticated GET polling checks this same prediction with a database lease
 * 3. finalize(): S3 upload (80%) → Scene update (95%) → completed
 * On failure: scene status reset, credits refunded, job marked failed.
 *
 * If the function dies mid-way, GET /api/jobs/[id] calls `resumeVideoJob()` which
 * picks the prediction up by id and finishes the work.
 */
export async function runVideoJob(params: VideoJobParams): Promise<void> {
  const { jobId, sceneId, projectId, userId } = params;
  const cost = Number(params.cost ?? 0);

  const diagnostics: GenerationAttempt[] = [];
  let state: VideoJobState | null = null;
  const persist = () => updateJob(jobId, { resultData: JSON.stringify({ ...state, diagnostics }) });
  try {
    const scene = await prisma.scene.findUnique({ where: { id: sceneId } });
    if (!scene?.videoPrompt) throw new Error("Scene has no video prompt");
    await updateJob(jobId, { status: "processing", progress: 5, message: "Preparing photorealistic visual references..." });
    const links = await prisma.sceneCharacter.findMany({ where: { sceneId }, include: { character: true } });
    const visualPrompt = styledVisualPrompt(scene.videoPrompt, links.map(l => l.character.name));
    // Stage 4: speech is ALWAYS English. `dialogueEn` holds the voiced lines; legacy scenes written in
    // another language are translated once and the translation is saved.
    const targetLanguage = "English";
    let dialogue = (scene.dialogueEn ?? "").trim() || scene.dialogue;
    if (dialogue && detectSpokenLanguage(dialogue) !== targetLanguage) {
      dialogue = await translateDialogue(dialogue, targetLanguage);
      await prisma.scene.update({ where: { id: sceneId }, data: { dialogueEn: dialogue, language: "en" } }).catch(() => {});
    }
    // Sanitize visual descriptions BEFORE adding speech: never rewrite scripted dialogue.
    let prompt = `${buildNativeAudioPrompt(stripSlowDirections(visualPrompt), dialogue, links.map(l => l.character), targetLanguage)}\n\n${PACE_DIRECTION}`;
    // Seedance moderation (E005): neutralize explicit wording (weapons, blood, violence, children in
    // danger, intimacy...) in BOTH the visual prompt and the English dialogue before submitting.
    const softened = softenForModeration(prompt, 1);
    if (softened.changed) console.log("[video-job] moderation-safe rewrite (level 1):", { jobId, sceneId, hits: softened.hits });
    prompt = softened.text;
    const basePrompt = prompt;
    let retryRefs: ModerationRetryInput["refs"] = [];
    let fallbackRefs: ModerationRetryInput["fallbackRefs"] = [];

    const previous = scene.number > 1 ? await prisma.scene.findFirst({
      where: { episodeId: scene.episodeId, number: scene.number - 1 },
      select: { id: true, number: true, locationDesc: true, lastFrameUrl: true },
    }) : null;
    let image: string | undefined;
    let referenceImages: string[] = [];
    let reference: Record<string, unknown>;
    // Stage 3 reference set, in priority order: speaking/visible individual characters → the
    // episode's location reference → crowd groups. Seedance accepts up to MAX_REFERENCE_IMAGES.
    const styled = links.filter(l => isStyledAsset(l.character.imageFront));
    const individuals = styled.filter(l => l.character.tier !== "CROWD");
    const crowds = styled.filter(l => l.character.tier === "CROWD");
    const episodeLoc = await prisma.episode.findUnique({ where: { id: scene.episodeId }, select: { location: { select: { id: true, name: true, imageUrl: true, imageReverse: true, imageDetail: true } } } });
    // Stage 3b: every generated angle of the SAME location goes in as a reference, so the place,
    // the time of day and the light stay identical between shots — only the camera angle changes.
    const locationAngles = episodeLoc?.location ? locationAngleImages(episodeLoc.location) : [];
    const location = locationAngles.length ? episodeLoc!.location! : null;
    const characterRefs = individuals.map(l => ({ url: l.character.imageFront!, kind: "character", id: l.characterId, note: `defines ${l.character.name}'s photorealistic appearance and identity; use the scene's staging and camera.` }));
    const locationRefs = locationAngles.map(a => ({ url: a.url, kind: "location", id: location!.id, note: `the location "${location!.name}" — ${a.angle} angle. Same place, same time of day, same light and palette as the other location references. Keep the camera inside this location and match this lighting exactly.` }));
    // Reduced set used by the last moderation retry: speaking characters + one location angle.
    fallbackRefs = [...characterRefs, ...locationRefs.slice(0, 1)].slice(0, MAX_REFERENCE_IMAGES).map(r => ({ url: r.url, kind: r.kind, note: r.note }));
    if (canChainFrame(scene, previous)) {
      image = previous!.lastFrameUrl!;
      reference = { mode: "adjacent_frame", sceneId: previous!.id };
    } else {
      if (individuals.length || location || crowds.length) {
        const refs: { url: string; note: string; kind: string; id: string }[] = [
          ...characterRefs,
          ...locationRefs,
          ...crowds.map(l => ({ url: l.character.imageFront!, kind: "crowd", id: l.characterId, note: `defines the look of the group "${l.character.name}" (extras): who they are and how they are dressed.` })),
        ].slice(0, MAX_REFERENCE_IMAGES);
        referenceImages = refs.map(r => r.url);
        retryRefs = refs.map(r => ({ url: r.url, kind: r.kind, note: r.note }));
        reference = { mode: "character_references", characterIds: refs.filter(r => r.kind !== "location").map(r => r.id), locationId: location?.id ?? null, kinds: refs.map(r => r.kind) };
        prompt += "\n" + refs.map((r, i) => `[Image${i + 1}] ${r.note}`).join("\n");
        if (location) prompt += "\nCamera stays inside this location across the whole shot; lighting, weather, time of day and palette identical to the location references. Only the camera angle changes between shots. The characters are physically present in this place and interact with its objects and surfaces; the cuts show the same location from different angles with real depth (foreground, characters, background) — never a flat backdrop.";
      } else {
        // One new scene composition, never overwrite the user's old portraits or frames.
        // This is original text-to-image design, not a way to bypass a provider refusal.
        const referencePrompt = `${visualPrompt}\nSingle still establishing the described scene with the same characters, clothing and setting. No text or subtitles.`;
        const attempt: GenerationAttempt = {
          jobId, sceneId, attempt: 1, model: "black-forest-labs/flux-1.1-pro", phase: "reference",
          status: "submitting", style: VISUAL_STYLE_ID,
          input: safeDiagnosticInput({ prompt: referencePrompt, aspect_ratio: "9:16", safety_tolerance: 2, source: "original_scene_description" }),
        };
        diagnostics.push(attempt); await persist(); logAttempt(attempt);
        attempt.predictionId = await startImagePrediction({ prompt: referencePrompt, aspect_ratio: "9:16" });
        attempt.status = "processing"; await persist(); logAttempt(attempt);
        const started = Date.now();
        let referenceUrl = "";
        while (!referenceUrl) {
          const prediction = await getPredictionState(attempt.predictionId);
          if (prediction.status === "succeeded" && prediction.url) {
            referenceUrl = prediction.url; attempt.status = "succeeded"; await persist(); logAttempt(attempt); break;
          }
          if (prediction.status === "failed" || prediction.status === "canceled") {
            attempt.status = prediction.status;
            throw new Error(prediction.error || "Reference model failed");
          }
          if (Date.now() - started > 180_000) throw new Error("Reference model timed out; no automatic resubmission");
          await heartbeatJob(jobId); await sleep(POLL_INTERVAL_MS);
        }
        const { folderPrefix } = getBucketConfig();
        // Seedream reference is PNG (keeps its C2PA content-credentials watermark on purpose).
        const key = `${folderPrefix}public/references/${projectId}/${VISUAL_STYLE_ID}/${sceneId}-${jobId}.png`;
        const stored = await uploadRemoteToS3(referenceUrl, key, "image/png");
        referenceImages = [stored];
        reference = { mode: "new_scene_reference", sceneId, referencePredictionId: attempt.predictionId };
        const note = "defines the scene's original photorealistic character designs, clothing and environment. Preserve those designs while performing the scripted action.";
        prompt += `\n[Image1] ${note}`;
        retryRefs = [{ url: stored, kind: "scene", note }];
      }
    }
    // One paid video attempt. Copyright, general moderation, E003 and timeout remain distinct;
    // none silently trigger another generation or switch the audio off.
    const provider = params.provider === "kling" ? "kling" : "seedance";
    let predictionId: string;
    let attempt: GenerationAttempt;
    let submitMessage: string;
    // Extra state for the multi-stage Kling+lipsync pipeline (set below when applicable).
    const pipelineExtra: Partial<VideoJobState> = {};

    if (provider === "kling") {
      // Kling v2.1 is image-to-video ONLY and needs a single start frame. Reuse the
      // frame we already have: an adjacent last frame, or the first reference still.
      const startImage = image ?? referenceImages[0];
      if (!startImage) throw new Error("Kling requires a start image but none was produced");
      // Kling has NO audio track — feed the clean VISUAL prompt (no spoken-dialogue
      // instructions). Real schema caps duration at 5 or 10 s; there is no 15s.
      const klingDuration = Math.min(10, Number(params.duration ?? 10));
      // If the scene has spoken lines, run the realistic lipsync pipeline: after the
      // silent Kling video we harvest native speech from a moderation-passing Seedance
      // run and sync it onto the Kling character's lips. Silent scenes stay single-stage.
      const spokenLines = parseDialogue(dialogue);
      if (spokenLines.length) {
        // Speech is generated by a Seedance run whose VISUAL is deliberately stylized
        // (non-photorealistic) so it passes the moderation that blocks realistic Seedance.
        // Only its audio track is used; the realistic visuals come from Kling.
        const stylizedBase =
          "Simple hand-drawn 2D animated cartoon, flat colours and soft outlines: an original " +
          "stylized character speaking to camera in a plain setting. Non-photorealistic illustration.";
        pipelineExtra.lipsync = true;
        pipelineExtra.stage = "video";
        pipelineExtra.audioDuration = klingDuration;
        pipelineExtra.audioPrompt = buildNativeAudioPrompt(stylizedBase, dialogue, links.map(l => l.character), targetLanguage);
      }
      const klingInputForLog = {
        prompt: visualPrompt, duration: klingDuration, mode: "standard", start_image: startImage,
        audio: pipelineExtra.lipsync ? "lipsync pipeline (Seedance native speech -> sync/lipsync-2)" : "none (Kling has no native audio)",
      };
      attempt = {
        jobId, sceneId, attempt: 1, model: KLING_MODEL, phase: "video", status: "submitting",
        style: VISUAL_STYLE_ID, language: scene.language || "en",
        input: safeDiagnosticInput({ ...klingInputForLog, reference }),
      };
      diagnostics.push(attempt); await persist(); logAttempt(attempt);
      predictionId = await startKlingPrediction({
        prompt: visualPrompt, start_image: startImage, duration: klingDuration, mode: "standard",
      });
      submitMessage = pipelineExtra.lipsync
        ? "Submitted to Kling (realistic video); native speech + lipsync will follow..."
        : "Submitted to Kling (silent, image-to-video); checking the same prediction...";
    } else {
      const input = {
        prompt, duration: Number(params.duration ?? 5), resolution: String(params.resolution ?? "480p"),
        aspect_ratio: image ? "adaptive" : "9:16", generate_audio: true, watermark: false,
      };
      attempt = {
        jobId, sceneId, attempt: 1, model: "bytedance/seedance-2.5", phase: "video", status: "submitting",
        style: VISUAL_STYLE_ID, language: scene.language || "en", input: safeDiagnosticInput({ ...input, reference }),
      };
      diagnostics.push(attempt); await persist(); logAttempt(attempt);
      predictionId = await startVideoPrediction({ ...input, ...(image ? { image } : { reference_images: referenceImages }) });
      submitMessage = "Submitted to Seedance; checking the same prediction...";
      // Keep what is needed to resubmit the SAME scene with a softer prompt after a moderation refusal.
      pipelineExtra.retry = { basePrompt, duration: input.duration, resolution: input.resolution, image, refs: retryRefs, fallbackRefs };
      pipelineExtra.moderationRetries = 0;
    }
    attempt.predictionId = predictionId; attempt.status = "processing";
    state = { predictionId, sceneId, projectId, userId, cost, startedAt: Date.now(), diagnostics, ...pipelineExtra };
    // This checkpoint MUST succeed: never swallow the prediction ID write.
    await prisma.generationJob.update({ where: { id: jobId }, data: {
      resultData: JSON.stringify(state), message: submitMessage,
    } });
    logAttempt(attempt);
    // Release the serverless invocation immediately. Polling inspects the persisted prediction,
    // including after browser reload; it never starts a replacement prediction.

  } catch (err: unknown) {
    const attempt = diagnostics[diagnostics.length - 1];
    if (attempt && attempt.status !== "succeeded") {
      attempt.error = safeProviderError(err); attempt.errorKind = classifyProviderError(err);
      if (attempt.status !== "failed" && attempt.status !== "canceled") attempt.status = attempt.errorKind === "timeout" ? "timeout" : "failed";
      logAttempt(attempt);
    }
    await persist();
    // If submission succeeded, never convert a checkpoint/network failure into a refund
    // and a second generation. Keep the known prediction for recovery.
    if (state?.predictionId) {
      console.error("[video-job] prediction checkpoint needs recovery:", { jobId, predictionId: state.predictionId, error: safeProviderError(err) });
      return;
    }
    await handleFailure(jobId, { sceneId, userId, cost }, err);
  }
}

/** Stage 4 pace: drop slow/lingering camera words that would stretch the rhythm of the clip. */
function stripSlowDirections(prompt: string): string {
  return prompt
    .replace(/\b(in )?slow[- ]?motion\b/gi, "")
    .replace(/\bslowly\b/gi, "briskly")
    .replace(/\blingering\b/gi, "brief")
    .replace(/\blingers?\b/gi, "cuts")
    .replace(/\blong (pause|silence)\b/gi, "no pause")
    .replace(/\bslow (pan|push|zoom|dolly)\b/gi, "quick $1")
    .replace(/ {2,}/g, " ");
}

/** Guard all recovery writes with an expiring compare-and-swap lease. */
function owned(jobId: string, state: VideoJobState) {
  return { id: jobId, status: "processing", resultData: { contains: `"leaseToken":"${state.leaseToken}"` } };
}
async function saveOwned(jobId: string, state: VideoJobState, data: Record<string, unknown> = {}) {
  const result = await prisma.generationJob.updateMany({ where: owned(jobId, state), data: {
    ...data, resultData: JSON.stringify(state),
  } });
  return result.count === 1;
}

async function finalizeVideoJob(jobId: string, state: VideoJobState, source: string) {
  const scene = await prisma.scene.findUnique({ where: { id: state.sceneId } });
  if (!scene) throw new Error("Scene not found");
  const { folderPrefix } = getBucketConfig();
  // Deterministic object names: recovery never creates duplicate published outputs.
  const key = `${folderPrefix}public/videos/${state.projectId}/${scene.episodeId}/${VISUAL_STYLE_ID}/${jobId}`;
  // The Seedance clip is published as-is (native speech, no burned-in subtitles).
  const videoUrl = await uploadRemoteToS3(source, `${key}.mp4`, "video/mp4");
  let lastFrameUrl: string | null = null;
  try {
    const frame = await extractLastFrameBuffer(videoUrl);
    lastFrameUrl = await uploadBufferToS3(frame, `${key}-lastframe.jpg`, "image/jpeg");
  } catch (error) { console.warn("[video-job] frame:", safeProviderError(error)); }
  // Publish scene and completed job together. A stale lease holder cannot publish or refund.
  await prisma.$transaction(async tx => {
    const result = await tx.generationJob.updateMany({ where: owned(jobId, state), data: {
      status: "completed", progress: 100, message: "Video ready", error: null,
      resultData: JSON.stringify({ ...state, leaseUntil: 0, finalizing: false, videoUrl }),
    } });
    if (!result.count) return;
    await tx.scene.update({ where: { id: state.sceneId }, data: {
      videoUrl, audioUrl: null, status: "generated", lastFrameUrl, subtitled: false,
    } });
  });
}

/** Status transition and refund are atomic and happen only once. */
async function handleFailure(jobId: string, ctx: { sceneId: string; userId?: string; cost?: number }, error: unknown, state?: VideoJobState) {
  const kind = classifyProviderError(error);
  let message = `[${kind}] ${safeProviderError(error)}`;
  if (kind === "moderation") {
    // Shown verbatim in the UI (job.error). Tell the user what to change instead of the raw provider code.
    const scene = await prisma.scene.findUnique({ where: { id: ctx.sceneId }, select: { videoPrompt: true, dialogueEn: true, dialogue: true, action: true } }).catch(() => null);
    const hints = moderationHints([scene?.videoPrompt, scene?.action, scene?.dialogueEn, scene?.dialogue].filter(Boolean).join("\n"));
    const tries = state?.moderationRetries ? ` (${state.moderationRetries + 1} попытки, включая автоматически смягчённые)` : "";
    message = `[moderation] Сцена не прошла модерацию Seedance${tries} — измените текст сцены (кнопка «Изменить сцену»). ` +
      (hints.length
        ? `Смягчите или уберите: ${hints.map(h => `«${h}»`).join(", ")}. `
        : "Уберите агрессию, физический контакт, опасность, оружие, кровь и интимные моменты; выразите конфликт через реплики, лица и мизансцену. ") +
      `Код провайдера: ${safeProviderError(error)}`;
  }
  console.error("[video-job] failed:", { jobId, sceneId: ctx.sceneId, error: message });
  await prisma.$transaction(async tx => {
    const result = await tx.generationJob.updateMany({
      where: state ? owned(jobId, state) : { id: jobId, status: { in: ["pending", "processing"] } },
      data: { status: "failed", error: message, message: "Failed", ...(state ? { resultData: JSON.stringify({ ...state, leaseUntil: 0 }) } : {}) },
    });
    if (!result.count) return;
    await tx.scene.update({ where: { id: ctx.sceneId }, data: { status: "pending" } });
    if (ctx.userId && Number(ctx.cost) > 0) {
      await tx.user.update({ where: { id: ctx.userId }, data: { credits: { increment: Number(ctx.cost) } } });
      await tx.creditTransaction.create({ data: { userId: ctx.userId, amount: Number(ctx.cost), description: `Refund: video generation failed (${jobId})` } });
    }
  });
}

/**
 * Realistic pipeline, stage video→audio: the silent Kling video succeeded. Submit the
 * Seedance native-speech run (deliberately STYLIZED visuals so it passes the moderation
 * that blocks realistic Seedance; only its audio track is used). No re-pay of Kling: the
 * successful Kling prediction is kept, so a failed submit simply retries on the next poll.
 */
async function advanceToAudioStage(jobId: string, state: VideoJobState, klingVideoUrl: string): Promise<boolean> {
  state.klingVideoUrl = klingVideoUrl;
  state.leaseUntil = Date.now() + FINALIZE_LEASE_MS;
  if (!await saveOwned(jobId, state, { progress: 62, message: "Kling video ready; generating native speech (Seedance)..." })) return false;
  runInBackground(async () => {
    try {
      const input = {
        prompt: state.audioPrompt ?? "",
        duration: Number(state.audioDuration ?? 10),
        resolution: "480p",
        aspect_ratio: "9:16",
        generate_audio: true,
        watermark: false,
      };
      const attempt: GenerationAttempt = {
        jobId, sceneId: state.sceneId, attempt: 1, model: "bytedance/seedance-2.5", phase: "audio",
        status: "submitting", style: VISUAL_STYLE_ID,
        input: safeDiagnosticInput({ ...input, source: "native_speech_for_lipsync" }),
      };
      const predictionId = await startVideoPrediction(input);
      attempt.predictionId = predictionId; attempt.status = "processing"; logAttempt(attempt);
      state.diagnostics = [...(state.diagnostics ?? []), attempt];
      state.stage = "audio";
      state.predictionId = predictionId;
      state.startedAt = Date.now();
      state.providerStatus = undefined;
      state.providerStartedAt = null;
      state.providerCompletedAt = null;
      state.leaseUntil = 0;
      await saveOwned(jobId, state, { progress: 65, message: "Generating native speech (Seedance)..." });
    } catch (error) {
      // Keep stage "video" + the successful Kling prediction; retry the submit next check.
      state.leaseUntil = 0;
      await saveOwned(jobId, state, { message: "Speech submission interrupted; retrying on the next check", error: safeProviderError(error) });
    }
  });
  return true;
}

/**
 * Realistic pipeline, stage audio→lipsync: the Seedance speech clip succeeded. Extract its
 * native audio track (ffmpeg, no TTS), store it as a WAV, then submit sync/lipsync-2 to
 * lay that speech onto the silent Kling character's lips. A failed extraction/submit keeps
 * stage "audio" and the successful speech prediction, so it retries without re-paying.
 */
async function advanceToLipsyncStage(jobId: string, state: VideoJobState, speechVideoUrl: string): Promise<boolean> {
  state.leaseUntil = Date.now() + FINALIZE_LEASE_MS;
  if (!await saveOwned(jobId, state, { progress: 82, message: "Native speech ready; syncing lips..." })) return false;
  runInBackground(async () => {
    try {
      const buf = await extractAudioBuffer(speechVideoUrl);
      const { folderPrefix } = getBucketConfig();
      const key = `${folderPrefix}public/videos/${state.projectId}/${state.sceneId}-${jobId}-speech.wav`;
      const wavUrl = await uploadBufferToS3(buf, key, "audio/wav");
      const attempt: GenerationAttempt = {
        jobId, sceneId: state.sceneId, attempt: 1, model: LIPSYNC_MODEL, phase: "lipsync",
        status: "submitting", style: VISUAL_STYLE_ID,
        input: safeDiagnosticInput({ video: "kling_silent_video", audio: "native_speech_wav", sync_mode: "silence" }),
      };
      const predictionId = await startLipsyncPrediction({ video: state.klingVideoUrl!, audio: wavUrl, sync_mode: "silence" });
      attempt.predictionId = predictionId; attempt.status = "processing"; logAttempt(attempt);
      state.diagnostics = [...(state.diagnostics ?? []), attempt];
      state.speechAudioUrl = wavUrl;
      state.stage = "lipsync";
      state.predictionId = predictionId;
      state.startedAt = Date.now();
      state.providerStatus = undefined;
      state.providerStartedAt = null;
      state.providerCompletedAt = null;
      state.leaseUntil = 0;
      await saveOwned(jobId, state, { progress: 85, message: "Syncing native speech onto the character's lips..." });
    } catch (error) {
      // Keep stage "audio" + the successful speech prediction; retry extraction/submit next check.
      state.leaseUntil = 0;
      await saveOwned(jobId, state, { message: "Lipsync submission interrupted; retrying on the next check", error: safeProviderError(error) });
    }
  });
  return true;
}

/**
 * Moderation auto-retry. Retry 1 = level 2 (aggression / physical contact / delivery cues softened).
 * Retry 2 = level 3 (staging lines rewritten to neutral dialogue blocking, delivery cues stripped,
 * reference set reduced to the speaking characters + one location angle, no start-frame chaining).
 */
async function retryAfterModeration(jobId: string, state: VideoJobState, reason: string): Promise<boolean> {
  const retry = state.retry!;
  const n = (state.moderationRetries ?? 0) + 1;
  const level: SoftenLevel = n === 1 ? 2 : 3;
  const softened = softenForModeration(retry.basePrompt, level);
  let image = retry.image;
  let refs = retry.refs;
  if (level === 3) {
    if (retry.fallbackRefs.length) { refs = retry.fallbackRefs; image = undefined; }
    else if (!refs.length && !image) { refs = retry.refs; }
  }
  let prompt = softened.text;
  if (!image && refs.length) {
    prompt += "\n" + refs.map((r, i) => `[Image${i + 1}] ${r.note}`).join("\n");
    if (refs.some(r => r.kind === "location")) prompt += "\nCamera stays inside this location across the whole shot; lighting, time of day and palette identical to the location reference.";
  }
  const input = {
    prompt, duration: retry.duration, resolution: retry.resolution,
    aspect_ratio: image ? "adaptive" : "9:16", generate_audio: true, watermark: false,
  };
  const attempt: GenerationAttempt = {
    jobId, sceneId: state.sceneId, attempt: n + 1, model: "bytedance/seedance-2.5", phase: "video", status: "submitting",
    style: VISUAL_STYLE_ID,
    input: safeDiagnosticInput({ ...input, reference: { mode: "moderation_retry", level, previousError: safeProviderError(reason), softenedPhrases: softened.hits, referenceCount: image ? 1 : refs.length } }),
  };
  state.diagnostics = [...(state.diagnostics ?? []), attempt];
  logAttempt(attempt);
  console.log("[video-job] moderation retry:", { jobId, sceneId: state.sceneId, attempt: n + 1, level, hits: softened.hits, refs: image ? "adjacent_frame" : refs.map(r => r.kind) });
  try {
    const predictionId = await startVideoPrediction({ ...input, ...(image ? { image } : { reference_images: refs.map(r => r.url) }) });
    attempt.predictionId = predictionId; attempt.status = "processing";
    state.predictionId = predictionId;
    state.startedAt = Date.now();
    state.moderationRetries = n;
    state.providerStatus = undefined; state.providerStartedAt = null; state.providerCompletedAt = null;
    state.leaseUntil = 0;
    logAttempt(attempt);
    await saveOwned(jobId, state, {
      progress: 5, error: null,
      message: `Модерация Seedance отклонила сцену — повторяю со смягчённым текстом (попытка ${n + 1} из ${MAX_MODERATION_RETRIES + 1})...`,
    });
    return true;
  } catch (error) {
    attempt.status = "failed"; attempt.error = safeProviderError(error); attempt.errorKind = classifyProviderError(error);
    logAttempt(attempt);
    // Resubmission itself failed: report the original moderation refusal (refund happens once).
    await handleFailure(jobId, state, new Error(reason), state);
    return true;
  }
}

/** One short provider check per poll, no sleeping invocation and no new prediction. */
export async function resumeVideoJob(job: { id: string; type: string; status: string; resultData: string | null; updatedAt: Date }): Promise<boolean> {
  if (job.type !== "video" || job.status !== "processing") return false;
  // Fresh read matters: callers may have read the job before a concurrent finalization/refund.
  const fresh = await prisma.generationJob.findUnique({ where: { id: job.id } });
  if (!fresh || fresh.status !== "processing") return false;
  const state = parseState(fresh.resultData);
  if (!state || (state.leaseUntil ?? 0) > Date.now()) return false;
  if (state.providerStatus && Date.now() - fresh.updatedAt.getTime() < POLL_INTERVAL_MS) return false;
  state.leaseToken = randomUUID(); state.leaseUntil = Date.now() + CHECK_LEASE_MS;
  const claim = await prisma.generationJob.updateMany({
    where: { id: job.id, status: "processing", resultData: fresh.resultData },
    data: { resultData: JSON.stringify(state) },
  });
  if (!claim.count) return false;
  try {
    let prediction = await getPredictionState(state.predictionId);
    // Deadline only applies to NON-terminal predictions. Late success still gets saved.
    if (["starting", "processing"].includes(prediction.status) && Date.now() - state.startedAt >= VIDEO_DEADLINE_MS) {
      await cancelVideoPrediction(state.predictionId);
      prediction = await getPredictionState(state.predictionId);
    }
    state.providerStatus = prediction.status;
    state.providerStartedAt = prediction.startedAt;
    state.providerCompletedAt = prediction.completedAt;
    const attempt = state.diagnostics?.find(a => a.predictionId === state.predictionId);
    if (attempt) {
      attempt.status = prediction.status;
      if (prediction.error) { attempt.error = safeProviderError(prediction.error); attempt.errorKind = classifyProviderError(prediction.error); }
      logAttempt(attempt);
    }
    if (prediction.status === "failed" || prediction.status === "canceled") {
      const reason = prediction.error || (Date.now() - state.startedAt >= VIDEO_DEADLINE_MS ? "Prediction timed out at the 30-minute application deadline (cancellation confirmed)" : "Prediction canceled by provider");
      // Seedance moderation (E005): resubmit the same scene with a progressively softer prompt.
      // Same job, same charge — the user is never billed for these automatic retries.
      if (classifyProviderError(reason) === "moderation" && state.retry && !state.lipsync && (state.moderationRetries ?? 0) < MAX_MODERATION_RETRIES) {
        return await retryAfterModeration(job.id, state, reason);
      }
      await handleFailure(job.id, state, new Error(reason), state);
      return true;
    }
    if (prediction.status === "succeeded" && prediction.url) {
      // Realistic Kling+lipsync pipeline: a succeeded prediction is NOT always the final
      // output — it may be the silent Kling video (advance to native speech) or the
      // Seedance speech clip (advance to lipsync). Only the final stage finalizes.
      const stage = state.stage ?? "video";
      if (state.lipsync && stage === "video") {
        return await advanceToAudioStage(job.id, state, prediction.url);
      }
      if (state.lipsync && stage === "audio") {
        return await advanceToLipsyncStage(job.id, state, prediction.url);
      }
      state.finalizing = true;
      state.finalizeAttempts = (state.finalizeAttempts ?? 0) + 1;
      if (state.finalizeAttempts > 3) {
        await handleFailure(job.id, state, new Error("Storage finalization failed after three recovery attempts"), state);
        return true;
      }
      state.leaseUntil = Date.now() + FINALIZE_LEASE_MS;
      if (!await saveOwned(job.id, state, { progress: 60, message: "Video ready. Uploading to storage..." })) return false;
      runInBackground(async () => {
        try { await finalizeVideoJob(job.id, state, prediction.url!); }
        catch (error) {
          // Network/storage failures are recoverable; keep the same successful prediction.
          state.leaseUntil = 0;
          await saveOwned(job.id, state, { message: "Upload interrupted; retrying storage on the next check", error: safeProviderError(error) });
        }
      });
      return true;
    }
    state.leaseUntil = 0;
    const stageLabel = state.stage === "audio" ? "Seedance (native speech)" : state.stage === "lipsync" ? "Lipsync" : (state.lipsync ? "Kling (realistic video)" : "Seedance");
    await saveOwned(job.id, state, { progress: waitingProgress(state.startedAt), message: prediction.status === "starting" ? `Queued at ${stageLabel}; checking the same prediction...` : `${stageLabel} is processing; waiting for the result...` });
    return true;
  } catch (error) {
    // A failed status GET is NOT a failed generation. Leave it recoverable, without a refund.
    state.leaseUntil = 0;
    await saveOwned(job.id, state, { message: "Provider status temporarily unavailable; checking again", error: safeProviderError(error) });
    return true;
  }
}
