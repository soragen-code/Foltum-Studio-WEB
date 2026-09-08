import { sanitizeVideoPrompt } from "@/lib/sanitize-prompt";

/** Versioned asset paths identify newly generated, compatible references; legacy assets stay intact.
 * Bumping this id retires older-style frames from continuity chaining without deleting them. */
export const VISUAL_STYLE_ID = "human-alike-v1";
export const VISUAL_STYLE =
  "Stylized cinematic look with human-like characters — believable and expressive but clearly NOT photorealistic, " +
  "a polished digital-cinematic / 3D-animated feature-film aesthetic, natural human proportions and readable facial " +
  "expressions with clear mouth movement, soft naturalistic lighting and shadows, gentle filmic color grading, " +
  "detailed yet slightly stylized skin and fabrics (not real-photo skin pores), believable everyday environments. " +
  "Distinct fictional individuals with consistent hair, clothing and features. " +
  "Entirely original invented people — NOT any real actor, celebrity or public figure and not a lookalike of one; " +
  "no branded logos or products in frame; not an imitation of any named artist, studio, film or franchise.";

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
