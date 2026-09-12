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
import { PACE_DIRECTION, ACTION_PACE_DIRECTION, CONFRONTATION_STAGING_SENTENCE } from "@/lib/season";
import { styledVisualPrompt, isStyledAsset, locationAngleImages, parseLocationExtra, locationExtraLabel } from "@/lib/visual-style";
import { normalizeVideoModel, videoModelSlug, type VideoModelId } from "@/lib/ai-models";

/**
 * Stage 36: hard cap on reference images per submission — the provider maximum for Seedance 2.5
 * `reference_images` (30). Every scene is submitted in reference mode with its whole cast, every
 * styled location angle and the linked crowd groups. Stage 38: the previous scene's last frame is
 * NEVER sent any more (it was the recurring moderation trigger and made characters drift);
 * continuity between scenes now rests on the script text alone (presence / entrances / continuesFrom).
 * Stage 51: reverted to the known-good 46B-0 selection after 46B-1/46B-2/49/50 regressed Seedance
 * moderation with E005 ("flagged as sensitive"). Each individual sends EXACTLY ONE photo to video —
 * the styled FRONT portrait (imageFront) — then ALL styled location angles (base + extras), then the
 * crowds (front only). The profile, the full body and the extra character angles are NEVER sent to
 * video: they stay on the character card for regen/download only. Real Replicate runs proved this
 * exact set (single front face per character + all location angles) is what PASSED moderation on
 * 11-09 23:13; sending several character photos at once (face+profile+full+extras, added in
 * 46B-1/46B-2) is what triggered E005. If the set exceeds the cap the trim order is: crowds → extra
 * location angles; the one-per-character front refs and the base location angles are never dropped.
 * See buildScenePrompt.
 */
export const REFERENCE_IMAGE_CAP = 30;
/** Stage 44 — how many extra location angles (Location.imageExtra) may join the three base angles as references. */
export const LOCATION_EXTRA_REF_CAP = 6;
/** Stage 44 — the note appended when location references are sent: the characters are INSIDE the photographed place. */
export const LOCATION_INSIDE_NOTE =
  "Camera stays inside this location across the whole shot; lighting, weather, time of day and palette identical to the location references. Only the camera angle changes between shots. These frames are the SAME real place photographed from different positions — the characters are INSIDE this space: floor under their feet, walls/objects beside and behind them, real depth in front and behind; shoot them in wide/full shots within the environment, never as figures placed in front of a picture of the place. They interact with its objects and surfaces; the cuts show the same location from different angles with real depth (foreground, characters, background) — never a flat backdrop.";
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
  /** Stage 41 — scripted START state of this scene's first frame (its own OPENING STATE unless the previous scene has an actual last-frame description). */
  startState?: string | null;
  /** Stage 40/41 — scripted END state of this scene's final frame; appended to the prompt as END STATE. */
  endState?: string | null;
  /**
   * Stage 31: manual final-prompt override. When non-empty it REPLACES the auto-assembled prompt
   * TEXT verbatim (no moderation softening, no `[ImageN]` notes appended); the reference image set
   * is still computed and SENT as usual. null/empty = use the auto prompt.
   */
  promptOverride?: string | null;
  /**
   * Stage 36: when true the video is submitted text-only for ANY scene — no character / location
   * references, no crowd groups, no `[ImageN]` notes, no Flux still.
   */
  skipReferences?: boolean | null;
  /**
   * Stage 37 flag, OBSOLETE since Stage 38: the previous scene's frame is never sent any more, so this
   * has no effect. Kept optional so older callers / stored rows still type-check.
   */
  skipPreviousFrame?: boolean | null;
}

export interface ScenePromptCharacterLink {
  characterId: string;
  name: string;
  tier?: string | null;
  imageFront?: string | null;
  /** Stage 46B-1 — styled full-body reference; sent after imageFront/imageProfile for individuals (build, proportions, current clothing). */
  imageFull?: string | null;
  /** Stage 46B-2 — styled profile (side view) reference; sent between the front and the full body. */
  imageProfile?: string | null;
  /** Stage 46B-2 — JSON array of extra angle URLs (Character.imageExtra); sent after the full body. */
  imageExtra?: string | null;
  /** Stage 46B-0 — CURRENT saved appearance / age of the live Character row (rebuilds the [CHARACTER] line). */
  appearance?: string | null;
  age?: string | null;
}

/**
 * Stage 46B-0 — the `[CHARACTER]:` line of a stored Scene.videoPrompt is written ONCE at script time
 * (LLM or normalizeEpisodeScript) and therefore describes the character version of THAT moment. The
 * scene job must always describe the CURRENT saved version, so the line is rebuilt here from the live
 * Character rows (`Name (age): appearance; ...`) every time the prompt is assembled. Characters without
 * an appearance text contribute nothing; if none has one the stored line is kept as is.
 */
export function liveCharacterLine(characters: ScenePromptCharacterLink[]): string | null {
  const parts = characters
    .filter(c => (c.appearance ?? "").trim().length > 0)
    .map(c => `${c.name.trim()}${(c.age ?? "").trim() ? ` (${(c.age ?? "").trim()})` : ""}: ${(c.appearance ?? "").trim().replace(/\s*\n+\s*/g, " ")}`);
  return parts.length ? `[CHARACTER]: ${parts.join("; ")}` : null;
}

/**
 * Replace the stored `[CHARACTER]:` line with the live one. `insertIfMissing` (auto prompts) appends the
 * line before `[TRANSITION]` / at the end when the stored prompt has none; a manual override is only
 * touched when it still contains a `[CHARACTER]:` line (the producer's free text is otherwise kept verbatim).
 */
export function refreshCharacterLine(prompt: string, characters: ScenePromptCharacterLink[], insertIfMissing = true): string {
  const line = liveCharacterLine(characters);
  if (!line) return prompt;
  const re = /\[CHARACTER\]:[^\n]*/i;
  if (re.test(prompt)) return prompt.replace(re, line);
  if (!insertIfMissing) return prompt;
  const idx = prompt.indexOf("[TRANSITION]");
  return idx >= 0 ? `${prompt.slice(0, idx)}${line}\n${prompt.slice(idx)}` : `${prompt}\n${line}`;
}

export interface ScenePromptLocation {
  id: string;
  name: string;
  imageUrl?: string | null;
  imageReverse?: string | null;
  imageDetail?: string | null;
  /** Stage 44 — JSON array of extra location angles (Location.imageExtra); sent as references too. */
  imageExtra?: string | null;
}

/**
 * The adjacent previous scene. Stage 38: its last frame IMAGE is never sent. Stage 40: its END STATE
 * text is — `endStateActual` (vision description of the real last frame, chain mode) wins over the
 * scripted `endState`; the winner opens the next scene's prompt as OPENING STATE.
 */
export interface ScenePromptPrevious {
  id: string;
  number: number;
  locationDesc?: string | null;
  lastFrameUrl?: string | null;
  endState?: string | null;
  endStateActual?: string | null;
}

/** Stage 40 — `continuesFrom` values that START a new visual sequence (no opening-state hand-off). */
export const SEQUENCE_BREAK_LINKS = ["location-change", "new-sequence"] as const;
export function breaksSequence(continuesFrom?: string | null): boolean {
  const k = (continuesFrom ?? "").trim().toLowerCase();
  return (SEQUENCE_BREAK_LINKS as readonly string[]).includes(k);
}

/** Stage 40 — prefix of the OPENING STATE block inserted before the 9-line visual prompt. */
export const OPENING_STATE_PREFIX = "OPENING STATE (frame 1 — the SAME instant and action continue from the previous shot, but from a NEW camera: different angle, shot scale and height — never the previous framing; re-frame the identical moment): ";
/** Stage 44 — directive appended on every continuous seam: match cut on action, new camera, nobody speaking on frame 1. */
export const NEW_CAMERA_ON_CUT_LINE =
  "NEW CAMERA ON THE CUT: this shot opens on the exact same action as the previous shot's final instant, but the camera has cut to a different angle / shot scale / height — never the same framing as the previous shot's end. Nobody is speaking on frame 1 — the first line of this shot starts fresh after the cut.";
/** Stage 44 — speech must be finished before the final second of every clip (no mid-word cuts). */
export const SPEECH_BEFORE_CUT_LINE =
  "All speech is finished before the final second of the clip — nobody is mid-word or mid-sentence at the cut; the last line lands, then the hard cut.";
/** Stage 41 — prefix of the END STATE block inserted after OPENING STATE, before the 9-line visual prompt. */
export const END_STATE_PREFIX = "END STATE (last frame — end exactly here): ";

const oneLine = (t?: string | null) => (t ?? "").replace(/\s+/g, " ").trim();

/**
 * The state the scene must open from (Stage 40/41), in priority order:
 *  1. the previous scene's ACTUAL last-frame description (chain mode) — unless this scene breaks the
 *     sequence (location-change / new-sequence);
 *  2. this scene's own scripted `startState` (written by the screenwriter for every scene, incl. scene 1);
 *  3. legacy fallback for scenes scripted before Stage 41: the previous scene's scripted `endState`.
 * null when nothing applies.
 */
export function resolveOpeningState(scene: { continuesFrom?: string | null; startState?: string | null }, previous: ScenePromptPrevious | null | undefined): string | null {
  const continues = !!previous && !breaksSequence(scene.continuesFrom);
  const actual = continues ? oneLine(previous!.endStateActual) : "";
  if (actual) return actual;
  const own = oneLine(scene.startState);
  if (own) return own;
  if (!continues) return null;
  return oneLine(previous!.endState) || null;
}

/** Stage 41 — the scene's own scripted end state for the END STATE block (null when absent). */
export function resolveEndState(scene: { endState?: string | null }): string | null {
  return oneLine(scene.endState) || null;
}

export interface BuildScenePromptInput {
  scene: ScenePromptScene;
  /** Speaking / visible scene characters (from SceneCharacter → Character). */
  characters: ScenePromptCharacterLink[];
  /** The episode's location, or null when it has no styled reference angles. */
  location: ScenePromptLocation | null;
  /** The adjacent previous scene (accepted for API compatibility; Stage 38 no longer chains its frame). */
  previous: ScenePromptPrevious | null;
  /** Legacy video model id / worker provider; always normalized to Seedance 2.5. */
  provider?: string | null;
  /**
   * English dialogue to voice, already resolved by the caller (the worker passes the translated
   * text here). When omitted the stored `dialogueEn` (else `dialogue`) is used verbatim — this is
   * what the preview does, so it never triggers a translation.
   */
  resolvedDialogueEn?: string | null;
  /**
   * Stage 40 — when the scene has NO styled character / location / crowd references, submit it
   * text-only instead of generating a new-scene Flux still (test episodes, reference-less projects).
   */
  textOnlyWhenNoReferences?: boolean;
}

/**
 * Stage 36 removed the first-frame (`image`) path; Stage 38 removed the "previous_frame" reference
 * as well — only character / location / crowd references (or a fresh scene still) are ever sent.
 */
export type ScenePromptReferenceKind = "character_references" | "new_scene_reference" | "text_only";

/** One reference image as submitted to the provider (order preserved). */
export interface SceneReference {
  url: string;
  /** character | location | crowd | scene */
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
  /** Stage 40 — the OPENING STATE text inserted before the visual prompt (null when none applies). */
  openingState: string | null;
  /** Stage 41 — the END STATE text inserted after OPENING STATE (null when the scene has no scripted end state). */
  endState: string | null;
  /** Reference descriptor persisted with the prediction (referencePredictionId is added later for new_scene_reference). */
  reference: Record<string, unknown>;
  /** Reference image URLs for character_references; empty for text_only and (until the worker generates it) new_scene_reference. */
  referenceImages: string[];
  /** Full ordered reference set with kinds/notes (empty until the worker fills it for new_scene_reference). */
  retryRefs: SceneReference[];
  /** Reduced reference set kept for diagnostics: individual characters + the wide location angle. */
  fallbackRefs: SceneReference[];
  /** Stage 38: always null — the previous scene's frame is never sent as a reference any more (kept for diagnostics shape). */
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

  // Stage 46B-0: the [CHARACTER] line always reflects the CURRENT saved character rows, never the script-time copy.
  const visualPrompt = styledVisualPrompt(refreshCharacterLine(scene.videoPrompt ?? "", characters), characters.map(c => c.name));
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

  // Stage 38: an "action" scene (fight / duel / chase / physical struggle) gets the combat pace &
  // staging block INSTEAD of the talking-scene PACE_DIRECTION; a dialogue scene gets PACE_DIRECTION
  // plus the universal "confrontation is staged face to face" sentence. Narration is unchanged.
  const isAction = !isNarration && scene.sceneKind === "action";
  const direction = isNarration
    ? PACE_DIRECTION
    : isAction
      ? ACTION_PACE_DIRECTION
      : `${PACE_DIRECTION} ${CONFRONTATION_STAGING_SENTENCE}`;
  // Stage 40 — scripted / actual end-state hand-off: when this scene continues the previous one
  // (not a location-change / new-sequence), the previous scene's end state opens the prompt so the
  // model starts frame 1 exactly where the last clip ended. The previous frame IMAGE is still never sent.
  // Stage 41 — the scene's own scripted END STATE follows the OPENING STATE block so the model knows
  // both where frame 1 starts and where the last frame must end.
  const openingState = resolveOpeningState(scene, previous);
  const endState = resolveEndState(scene);
  // Stage 44 — match cut on action: on a continuous seam the opening WORLD is the previous shot's final
  // instant while the CAMERA is new; the directive line makes that explicit for the video model.
  const continuousSeam = !!previous && !breaksSequence(scene.continuesFrom) && !!openingState;
  const stateBlocks = [
    openingState ? `${OPENING_STATE_PREFIX}${openingState}` : "",
    continuousSeam ? NEW_CAMERA_ON_CUT_LINE : "",
    endState ? `${END_STATE_PREFIX}${endState}` : "",
    SPEECH_BEFORE_CUT_LINE,
  ].filter(Boolean);
  const visualWithOpening = stateBlocks.length
    ? `${stateBlocks.join("\n")}\n\n${stripSlowDirections(visualPrompt)}`
    : stripSlowDirections(visualPrompt);
  // Sanitize visual descriptions BEFORE adding speech: never rewrite scripted dialogue / narration.
  let prompt = isNarration
    ? `${buildNarrationAudioPrompt(visualWithOpening, scene.voiceover)}\n\n${direction}`
    : `${buildNativeAudioPrompt(visualWithOpening, dialogue, characters.map(c => ({ name: c.name })), targetLanguage, { action: isAction })}\n\n${direction}`;
  // Stage 32: the assembled prompt is submitted VERBATIM — no moderation softening. The season
  // script now writes the real physical/dramatic action on purpose, so auto-softening here would
  // undo it. If the provider rejects an individual shot (E005) the job fails fast and the producer
  // fixes that scene by hand via a manual per-scene override (Stage 30/31).
  // A manual override replaces the auto-assembled TEXT verbatim and suppresses the `[ImageN]` notes
  // appended below; the reference image set is still computed (and sent) as usual either way.
  const override = (scene.promptOverride ?? "").trim();
  const hasOverride = override.length > 0;
  if (hasOverride) {
    // Stage 46B-0: the producer's text is kept verbatim, except a [CHARACTER] line it still carries —
    // that one is rebuilt from the live character rows too (no line → nothing is added).
    prompt = refreshCharacterLine(override, characters, false);
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
  const previousFrameSceneId: string | null = null;

  // Stage 36 — reference mode for EVERY scene. Ordered set (Stage 51 — reverted to the known-good
  // 46B-0 selection after 46B-1/46B-2/49/50 regressed Seedance moderation with E005):
  //   1. ALL individual (non-CROWD) characters linked to THIS scene (SceneCharacter is written per
  //      scene by the season worker) that have a styled front portrait — no character cap. Characters
  //      named in this scene's dialogue / videoPrompt are ranked first, then the rest of the linked
  //      list in its original order (deterministic). Each individual contributes EXACTLY ONE photo to
  //      video: the styled FRONT portrait (imageFront). The profile, the full body and the extra angles
  //      are NEVER sent to video — they remain on the character card for regen/download/generation only;
  //   2. ALL styled location angles (wide first — locationAngleImages' own order), then the extra
  //      location angles, each with its own note;
  //   3. crowd groups linked to the scene (front only).
  //   Stage 38: the previous scene's last frame is NOT sent any more (neither as first-frame `image`
  //   nor as a "previous_frame" reference) — it was the recurring moderation trigger and made
  //   characters drift. Continuity rests on the script text (presence / entrances / continuesFrom).
  // Stage 51 rationale: this exact set (single front face per character + ALL location angles) is the
  // configuration that PASSED Seedance moderation on 11-09 23:13 (see /tmp/ok.json and the "OLD" probe
  // in scripts/_exp/stage48-results.json). Sending several character photos at once (face+profile+full+
  // extras, added in 46B-1/46B-2) is what triggered E005 ("flagged as sensitive"). Trim order when the
  // set exceeds REFERENCE_IMAGE_CAP: crowds first, then extra location angles (the wide angle is kept),
  // never the characters.
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
  // Stage 44 — the extra angles of the same photographed place are references too (within the cap).
  const locationExtras = location ? parseLocationExtra(location.imageExtra).slice(0, LOCATION_EXTRA_REF_CAP) : [];
  const effectiveLocation = locationAngles.length ? location : null;
  type Ref = SceneReference & { id: string };
  const characterRefs: Ref[] = individuals.map(c => ({ url: c.imageFront!, kind: "character", id: c.characterId, note: `defines ${c.name}'s photorealistic appearance and identity; use the scene's staging and camera.` }));
  const locationRefs: Ref[] = [
    ...locationAngles.map(a => ({ url: a.url, angle: a.angle as string })),
    ...(effectiveLocation ? locationExtras.map((url, i) => ({ url, angle: locationExtraLabel(i) })) : []),
  ].map(a => ({ url: a.url, kind: "location" as const, id: effectiveLocation!.id, note: `the location "${effectiveLocation!.name}" — ${a.angle} angle. Same place, same time of day, same light and palette in every shot. Keep the camera inside this location and match this lighting exactly.` }));
  const crowdRefs: Ref[] = crowds.map(c => ({ url: c.imageFront!, kind: "crowd", id: c.characterId, note: `defines the look of the group "${c.name}" (extras): who they are and how they are dressed.` }));
  // Reduced set (individual characters + the wide location angle) kept for diagnostics.
  const fallbackRefs: SceneReference[] = [...characterRefs, ...locationRefs.slice(0, 1)].slice(0, REFERENCE_IMAGE_CAP).map(r => ({ url: r.url, kind: r.kind, note: r.note }));
  const skipReferences = !!scene.skipReferences;

  if (skipReferences) {
    // Stage 33/36: producer asked for text-only submission (no reference images at all) — typically
    // after a provider block that the text alone cannot explain.
    reference = { mode: "text_only", sceneId: scene.id };
    referenceKind = "text_only";
  } else if (characterRefs.length || locationRefs.length || crowdRefs.length) {
    // Stage 51 (46B-0 known-good): the mandatory part is the one-per-character front refs — never
    // trimmed. The remaining room is filled: location angles (wide first, then extras) → crowds.
    const mandatory = characterRefs.length;
    let room = Math.max(0, REFERENCE_IMAGE_CAP - mandatory);
    const keptLocation = locationRefs.slice(0, room);
    room -= keptLocation.length;
    const keptCrowds = crowdRefs.slice(0, room);
    const refs: Ref[] = [...characterRefs, ...keptLocation, ...keptCrowds].slice(0, REFERENCE_IMAGE_CAP);
    referenceImages = refs.map(r => r.url);
    retryRefs = refs.map(r => ({ url: r.url, kind: r.kind, note: r.note }));
    reference = {
      mode: "character_references",
      characterIds: refs.filter(r => r.kind === "character" || r.kind === "crowd").map(r => r.id),
      locationId: keptLocation.length ? effectiveLocation!.id : null,
      kinds: refs.map(r => r.kind),
      previousFrameSceneId, // Stage 38: always null (kept for diagnostics-shape compatibility)
    };
    referenceKind = "character_references";
    // With a manual override the producer owns the full text — never append the reference notes
    // (the images are still sent).
    if (!hasOverride) {
      prompt += "\n" + refs.map((r, i) => `[Image${i + 1}] ${r.note}`).join("\n");
      if (keptLocation.length) prompt += "\n" + LOCATION_INSIDE_NOTE;
    }
  } else if (input.textOnlyWhenNoReferences) {
    // Stage 40 — «Тестовая серия» / scenes with no linked characters or location: submit text-only
    // instead of generating a Flux still first (no reference_images key at all).
    reference = { mode: "text_only", sceneId: scene.id, reason: "no_references" };
    referenceKind = "text_only";
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
    openingState,
    endState,
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
