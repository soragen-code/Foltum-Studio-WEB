/**
 * Stage 125 — character SEX forced into the reference prompt.
 *
 * A dedicated `gender` field ("male" | "female") is the single source of truth for a character's sex — set
 * by the idea LLM (consistent with role/kinship) and persisted on Character. The reference-prompt builders
 * force that sex to the FRONT of the subject description and add an emphatic exclusion of the opposite sex,
 * so a female role ("мать Николя") can never render as a man (Seedream has no negative field → the exclusion
 * is positive prompt text). Legacy rows with gender=null fall back to a heuristic over role/appearance/name.
 *
 * Pure/synthetic checks on the prompt builders, the gender resolver, the idea schema and the shared 9:16
 * constant — no network, no paid generations.
 * Run: timeout 90 npx tsx --tsconfig tsconfig.json scripts/test-stage125.ts
 */
import {
  characterShotPrompt,
  characterExtraShotPrompt,
  genderNounFromField,
  resolveGenderNoun,
  genderLockClause,
} from '../lib/full-body-prompt';
import { REFERENCE_ASPECT_RATIO } from '../lib/visual-style';
import { normalizeGender, characterCardSchema, characterCardToData, toCharacterCard, CHARACTER_GENDERS } from '../lib/idea';

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
  console.log('ok: ' + msg);
}

const NEUTRAL = 'Wearing a plain dark t-shirt and blue jeans, athletic build, standing in a room.'; // no sex words

// ── (1) gender field normalization & resolver ────────────────────────────────────────────────────────
ok(normalizeGender('female') === 'female' && normalizeGender('Woman') === 'female' && normalizeGender('ж') === 'female', 'normalizeGender → female for female/woman/ж');
ok(normalizeGender('male') === 'male' && normalizeGender('Man') === 'male' && normalizeGender('муж') === 'male', 'normalizeGender → male for male/man/муж');
ok(normalizeGender('') === null && normalizeGender(undefined) === null && normalizeGender('xyz') === null, 'normalizeGender → null when unknown/empty');
ok(genderNounFromField('female') === 'woman' && genderNounFromField('male') === 'man' && genderNounFromField(null) === null, 'genderNounFromField maps field → prompt noun');
// Explicit field WINS over contradicting text.
ok(resolveGenderNoun('female', 'A man with a thick beard', 'John') === 'woman', 'resolveGenderNoun: explicit field overrides contradicting text');
// Fallback heuristic when field is null.
ok(resolveGenderNoun(null, 'мать Николя', NEUTRAL, 'Celia Roberts') === 'woman', 'resolveGenderNoun: null field → heuristic from role "мать" → woman');
ok(resolveGenderNoun(null, 'father of the family', NEUTRAL, 'Daniel') === 'man', 'resolveGenderNoun: null field → heuristic from role "father" → man');
ok(resolveGenderNoun(null, 'mysterious figure', 'a person', 'Sam') === null, 'resolveGenderNoun: null field + no cues → null');

// ── (2) FEMALE character reference prompt leads with the correct sex, excludes the opposite ───────────
const female = characterShotPrompt(NEUTRAL, 'full', 'Celia Roberts', 'SUPPORTING', null, false, 'face', null, '34', 'female', 'мать Николя');
ok(/A fully grown adult woman/i.test(female), 'female: prompt LEADS with "a fully grown adult woman"');
ok(/clearly female/i.test(female) && /unmistakably a woman/i.test(female), 'female: emphatic sex lock present (unmistakably a woman, clearly female)');
ok(/do NOT render as a man/i.test(female), 'female: opposite sex (man) explicitly excluded');
ok(!/adult man\b/i.test(female), 'female: never leads with / states an adult MAN');

// ── (3) MALE character reference prompt is the mirror image ───────────────────────────────────────────
const male = characterShotPrompt(NEUTRAL, 'full', 'Daniel Hayes', 'MAIN', null, false, 'face', null, '40', 'male', 'отец');
ok(/A fully grown adult man/i.test(male), 'male: prompt LEADS with "a fully grown adult man"');
ok(/clearly male/i.test(male) && /unmistakably a man/i.test(male), 'male: emphatic sex lock present (unmistakably a man, clearly male)');
ok(/do NOT render as a woman/i.test(male), 'male: opposite sex (woman) explicitly excluded');

// ── (4) FALLBACK: legacy row (gender=null) still resolves the sex from the role ───────────────────────
const legacyFemale = characterShotPrompt(NEUTRAL, 'full', 'Celia Roberts', 'SUPPORTING', null, false, 'face', null, '34', null, 'мать Николя');
ok(/A fully grown adult woman/i.test(legacyFemale) && /do NOT render as a man/i.test(legacyFemale), 'fallback: gender=null + role "мать" → female prompt');
const legacyMale = characterShotPrompt(NEUTRAL, 'full', 'Daniel', 'MAIN', null, false, 'face', null, '40', null, 'father / dad');
ok(/A fully grown adult man/i.test(legacyMale) && /do NOT render as a woman/i.test(legacyMale), 'fallback: gender=null + role "father" → male prompt');

// ── (5) Extra-angle prompt also forces the sex ────────────────────────────────────────────────────────
const extraFemale = characterExtraShotPrompt(NEUTRAL, 'Celia Roberts', 1, 'full', null, '34', 'female', 'мать Николя');
ok(/adult woman/i.test(extraFemale) && /do NOT render as a man/i.test(extraFemale), 'extra angle: female sex forced');

// ── (6) CROWD groups keep their group wording (no per-person sex lock) ────────────────────────────────
const crowd = characterShotPrompt('A group of women at a wedding, various ages, festive dresses.', 'full', 'Wedding guests', 'CROWD', 12, false, 'face', null, '30-50', 'female', 'guests');
ok(!/unmistakably a woman/i.test(crowd), 'CROWD: per-person sex-lock clause is NOT added (group wording kept)');

// ── (7) Legacy call (no gender arg) is unchanged — no sex-lock clause injected ────────────────────────
const legacyNoArgs = characterShotPrompt(NEUTRAL, 'full', 'Someone');
ok(!/unmistakably a (woman|man)/i.test(legacyNoArgs), 'legacy call without gender arg: no sex-lock clause (byte-compatible path)');

// ── (8) genderLockClause shape ────────────────────────────────────────────────────────────────────────
ok(genderLockClause('woman').includes('woman') && genderLockClause('woman').includes('do NOT render as a man'), 'genderLockClause(woman) states woman, excludes man');
ok(genderLockClause('man').includes('man') && genderLockClause('man').includes('do NOT render as a woman'), 'genderLockClause(man) states man, excludes woman');

// ── (9) idea schema: gender is parsed, persisted, and consistent ──────────────────────────────────────
ok((CHARACTER_GENDERS as readonly string[]).length === 2, 'CHARACTER_GENDERS has male & female');
const card = characterCardSchema.parse({
  name: 'Celia Roberts', age: '34', gender: 'Female', role: 'мать Николя',
  appearance: 'A woman with dark hair.', personality: 'caring', firstAppearance: 'opening scene',
});
ok(card.gender === 'female', 'characterCardSchema normalizes gender "Female" → "female"');
ok(characterCardToData(card).gender === 'female', 'characterCardToData persists gender');
// Missing gender still validates (optional) → null, and toCharacterCard fills from a DB row.
const cardNoGender = characterCardSchema.parse({
  name: 'X', age: '20', role: 'r', appearance: 'A man.', personality: 'p', firstAppearance: 'f',
});
ok(cardNoGender.gender === null, 'characterCardSchema: missing gender is optional → null');
ok(toCharacterCard({ name: 'Y', gender: 'male', role: 'отец' }).gender === 'male', 'toCharacterCard normalizes a DB row gender');

// ── (10) Format unchanged — references stay 9:16 (Stage 124) ──────────────────────────────────────────
ok(REFERENCE_ASPECT_RATIO === '9:16', 'Stage 124 preserved: REFERENCE_ASPECT_RATIO is still 9:16');

console.log(`Stage 125: PASS (${passed} checks)`);
