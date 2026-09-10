/**
 * Single source of truth for the FINAL Seedance video prompt of a scene.
 *
 * `buildScenePrompt` is a PURE function (no network, no LLM, no DB): given the scene, its
 * characters, the episode location and the previous scene, it assembles EXACTLY the prompt the
 * video worker submits to Seedance — the styled visual prompt, the native-audio / narration
 * speech block, the pace direction, the moderation-safe level-1 rewrite and the ordered
 * `[Image1]…[ImageN]` reference notes.
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
import { softenForModeration } from "@/lib/sanitize-prompt";
import { styledVisualPrompt, isStyledAsset, canChainFrame, locationAngleImages } from "@/lib/visual-style";
import { normalizeVideoModel, videoModelSlug, type VideoModelId } from "@/lib/ai-models";

/** Seedance 2.5 accepts up to 30 reference images ([Image1]..[ImageN] in the prompt). */
export const MAX_REFERENCE_IMAGES = 30;

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
  /** Video model id / worker provider ("seedance" | "seedance-2.0"); defaults to the registry default. */
  provider?: string | null;
  /**
   * English dialogue to voice, already resolved by the caller (the worker passes the translated
   * text here). When omitted the stored `dialogueEn` (else `dialogue`) is used verbatim — this is
   * what the preview does, so it never triggers a translation.
   */
  resolvedDialogueEn?: string | null;
}

export type ScenePromptReferenceKind = "adjacent_frame" | "character_references" | "new_scene_reference";

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
  /** Reference descriptor persisted with the prediction (referencePredictionId is added later for new_scene_reference). */
  reference: Record<string, unknown>;
  /** Reference image URLs for character_references; empty for adjacent_frame and (until the worker generates it) new_scene_reference. */
  referenceImages: string[];
  /** Full reference set for moderation resubmission (empty until the worker fills it for new_scene_reference). */
  retryRefs: { url: string; kind: string; note: string }[];
  /** Reduced reference set used by the last moderation retry: speaking characters + one location angle. */
  fallbackRefs: { url: string; kind: string; note: string }[];
  /** Adjacent last frame (image-to-video) when chaining, else undefined. */
  image?: string;
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
  // Seedance moderation (E005): neutralize explicit wording in BOTH the visual prompt and the
  // English dialogue before submitting.
  const softened = softenForModeration(prompt, 1);
  prompt = softened.text;
  const basePrompt = prompt;

  const model = normalizeVideoModel(input.provider);
  const modelSlug = videoModelSlug(model);

  let image: string | undefined;
  let referenceImages: string[] = [];
  let retryRefs: BuildScenePromptResult["retryRefs"] = [];
  let reference: Record<string, unknown>;
  let referenceKind: ScenePromptReferenceKind;
  let newSceneReference = false;
  let referencePrompt: string | undefined;
  let newSceneReferenceNote: string | undefined;

  // Reference set, in priority order: speaking/visible individual characters → the episode's
  // location reference → crowd groups. Seedance accepts up to MAX_REFERENCE_IMAGES.
  const styled = characters.filter(c => isStyledAsset(c.imageFront));
  const individuals = styled.filter(c => c.tier !== "CROWD");
  const crowds = styled.filter(c => c.tier === "CROWD");
  // Every generated angle of the SAME location goes in as a reference, so the place, the time of
  // day and the light stay identical between shots — only the camera angle changes.
  const locationAngles = location ? locationAngleImages(location) : [];
  const effectiveLocation = locationAngles.length ? location : null;
  const characterRefs = individuals.map(c => ({ url: c.imageFront!, kind: "character", id: c.characterId, note: `defines ${c.name}'s photorealistic appearance and identity; use the scene's staging and camera.` }));
  const locationRefs = locationAngles.map(a => ({ url: a.url, kind: "location", id: effectiveLocation!.id, note: `the location "${effectiveLocation!.name}" — ${a.angle} angle. Same place, same time of day, same light and palette as the other location references. Keep the camera inside this location and match this lighting exactly.` }));
  // Reduced set used by the last moderation retry: speaking characters + one location angle.
  const fallbackRefs = [...characterRefs, ...locationRefs.slice(0, 1)].slice(0, MAX_REFERENCE_IMAGES).map(r => ({ url: r.url, kind: r.kind, note: r.note }));

  if (canChainFrame(scene, previous)) {
    image = previous!.lastFrameUrl!;
    reference = { mode: "adjacent_frame", sceneId: previous!.id };
    referenceKind = "adjacent_frame";
  } else if (individuals.length || effectiveLocation || crowds.length) {
    const refs: { url: string; note: string; kind: string; id: string }[] = [
      ...characterRefs,
      ...locationRefs,
      ...crowds.map(c => ({ url: c.imageFront!, kind: "crowd", id: c.characterId, note: `defines the look of the group "${c.name}" (extras): who they are and how they are dressed.` })),
    ].slice(0, MAX_REFERENCE_IMAGES);
    referenceImages = refs.map(r => r.url);
    retryRefs = refs.map(r => ({ url: r.url, kind: r.kind, note: r.note }));
    reference = { mode: "character_references", characterIds: refs.filter(r => r.kind !== "location").map(r => r.id), locationId: effectiveLocation?.id ?? null, kinds: refs.map(r => r.kind) };
    referenceKind = "character_references";
    prompt += "\n" + refs.map((r, i) => `[Image${i + 1}] ${r.note}`).join("\n");
    if (effectiveLocation) prompt += "\nCamera stays inside this location across the whole shot; lighting, weather, time of day and palette identical to the location references. Only the camera angle changes between shots. The characters are physically present in this place and interact with its objects and surfaces; the cuts show the same location from different angles with real depth (foreground, characters, background) — never a flat backdrop.";
  } else {
    // One new scene composition, never overwrite the user's old portraits or frames. This is
    // original text-to-image design, not a way to bypass a provider refusal. The worker generates
    // this still (Flux) and substitutes the real URL; the pure function only appends the note.
    referencePrompt = `${visualPrompt}\nSingle still establishing the described scene with the same characters, clothing and setting. No text or subtitles.`;
    reference = { mode: "new_scene_reference", sceneId: scene.id };
    referenceKind = "new_scene_reference";
    newSceneReference = true;
    newSceneReferenceNote = "defines the scene's original photorealistic character designs, clothing and environment. Preserve those designs while performing the scripted action.";
    prompt += `\n[Image1] ${newSceneReferenceNote}`;
  }

  return {
    prompt,
    basePrompt,
    visualPrompt,
    model,
    modelSlug,
    referenceKind,
    reference,
    referenceImages,
    retryRefs,
    fallbackRefs,
    image,
    newSceneReference,
    referencePrompt,
    newSceneReferenceNote,
    dialogue,
    isNarration,
  };
}
