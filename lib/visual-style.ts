import { sanitizeVideoPrompt } from "@/lib/sanitize-prompt";

/** Versioned asset paths identify newly generated, compatible references; legacy assets stay intact. */
export const VISUAL_STYLE_ID = "soft-original-v1";
export const VISUAL_STYLE =
  "Original lightly stylized illustration in motion, softly rounded forms, subtle hand-painted matte textures, " +
  "natural but gently simplified proportions, expressive distinctive faces, soft diffuse lighting. " +
  "Recognizable individual characters with consistent hair, clothing and features. " +
  "Not photorealistic or live action; no imitation of a named artist, studio or franchise.";

/** Change rendering treatment only. Action, camera, transitions and dialogue are not rewritten. */
export function styledVisualPrompt(input: string, names: string[] = []): string {
  const styled = input.replace(/\[VISUAL STYLE\]:[^\n]*/gi, `[VISUAL STYLE]: ${VISUAL_STYLE}`);
  const clean = sanitizeVideoPrompt(styled, { keep: names }).prompt;
  return /\[VISUAL STYLE\]:/i.test(clean) ? clean : `[VISUAL STYLE]: ${VISUAL_STYLE}\n${clean}`;
}

export function characterImagePrompt(appearance: string, shot: "front" | "profile" | "full", name = ""): string {
  const framing = {
    front: "Close-up front portrait, facing camera, eye contact.",
    profile: "Side profile portrait, soft rim lighting.",
    full: "Full-body standing portrait, all clothing and silhouette visible.",
  }[shot];
  return `${VISUAL_STYLE}\nCharacter: ${sanitizeVideoPrompt(appearance, { keep: [name] }).prompt}. ${framing} Neutral unobtrusive background. No text or logos.`;
}

export function isStyledAsset(url?: string | null): boolean {
  if (!url) return false;
  try { return new URL(url).pathname.split("/").includes(VISUAL_STYLE_ID); }
  catch { return false; }
}

const normalizedLocation = (s?: string | null) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
export function canChainFrame(
  scene: { number: number; locationDesc?: string | null },
  previous?: { number: number; locationDesc?: string | null; lastFrameUrl?: string | null } | null
): boolean {
  // Never jump back to an older nonadjacent frame, or assume an untagged upload is stylized.
  return !!previous && previous.number === scene.number - 1 && isStyledAsset(previous.lastFrameUrl) &&
    !!normalizedLocation(scene.locationDesc) && normalizedLocation(scene.locationDesc) === normalizedLocation(previous.locationDesc) &&
    !/\b(?:cut to|hours? later|days? later)\b/i.test(scene.locationDesc ?? "");
}
