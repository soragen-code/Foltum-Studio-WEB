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
  CHARACTER_EXPRESSION_NOTE,
  FULL_BODY_CLOTHING_RULE,
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
export function adultAgeClause(age: string | null | undefined, appearance = "", genderNoun?: "woman" | "man" | null): string | null {
  if (isChildAppearance(appearance)) return null; // a real child keeps child proportions/wording
  // Stage 125: an explicit gender noun (from Character.gender / the resolver) overrides the text heuristic.
  const noun = genderNoun ?? detectGenderNoun(appearance);
  const n = parseAgeNumber(age);
  if (n !== null && n < 18) return null; // an explicitly stated minor — never fabricate an adult age
  // Stage 49: emphasise mature, fully-grown adult facial features so the close-up face portrait does not
  // read visually younger than the stated age (the Seedance moderation "possible minor" E005 trigger).
  const mature = "with mature, fully-grown adult facial features";
  if (n !== null) return noun ? `a fully grown adult ${noun}, ${n} years old, ${mature}` : `a fully grown adult, ${n} years old, ${mature}`;
  return noun ? `a fully grown adult ${noun} in their late 20s, ${mature}` : `a fully grown adult in their late 20s, ${mature}`;
}

/** Prepend the adult-age clause (capitalised, as its own sentence) to the character description. */
export function withAdultAge(who: string, age: string | null | undefined, appearance: string, genderNoun?: "woman" | "man" | null): string {
  const clause = adultAgeClause(age, appearance, genderNoun);
  if (!clause) return who;
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}. ${who}`;
}

// ---------------------------------------------------------------------------------------------------
// Stage 151 — EXPLICIT age wording in EVERY person-bearing reference prompt (gender AND age must both be
// stated). `adultAgeClause` deliberately returns null for a genuine child or a stated minor so we never
// fabricate an adult age (that would break the child proportions / child-safety logic). But a reference
// prompt must still state the subject's age explicitly. This age-appropriate clause fills exactly that
// gap: for a child / stated minor it emits an explicit, NON-adult age descriptor (the real number when
// known, e.g. "a child, 8 years old" / "a teenager, 15 years old", else "a young child") without any
// "fully grown adult" wording. It returns null for adults / unknown so the adult clause owns that case.
// ---------------------------------------------------------------------------------------------------
export function childAgeClause(age: string | null | undefined, appearance = ""): string | null {
  const n = parseAgeNumber(age);
  const statedMinor = n !== null && n < 18;
  if (!isChildAppearance(appearance) && !statedMinor) return null; // an adult / unknown — not this clause's job
  if (n !== null) return `a ${n >= 13 ? "teenager" : "child"}, ${n} years old`;
  return "a young child"; // a child appearance with no stated number — an explicit, age-appropriate descriptor
}

/**
 * The age clause used by the reference-prompt builders: the adult clause when the subject is an adult
 * (unchanged Stage 49 wording), otherwise the child/minor age-appropriate clause — so age is ALWAYS
 * stated explicitly for a person, and never fabricated as adult for a minor.
 */
export function explicitAgeClause(age: string | null | undefined, appearance = "", genderNoun?: "woman" | "man" | null): string | null {
  return adultAgeClause(age, appearance, genderNoun) ?? childAgeClause(age, appearance);
}

/** Prepend the EXPLICIT age clause (adult or child/minor) as its own capitalised sentence — age is never omitted for a person. */
export function withExplicitAge(who: string, age: string | null | undefined, appearance: string, genderNoun?: "woman" | "man" | null): string {
  const clause = explicitAgeClause(age, appearance, genderNoun);
  if (!clause) return who;
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}. ${who}`;
}

// ---------------------------------------------------------------------------------------------------
// Stage 125 — the character's SEX is forced into every reference prompt.
//
// The bug: a female role ("мать Николя") whose stored appearance did not clearly open with "A woman"
// let Seedream pick the sex freely and it rendered a man. The fix threads the character's sex — the
// explicit Character.gender field as the single source of truth, with a heuristic fallback over the
// role/appearance/name for legacy rows — into the subject description so the prompt LEADS with the sex
// ("A fully grown adult woman, …") and repeats an emphatic sex lock. Seedream has no negative-prompt
// field, so the exclusion of the opposite sex is stated positively in the prompt text.
// ---------------------------------------------------------------------------------------------------

/** Map an explicit Character.gender field value ("male"/"female"/…) to the prompt noun. */
export function genderNounFromField(gender?: string | null): "woman" | "man" | null {
  const g = (gender ?? "").trim().toLowerCase();
  if (/^(female|woman|women|girl|lady|f|ж|жен|женщ)/.test(g)) return "woman";
  if (/^(male|man|men|boy|guy|m|м|муж)/.test(g)) return "man";
  return null;
}

/**
 * Single source of truth for the character's sex noun in the reference prompt: the explicit
 * Character.gender field wins; when it is null (legacy rows written before Stage 125) fall back to the
 * text heuristic over the role / appearance / name so even an un-migrated character resolves correctly.
 */
export function resolveGenderNoun(gender: string | null | undefined, ...texts: (string | null | undefined)[]): "woman" | "man" | null {
  return genderNounFromField(gender) ?? detectGenderNoun(texts.filter(Boolean).join(" "));
}

/** Emphatic in-prompt sex lock (Seedream has no negative field): states the sex and excludes the opposite. */
export function genderLockClause(noun: "woman" | "man"): string {
  const sex = noun === "woman" ? "female" : "male";
  const opposite = noun === "woman" ? "man" : "woman";
  return `This person is unmistakably a ${noun}, clearly ${sex}; do NOT render as a ${opposite}.`;
}

/**
 * Build the subject description with the sex forced to the front (and an emphatic exclusion of the
 * opposite sex). `gender` is the explicit Character.gender ("male"/"female"/null); `role` (and the
 * appearance/name) feed the fallback heuristic. Returns the plain adult-age behaviour when the sex
 * can't be resolved. CROWD groups are handled by the caller (their group wording is kept as-is).
 */
export function withForcedGender(who0: string, age: string | null | undefined, appearance: string, gender: string | null | undefined, role?: string | null, name?: string | null): string {
  const noun = resolveGenderNoun(gender, role, appearance, name);
  // Stage 151: withExplicitAge always states the age — an adult clause ("A fully grown adult woman, 34
  // years old …") for adults, or an age-appropriate child/minor clause ("A child, 8 years old. …") for
  // minors — so every person-bearing reference prompt carries BOTH the sex (gender-lock below) and the age.
  const who = withExplicitAge(who0, age ?? null, appearance, noun);
  return noun ? `${who} ${genderLockClause(noun)}` : who;
}

// Stage 58: the full-length proportion "rule" is now the SAME text as the inline adult proportions block
// (single source of truth in lib/visual-style.ts). Aliasing them removes the near-duplicate second copy that
// pushed the composed full-body prompt past the image provider's 4000-char hard limit (HTTP 422). Because the
// two strings are now identical, `withFullBodyProportionsRule` (idempotent) appends nothing to a prompt that
// already carries the inline block — the adult full-body shot ends up with exactly ONE proportion block —
// while child and back-view frames (which carry a different inline block, or none) still get it appended.
export const FULL_BODY_PROPORTIONS_RULE = FULL_BODY_PROPORTIONS;

/**
 * Stage 58 — hard cap on the character-prompt length sent to the image provider. Seedream rejects any prompt
 * longer than 4000 characters with HTTP 422, which nulled the character's full-body photo. 3900 leaves a small
 * margin under that limit. After the Stage 58 de-duplication a typical full-body prompt is comfortably under
 * this; the cap is a safety net for an unusually long appearance / manual override or a stacked retry suffix.
 */
export const PROMPT_MAX_CHARS = 3900;

/**
 * Guarantee a prompt never exceeds the provider limit. The load-bearing tail — the proportion / anatomy block
 * and everything after it (the trailing background line and any appended corrective suffix) — is kept intact;
 * only the free-text character description is shortened, and always from its END, so the framing, the E005
 * adult-age clause (both at the very start) and the full proportion wording are preserved. A prompt already
 * within the limit is returned byte-for-byte unchanged.
 */
export function clampPromptToLimit(prompt: string, max = PROMPT_MAX_CHARS): string {
  if (prompt.length <= max) return prompt;
  // Split at the FIRST proportion block so the whole tail (proportions + background line + any suffix) is kept.
  let tailStart = -1;
  for (const block of [FULL_BODY_PROPORTIONS_CHILD, FULL_BODY_PROPORTIONS]) {
    const i = prompt.indexOf(block);
    if (i >= 0 && (tailStart < 0 || i < tailStart)) tailStart = i;
  }
  if (tailStart < 0) return prompt.slice(0, max); // no known block — last-resort hard cap
  const tail = prompt.slice(tailStart);
  if (tail.length >= max) return tail.slice(0, max); // pathological: even the tail alone is over the cap
  const head = prompt.slice(0, tailStart);
  const room = max - tail.length;
  // head.length > room here (otherwise the whole prompt would fit); trim the description tail off the head.
  const trimmedHead = head.slice(0, room).replace(/\s+\S*$/, " ");
  return trimmedHead + tail;
}

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
  age?: string | null,
  gender?: string | null,
  role?: string | null
): string {
  const who0 = resolveCharacterBase(appearance, baseOverride);
  // Stage 49: the caller opts in by passing `age` (even null); the adult clause is skipped for crowds and
  // when `age` is undefined (keeps every legacy call — and its tests — byte-identical to the old prompt).
  // Stage 125: when the caller passes `gender` (even null), the SEX is forced (explicit field first, then a
  // heuristic over role/appearance/name for legacy rows). CROWD keeps its group wording untouched.
  const who =
    gender !== undefined && tier !== "CROWD"
      ? withForcedGender(who0, age, appearance, gender, role, name)
      : age !== undefined && tier !== "CROWD"
        ? withAdultAge(who0, age, appearance)
        : who0;
  const base = characterImagePrompt(who, shot, name, tier, groupSize, chained, refKind);
  // Stage 58: clamp only the full-length prompt (the one that carries the long proportion block); a normal-length
  // prompt is returned unchanged, so close-ups, crowds and typical full-body prompts stay byte-identical.
  return isFullBodyShot(shot) && tier !== "CROWD" ? clampPromptToLimit(withFullBodyProportionsRule(base)) : base;
}

/** Extra-angle prompt with the proportion rule on the full-length slots only (right profile stays as is). */
export function characterExtraShotPrompt(appearance: string, name = "", index = 0, refKind: CharacterRefKind = "face", baseOverride?: string | null, age?: string | null, gender?: string | null, role?: string | null): string {
  const who0 = resolveCharacterBase(appearance, baseOverride);
  // Stage 125: force the sex when the caller passes `gender` (explicit field first, heuristic fallback).
  const who = gender !== undefined ? withForcedGender(who0, age, appearance, gender, role, name) : age !== undefined ? withAdultAge(who0, age, appearance) : who0;
  const base = characterExtraAnglePrompt(who, name, index, refKind);
  return isFullBodyExtraIndex(index) ? clampPromptToLimit(withFullBodyProportionsRule(base)) : base;
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
  CHARACTER_EXPRESSION_NOTE,
  FULL_BODY_CLOTHING_RULE,
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
    .replace(/(^|\n)\s*(?:CHARACTER|Character|CLOTHING):\s*/gi, "$1")
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
