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
import { characterImagePrompt, characterExtraAnglePrompt, CHARACTER_EXTRA_VARIANTS, type CharacterRefKind } from "@/lib/visual-style";

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
  refKind: CharacterRefKind = "face"
): string {
  const base = characterImagePrompt(appearance, shot, name, tier, groupSize, chained, refKind);
  return isFullBodyShot(shot) && tier !== "CROWD" ? withFullBodyProportionsRule(base) : base;
}

/** Extra-angle prompt with the proportion rule on the full-length slots only (right profile stays as is). */
export function characterExtraShotPrompt(appearance: string, name = "", index = 0, refKind: CharacterRefKind = "face"): string {
  const base = characterExtraAnglePrompt(appearance, name, index, refKind);
  return isFullBodyExtraIndex(index) ? withFullBodyProportionsRule(base) : base;
}
