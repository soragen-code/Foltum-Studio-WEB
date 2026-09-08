import { sanitizeVideoPrompt } from "@/lib/sanitize-prompt";

/** Versioned asset paths identify newly generated, compatible references; legacy assets stay intact.
 * Bumping this id retires older-style frames from continuity chaining without deleting them. */
export const VISUAL_STYLE_ID = "realistic-original-v2";
export const VISUAL_STYLE =
  "Photorealistic live-action cinematography, natural realistic human skin with pores and fine detail, " +
  "true-to-life materials and fabrics, physically accurate lighting and shadows, real depth of field, " +
  "cinematic color grading and film grain, believable everyday environments. " +
  "Distinct fictional individuals with consistent hair, clothing and features. " +
  "Entirely original invented people — NOT any real actor, celebrity or public figure and not a lookalike of one; " +
  "no branded logos or products in frame; not an imitation of any named artist, studio, film or franchise.";

/** Change rendering treatment only. Action, camera, transitions and dialogue are not rewritten. */
export function styledVisualPrompt(input: string, names: string[] = []): string {
  const styled = input.replace(/\[VISUAL STYLE\]:[^\n]*/gi, `[VISUAL STYLE]: ${VISUAL_STYLE}`);
  const clean = sanitizeVideoPrompt(styled, { keep: names }).prompt;
  return /\[VISUAL STYLE\]:/i.test(clean) ? clean : `[VISUAL STYLE]: ${VISUAL_STYLE}\n${clean}`;
}

export function characterImagePrompt(appearance: string, shot: "front" | "profile" | "full", name = "", tier?: string | null, groupSize?: number | null): string {
  if (tier === "CROWD") {
    // A crowd group is one reference: the whole group in frame, so Seedance can reuse the same extras.
    const framing = {
      front: "Wide group shot, the whole group facing the camera, everyone fully visible, natural candid expressions.",
      profile: "Candid medium-wide shot of the group from the side, people interacting with each other, nobody looking at camera.",
      full: "Full wide establishing shot of the entire group in their environment, all bodies visible head to toe.",
    }[shot];
    const size = groupSize ? ` (${groupSize} people)` : "";
    return `${VISUAL_STYLE}\nGroup of people${size}: ${sanitizeVideoPrompt(appearance, { keep: [name] }).prompt}. ${framing} Realistic environment matching the group. No text or logos.`;
  }
  const framing = {
    front: "Close-up front portrait, facing camera, eye contact.",
    profile: "Side profile portrait, soft rim lighting.",
    full: "Full-body standing portrait, all clothing and silhouette visible.",
  }[shot];
  return `${VISUAL_STYLE}\nCharacter: ${sanitizeVideoPrompt(appearance, { keep: [name] }).prompt}. ${framing} Neutral unobtrusive background. No text or logos.`;
}

/** Photoreal 9:16 location reference (no people) — used by Seedance as an environment reference. */
export function locationImagePrompt(visualPrompt: string, name = ""): string {
  return `${VISUAL_STYLE}\nLocation establishing shot: ${sanitizeVideoPrompt(visualPrompt, { keep: [name] }).prompt}. Wide vertical composition, eye-level camera, ` +
    `no people, no animals, no text, no signs with readable words, no logos. Real physical environment with authentic wear and detail.`;
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
