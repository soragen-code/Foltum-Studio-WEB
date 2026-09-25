/**
 * Moderation softening for image prompts.
 *
 * Image providers (Seedream / GPT Image) reject whole prompts with a generic "Content flagged as potentially
 * sensitive" error. Typical triggers in an ordinary drama storyboard are (a) explicit minor ages ("boy of about
 * twelve"), (b) violence / weapon / injury vocabulary and (c) captivity words ("chained gate"). This module is PURE:
 * it rewrites the prompt with neutral cinematic equivalents and appends an explicit safety note so a retry can pass
 * without the producer having to edit anything. The producer can still edit the prompt manually afterwards.
 */

const UNDER_18 =
  "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|[1-9]|1[0-7])";

/** [pattern, replacement] pairs applied in order; all are case-insensitive with word boundaries. */
const RULES: Array<[RegExp, string]> = [
  // ── minors: drop explicit ages under 18 and childhood nouns ──
  [new RegExp(`\\b(?:of\\s+)?(?:about|around|aged|age|nearly|roughly)\\s+${UNDER_18}(?:\\s*(?:years?|yrs?)(?:\\s*old)?)?\\b`, "gi"), ""],
  [new RegExp(`\\b${UNDER_18}[-\\s](?:year|years|yr)[-\\s]old\\b`, "gi"), ""],
  [/\bchildish\b/gi, "youthful"],
  [/\bundersized\b/gi, "slight"],
  [/\b(?:little|small|young)\s+(?:boy|girl|child|kid)\b/gi, "slight young adult"],
  [/\bboys\b/gi, "young men"],
  [/\bgirls\b/gi, "young women"],
  [/\bboy\b/gi, "young man"],
  [/\bgirl\b/gi, "young woman"],
  [/\b(?:children|kids|toddlers|infants|babies)\b/gi, "young adults"],
  [/\b(?:child|kid|toddler|infant|baby|minor)\b/gi, "young adult"],
  [/\bteen(?:ager)?s?\b/gi, "young adult"],
  // ── violence / weapons / injury ──
  [/\bbloody\b/gi, "stained"],
  [/\bblood\b/gi, "dark stains"],
  [/\bgore\b/gi, "grit"],
  [/\b(?:corpses?|dead bod(?:y|ies)|cadavers?)\b/gi, "motionless figure"],
  [/\b(?:kill(?:s|ed|ing)?|murder(?:s|ed|ing|er)?|slaughter(?:s|ed|ing)?)\b/gi, "confront"],
  [/\b(?:stab(?:s|bed|bing)?)\b/gi, "push"],
  [/\b(?:guns?|pistols?|rifles?|firearms?|revolvers?)\b/gi, "tool"],
  [/\b(?:knife|knives|blades?|daggers?|swords?|axes?)\b/gi, "hand tool"],
  [/\bweapons?\b/gi, "prop"],
  [/\b(?:wound(?:s|ed)?|injur(?:y|ies|ed))\b/gi, "mark"],
  [/\btortur(?:e|ed|ing)\b/gi, "pressure"],
  [/\b(?:explosions?|explod(?:es|ed|ing))\b/gi, "burst of light"],
  [/\bslaps?\b/gi, "taps"],
  [/\bslapped\b/gi, "tapped"],
  [/\bshoves?\b/gi, "guides"],
  [/\bshoved\b/gi, "guided"],
  [/\bhurls?\b/gi, "tosses"],
  [/\bhurled\b/gi, "tossed"],
  [/\b(?:smash(?:es|ed)?|crush(?:es|ed)?)\b/gi, "presses"],
  [/\bscream(?:s|ed|ing)?\b/gi, "calls out"],
  [/\bterror\b/gi, "unease"],
  [/\b(?:suicide|suicidal)\b/gi, "despair"],
  // ── captivity / fire ──
  [/\bchained\b/gi, "locked"],
  [/\bchains\b/gi, "bars"],
  [/\bchain\b/gi, "latch"],
  [/\bburning\b/gi, "glowing"],
  [/\bflames?\b/gi, "warm light"],
  // ── nudity / substances ──
  [/\b(?:naked|nude|nudity|topless)\b/gi, "fully clothed"],
  [/\bsex(?:ual|y)?\b/gi, ""],
  [/\bdrugs?\b/gi, "medicine"],
];

export const MODERATION_SAFETY_NOTE =
  "CONTENT NOTE: family-friendly PG storyboard sketch. Every person is a fully clothed adult. No violence, no gore, no weapons, no injuries, no nudity — calm, dramatic acting only.";

/** Rewrite a prompt with neutral wording and append the safety note. Idempotent. */
export function softenPromptForModeration(prompt: string): string {
  let out = prompt;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  out = out.replace(/[ \t]{2,}/g, " ").replace(/ ,/g, ",").replace(/ \./g, ".");
  if (!out.includes(MODERATION_SAFETY_NOTE)) out = `${out.trimEnd()}\n\n${MODERATION_SAFETY_NOTE}`;
  return out;
}

/** True when a provider error is a content-moderation rejection (not a timeout / overload / generic failure). */
export function isModerationError(err: unknown): boolean {
  const text = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  return /sensitive|flagged|moderation|content policy|contentfilter|nsfw|prohibited|safety|not allowed/.test(text);
}
