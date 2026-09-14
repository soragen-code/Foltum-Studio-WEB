/**
 * Stage 104 — KEYFRAME-DRIVEN SCENES (pure builders, no network).
 *
 * Every scene first gets a KEYFRAME: one Seedream (edit) still that is the exact opening frame of the shot.
 * The video is then rendered with Seedance IMAGE-TO-VIDEO: keyframe N = `image` (frame 1) and keyframe N+1
 * (when the next scene exists) = `last_image` (the final frame), so the cut into the next shot is a real
 * continuation and the world never has to be re-invented from text.
 *
 * Standing rules encoded here: the location reference comes first, then the cast; the CAMERA changes
 * between shots while the WORLD does not; scenes are generated sequentially (scene N-1's keyframe is the
 * continuity image of scene N).
 */
import { CAMERA_OF_THIS_FRAME_PREFIX } from "@/lib/frame-state";
import { extractScriptedCamera, openingAngleForScene, stripPreviousCameraLine } from "@/lib/prompt-seam";
import { characterAnchorUrl, type ScenePromptCharacterLink, type ScenePromptLocation } from "@/lib/scene-prompt";
import { VISUAL_STYLE, isStyledAsset, locationAngleImages, locationExtraLabel, locationLayoutNote, parseLocationExtra } from "@/lib/visual-style";
import { WAVESPEED_IMAGE_MAX_REFS, WAVESPEED_SEEDREAM_EDIT } from "@/lib/providers/image-provider";

/** Seedream edit request body (see WaveSpeed schema for bytedance/seedream-v5.0-pro/edit). */
export const KEYFRAME_ASPECT_RATIO = "9:16";
export const KEYFRAME_RESOLUTION = "1k";
export const KEYFRAME_OUTPUT_FORMAT = "jpeg";
export const KEYFRAME_MODEL = WAVESPEED_SEEDREAM_EDIT;
export const KEYFRAME_MAX_IMAGES = WAVESPEED_IMAGE_MAX_REFS;
/** Job type of a keyframe generation (GenerationJob.type). */
export const KEYFRAME_JOB_TYPE = "scene-keyframe";
export type KeyframeStatus = "pending" | "running" | "done" | "error";

export interface KeyframeScene {
  id: string;
  number: number;
  videoPrompt?: string | null;
  promptOverride?: string | null;
  startState?: string | null;
  continuesFrom?: string | null;
  locationDesc?: string | null;
}

export interface KeyframeBuildInput {
  scene: KeyframeScene;
  /** Characters linked to THIS scene (SceneCharacter → Character). */
  characters: ScenePromptCharacterLink[];
  /** The episode's location (null when the episode has none). */
  location: ScenePromptLocation | null;
  /**
   * Continuity image: scene N-1's keyframe (N ≥ 2); for scene 1 of episode E>1 the last frame (else the
   * keyframe) of the last scene of episode E-1; null for scene 1 of episode 1.
   */
  continuityImageUrl?: string | null;
  /** Optional episode visual identity sentence; defaults to the [VISUAL STYLE] line of the scene prompt / VISUAL_STYLE. */
  visualIdentity?: string | null;
}

export interface KeyframeImage {
  url: string;
  kind: "continuity" | "location" | "character" | "crowd";
  note: string;
}

export interface KeyframeRequest {
  prompt: string;
  images: string[];
  /** Same images with their role / note (diagnostics + UI). */
  refs: KeyframeImage[];
  /** Exact WaveSpeed request body for KEYFRAME_MODEL. */
  body: Record<string, unknown>;
  /** The camera named for this frame (scripted CAMERA block or the deterministic opening angle). */
  camera: string;
}

const oneLine = (t?: string | null) => (t ?? "").replace(/\s+/g, " ").trim();

/** The bracket-tag line of a 9-line video prompt (text after "[TAG]:"), or "" when absent. */
export function promptTagLine(prompt: string | null | undefined, tag: string): string {
  const re = new RegExp(`\\[${tag.replace(/[[\]]/g, "")}\\]:?\\s*([^\\n]*)`, "i");
  const m = re.exec(prompt ?? "");
  return m ? oneLine(m[1]) : "";
}

/**
 * WORLD state of the frame: the scripted startState with every CAMERA block removed — the "CAMERA:" block of
 * the script AND the "CAMERA OF THIS FRAME:" line of a vision description. The "WORLD:" label is dropped too.
 */
export function keyframeWorldState(startState: string | null | undefined): string {
  let text = stripPreviousCameraLine(startState);
  text = text.replace(new RegExp(`^\\s*${CAMERA_OF_THIS_FRAME_PREFIX}[^\\n]*\\n?`, "gim"), "");
  // Drop the scripted "CAMERA: ..." block (runs to the next labelled block or the end).
  text = text.replace(/CAMERA:\s*[\s\S]*?(?=\n\s*[A-Z][A-Z \/&-]{2,}:|$)/g, "");
  text = text.replace(/^\s*WORLD:\s*/i, "");
  return oneLine(text);
}

/**
 * Build the Seedream edit request of a scene keyframe. Pure and deterministic.
 * Image order (= priority under the 10-image cap): continuity → base location angles → cast (one full-body
 * anchor per individual) → extra location angles → crowds.
 */
export function buildKeyframeRequest(input: KeyframeBuildInput): KeyframeRequest {
  const { scene, characters, location } = input;
  const n = Math.max(1, Math.floor(scene.number || 1));
  const sourcePrompt = (scene.promptOverride ?? "").trim() || scene.videoPrompt || "";

  // --- images ---------------------------------------------------------------------------------------------
  const refs: KeyframeImage[] = [];
  const continuity = (input.continuityImageUrl ?? "").trim();
  if (continuity) refs.push({ url: continuity, kind: "continuity", note: "previous frame of the same continuous action" });

  const angles = location ? locationAngleImages(location) : [];
  const locationName = location?.name?.trim() || "the location";
  for (const a of angles) refs.push({ url: a.url, kind: "location", note: a.angle === "layout" ? locationLayoutNote(locationName) : `the location "${locationName}" — ${a.angle} angle` });

  const styled = characters.filter(c => isStyledAsset(c.imageFull) || isStyledAsset(c.imageFront));
  const individuals = styled.filter(c => c.tier !== "CROWD");
  const crowds = styled.filter(c => c.tier === "CROWD");
  const seen = new Set<string>();
  for (const c of individuals) {
    if (seen.has(c.characterId)) continue;
    seen.add(c.characterId);
    const age = (c.age ?? "").trim();
    refs.push({ url: characterAnchorUrl(c), kind: "character", note: `${c.name.trim()}${age ? ` (${age})` : ""} — same face, hair, build and wardrobe` });
  }
  if (location && angles.length) {
    parseLocationExtra(location.imageExtra).forEach((url, i) => refs.push({ url, kind: "location", note: `the location "${locationName}" — ${locationExtraLabel(i)} angle` }));
  }
  for (const c of crowds) refs.push({ url: characterAnchorUrl(c), kind: "crowd", note: `the group "${c.name.trim()}" (extras) — who they are and how they are dressed` });

  const kept = refs.slice(0, KEYFRAME_MAX_IMAGES);
  const images = kept.map(r => r.url);

  // --- prompt ---------------------------------------------------------------------------------------------
  const visualIdentity = oneLine(input.visualIdentity) || promptTagLine(sourcePrompt, "VISUAL STYLE") || VISUAL_STYLE;
  const world = keyframeWorldState(scene.startState);
  const camera = extractScriptedCamera(scene.startState) ?? openingAngleForScene(n);
  const lighting = promptTagLine(sourcePrompt, "LIGHTING");
  const blocking = promptTagLine(sourcePrompt, "BLOCKING");
  const characterLine = promptTagLine(sourcePrompt, "CHARACTER");
  const action = promptTagLine(sourcePrompt, "ACTION");

  const lines: string[] = [];
  lines.push(`STILL FRAME — opening frame of shot ${n} of a photorealistic vertical 9:16 drama.`);
  lines.push(`VISUAL STYLE: ${visualIdentity}`);
  if (world) lines.push(`WORLD STATE: ${world}`);
  else if (action) lines.push(`WORLD STATE: the very first instant of this action — ${action}`);
  if (blocking) lines.push(`BLOCKING: ${blocking}`);
  if (lighting) lines.push(`LIGHTING: ${lighting}`);
  if (characterLine) lines.push(`CHARACTERS: ${characterLine}`);
  if (continuity) {
    lines.push(
      "Image 1 is the previous frame of the same continuous action: keep EXACTLY the same characters, wardrobe, props, positions, lighting and location geometry — do not add or remove anything. " +
      `RENDER IT FROM A DIFFERENT CAMERA: ${camera}. ` +
      "FORBIDDEN: reusing Image 1's camera angle, height or scale."
    );
  } else {
    lines.push(`CAMERA: ${camera}.`);
  }
  kept.forEach((r, i) => {
    if (r.kind === "continuity") return;
    if (r.kind === "location") lines.push(`Image ${i + 1} = ${r.note}; the characters are INSIDE this real place — same geometry, light, weather and palette, real depth in front of and behind them.`);
    else if (r.kind === "character") lines.push(`Image ${i + 1} = ${r.note}.`);
    else lines.push(`Image ${i + 1} = ${r.note}.`);
  });
  lines.push("No text, no captions, no watermark, no split screen, no collage. Single cinematic frame, natural motion blur allowed.");
  const prompt = lines.join("\n");

  const body: Record<string, unknown> = {
    prompt,
    images,
    aspect_ratio: KEYFRAME_ASPECT_RATIO,
    resolution: KEYFRAME_RESOLUTION,
    output_format: KEYFRAME_OUTPUT_FORMAT,
    prompt_optimization_mode: "fast",
  };
  return { prompt, images, refs: kept, body, camera };
}
