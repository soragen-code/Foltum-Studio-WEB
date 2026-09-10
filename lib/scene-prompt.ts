/**
 * Single source of truth for the FINAL Seedance video prompt of a scene.
 *
 * `buildScenePrompt` is a PURE function (no network, no LLM, no DB): given the scene, its
 * characters, the episode location and the previous scene, it assembles EXACTLY the prompt the
 * video worker submits to Seedance — the styled visual prompt, the native-audio / narration
 * speech block, the pace direction and the ordered `[Image1]…[ImageN]` reference notes. The
 * assembled prompt is submitted VERBATIM (no moderation softening) so the physical/dramatic action
 * the script wrote survives; a manual per-scene override, when present, replaces the text.
 *
 * It is used by two callers so a preview can never drift from what is actually generated:
 *   1. lib/workers/video-job.ts — the real generation path.
 *   2. app/api/ai/scenes/[sceneId]/prompt — the authorized "show full prompt" preview.
 *
 * What stays OUTSIDE this function (worker-only, impure): translating legacy non-English dialogue
 * (translateDialogue), generating the new-scene reference still (Flux) and substituting real
 * reference URLs. The preview never does any of those — it uses the stored scene fields as-is and
 * only ever emits `[ImageN]` placeholders, so no real reference URL is exposed to the client.
 */
import { buildNativeAudioPrompt, buildNarrationAudioPrompt } from "@/lib/voiceover";
import { PACE_DIRECTION } from "@/lib/season";
import { styledVisualPrompt, isStyledAsset, canChainFrame, locationAngleImages } from "@/lib/visual-style";
import { normalizeVideoModel, videoModelSlug, type VideoModelId } from "@/lib/ai-models";

/**
 * Stage 36: hard cap on reference images per submission — the provider maximum for Seedance 2.5
 * `reference_images` (30). Every scene is now submitted in reference mode with its whole cast, every
 * styled location angle, the linked crowd groups and (when the chain conditions hold) the previous
 * scene's last frame as the LAST reference. If the set exceeds the cap, crowds are trimmed first,
 * then extra location angles (the wide angle stays) — characters and the previous frame are never
 * dropped. See buildScenePrompt for the ordering.
 */
export const REFERENCE_IMAGE_CAP = 30;
/** @deprecated alias kept for older imports — use REFERENCE_IMAGE_CAP. */
export const MAX_REFERENCE_IMAGES = REFERENCE_IMAGE_CAP;

export interface ScenePromptScene {
  id: string;
  number: number;
  videoPrompt: string | null;
  sceneKind?: string | null;
  voiceover?: string | null;
  dialogue?: string | null;
  dialogueEn?: string | null;
  language?: string | null;
  locationDesc?: string | null;
  continuesFrom?: string | null;
  /**
   * Stage 31: manual final-prompt override. When non-empty it REPLACES the auto-assembled prompt
   * TEXT verbatim (no moderation softening, no `[ImageN]` notes appended); the reference image set
   * is still computed and SENT as usual. null/empty = use the auto prompt.
   */
  promptOverride?: string | null;
  /**
   * Stage 36: when true the video is submitted text-only for ANY scene — no character / location
   * references, no crowd groups, no previous-scene frame, no `[ImageN]` notes, no Flux still.
   */
  skipReferences?: boolean | null;
}

export interface ScenePromptCharacterLink {
  characterId: string;
  name: string;
  tier?: string | null;
  imageFront?: string | null;
}

export interface ScenePromptLocation {
  id: string;
  name: string;
  imageUrl?: string | null;
  imageReverse?: string | null;
  imageDetail?: string | null;
}

export interface ScenePromptPrevious {
  id: string;
  number: number;
  locationDesc?: string | null;
  lastFrameUrl?: string | null;
}

export interface BuildScenePromptInput {
  scene: ScenePromptScene;
  /** Speaking / visible scene characters (from SceneCharacter → Character). */
  characters: ScenePromptCharacterLink[];
  /** The episode's location, or null when it has no styled reference angles. */
  location: ScenePromptLocation | null;
  /** The adjacent previous scene, used to decide frame chaining. */
  previous: ScenePromptPrevious | null;
  /** Legacy video model id / worker provider; always normalized to Seedance 2.5. */
  provider?: string | null;
  /**
   * English dialogue to voice, already resolved by the caller (the worker passes the translated
   * text here). When omitted the stored `dialogueEn` (else `dialogue`) is used verbatim — this is
   * what the preview does, so it never triggers a translation.
   */
  resolvedDialogueEn?: string | null;
}

/**
 * Stage 36: the first-frame (`image`) path — formerly "adjacent_frame" — is gone. A scene that
 * continues the previous one now carries that frame as its LAST reference image ("previous_frame").
 */
export type ScenePromptReferenceKind = "character_references" | "new_scene_reference" | "text_only";

/** One reference image as submitted to the provider (order preserved). */
export interface SceneReference {
  url: string;
  /** character | location | crowd | previous_frame | scene */
  kind: string;
  note: string;
}

export interface BuildScenePromptResult {
  /** The FINAL prompt submitted to Seedance (with the `[ImageN]` notes already appended). */
  prompt: string;
  /** The core prompt WITHOUT the `[ImageN]` notes (used by moderation auto-recovery). */
  basePrompt: string;
  /** The styled visual prompt (pre audio/pace), reused by the new-scene reference still. */
  visualPrompt: string;
  /** Normalized video model id. */
  model: VideoModelId;
  /** Replicate slug for the model. */
  modelSlug: string;
  /** Which reference strategy the scene resolves to. */
  referenceKind: ScenePromptReferenceKind;
  /** true when the submitted text is the producer's manual override (Stage 31). */
  hasOverride: boolean;
  /** Reference descriptor persisted with the prediction (referencePredictionId is added later for new_scene_reference). */
  reference: Record<string, unknown>;
  /** Reference image URLs for character_references; empty for text_only and (until the worker generates it) new_scene_reference. */
  referenceImages: string[];
  /** Full ordered reference set with kinds/notes (empty until the worker fills it for new_scene_reference). */
  retryRefs: SceneReference[];
  /** Reduced reference set kept for diagnostics: individual characters + the wide location angle. */
  fallbackRefs: SceneReference[];
  /** Id of the previous scene whose last frame was appended as the "previous_frame" reference, else null. */
  previousFrameSceneId: string | null;
  /** true when the worker must generate a fresh Flux still (no chain, no references). */
  newSceneReference: boolean;
  /** Flux text-to-image prompt for the new-scene reference still (only when newSceneReference). */
  referencePrompt?: string;
  /** The deterministic note appended for the new-scene reference (worker reuses it for retryRefs). */
  newSceneReferenceNote?: string;
  /** English dialogue actually used (empty for narration / no dialogue). */
  dialogue: string;
  /** true for an off-screen narration scene (b-roll under narration). */
  isNarration: boolean;
}

/**
 * Stage 27a: only strip the literal "slow motion" visual effect (a model artifact request that
 * warps the footage). Natural conversational pacing — unhurried delivery, the normal small pauses of
 * real speech and gentle camera moves — is intentionally KEPT.
 */
export function stripSlowDirections(prompt: string): string {
  return prompt
    .replace(/\b(in )?slow[- ]?motion\b/gi, "")
    .replace(/ {2,}/g, " ");
}

/**
 * Assemble the final Seedance prompt for a scene. Pure and deterministic: identical inputs always
 * produce the identical prompt, with no side effects and no real reference URLs in the text.
 */
export function buildScenePrompt(input: BuildScenePromptInput): BuildScenePromptResult {
  const { scene, characters, location, previous } = input;

  const visualPrompt = styledVisualPrompt(scene.videoPrompt ?? "", characters.map(c => c.name));
  // Speech is ALWAYS English. `dialogueEn` holds the voiced lines; the worker translates legacy
  // non-English scenes once and passes the result via resolvedDialogueEn — the preview never does.
  const targetLanguage = "English";
  // Narration scenes carry an off-screen English narrator (b-roll under narration), NOT on-camera
  // dialogue — so they never go through the lip-sync/dialogue prompt path.
  const isNarration = scene.sceneKind === "narration" && !!(scene.voiceover ?? "").trim();
  const resolved = input.resolvedDialogueEn !== undefined && input.resolvedDialogueEn !== null
    ? input.resolvedDialogueEn
    : ((scene.dialogueEn ?? "").trim() || scene.dialogue || "");
  const dialogue = isNarration ? "" : resolved;

  // Sanitize visual descriptions BEFORE adding speech: never rewrite scripted dialogue / narration.
  let prompt = isNarration
    ? `${buildNarrationAudioPrompt(stripSlowDirections(visualPrompt), scene.voiceover)}\n\n${PACE_DIRECTION}`
    : `${buildNativeAudioPrompt(stripSlowDirections(visualPrompt), dialogue, characters.map(c => ({ name: c.name })), targetLanguage)}\n\n${PACE_DIRECTION}`;
  // Stage 32: the assembled prompt is submitted VERBATIM — no moderation softening. The season
  // script now writes the real physical/dramatic action on purpose, so auto-softening here would
  // undo it. If the provider rejects an individual shot (E005) the job fails fast and the producer
  // fixes that scene by hand via a manual per-scene override (Stage 30/31).
  // A manual override replaces the auto-assembled TEXT verbatim and suppresses the `[ImageN]` notes
  // appended below; the reference image set is still computed (and sent) as usual either way.
  const override = (scene.promptOverride ?? "").trim();
  const hasOverride = override.length > 0;
  if (hasOverride) {
    prompt = override;
  }
  const basePrompt = prompt;

  const model = normalizeVideoModel(input.provider);
  const modelSlug = videoModelSlug(model);

  let referenceImages: string[] = [];
  let retryRefs: SceneReference[] = [];
  let reference: Record<string, unknown>;
  let referenceKind: ScenePromptReferenceKind;
  let newSceneReference = false;
  let referencePrompt: string | undefined;
  let newSceneReferenceNote: string | undefined;
  let previousFrameSceneId: string | null = null;

  // Stage 36 — reference mode for EVERY scene. Ordered set:
  //   1. ALL individual (non-CROWD) characters linked to THIS scene (SceneCharacter is written per
  //      scene by the season worker) that have a styled front portrait — no character cap. Characters
  //      named in this scene's dialogue / videoPrompt are ranked first, then the rest of the linked
  //      list in its original order (deterministic);
  //   2. ALL styled location angles (wide first — locationAngleImages' own order), each with its own note;
  //   3. crowd groups linked to the scene;
  //   4. when canChainFrame(scene, previous) holds, the previous scene's last frame as the LAST
  //      reference ("previous_frame") with a continuity note — it is no longer sent as the first-frame
  //      `image` (the provider forbids combining that with reference images, which is exactly what
  //      made characters drift between chained scenes).
  // Trim order when the set exceeds REFERENCE_IMAGE_CAP: crowds first, then extra location angles
  // (the wide angle is kept), never the characters or the previous frame.
  const styled = characters.filter(c => isStyledAsset(c.imageFront));
  const individualsAll = styled.filter(c => c.tier !== "CROWD");
  const crowds = styled.filter(c => c.tier === "CROWD");
  const mentionText = `${scene.videoPrompt ?? ""}\n${dialogue}\n${scene.voiceover ?? ""}`.toLowerCase();
  const isMentioned = (name: string) => {
    const n = name.trim().toLowerCase();
    return n.length > 0 && mentionText.includes(n);
  };
  const mentioned = individualsAll.filter(c => isMentioned(c.name));
  const unmentioned = individualsAll.filter(c => !isMentioned(c.name));
  const individuals = [...mentioned, ...unmentioned];
  const locationAngles = location ? locationAngleImages(location) : [];
  const effectiveLocation = locationAngles.length ? location : null;
  type Ref = SceneReference & { id: string };
  const characterRefs: Ref[] = individuals.map(c => ({ url: c.imageFront!, kind: "character", id: c.characterId, note: `defines ${c.name}'s photorealistic appearance and identity; use the scene's staging and camera.` }));
  const locationRefs: Ref[] = locationAngles.map(a => ({ url: a.url, kind: "location", id: effectiveLocation!.id, note: `the location "${effectiveLocation!.name}" — ${a.angle} angle. Same place, same time of day, same light and palette in every shot. Keep the camera inside this location and match this lighting exactly.` }));
  const crowdRefs: Ref[] = crowds.map(c => ({ url: c.imageFront!, kind: "crowd", id: c.characterId, note: `defines the look of the group "${c.name}" (extras): who they are and how they are dressed.` }));
  const chained = canChainFrame(scene, previous);
  const previousFrameRefs: Ref[] = chained
    ? [{ url: previous!.lastFrameUrl!, kind: "previous_frame", id: previous!.id, note: "the final frame of the previous scene: start this scene from the same camera position, character placement, lighting and time of day; continue the action from here." }]
    : [];
  // Reduced set (individual characters + the wide location angle) kept for diagnostics.
  const fallbackRefs: SceneReference[] = [...characterRefs, ...locationRefs.slice(0, 1)].slice(0, REFERENCE_IMAGE_CAP).map(r => ({ url: r.url, kind: r.kind, note: r.note }));
  const skipReferences = !!scene.skipReferences;

  if (skipReferences) {
    // Stage 33/36: producer asked for text-only submission (no reference images at all, not even the
    // previous scene's frame) — typically after a provider block that the text alone cannot explain.
    reference = { mode: "text_only", sceneId: scene.id };
    referenceKind = "text_only";
  } else if (characterRefs.length || locationRefs.length || crowdRefs.length || previousFrameRefs.length) {
    // Mandatory part first (never trimmed), then fill the remaining room: wide angle → extra angles → crowds.
    const mandatory = characterRefs.length + previousFrameRefs.length;
    let room = Math.max(0, REFERENCE_IMAGE_CAP - mandatory);
    const keptLocation = locationRefs.slice(0, room);
    room -= keptLocation.length;
    const keptCrowds = crowdRefs.slice(0, room);
    const refs: Ref[] = [...characterRefs, ...keptLocation, ...keptCrowds, ...previousFrameRefs].slice(0, REFERENCE_IMAGE_CAP);
    referenceImages = refs.map(r => r.url);
    retryRefs = refs.map(r => ({ url: r.url, kind: r.kind, note: r.note }));
    previousFrameSceneId = previousFrameRefs.length && refs.some(r => r.kind === "previous_frame") ? previous!.id : null;
    reference = {
      mode: "character_references",
      characterIds: refs.filter(r => r.kind === "character" || r.kind === "crowd").map(r => r.id),
      locationId: keptLocation.length ? effectiveLocation!.id : null,
      kinds: refs.map(r => r.kind),
      ...(previousFrameSceneId ? { previousFrameSceneId } : {}),
    };
    referenceKind = "character_references";
    // With a manual override the producer owns the full text — never append the reference notes
    // (the images are still sent).
    if (!hasOverride) {
      prompt += "\n" + refs.map((r, i) => `[Image${i + 1}] ${r.note}`).join("\n");
      if (keptLocation.length) prompt += "\nCamera stays inside this location across the whole shot; lighting, weather, time of day and palette identical to the location references. Only the camera angle changes between shots. The characters are physically present in this place and interact with its objects and surfaces; the cuts show the same location from different angles with real depth (foreground, characters, background) — never a flat backdrop.";
    }
  } else {
    // One new scene composition, never overwrite the user's old portraits or frames. This is
    // original text-to-image design, not a way to bypass a provider refusal. The worker generates
    // this still (Flux) and substitutes the real URL; the pure function only appends the note.
    referencePrompt = `${visualPrompt}\nSingle still establishing the described scene with the same characters, clothing and setting. No text or subtitles.`;
    reference = { mode: "new_scene_reference", sceneId: scene.id };
    referenceKind = "new_scene_reference";
    newSceneReference = true;
    newSceneReferenceNote = "defines the scene's original photorealistic character designs, clothing and environment. Preserve those designs while performing the scripted action.";
    // With a manual override the producer owns the full text — never append the reference note.
    if (!hasOverride) prompt += `\n[Image1] ${newSceneReferenceNote}`;
  }

  return {
    prompt,
    basePrompt,
    visualPrompt,
    model,
    modelSlug,
    referenceKind,
    hasOverride,
    reference,
    referenceImages,
    retryRefs,
    fallbackRefs,
    previousFrameSceneId,
    newSceneReference,
    referencePrompt,
    newSceneReferenceNote,
    dialogue,
    isNarration,
  };
}
