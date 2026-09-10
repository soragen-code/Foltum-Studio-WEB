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

export function characterImagePrompt(appearance: string, shot: "front" | "profile" | "full", name = "", tier?: string | null, groupSize?: number | null, chained = false): string {
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
  // Stage 16: the 3 base shots of the fixed 5-angle set → face close-up, LEFT profile,
  // full-body FRONT. (The 2 extras — RIGHT profile + full-body BACK — are in CHARACTER_EXTRA_VARIANTS.)
  const framing = {
    front: "Close-up front portrait, the face filling the frame, facing the camera directly, eye contact, sharp facial detail.",
    profile: "Left-side profile portrait — camera on the character's LEFT side, showing the left cheek and side of the face in clean profile, soft rim lighting.",
    full: "Full-body standing portrait from the FRONT, facing the camera, entire figure head to toe, all clothing and silhouette visible.",
  }[shot];
  // Stage 21: profile/full are generated WITH the front portrait as image_input, so they must lock
  // onto that exact identity — only the camera angle/pose changes, never the face, hair or outfit.
  const identityLock = chained
    ? " This is the SAME person as the reference image — keep the identical face, facial features, skin tone, hairstyle, hair colour, build, wardrobe, clothing colours and lighting as the reference; ONLY the camera angle and pose change."
    : "";
  return `${VISUAL_STYLE}\nCharacter: ${sanitizeVideoPrompt(appearance, { keep: [name] }).prompt}. ${framing}${identityLock} Neutral unobtrusive background. No text or logos.`;
}

/**
 * Stage 16: the 2 EXTRA angles that complete the FIXED 5-photo character set (beyond the
 * 3 base shots face / left-profile / full-front): index 0 = RIGHT profile, index 1 = full-body
 * BACK. This is a fixed ordered set (NOT random) so every character is covered from the same
 * predictable viewpoints. Generated with the front portrait as image_input so the SAME face,
 * hair, wardrobe and lighting are preserved — only the angle changes.
 */
export const CHARACTER_EXTRA_VARIANTS = [
  "Right-side profile portrait — camera on the character's RIGHT side, showing the right cheek and side of the face in clean profile, same face, hair, wardrobe and lighting as the reference.",
  "Full-body standing view from directly BEHIND (back view), the whole figure head to toe, showing the hairstyle and the outfit from the back, same wardrobe, colours and lighting as the reference.",
] as const;

export function characterExtraAnglePrompt(appearance: string, name = "", index = 0): string {
  const who = sanitizeVideoPrompt(appearance, { keep: [name] }).prompt;
  const variant = CHARACTER_EXTRA_VARIANTS[((index % CHARACTER_EXTRA_VARIANTS.length) + CHARACTER_EXTRA_VARIANTS.length) % CHARACTER_EXTRA_VARIANTS.length];
  return `${VISUAL_STYLE}\nThe SAME person as the reference image: ${who}. ${variant} Neutral unobtrusive background. No text or logos.`;
}

/**
 * Stage 16: reference frames for an important object / artifact (3 per artifact).
 * Object only — no people. Frame 0 is a clean isolated reference; frames 1 and 2 are generated
 * with frame 0 as image_input so the object stays identical: frame 1 shows it in a realistic
 * in-story context at true scale, frame 2 is a close-up detail of its defining feature.
 */
export const ARTIFACT_VARIANTS = [
  "Clean isolated product-style reference on a neutral surface, the whole object in frame, sharp focus, showing its true shape, materials, colour and defining details.",
  "The SAME object as the reference image, shown in a realistic in-story context at true scale (held or resting where it belongs), same shape, materials, colour, wear and markings as the reference — only the setting and framing changed.",
  "The SAME object as the reference image, extreme close-up detail of its most defining feature (texture, markings, mechanism or edge), macro focus, same materials, colour and wear as the reference — only the framing is much tighter.",
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
 * Stage 16 (B2): 15 DISTINCT camera/position formulations for the extra angles of the SAME
 * location (beyond the base 3 = wide/reverse/detail). With the base set that is 18 distinct
 * formulations total; the episode generator uses 12 of these to reach 15 frames per location.
 * Each is a genuinely different viewpoint — different height, side, focal length and part of the
 * space — so the frames are recognizably the SAME place seen from clearly different positions,
 * NOT near-copies of the wide shot. Still NO people (reference plates stay people-free).
 */
export const LOCATION_EXTRA_VARIANTS = [
  "a high bird's-eye angle looking straight down over the whole space, revealing its full layout and how far it extends",
  "a very low angle near the floor, foreground objects large and close, the space receding deep behind",
  "a wide establishing view of a different corner or zone of the place not seen before, revealing more of its depth",
  "a doorway/threshold view looking through the entrance into the depth of the space (foreground frame, mid-ground, deep background)",
  "an extreme close-up detail of a characteristic surface, prop or texture of the place (materials, wear, small signs of life)",
  "a long shot from the far end of the space looking back toward the main entrance, deep depth of field",
  "an eye-level shot looking straight down the LENGTH of the space, strong leading lines receding into the distance",
  "a three-quarter angle from a raised position showing two walls or sides meeting at a corner of the place",
  "a shot aimed toward the main window or light source, backlit, showing how the daylight enters the space",
  "a shot with the camera's back to the window, the light falling across the front-lit surfaces of the space",
  "an elevated overview from one upper corner covering most of the floor and the far wall",
  "a ground-level wide shot from the opposite short side of the space, the far end now closest to camera",
  "a medium shot of the secondary focal area of the place (the work zone, seating, counter or feature)",
  "a narrow shot pushing into a tight nook, alcove or passage of the place, compressed framing",
  "a wide establishing shot from just inside the entrance at standing eye height, taking in the whole room",
] as const;

/**
 * Stage 16 (B1): by default the extra angles are NOT hard-bound to the wide shot via image_input
 * (that pins the viewpoint and produces near-copies). When `withBaseImage` is false the prompt
 * anchors consistency purely on the rich textual description of the place; when true (a periodic
 * re-anchor frame) it also references the base image. Either way the camera position must change.
 */
export function locationExtraAnglePrompt(visualPrompt: string, name = "", index = 0, opts?: { withBaseImage?: boolean }): string {
  const place = sanitizeVideoPrompt(visualPrompt, { keep: [name] }).prompt;
  const noPeople = "no people, no animals, no text, no signs with readable words, no logos. Real physical environment with authentic wear and detail.";
  const variant = LOCATION_EXTRA_VARIANTS[((index % LOCATION_EXTRA_VARIANTS.length) + LOCATION_EXTRA_VARIANTS.length) % LOCATION_EXTRA_VARIANTS.length];
  const anchor = opts?.withBaseImage
    ? "The SAME location as the reference image"
    : "The SAME specific location described below — keep its architecture, materials, colour palette, props, time of day, weather and light direction identical";
  return `${VISUAL_STYLE}\n${anchor}, ${variant}: ${place}. ` +
    `This is a DIFFERENT camera position and viewpoint of that same place — do NOT reproduce the earlier framing. Only the camera position/height/framing changes; the place itself stays identical. Vertical 9:16, ${noPeople} ${LIGHT_LOCK}`;
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
/**
 * Stage 20 (A3): chain the previous scene's last frame into this scene's first frame only when the two
 * shots are truly the SAME place. After anchorSceneLocation, non-location-change scenes share the
 * IDENTICAL canonical locationDesc, so normalized-location equality is now a reliable same-location key.
 * The chain is broken when: the previous frame isn't the adjacent scene, the previous frame isn't a
 * styled asset, the current scene is a deliberately SHOWN location-change, the two canonical locations
 * differ, or the text signals an explicit time/place jump ("cut to" / "hours later" / "days later").
 */
export function canChainFrame(
  scene: { number: number; locationDesc?: string | null; continuesFrom?: string | null },
  previous?: { number: number; locationDesc?: string | null; lastFrameUrl?: string | null } | null
): boolean {
  // Never jump back to an older nonadjacent frame, or assume an untagged upload is stylized.
  if (!previous || previous.number !== scene.number - 1) return false;
  if (!isStyledAsset(previous.lastFrameUrl)) return false;
  // A deliberately shown move to a new place must NOT carry the previous location's frame.
  if ((scene.continuesFrom ?? "").trim().toLowerCase() === "location-change") return false;
  // Same canonical episode location (identical anchored locationDesc after A2).
  if (!normalizedLocation(scene.locationDesc) || normalizedLocation(scene.locationDesc) !== normalizedLocation(previous.locationDesc)) return false;
  // An explicit time/place jump in the text still breaks the chain.
  if (/\b(?:cut to|hours? later|days? later)\b/i.test(scene.locationDesc ?? "")) return false;
  return true;
}
