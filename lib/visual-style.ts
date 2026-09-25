import { sanitizeVideoPrompt } from "@/lib/sanitize-prompt";

/** Versioned asset paths identify newly generated, compatible references; legacy assets stay intact.
 * Bumping this id retires older-style frames from continuity chaining without deleting them. */
export const VISUAL_STYLE_ID = "realistic-original-v2";

/**
 * Stage 124 — every reference image the project generates (character shots, location master/region
 * plates, artifact/object frames) is produced in vertical 9:16, matching the 9:16 video the whole
 * pipeline targets. This is the single source of truth for the reference aspect ratio; pass it as the
 * `aspect_ratio` of every Seedream generate/edit call for a reference so no path can drift back to a
 * square (1:1), landscape (16:9) or portrait-but-not-9:16 (3:4) default. seedreamImageSize("9:16")
 * maps this to 1440×2560. Existing DB images are untouched — this only affects new/regenerated refs.
 */
export const REFERENCE_ASPECT_RATIO = "9:16";
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

/**
 * Stage 241 — every character reference (main cast AND crowd/extras) is generated on a plain neutral
 * background with NO objects, props, furniture, location or environment of any kind. Extras simply stand
 * next to each other on the same empty neutral background. This single strong line replaces the old
 * "Neutral unobtrusive background" wording so the image model never adds a set or props.
 */
export const NEUTRAL_BACKGROUND_LINE =
  "Plain neutral studio background (solid neutral grey), completely empty — no objects, no props, no furniture, no location or environment of any kind, only the character(s). No text or logos.";

/** What the chained reference image shows: a face close-up (legacy anchor) or a full-length figure (Stage 46A anchor). */
export type CharacterRefKind = "face" | "full";

export function characterImagePrompt(appearance: string, shot: "front" | "profile" | "full", name = "", tier?: string | null, groupSize?: number | null, chained = false, refKind: CharacterRefKind = "face"): string {
  if (tier === "CROWD") {
    // A crowd group is one reference: the whole group in frame, so Seedance can reuse the same extras.
    // Stage 241: extras (crowd) are generated on the SAME plain neutral background as the main cast —
    // they simply stand next to each other, no environment, no props, no location.
    const framing = {
      front: "Wide group shot, the whole group standing side by side and facing the camera, everyone fully visible, natural candid expressions.",
      profile: "Medium-wide shot of the group standing next to each other, seen slightly from the side, nobody looking at camera.",
      full: "Full wide shot of the entire group standing side by side, all bodies visible head to toe.",
    }[shot];
    const size = groupSize ? ` (${groupSize} people)` : "";
    return `${VISUAL_STYLE}\nGroup of people${size}: ${sanitizeVideoPrompt(appearance, { keep: [name] }).prompt}. ${framing} The people simply stand next to each other. ${NEUTRAL_BACKGROUND_LINE}`;
  }
  // Stage 16: the 3 base shots of the fixed 5-angle set → face close-up, LEFT profile,
  // full-body FRONT. (The 2 extras — RIGHT profile + full-body BACK — are in CHARACTER_EXTRA_VARIANTS.)
  const framing = {
    front: "Close-up front portrait, the face filling the frame, facing the camera directly, eye contact, sharp facial detail.",
    profile: "Left-side profile portrait — camera on the character's LEFT side, showing the left cheek and side of the face in clean profile, soft rim lighting.",
    full: FULL_BODY_FRAMING,
  }[shot];
  const who = sanitizeVideoPrompt(appearance, { keep: [name] }).prompt;
  // Stage 21: profile/full are generated WITH the front portrait as image_input, so they must lock
  // onto that exact identity — only the camera angle/pose changes, never the face, hair or outfit.
  // For the full-body shot the reference is a face CLOSE-UP: its identity is copied, its framing is NOT —
  // otherwise the model inherits the tight crop and returns a medium shot with an oversized head.
  // Stage 46A: the full-body FRONT shot is now generated FIRST (text-to-image, natural proportions) and is the
  // identity anchor; the close-ups are chained on it. When a full-length reference is used for another
  // full-length shot the proportions are simply copied from it (no scale drift).
  const identityLock = chained
    ? shot === "full"
      ? refKind === "full"
        ? ` ${FULL_BODY_SAME_FIGURE_NOTE}`
        : ` ${FULL_BODY_REFERENCE_NOTE}`
      : refKind === "full"
        ? ` ${CLOSEUP_FROM_FULL_NOTE}`
        : " This is the SAME person as the reference image — keep the identical face, facial features, skin tone, hairstyle, hair colour, build, wardrobe, clothing colours and lighting as the reference; ONLY the camera angle and pose change."
    : "";
  // Full-body: the framing comes FIRST and dominates the prompt — the description of the person follows.
  if (shot === "full") {
    // The template's own LIGHT/BACKGROUND/QUALITY block defines the neutral technical-reference look, so the
    // cinematic VISUAL_STYLE (film grain + colour grading) is deliberately omitted here: it would both
    // contradict that block and waste ~560 chars of the provider's 4000-character budget.
    return `${framing}\nCHARACTER: ${who}. ${CHARACTER_EXPRESSION_NOTE}${identityLock}\n${FULL_BODY_CLOTHING_RULE}\n${fullBodyProportionsFor(appearance)}\n${NEUTRAL_BACKGROUND_LINE}`;
  }
  return `${VISUAL_STYLE}\nCharacter: ${who}. ${framing}${identityLock} ${NEUTRAL_BACKGROUND_LINE}`;
}

/**
 * Full-body FRONT framing — the head-to-toe reference shot. Stated first and strongly: a distant
 * full-length figure with visible floor and headroom, never a medium shot cropped at the hips.
 */
export const FULL_BODY_FRAMING =
  "Photorealistic FULL-LENGTH, head-to-toe reference of ONE fictional adult character — a technical appearance-and-wardrobe reference, NOT an artistic poster. " +
  "FRAMING & CAMERA: one single character, vertical 9:16, strictly frontal (face, chest, hips and knees turned toward the camera). " +
  "The ENTIRE figure, from the top of the hair to the soles of the shoes, is inside the frame, with a little space above the head and a visible strip of floor below the shoes; the standing figure fills about 85–90% of the frame height WITHOUT stretching or squashing its natural proportions, nothing cropped. " +
  "Camera at hip height, optical axis horizontal (no tilt, no low or high angle), about a 50mm full-frame lens — no wide-angle distortion and no perspective foreshortening or compression of the legs. Choose the camera distance for this framing, do not stretch the figure. " +
  "NOT a close-up, waist-up, portrait, three-quarter, top-down or bottom-up view — no cropping at the waist, hips or knees; both feet and shoes fully visible flat on the floor.";

/** Fixed neutral facial expression for the full-length reference (template: нейтральное, спокойное, взгляд в камеру). */
export const CHARACTER_EXPRESSION_NOTE =
  "Facial expression neutral and calm, looking straight into the camera.";

/** Wardrobe rule for the full-length reference: only the described clothing, nothing extra, no branding (template CLOTHING block). */
export const FULL_BODY_CLOTHING_RULE =
  "CLOTHING: wear only the garments described above — do NOT add any accessories, jewellery or extra clothing layers that were not described; no text, no logos, no recognisable brands.";

/**
 * Realistic ADULT anatomy / proportions for the full-body shot (added after the character description).
 * Stage 58: this is now the SINGLE source of the full-length proportion wording — `FULL_BODY_PROPORTIONS_RULE`
 * (lib/full-body-prompt.ts) is an alias of this constant, so the earlier DUPLICATE block (the inline
 * proportions PLUS a near-identical appended "rule") that pushed the composed prompt past the image
 * provider's 4000-character hard limit (HTTP 422) is gone — the idempotent wrapper now appends nothing when
 * this block is already present. Session 16: restructured to the user's character-reference template
 * (POSE & ANATOMY, LIGHT/BACKGROUND/QUALITY, EXCLUDE, PRIORITIES). ≈7–7.5 heads, natural-size head, long
 * adult legs roughly half the standing height (the hard "exactly half / vertical midpoint / high hip line"
 * wording was softened; long clothing must not shorten the legs), ~3-head torso, one consistent build,
 * correct anatomy, and the explicit negatives against short/stubby legs and stretching. Kept concise so the
 * composed full-body prompt stays under the provider's 4000-character limit.
 */
export const FULL_BODY_PROPORTIONS =
  "POSE & ANATOMY (natural realistic adult anatomy): stands straight and upright in a calm, neutral frontal pose — shoulders level, head not tilted; arms relaxed and slightly away from the torso, hands open and in view; feet slightly apart, both soles flat on the floor, weight even, no contrapposto. " +
  "Balanced proportions: a NATURAL-size head (about 7 to 7.5 heads tall, never 8 or more, not undersized), torso about 3 head-heights, long adult legs roughly half the standing height — but do NOT force the crotch / hip line to sit at exactly half the height, and a long coat, dress or robe must NOT make the legs look short. " +
  "ONE consistent build; clothing must not distort the proportions. Correct anatomy — two arms, two legs, five fingers per hand, no extra, missing, fused or warped limbs; the whole figure head to toe in frame, nothing cropped. " +
  "LIGHT & QUALITY: plain neutral-grey background, matte floor, soft even lighting; the whole figure including face and shoes in sharp focus; realistic skin, believable fabrics and colours; no heavy grain, colour grading, fog or dramatic backlight; a fictional person, not any real celebrity. " +
  "EXCLUDE: close-up or waist-up framing, cropped figure, three-quarter, top-down or bottom-up view, wide-angle distortion, NO short stubby legs, NO squat or dwarfish build, NO oversized or undersized head, NOT chibi, NOT a caricature, extra or fused limbs, objects covering the hands, text, logos, collages, extra people. " +
  "PRIORITIES on conflict: (1) whole figure in frame with correct anatomy; (2) match appearance, sex and clothing; (3) frontal neutral pose; (4) readable detail and true colours; (5) frame fill.";

/** Child / young-teen variant — a child character keeps age-appropriate proportions instead of adult ones. */
export const FULL_BODY_PROPORTIONS_CHILD =
  "POSE & ANATOMY (child): realistic proportions for a child of the stated age (about 6–7 heads tall, naturally larger head-to-body ratio than an adult, legs a bit under half of the total height). " +
  "The child stands straight and upright in a calm, neutral frontal pose — shoulders level and head not tilted, arms relaxed and held slightly away from the body with hands open and in view, feet slightly apart and both soles flat on the floor. " +
  "The whole figure head-to-toe inside the frame with nothing cropped and correct human anatomy (two arms, two legs, five fingers per hand, no extra, missing, fused or warped limbs); clothing must not distort the perceived proportions. " +
  "LIGHT, BACKGROUND & QUALITY: a plain, uniform neutral-grey background and a simple matte floor; soft, even lighting with gentle, natural shadows; the whole figure including the face and shoes in sharp focus; realistic skin texture and believable fabric colours; no heavy grain, strong colour grading, fog or dramatic backlight; a completely fictional child, not based on any real person. " +
  "EXCLUDE: close-up or waist-up framing, a cropped figure, three-quarter angle, top-down or bottom-up view, wide-angle distortion, extra or fused limbs, objects covering the hands, text, logos, collages and additional people. " +
  "NO vertical stretching or squashing, NOT chibi, NOT a caricature, NO grotesquely oversized head, NO stubby legs — a real child photographed head to toe.";

/**
 * Heuristic: does the appearance text describe a child / young teen (≤ 14)? Adults get the adult
 * proportions block; children keep child proportions. Exported for unit tests.
 */
export function isChildAppearance(appearance: string): boolean {
  const a = appearance.toLowerCase();
  // (\b is ASCII-only in JS regexes, so the Russian alternatives avoid it.)
  const ageMatch = a.match(/(?:^|[^\d])(\d{1,2})[\s-]*(?:years?[\s-]*old\b|y\.?o\.?\b|лет|года?)(?![a-zа-яё])/);
  if (ageMatch) return Number(ageMatch[1]) <= 14;
  const range = a.match(/\baged?\s+(\d{1,2})\b/);
  if (range) return Number(range[1]) <= 14;
  if (/\b(?:adult|man|woman|grown|elderly|old man|old woman|in (?:his|her|their) (?:20|30|40|50|60|70)s|twenties|thirties|forties|fifties|sixties)\b/.test(a)) return false;
  return /\b(?:child|kid|little (?:boy|girl)|small (?:boy|girl)|young (?:boy|girl)|toddler|schoolboy|schoolgirl|preteen|pre-teen)\b/.test(a)
    || /(?:^|[^a-zа-яё])(?:ребён|ребен|мальчик|девочк|малыш|подросток)/.test(a)
    || /\b(?:boy|girl)\b/.test(a) && !/\b(?:girlfriend|boyfriend|cowboy|cowgirl|playboy|tomboy)\b/.test(a);
}

/** Proportions block appropriate to the character's stated age / build. */
export function fullBodyProportionsFor(appearance: string): string {
  return isChildAppearance(appearance) ? FULL_BODY_PROPORTIONS_CHILD : FULL_BODY_PROPORTIONS;
}

/** Chained full-body shot: the reference image is a face CLOSE-UP — use it for identity only. */
export const FULL_BODY_REFERENCE_NOTE =
  "The reference image is a CLOSE-UP of this person's face and is used ONLY for identity — copy the identical face, facial features, skin tone, hairstyle and hair colour and the outfit / wardrobe from it. " +
  "Do NOT copy the reference's framing, crop, head size or head-to-frame scale: the reference is tightly framed on the face, this image must be a distant full-length shot in which the head is a small part of a tall body.";

/** Chained close-up (front / profile) whose reference is the FULL-LENGTH anchor shot of the same person. */
export const CLOSEUP_FROM_FULL_NOTE =
  "The reference image is a full-length shot of this person — this image shows the SAME person: identical face, facial features, skin tone, hairstyle, hair colour, wardrobe and lighting as in the reference. " +
  "Move the camera much closer for this framing; do not change the person.";

/** Chained full-length shot whose reference is ALSO a full-length shot: copy the figure and its proportions exactly. */
export const FULL_BODY_SAME_FIGURE_NOTE =
  "The reference image is a full-length shot of this person — reproduce the SAME person with the SAME body proportions, height, build, face, hairstyle and wardrobe; only the camera angle / pose changes.";

/**
 * Stage 16: the 2 EXTRA angles that complete the FIXED 5-photo character set (beyond the
 * 3 base shots face / left-profile / full-front): index 0 = RIGHT profile, index 1 = full-body
 * BACK. This is a fixed ordered set (NOT random) so every character is covered from the same
 * predictable viewpoints. Generated with the front portrait as image_input so the SAME face,
 * hair, wardrobe and lighting are preserved — only the angle changes.
 */
export const CHARACTER_EXTRA_VARIANTS = [
  "Right-side profile portrait — camera on the character's RIGHT side, showing the right cheek and side of the face in clean profile, same face, hair, wardrobe and lighting as the reference.",
  "FULL-BODY FULL-LENGTH SHOT from directly BEHIND (back view), head to toe: a distant full-length standing figure, camera at chest height about 4–5 metres away, 50mm lens, no wide-angle distortion. The ENTIRE body from the top of the hair to the soles of the shoes is inside the frame with visible floor below the feet and empty space above the head, the figure about 85–90% of the frame height, natural realistic adult proportions (about 7 to 7.5 heads tall, natural-size head, legs about half of the total height, torso NOT elongated or vertically stretched — NOT chibi, NO oversized OR undersized head, NO short stubby legs, NO distorted or extra limbs). NOT a close-up, NOT a medium shot — no cropping at the waist, hips or knees. Shows the hairstyle and the outfit from the back, same wardrobe, colours and lighting as the reference; the reference is a face close-up used ONLY for identity — do not copy its framing or scale.",
] as const;

export function characterExtraAnglePrompt(appearance: string, name = "", index = 0, refKind: CharacterRefKind = "face"): string {
  const who = sanitizeVideoPrompt(appearance, { keep: [name] }).prompt;
  const variant = CHARACTER_EXTRA_VARIANTS[((index % CHARACTER_EXTRA_VARIANTS.length) + CHARACTER_EXTRA_VARIANTS.length) % CHARACTER_EXTRA_VARIANTS.length];
  const note = refKind === "full" ? ` ${FULL_BODY_SAME_FIGURE_NOTE}` : "";
  return `${VISUAL_STYLE}\nThe SAME person as the reference image: ${who}. ${variant}${note} ${NEUTRAL_BACKGROUND_LINE}`;
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
  // Stage 111 — the SECOND MANDATORY frame of every location: a slightly ELEVATED view (camera ~2.5–3 m,
  // tilted down) that shows where every zone / object / doorway sits relative to the others. Stored in
  // the `imageReverse` column (free since Stage 46A — no DB migration); it is a LAYOUT reference for the
  // video model, never the camera angle of a shot.
  { key: "imageReverse", angle: "layout", label: "Ракурс сверху (планировка)" },
  { key: "imageDetail", angle: "detail", label: "Средний план" },
] as const;
/** Stage 111 — the mandatory base angles every location must carry before the scenes step unlocks. */
export const LOCATION_REQUIRED_ANGLES: readonly LocationAngle[] = ["wide", "layout"];
/** Stage 111 — the note attached to the layout frame wherever it is sent as a reference. */
export function locationLayoutNote(locationName: string): string {
  return `the location "${locationName}" — elevated LAYOUT view (camera raised, looking slightly down over the whole space). It is the FLOOR-PLAN AUTHORITY for this place: the exact placement of every fixed object and structure, and which objects sit flush against which walls. Use it ONLY to place objects, furniture, doorways and characters correctly relative to each other and against the walls; it is NOT the camera angle of this shot.`;
}
/** Stage 111 — true when the location carries both mandatory frames (wide + layout). */
export function locationBaseReady(loc: { imageUrl?: string | null; imageReverse?: string | null }): boolean {
  return isStyledAsset(loc.imageUrl) && isStyledAsset(loc.imageReverse);
}
export type LocationAngle = (typeof LOCATION_ANGLES)[number]["angle"];
export type LocationImageKey = (typeof LOCATION_ANGLES)[number]["key"];

const LIGHT_LOCK = "Lighting is FIXED for this location: one time of day, one weather, one light direction and colour temperature — never changes between angles.";

/**
 * Stage 113 — how many set-inventory entries may enter one reference prompt. The idea stage asks for
 * 12-30 (hard-capped at 40 in storage), so this normally keeps everything; when it does trim, the caller
 * logs it (never silently).
 */
export const MAX_INVENTORY_IN_PROMPT = 30;

/** Stage 113 — DB text (one entry per line) or an array → clean entry list. */
export function setInventoryEntries(setInventory: string[] | string | null | undefined): string[] {
  const raw = Array.isArray(setInventory) ? setInventory : typeof setInventory === "string" ? setInventory.split(/\r?\n/) : [];
  const out: string[] = [];
  for (const e of raw) {
    const t = (e ?? "").replace(/\s+/g, " ").trim();
    if (t) out.push(t);
  }
  return out;
}

/**
 * Stage 113 — the SET INVENTORY block appended (AFTER sanitizing the visual prompt, so object names are
 * never rewritten) to the wide and layout reference prompts. Empty string when the location has no
 * inventory (legacy rows → the pre-113 prompt, unchanged).
 */
export function formatSetInventoryBlock(setInventory: string[] | string | null | undefined, max = MAX_INVENTORY_IN_PROMPT): string {
  const items = setInventoryEntries(setInventory).slice(0, max);
  if (!items.length) return "";
  return `SET INVENTORY (every item must be visible, exact placement): ${items.join("; ")}.`;
}

export function locationAnglePrompt(visualPrompt: string, name = "", angle: LocationAngle, setInventory?: string[] | string | null): string {
  const place = sanitizeVideoPrompt(visualPrompt, { keep: [name] }).prompt;
  const noPeople = "no people, no animals, no text, no signs with readable words, no logos. Real physical environment with authentic wear and detail.";
  const inventory = formatSetInventoryBlock(setInventory);
  if (angle === "wide")
    return `${VISUAL_STYLE}\nLocation establishing shot: ${place}. ` +
      (inventory ? `${inventory} A highly DETAILED frame: every listed object is present, clearly recognizable and placed exactly where listed, sharp and readable at its real scale. Any object whose placement names a wall or corner sits FLUSH against that exact wall or corner, welded to the architecture with no gap, columns or open space behind it. ` : "") +
      `Wide vertical composition, eye-level camera, ${noPeople} ${LIGHT_LOCK}`;
  if (angle === "layout")
    return `${VISUAL_STYLE}\nThe reference image IS this location, already photographed — do not invent new architecture, materials or layout; this is the same photographed place seen from a SLIGHTLY ELEVATED position: camera raised to about 2.5–3 m at a corner of the space and tilted down ~30–40° (a high angle, NOT top-down and NOT a bird's-eye view — walls and depth stay visible), ` +
      `so the WHOLE LAYOUT is readable at once: where every zone, piece of furniture, prop, doorway and passage sits relative to the others, and how far the place extends: ${place}. ` +
      (inventory ? `${inventory} This layout frame MUST show ALL listed items at once and make their relative placement unmistakable — each object stays exactly where it is in the reference image (same geometry), nothing added, nothing removed. Any object whose placement names a wall or corner sits FLUSH against that exact wall or corner, with no gap, columns or open space behind it — this layout is the FLOOR-PLAN authority for which object sits against which wall. ` : "") +
      `Same architecture, materials, props, time of day, weather and light direction as the reference — only the camera height, tilt and position changed. Wide framing, vertical 9:16, ${noPeople} ${LIGHT_LOCK}`;
  return `${VISUAL_STYLE}\nThe reference image IS this location, already photographed — do not invent new architecture, materials or layout; this is the same photographed place as a medium shot 45° from the side, the action zone where characters would talk: ${place}. ` +
    `Same materials, props, time of day, weather and light direction as the reference — only the framing is closer. Vertical 9:16, ${noPeople} ${LIGHT_LOCK}`;
}

/**
 * Stage 44 — a FIXED photo plan for the extra angles of the SAME location (beyond the base
 * wide / layout / detail). Each slot names its side, height and zone explicitly so the frames are
 * recognizably different camera positions of ONE photographed place — never near-copies of the wide
 * shot. Still NO people (reference plates stay people-free). Stage 111: the bird's-eye "top" slot was
 * removed — the elevated LAYOUT view is now a mandatory base frame (LOCATION_ANGLES), so five slots remain.
 */
export const LOCATION_SHOT_PLAN = [
  { key: "far-edge", label: "С дальнего края", prompt: "a LOW angle (camera near the floor) from the FAR / opposite short edge of the space, the far end now closest to camera, the main zone receding deep behind" },
  { key: "other-zone", label: "Другая зона", prompt: "an eye-level view from the 90° SIDE of a SEPARATE zone or corner of the place not shown in the previous frames (a secondary area, seating, storage, passage) — revealing more of the same place" },
  { key: "threshold", label: "От входа", prompt: "a threshold / doorway view from the ENTRANCE at standing eye height, looking through the opening into the depth of the space (foreground frame, mid-ground, deep background)" },
  { key: "length", label: "Вдоль пространства", prompt: "a long shot at eye level from one END of the space looking straight down its LENGTH, strong leading lines receding to the far wall or horizon" },
  { key: "light", label: "К источнику света", prompt: "a shot aimed TOWARD the main window / light source from mid-height on the shaded side, backlit, showing how the light enters and falls across the surfaces" },
] as const;
export const LOCATION_EXTRA_LABELS = LOCATION_SHOT_PLAN.map((p) => p.label) as readonly string[];
/** Russian UI label of extra slot `i` (wraps for legacy locations that carry more extras than the plan has slots). */
export function locationExtraLabel(i: number): string {
  const n = LOCATION_SHOT_PLAN.length;
  return LOCATION_SHOT_PLAN[((i % n) + n) % n].label;
}
/** @deprecated Stage 16 name — now the six-slot plan texts (kept for older imports). */
export const LOCATION_EXTRA_VARIANTS = LOCATION_SHOT_PLAN.map((p) => p.prompt) as readonly string[];

/** Stage 44 — the anchor sentence shared by every non-wide location plate. */
const SAME_PLACE_ANCHOR = "The reference image IS this location, already photographed — do not invent new architecture, materials or layout; this is another camera position of that same photographed place";

/**
 * Stage 44 — extra plates are ALWAYS generated from the existing photographs of the place (the master
 * wide shot plus every other angle already made), so the prompt always speaks about "the reference
 * image". `index` selects the slot of the six-shot plan. (`opts.withBaseImage` is accepted for
 * backwards compatibility and ignored — the base image is always attached now.)
 */
export function locationExtraAnglePrompt(visualPrompt: string, name = "", index = 0, _opts?: { withBaseImage?: boolean }): string {
  const place = sanitizeVideoPrompt(visualPrompt, { keep: [name] }).prompt;
  const noPeople = "no people, no animals, no text, no signs with readable words, no logos. Real physical environment with authentic wear and detail.";
  const n = LOCATION_SHOT_PLAN.length;
  const slot = LOCATION_SHOT_PLAN[((index % n) + n) % n];
  return `${VISUAL_STYLE}\n${SAME_PLACE_ANCHOR}: ${slot.prompt}: ${place}. ` +
    `Same architecture, materials, colour palette, props, time of day, weather and light direction as the reference — only the camera position, height and framing change; do NOT reproduce the earlier framing. Vertical 9:16, ${noPeople} ${LIGHT_LOCK}`;
}

/**
 * 4-ANGLE REFERENCES — build the edit prompt for ONE extra angle of the SAME place from a FREE-FORM angle
 * description: either a scripted ACCENT camera angle (season.ts S17 "cameraAngle") or a default shot-plan
 * phrase. Like locationExtraAnglePrompt it is ALWAYS generated FROM the existing photographs of the place
 * (attached as image_input), so the model re-photographs the SAME location from the new camera position and
 * never invents new architecture, materials or layout.
 */
export function locationAccentAnglePrompt(visualPrompt: string, name = "", angleDescription = ""): string {
  const place = sanitizeVideoPrompt(visualPrompt, { keep: [name] }).prompt;
  const noPeople = "no people, no animals, no text, no signs with readable words, no logos. Real physical environment with authentic wear and detail.";
  const angle = (angleDescription ?? "").replace(/\s+/g, " ").trim() || "a different camera position of the same space at eye level, a fresh vantage not shown in the earlier frames";
  return `${VISUAL_STYLE}\n${SAME_PLACE_ANCHOR}: ${angle}: ${place}. ` +
    `Same architecture, materials, colour palette, props, time of day, weather and light direction as the reference — only the camera position, height and framing change; do NOT reproduce the earlier framing. Vertical 9:16, ${noPeople} ${LIGHT_LOCK}`;
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
