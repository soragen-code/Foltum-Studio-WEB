/**
 * Stage 46D — anatomical-constraints block for every FULL-BODY character frame.
 *
 * The observed failure: a head-to-toe figure that passes the framing guard but has an elongated torso
 * (~4 heads instead of ~3), short legs (~40% of the height), an undersized head (8+ heads tall) and a
 * bloated midsection next to thin arms / shins. This rule spells out the natural proportions and the
 * neutral camera so the image model has no room for vertical stretching, and the prompt wrappers below
 * apply it wherever a full-length frame is generated (bulk job + per-slot /shot route). Face / profile
 * close-ups never get it — it is a full-length rule only.
 */
import {
  characterImagePrompt,
  characterExtraAnglePrompt,
  CHARACTER_EXTRA_VARIANTS,
  VISUAL_STYLE,
  FULL_BODY_FRAMING,
  FULL_BODY_PROPORTIONS,
  FULL_BODY_PROPORTIONS_CHILD,
  type CharacterRefKind,
} from "@/lib/visual-style";

export const FULL_BODY_PROPORTIONS_RULE =
  "BODY PROPORTION RULE (strict, natural realistic human anatomy): total height about 7 to 7.5 heads (never 8 or more — the head must NOT be undersized); " +
  "legs (hip joint to sole) are about HALF of the total height — not shorter; the torso is NOT elongated: shoulders to hip is about 3 head-heights, no stretched midsection; " +
  "the head is natural size for the body; ONE consistent build across the whole body — torso, arms and legs share the same volume and thickness (no bloated midsection with thin arms or shins); " +
  "camera at chest height, neutral 50mm-equivalent lens, straight-on, no wide-angle distortion, no vertical stretching or squashing of the figure.";

/** Which shots of the character set are full-length (and therefore get the proportion rule). */
export function isFullBodyShot(shot: "front" | "profile" | "full"): boolean {
  return shot === "full";
}

/** Extra angle `index` is a full-length frame when its slot of the fixed plan is the full-body BACK (odd index). */
export function isFullBodyExtraIndex(index: number): boolean {
  const n = CHARACTER_EXTRA_VARIANTS.length;
  return ((index % n) + n) % n === 1;
}

/** Append the proportion rule to a full-length prompt (idempotent; a prompt already carrying it is returned as is). */
export function withFullBodyProportionsRule(prompt: string): string {
  return prompt.includes(FULL_BODY_PROPORTIONS_RULE) ? prompt : `${prompt} ${FULL_BODY_PROPORTIONS_RULE}`;
}

/**
 * Base-shot prompt used by the bulk job and the /shot route: the visual-style builder, plus the proportion
 * rule for the full-body shot of a PERSON (crowd groups and close-ups are untouched).
 */
export function characterShotPrompt(
  appearance: string,
  shot: "front" | "profile" | "full",
  name = "",
  tier?: string | null,
  groupSize?: number | null,
  chained = false,
  refKind: CharacterRefKind = "face",
  baseOverride?: string | null
): string {
  const who = resolveCharacterBase(appearance, baseOverride);
  const base = characterImagePrompt(who, shot, name, tier, groupSize, chained, refKind);
  return isFullBodyShot(shot) && tier !== "CROWD" ? withFullBodyProportionsRule(base) : base;
}

/** Extra-angle prompt with the proportion rule on the full-length slots only (right profile stays as is). */
export function characterExtraShotPrompt(appearance: string, name = "", index = 0, refKind: CharacterRefKind = "face", baseOverride?: string | null): string {
  const who = resolveCharacterBase(appearance, baseOverride);
  const base = characterExtraAnglePrompt(who, name, index, refKind);
  return isFullBodyExtraIndex(index) ? withFullBodyProportionsRule(base) : base;
}

// ---------------------------------------------------------------------------------------------------
// Stage 46E — character prompt view / edit
// ---------------------------------------------------------------------------------------------------

/**
 * The AUTO character prompt shown to the user: the full-body FRONT text-to-image prompt (the identity anchor
 * of the whole set — style block, character description, framing and the proportion rule). Nothing is sent
 * to the model from here; it is exactly what `characterShotPrompt(appearance, "full", …)` produces.
 */
export function characterBasePrompt(appearance: string, name = "", tier?: string | null, groupSize?: number | null): string {
  return characterShotPrompt(appearance, "full", name, tier, groupSize, false, "face");
}

/** Fixed fragments of the composed prompt that every shot re-adds itself (so they must not be duplicated from a saved override). */
const WRAPPER_FRAGMENTS = [
  FULL_BODY_FRAMING,
  VISUAL_STYLE,
  FULL_BODY_PROPORTIONS_RULE,
  FULL_BODY_PROPORTIONS,
  FULL_BODY_PROPORTIONS_CHILD,
  "Neutral unobtrusive background. No text or logos.",
];

/**
 * Turn a saved manual prompt into the character DESCRIPTION every shot is built around. The user edits the
 * composed auto prompt, so the known wrapper fragments (framing / style / proportions / background line) are
 * stripped and re-applied per shot by the builders — a saved-unchanged auto prompt therefore generates exactly
 * like auto, while an edited description (or a fully custom text) is carried to ALL five shots.
 */
export function overrideToCharacterDescription(override: string): string {
  let s = override;
  for (const frag of WRAPPER_FRAGMENTS) s = s.split(frag).join(" ");
  s = s
    .replace(/(^|\n)\s*Character:\s*/g, "$1")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/(^|\n)[\s.]+(?=\n|$)/g, "$1")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .replace(/\.+$/, "")
    .trim();
  return s || override.trim();
}

/** Appearance actually used by the shot builders: the manual override (when non-empty) or the stored appearance. */
export function resolveCharacterBase(appearance: string, baseOverride?: string | null): string {
  const o = (baseOverride ?? "").trim();
  return o ? overrideToCharacterDescription(o) : appearance;
}
