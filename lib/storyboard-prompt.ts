/**
 * Stage 64 — STORYBOARD frame prompt (pure, no I/O).
 *
 * In storyboard mode every scene first gets ONE 9:16 photoreal still (Seedream) — the scene's first
 * frame — which the author approves; the video is then generated with that still as Image1. This
 * module assembles the Seedream prompt text + the ordered reference list for that still:
 *   text  = OPENING STATE (the scene's scripted first frame) + the scene's own [VISUAL STYLE] / [LIGHTING]
 *           lines + the SAME PEOPLE IN FRAME / CLOTHING & PROPS text as the video prompt (shared helpers,
 *           no re-worded duplicates) + the still-frame directive + per-image [ImageN] notes;
 *   refs  = previous scene's storyboard (continuation only) → one anchor photo per character →
 *           location angles; capped at SEEDREAM_IMAGE_INPUT_CAP (14), trimmed from the tail (extra
 *           location angles first — the previous storyboard and the characters are never dropped
 *           unless the characters alone exceed the cap).
 * promptOverride is NOT applied here (it is a video-prompt override).
 */
import { styledVisualPrompt, isStyledAsset, locationAngleImages, parseLocationExtra, locationExtraLabel } from "@/lib/visual-style";
import { matchPropsInText, type PropRegistryEntry } from "@/lib/prop-registry";
import {
  breaksSequence,
  buildPeopleCounter,
  buildPropsSection,
  characterAnchorUrl,
  characterReferenceNote,
  locationReferenceNote,
  type ScenePromptCharacterLink,
  type ScenePromptLocation,
} from "@/lib/scene-prompt";

/** Seedream `image_input` accepts 1–14 URLs (lib/replicate.ts FluxInput). */
export const SEEDREAM_IMAGE_INPUT_CAP = 14;
/** Same extra-angle allowance as the video path. */
const STORYBOARD_LOCATION_EXTRA_CAP = 6;

export const STORYBOARD_OPENING_PREFIX = "OPENING STATE (this exact instant is the still frame): ";
export const STORYBOARD_FRAME_DIRECTIVE = "Vertical 9:16 single still frame, photorealistic, no text, no watermark.";
export const PREVIOUS_STORYBOARD_NOTE =
  "previous shot's frame in the same location — keep every object in the same position, same set dressing, light and palette; only the camera and the action advance.";

export interface StoryboardPromptScene {
  id: string;
  number?: number;
  videoPrompt?: string | null;
  startState?: string | null;
  presence?: string | null;
  action?: string | null;
  continuesFrom?: string | null;
  dialogue?: string | null;
  dialogueEn?: string | null;
  voiceover?: string | null;
}

export interface StoryboardPromptPrevious {
  id: string;
  storyboardUrl?: string | null;
}

export interface BuildStoryboardPromptInput {
  scene: StoryboardPromptScene;
  characters: ScenePromptCharacterLink[];
  location: ScenePromptLocation | null;
  previous: StoryboardPromptPrevious | null;
  props?: PropRegistryEntry[];
}

export interface StoryboardReference {
  url: string;
  /** previous_storyboard | character | location */
  kind: "previous_storyboard" | "character" | "location";
  id: string;
  note: string;
}

export interface BuildStoryboardPromptResult {
  /** Final Seedream prompt (with the [ImageN] notes appended; never a real URL). */
  prompt: string;
  /** Ordered `image_input` URLs (≤ 14). */
  referenceImages: string[];
  /** The same references with kinds/notes (order preserved). */
  refs: StoryboardReference[];
  /** true when the previous scene's storyboard was attached (continuation). */
  continuesPrevious: boolean;
}

const oneLine = (t?: string | null) => (t ?? "").replace(/\s+/g, " ").trim();

/** Pick one tagged line ("[LIGHTING]: …") out of the 9-line video prompt; "" when absent. */
export function pickPromptLine(videoPrompt: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^[ \\t]*${escaped}[^\\n]*`, "im");
  const m = videoPrompt.match(re);
  return m ? m[0].trim() : "";
}

/**
 * The scene's opening state for the still: the scripted `startState`; fallback = presence + action,
 * else the first non-tag paragraph of the video prompt.
 */
export function resolveStoryboardOpening(scene: StoryboardPromptScene): string {
  const own = oneLine(scene.startState);
  if (own) return own;
  const fallback = [oneLine(scene.presence), oneLine(scene.action)].filter(Boolean).join(" ");
  if (fallback) return fallback;
  const vp = (scene.videoPrompt ?? "").trim();
  const blocking = pickPromptLine(vp, "[BLOCKING]").replace(/^\[BLOCKING\]\s*:?\s*/i, "");
  const actionLine = pickPromptLine(vp, "[ACTION]").replace(/^\[ACTION\]\s*:?\s*/i, "");
  return oneLine([blocking, actionLine].filter(Boolean).join(" ")) || oneLine(vp).slice(0, 400);
}

/**
 * Trim the ordered reference list to the Seedream cap FROM THE TAIL: extra location angles go first,
 * then the base location angles; the previous storyboard and the characters are kept unless the
 * characters alone exceed the cap (then the tail characters are dropped, last).
 */
export function trimStoryboardRefs(
  previousRefs: StoryboardReference[], characterRefs: StoryboardReference[], baseLocationRefs: StoryboardReference[], extraLocationRefs: StoryboardReference[], cap = SEEDREAM_IMAGE_INPUT_CAP,
): StoryboardReference[] {
  const ordered = [...previousRefs, ...characterRefs, ...baseLocationRefs, ...extraLocationRefs];
  return ordered.slice(0, cap);
}

export function buildStoryboardPrompt(input: BuildStoryboardPromptInput): BuildStoryboardPromptResult {
  const { scene, characters, location, previous } = input;
  const styledPrompt = styledVisualPrompt(scene.videoPrompt ?? "", characters.map(c => c.name));
  const visualStyleLine = pickPromptLine(styledPrompt, "[VISUAL STYLE]");
  const lightingLine = pickPromptLine(styledPrompt, "[LIGHTING]");

  // ---- references (same selection rules as the video path: one anchor per character, all location angles) ----
  const styled = characters.filter(c => isStyledAsset(c.imageFull) || isStyledAsset(c.imageFront));
  const individuals = styled.filter(c => c.tier !== "CROWD");
  const crowds = styled.filter(c => c.tier === "CROWD");
  const characterRefs: StoryboardReference[] = individuals.map(c => ({ url: characterAnchorUrl(c), kind: "character", id: c.characterId, note: characterReferenceNote(c.name) }));
  const locationAngles = location ? locationAngleImages(location) : [];
  const effectiveLocation = locationAngles.length ? location : null;
  const locationExtras = effectiveLocation ? parseLocationExtra(effectiveLocation.imageExtra).slice(0, STORYBOARD_LOCATION_EXTRA_CAP) : [];
  const baseLocationRefs: StoryboardReference[] = locationAngles.map(a => ({ url: a.url, kind: "location", id: effectiveLocation!.id, note: locationReferenceNote(effectiveLocation!.name, a.angle as string) }));
  const extraLocationRefs: StoryboardReference[] = locationExtras.map((url, i) => ({ url, kind: "location", id: effectiveLocation!.id, note: locationReferenceNote(effectiveLocation!.name, locationExtraLabel(i)) }));
  // Continuation only: a previous scene exists, this scene does not break the sequence, and it has a storyboard.
  const prevUrl = (previous?.storyboardUrl ?? "").trim();
  const continuesPrevious = !!previous && !breaksSequence(scene.continuesFrom) && prevUrl.length > 0;
  const previousRefs: StoryboardReference[] = continuesPrevious ? [{ url: prevUrl, kind: "previous_storyboard", id: previous!.id, note: PREVIOUS_STORYBOARD_NOTE }] : [];
  const refs = trimStoryboardRefs(previousRefs, characterRefs, baseLocationRefs, extraLocationRefs);

  // ---- text ----
  const opening = resolveStoryboardOpening(scene);
  const mentionText = `${scene.videoPrompt ?? ""}\n${(scene.dialogueEn ?? "").trim() || scene.dialogue || ""}\n${scene.voiceover ?? ""}`.toLowerCase();
  const peopleCounter = buildPeopleCounter(characters.filter(c => c.tier !== "CROWD"), characters.some(c => c.tier === "CROWD"));
  const propsSection = buildPropsSection(matchPropsInText(input.props ?? [], mentionText));
  void crowds;
  const lines = [
    opening ? `${STORYBOARD_OPENING_PREFIX}${opening}` : "",
    visualStyleLine,
    lightingLine,
    peopleCounter,
    propsSection,
    STORYBOARD_FRAME_DIRECTIVE,
  ].filter(Boolean);
  let prompt = lines.join("\n");
  if (refs.length) prompt += "\n" + refs.map((r, i) => `[Image${i + 1}] ${r.note}`).join("\n");

  return { prompt, referenceImages: refs.map(r => r.url), refs, continuesPrevious };
}
