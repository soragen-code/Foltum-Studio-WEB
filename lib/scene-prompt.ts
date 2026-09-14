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
 * (translateDialogue), camera-only editing of a completed predecessor frame and substituting real
 * reference URLs. The preview never does any of those — it uses the stored scene fields as-is and
 * only ever emits `[ImageN]` placeholders, so no real reference URL is exposed to the client.
 */
import { buildNativeAudioPrompt, buildNarrationAudioPrompt } from "@/lib/voiceover";
import { PACE_DIRECTION, ACTION_PACE_DIRECTION, CONFRONTATION_STAGING_SENTENCE } from "@/lib/season";
import { styledVisualPrompt, isStyledAsset, locationAngleImages, parseLocationExtra, locationExtraLabel, locationLayoutNote } from "@/lib/visual-style";
import { normalizeVideoModel, videoModelSlug, type VideoModelId } from "@/lib/ai-models";
import { matchPropsInText, type PropRegistryEntry } from "@/lib/prop-registry";

/** Seedance limit. Stage 112 order: re-angle (if predecessor), cast, wide, layout, crowd. */
export const REFERENCE_IMAGE_CAP = 30;
/** Stage 44 — how many extra location angles (Location.imageExtra) may join the three base angles as references. */
export const LOCATION_EXTRA_REF_CAP = 6;
/** Stage 44 — the note appended when location references are sent: the characters are INSIDE the photographed place. */
export const LOCATION_INSIDE_NOTE =
  "Camera stays inside this location across the whole shot; lighting, weather, time of day and palette identical to the location references. Only the camera angle changes between shots. These frames are the SAME real place photographed from different positions — the characters are INSIDE this space: floor under their feet, walls/objects beside and behind them, real depth in front and behind; shoot them in wide/full shots within the environment, never as figures placed in front of a picture of the place. They interact with its objects and surfaces; the cuts show the same location from different angles with real depth (foreground, characters, background) — never a flat backdrop.";
/** @deprecated alias kept for older imports — use REFERENCE_IMAGE_CAP. */
export const MAX_REFERENCE_IMAGES = REFERENCE_IMAGE_CAP;
/** Stage 112: only a camera edit of the ACTUAL predecessor frame can lead video references. */
export const REANGLE_REFERENCE_NOTE = "the OPENING FRAME: the actual previous video's final instant already re-rendered from THIS shot's new camera. Match this camera/composition at frame 1; do not re-angle it again. Then immediately perform this scene's action and dialogue, without freezing.";

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
  /**
   * Stage 54 — the episode's PROP REGISTRY (variant B). The full list of the episode's key recurring
   * props with their canonical English descriptions; the builder substitutes the description of every
   * prop whose name appears in THIS scene VERBATIM into the «CLOTHING & PROPS» section, so a prop
   * (e.g. a blue tin) looks identical in every scene. Empty / omitted = no shared props.
   */
  props?: PropRegistryEntry[];
  /**
   * Stage 72 — the episode's scene-generation order. The previous scene's LAST FRAME is sent as a
   * continuity reference ONLY in "chain" mode (scenes render one after another, so the frame exists).
   * Omitted / "parallel" → no previous_frame reference (all scenes render simultaneously).
   */
  chainMode?: "parallel" | "chain" | null;
  reangleUrl?: string | null;
  /** URLs forbidden from video, even if accidentally assigned to cast/location. */
  forbiddenReferenceUrls?: string[];
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
  /** Provider model slug. */
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
  /** Stage 62: the previous scene's id when its LAST FRAME is sent as a continuity reference (same-location continuation); null otherwise. */
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
 * Stage 54 — labels of the deterministic sections injected into every auto prompt (English, fixed).
 */
export const SCENE_SECTION = {
  referenceMap: "REFERENCE MAP",
  people: "PEOPLE IN FRAME",
  props: "CLOTHING & PROPS",
  negatives: "NEGATIVES",
} as const;

/**
 * Stage 54 — PEOPLE COUNTER, the main "how many are on screen" signal. Built from the ACTUAL scene
 * cast (SceneCharacter → Character): every non-crowd link is one named person; crowd-tier links are a
 * single background group, never named individually. Empty when the scene has no cast at all (b-roll),
 * so it never claims a false "0 people". Absent people are never listed.
 */
export function buildPeopleCounter(individuals: { name: string }[], hasCrowd: boolean): string {
  const names = individuals.map(c => (c.name ?? "").trim()).filter(Boolean);
  const n = names.length;
  if (n === 0 && !hasCrowd) return "";
  if (n === 0 && hasCrowd) return `${SCENE_SECTION.people}: only a background crowd (extras) is visible — no named individuals in frame.`;
  const head = n === 1
    ? `In frame exactly one person: ${names[0]}.`
    : `In frame exactly ${n} people: ${names.join(", ")}.`;
  const tail = hasCrowd
    ? " Plus a background crowd (extras) behind them; no other named individuals in frame."
    : " No other people in frame.";
  return `${SCENE_SECTION.people}: ${head}${tail}`;
}

/**
 * Stage 54 — compact REFERENCE MAP at the top: which attached image is who, so the model binds
 * identity before it reads the action. Characters come first and are exactly one image each (Stage 53),
 * so their Image indices are exact; the remaining images are the location angles (+ crowd), described
 * without over-committing to indices the cap could shift. Only "same place, same light" is asserted
 * about the location — its full description stays on the reference photo and is NEVER re-typed here.
 */
export function buildReferenceMap(individuals: { name: string }[], locationName: string | null, crowds: { name: string }[], leading?: string): string {
  // `leading` (optional) is a fixed first entry — every character index shifts by one.
  const offset = leading ? 1 : 0;
  const parts = individuals
    .map((c, i) => ({ nm: (c.name ?? "").trim(), i }))
    .filter(x => x.nm)
    .map(x => `Image${x.i + 1 + offset} = ${x.nm}`);
  if (leading) parts.unshift(leading);
  const tail: string[] = [];
  if (locationName) tail.push(`the location "${locationName}" from several angles (same place, same light — only the camera angle changes between shots; its elevated LAYOUT view is for object placement only, not a shot angle)`);
  crowds.forEach(c => { const nm = (c.name ?? "").trim(); if (nm) tail.push(`the crowd "${nm}" (extras)`); });
  if (!parts.length && !tail.length) return "";
  const head = parts.length ? `${parts.join(", ")} (each character's single full-body reference, in this order)` : "";
  const rest = tail.length ? `${head ? "; then " : "the remaining reference images are "}${tail.join(", then ")}` : "";
  return `${SCENE_SECTION.referenceMap}: ${head}${rest}.`;
}

/**
 * Stage 54 — the «CLOTHING & PROPS» section: the canonical descriptions of the props that appear in
 * this scene, substituted VERBATIM from the episode registry so the same object reads identically in
 * every scene. Empty when the scene shows none of the registry props.
 */
export function buildPropsSection(matched: readonly PropRegistryEntry[]): string {
  const parts = matched.map(p => (p.description ?? "").trim().replace(/\s*\n+\s*/g, " ")).filter(Boolean);
  if (!parts.length) return "";
  const joined = parts.join("; ");
  return `${SCENE_SECTION.props}: ${joined}${joined.endsWith(".") ? "" : "."}`;
}

/**
 * Stage 54 — the fixed NEGATIVES block appended to every auto prompt (never to a manual override).
 * The base list is identical on every clip; the music / lip-movement lines are added only for an
 * off-screen-narration scene (a voiceover with no on-camera speaker).
 */
export function buildNegatives(isNarration: boolean): string {
  const base = "no logos, no brand marks, no on-screen text, no subtitles or captions, no watermark, no split screen, no distorted anatomy; no other people in frame than described above";
  const extra = isNarration
    ? "; no background music over the narration; no character's lips move to the off-screen narration"
    : "";
  return `${SCENE_SECTION.negatives}: ${base}${extra}.`;
}

/** The single video anchor photo of a character: the styled full-body frame, else the legacy front portrait (Stage 53). */
export function characterAnchorUrl(c: ScenePromptCharacterLink): string {
  return isStyledAsset(c.imageFull) ? c.imageFull! : c.imageFront!;
}
/** Identity note attached to every character reference. */
export function characterReferenceNote(name: string): string {
  return `defines ${name}'s photorealistic appearance and identity; use the scene's staging and camera.`;
}
/** Note attached to every location angle reference. */
export function locationReferenceNote(locationName: string, angle: string): string {
  if (angle === "layout") return locationLayoutNote(locationName); // Stage 111 — the elevated layout view is a placement reference, never the shot's camera
  return `the location "${locationName}" — ${angle} angle. Same place, same time of day, same light and palette in every shot. Keep the camera inside this location and match this lighting exactly.`;
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

  // Stage 51/53 — reference SELECTION (single full-body anchor per character, all location angles,
  // crowds). Moved up in Stage 54 so the REFERENCE MAP / PEOPLE / PROPS sections can name what is sent.
  // The selection logic itself is UNCHANGED (see the strategy note further down).
  const anchorUrl = characterAnchorUrl;
  const styled = characters.filter(c => isStyledAsset(c.imageFull) || isStyledAsset(c.imageFront));
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
  const locationAngles = location ? [{ url: location.imageUrl, angle: "wide" }, { url: location.imageReverse, angle: "layout" }].filter((a): a is { url: string; angle: string } => !!a.url) : [];
  // Stage 44 — the extra angles of the same photographed place are references too (within the cap).
  const locationExtras: string[] = []; // Only the mandatory wide + layout plates.
  const effectiveLocation = locationAngles.length ? location : null;
  type Ref = SceneReference & { id: string };
  const characterRefs: Ref[] = individuals.map(c => ({ url: anchorUrl(c), kind: "character", id: c.characterId, note: characterReferenceNote(c.name) }));
  const locationRefs: Ref[] = [
    ...locationAngles.map(a => ({ url: a.url, angle: a.angle as string })),
    ...(effectiveLocation ? locationExtras.map((url, i) => ({ url, angle: locationExtraLabel(i) })) : []),
  ].map(a => ({ url: a.url, kind: "location" as const, id: effectiveLocation!.id, note: locationReferenceNote(effectiveLocation!.name, a.angle) }));
  const crowdRefs: Ref[] = crowds.map(c => ({ url: anchorUrl(c), kind: "crowd", id: c.characterId, note: `defines the look of the group "${c.name}" (extras): who they are and how they are dressed.` }));
  // Stage 44 — the BASE photographed angles vs the extra angles are separated so the Stage 62 last-frame
  // ref can be prioritized above the extras (and above crowds) but not above the base angles.
  const baseLocationRefs = locationRefs.slice(0, locationAngles.length);
  const extraLocationRefs = locationRefs.slice(locationAngles.length);
  const forbidden = new Set([previous?.lastFrameUrl, ...(input.forbiddenReferenceUrls ?? [])].filter(Boolean));
  const reangleUrl = (input.reangleUrl ?? "").trim();
  if (reangleUrl && forbidden.has(reangleUrl)) throw new Error("The raw last frame cannot be a video reference.");
  const openingRefs: Ref[] = reangleUrl ? [{ url: reangleUrl, kind: "reangle", id: scene.id, note: REANGLE_REFERENCE_NOTE }] : [];
  const ordered = [...openingRefs, ...characterRefs, ...baseLocationRefs, ...crowdRefs].filter(r => !forbidden.has(r.url));
  if (ordered.length > REFERENCE_IMAGE_CAP) throw new Error("Too many required video references. Reduce the scene cast.");
  const fallbackRefs: SceneReference[] = ordered.map(({ url, kind, note }) => ({ url, kind, note }));

  // Stage 54 — deterministic sectioned signals injected into the auto prompt (see helpers above):
  //  • REFERENCE MAP  — which attached image is who (identity binding before the action);
  //  • PEOPLE IN FRAME — the exact people counter from the ACTUAL cast (main "how many" signal);
  //  • CLOTHING & PROPS — the episode registry props shown in THIS scene, substituted VERBATIM;
  //  • NEGATIVES — the fixed do-not block (appended after the body).
  const skipReferences = false; // Legacy text-only switches cannot bypass the approved chain.
  const matchedProps = matchPropsInText(input.props ?? [], mentionText);
  const referenceMap = ""; // Generated from the ACTUAL ordered refs below, including overrides.
  const peopleCounter = buildPeopleCounter(characters.filter(c => c.tier !== "CROWD"), characters.some(c => c.tier === "CROWD"));
  const propsSection = buildPropsSection(matchedProps);
  const structureBlock = [referenceMap, peopleCounter, propsSection].filter(Boolean).join("\n");
  const negativesBlock = buildNegatives(isNarration);

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
  const openingState = reangleUrl ? oneLine(previous?.endStateActual) || null : resolveOpeningState(scene, previous);
  const endState = resolveEndState(scene);
  // Stage 44 — match cut on action: on a continuous seam the opening WORLD is the previous shot's final
  // instant while the CAMERA is new; the directive line makes that explicit for the video model.
  const continuousSeam = !!previous && !breaksSequence(scene.continuesFrom) && !!openingState;
  const stateBlocks = [
    openingState ? `${OPENING_STATE_PREFIX}${openingState}` : "",
    continuousSeam && !reangleUrl ? NEW_CAMERA_ON_CUT_LINE : "",
    endState ? `${END_STATE_PREFIX}${endState}` : "",
    SPEECH_BEFORE_CUT_LINE,
  ].filter(Boolean);
  // Stage 54 — the deterministic structure block (reference map + people counter + clothing&props)
  // sits AFTER the state blocks and BEFORE the reused 9-tag body, so the prompt still opens with the
  // OPENING/END STATE prefixes (Stage 40/41) and the body still begins with "\n\n[SHOT TYPE]".
  const statesJoined = stateBlocks.length ? stateBlocks.join("\n") : "";
  const preBody = [statesJoined, structureBlock].filter(Boolean).join("\n\n");
  const visualWithOpening = preBody
    ? `${preBody}\n\n${stripSlowDirections(visualPrompt)}`
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
    // that one is rebuilt from the live character rows too (no line → nothing is added). A manual
    // override is authored end-to-end, so Stage 54's fixed NEGATIVES block is NOT appended to it.
    prompt = buildNativeAudioPrompt(stripReferenceList(refreshCharacterLine(override, characters, false)).replace(/^REFERENCE MAP:.*$/gm, ""), dialogue, characters.map(c => ({ name: c.name })), targetLanguage);
  } else {
    // Stage 54 — the fixed do-not block closes the auto-assembled prompt (after the AUDIO TRACK and the
    // pace direction), covering logos/watermarks/subtitles/extra people plus the narration-only bits.
    prompt = `${prompt}\n\n${negativesBlock}`;
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
  // Stage 62: set to the previous scene's id when its last frame is sent as a continuity reference; else null.
  let previousFrameSceneId: string | null = null;

  if (ordered.length) {
    const refs = ordered;
    referenceImages = refs.map(r => r.url);
    retryRefs = refs.map(({ url, kind, note }) => ({ url, kind, note }));
    previousFrameSceneId = reangleUrl ? previous?.id ?? null : null;
    reference = { mode: "character_references", kinds: refs.map(r => r.kind),
      characterIds: refs.filter(r => r.kind === "character" || r.kind === "crowd").map(r => r.id),
      locationId: refs.some(r => r.kind === "location") ? location?.id : null,
      previousFrameSceneId };
    referenceKind = "character_references";
    prompt += "\nREFERENCE MAP:\n" + refs.map((r, i) => `[Image${i + 1}] ${r.note}`).join("\n");
  } else {
    reference = { mode: "text_only", sceneId: scene.id, reason: "no_references" };
    referenceKind = "text_only";
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

/**
 * Stage 104 — remove the `[ImageN] ...` reference legend (and the LOCATION_INSIDE_NOTE line that follows
 * it) from an assembled scene prompt. Stage 111: the i2v submission is gone (every scene is text-to-video
 * with references again), so this is a plain utility kept for tools/tests. Pure; every other line is kept verbatim.
 */
export function stripReferenceList(prompt: string): string {
  const lines = (prompt ?? "").split("\n");
  const kept = lines.filter(line => {
    const t = line.trim();
    if (/^\[Image\d+\]/i.test(t)) return false;
    if (/keyframe|last_image|^CONTINUE FROM \[Image|^REFERENCE MAP:/i.test(t)) return false;
    if (t === LOCATION_INSIDE_NOTE.trim()) return false;
    return true;
  });
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
