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
  isChildAppearance,
  type CharacterRefKind,
} from "@/lib/visual-style";

// ---------------------------------------------------------------------------------------------------
// Stage 49 — explicit ADULT AGE wording in every portrait / shot prompt.
//
// Since Stage 46A the face was a close-up cropped from the full-body frame; the regenerated portraits read
// visually much younger than the character's stated age and Seedance rejected every scene using them with
// E005 ("flagged as sensitive" — a "possible minor" trigger). We now state the character's card age as adult
// wording ("an adult woman, 28 years old") at the front of the description so the image model anchors on an
// adult. This is a clarification only — no content is filtered, softened or removed.
// ---------------------------------------------------------------------------------------------------

function detectGenderNoun(appearance: string): "woman" | "man" | null {
  const a = ` ${appearance.toLowerCase()} `;
  const female = /(?:^|[^a-zа-яё])(she|her|hers|woman|women|female|girl|lady|mother|sister|daughter|wife|actress|queen|женщин|девушк|девочк|мать|сестр|дочь|жена)/;
  const male = /(?:^|[^a-zа-яё])(he|him|his|man|men|male|guy|father|brother|son|husband|king|мужчин|парень|мальчик|отец|брат|сын|муж)/;
  if (female.test(a)) return "woman";
  if (male.test(a)) return "man";
  return null;
}

function parseAgeNumber(age?: string | null): number | null {
  if (!age) return null;
  const m = String(age).match(/\d{1,3}/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 && n < 120 ? n : null;
}

/**
 * Adult-age clause derived from the character card. Returns null for a genuine child (age-appropriate
 * wording is kept) or a stated minor age; otherwise an explicit adult phrase using the card age (and the
 * gender inferred from the appearance) or a safe "late 20s" default when the age is missing/unparseable.
 */
export function adultAgeClause(age: string | null | undefined, appearance = ""): string | null {
  if (isChildAppearance(appearance)) return null; // a real child keeps child proportions/wording
  const noun = detectGenderNoun(appearance);
  const n = parseAgeNumber(age);
  if (n !== null && n < 18) return null; // an explicitly stated minor — never fabricate an adult age
  // Stage 49: emphasise mature, fully-grown adult facial features so the close-up face portrait does not
  // read visually younger than the stated age (the Seedance moderation "possible minor" E005 trigger).
  const mature = "with mature, fully-grown adult facial features";
  if (n !== null) return noun ? `a fully grown adult ${noun}, ${n} years old, ${mature}` : `a fully grown adult, ${n} years old, ${mature}`;
  return noun ? `a fully grown adult ${noun} in their late 20s, ${mature}` : `a fully grown adult in their late 20s, ${mature}`;
}

/** Prepend the adult-age clause (capitalised, as its own sentence) to the character description. */
export function withAdultAge(who: string, age: string | null | undefined, appearance: string): string {
  const clause = adultAgeClause(age, appearance);
  if (!clause) return who;
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}. ${who}`;
}

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
  baseOverride?: string | null,
  age?: string | null
): string {
  const who0 = resolveCharacterBase(appearance, baseOverride);
  // Stage 49: the caller opts in by passing `age` (even null); the adult clause is skipped for crowds and
  // when `age` is undefined (keeps every legacy call — and its tests — byte-identical to the old prompt).
  const who = age !== undefined && tier !== "CROWD" ? withAdultAge(who0, age, appearance) : who0;
  const base = characterImagePrompt(who, shot, name, tier, groupSize, chained, refKind);
  return isFullBodyShot(shot) && tier !== "CROWD" ? withFullBodyProportionsRule(base) : base;
}

/** Extra-angle prompt with the proportion rule on the full-length slots only (right profile stays as is). */
export function characterExtraShotPrompt(appearance: string, name = "", index = 0, refKind: CharacterRefKind = "face", baseOverride?: string | null, age?: string | null): string {
  const who0 = resolveCharacterBase(appearance, baseOverride);
  const who = age !== undefined ? withAdultAge(who0, age, appearance) : who0;
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
