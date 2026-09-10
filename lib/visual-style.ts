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

/**
 * Stage 14 (E): extra character angles (beyond front/profile/full) → 5 photos total.
 * Generated with the front portrait as image_input so face/hair/wardrobe stay identical —
 * only the pose/framing changes. Cycled by index so repeated requests keep varying.
 */
export const CHARACTER_EXTRA_VARIANTS = [
  "Three-quarter angle portrait (body turned ~45° to camera), same face, hair, wardrobe and lighting as the reference, natural relaxed pose.",
  "Full-body action pose in a natural stance (mid-gesture, walking or reaching), same face, hair and wardrobe as the reference, dynamic but clear silhouette.",
  "Medium shot from a slightly high angle, same face, hair and wardrobe as the reference, candid expression, no eye contact.",
  "Full-body back/over-the-shoulder view showing hairstyle and outfit from behind, same wardrobe and colours as the reference.",
] as const;

export function characterExtraAnglePrompt(appearance: string, name = "", index = 0): string {
  const who = sanitizeVideoPrompt(appearance, { keep: [name] }).prompt;
  const variant = CHARACTER_EXTRA_VARIANTS[((index % CHARACTER_EXTRA_VARIANTS.length) + CHARACTER_EXTRA_VARIANTS.length) % CHARACTER_EXTRA_VARIANTS.length];
  return `${VISUAL_STYLE}\nThe SAME person as the reference image: ${who}. ${variant} Neutral unobtrusive background. No text or logos.`;
}

/**
 * Stage 14 (E): reference frames for an important object / artifact (2 per artifact).
 * Object only — no people. Frame 0 is a clean isolated reference; frame 1 shows it in context
 * with realistic scale and wear, generated with frame 0 as image_input so it stays identical.
 */
export const ARTIFACT_VARIANTS = [
  "Clean isolated product-style reference on a neutral surface, the whole object in frame, sharp focus, showing its true shape, materials, colour and defining details.",
  "The SAME object as the reference image, shown in a realistic in-story context at true scale (held or resting where it belongs), same shape, materials, colour, wear and markings as the reference — only the setting and framing changed.",
] as const;

export function artifactImagePrompt(visualPrompt: string, name = "", index = 0): string {
  const thing = sanitizeVideoPrompt(visualPrompt, { keep: [name] }).prompt;
  const variant = ARTIFACT_VARIANTS[((index % ARTIFACT_VARIANTS.length) + ARTIFACT_VARIANTS.length) % ARTIFACT_VARIANTS.length];
  const noPeople = "No people, no faces, no text, no readable labels, no brand logos. Real physical object with authentic materials and detail.";
  return `${VISUAL_STYLE}\nImportant story object: ${thing}. ${variant} ${noPeople}`;
}

/** Photoreal 9:16 location reference (no people) — used by Seedance as an environment reference. */
export function locationImagePrompt(visualPrompt: string, name = ""): string {
  return locationAnglePrompt(visualPrompt, name, "wide");
}

/**
 * Camera angles of one location reference set. The wide shot is generated first; the other
 * angles are generated WITH the wide shot as Seedream image_input, so the place, time of day,
 * weather, light direction and palette stay identical — only the camera moves.
 */
export const LOCATION_ANGLES = [
  { key: "imageUrl", angle: "wide", label: "Общий план" },
  { key: "imageReverse", angle: "reverse", label: "Обратный ракурс" },
  { key: "imageDetail", angle: "detail", label: "Средний план" },
] as const;
export type LocationAngle = (typeof LOCATION_ANGLES)[number]["angle"];
export type LocationImageKey = (typeof LOCATION_ANGLES)[number]["key"];

const LIGHT_LOCK = "Lighting is FIXED for this location: one time of day, one weather, one light direction and colour temperature — never changes between angles.";

export function locationAnglePrompt(visualPrompt: string, name = "", angle: LocationAngle): string {
  const place = sanitizeVideoPrompt(visualPrompt, { keep: [name] }).prompt;
  const noPeople = "no people, no animals, no text, no signs with readable words, no logos. Real physical environment with authentic wear and detail.";
  if (angle === "wide")
    return `${VISUAL_STYLE}\nLocation establishing shot: ${place}. Wide vertical composition, eye-level camera, ${noPeople} ${LIGHT_LOCK}`;
  if (angle === "reverse")
    return `${VISUAL_STYLE}\nThe SAME location as the reference image, photographed from the opposite side (reverse angle, camera turned ~180°): ${place}. ` +
      `Same architecture, materials, props, time of day, weather and light direction as the reference — only the camera position changed. Eye-level, vertical 9:16, ${noPeople} ${LIGHT_LOCK}`;
  return `${VISUAL_STYLE}\nThe SAME location as the reference image, medium shot from a 45° side angle at the spot where characters would talk: ${place}. ` +
    `Same materials, props, time of day, weather and light direction as the reference — only the framing is closer. Vertical 9:16, ${noPeople} ${LIGHT_LOCK}`;
}

/**
 * Extra on-demand angles/shots of the SAME location (beyond the base 3). Each is generated with
 * the wide shot as image_input so light and materials stay locked. Cycled by index so repeated
 * requests keep producing different views. Still NO people (reference plates stay people-free).
 */
export const LOCATION_EXTRA_VARIANTS = [
  "photographed from a high angle looking down over the space, showing its full layout and how far it extends",
  "photographed from a low angle near the floor, foreground objects large and close, the space receding deep behind",
  "a different corner or zone of the same place not seen before, wide framing that reveals more of its depth",
  "a doorway/threshold view looking through into the depth of the space (foreground frame, mid-ground, deep background)",
  "a tight detail shot of a characteristic surface, prop or texture of the place (materials, wear, signs of life)",
  "photographed from the far end of the space looking back toward the main entrance, long depth of field",
] as const;

export function locationExtraAnglePrompt(visualPrompt: string, name = "", index = 0): string {
  const place = sanitizeVideoPrompt(visualPrompt, { keep: [name] }).prompt;
  const noPeople = "no people, no animals, no text, no signs with readable words, no logos. Real physical environment with authentic wear and detail.";
  const variant = LOCATION_EXTRA_VARIANTS[((index % LOCATION_EXTRA_VARIANTS.length) + LOCATION_EXTRA_VARIANTS.length) % LOCATION_EXTRA_VARIANTS.length];
  return `${VISUAL_STYLE}\nThe SAME location as the reference image, ${variant}: ${place}. ` +
    `Same architecture, materials, props, time of day, weather and light direction as the reference — only the camera position/framing changed. Vertical 9:16, ${noPeople} ${LIGHT_LOCK}`;
}

/** Parse the stored imageExtra JSON array into a clean list of styled URLs. */
export function parseLocationExtra(imageExtra?: string | null): string[] {
  if (!imageExtra) return [];
  try {
    const arr = JSON.parse(imageExtra);
    return Array.isArray(arr) ? arr.filter((u): u is string => typeof u === "string" && isStyledAsset(u)) : [];
  } catch { return []; }
}

/** All valid reference angles of a location, wide first. */
export function locationAngleImages(loc: { imageUrl?: string | null; imageReverse?: string | null; imageDetail?: string | null }): { angle: LocationAngle; label: string; url: string }[] {
  return LOCATION_ANGLES
    .map((a) => ({ angle: a.angle, label: a.label, url: (loc as Record<string, string | null | undefined>)[a.key] ?? "" }))
    .filter((a) => isStyledAsset(a.url));
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
