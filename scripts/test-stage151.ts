/**
 * Stage 151 — three fixes, verified with pure/synthetic logic only (no network, no LLM, no DB, no paid
 * generations):
 *
 *  (1) EVERY reference-image prompt in which a PERSON appears must state BOTH the gender AND the age
 *      explicitly. The Stage 125 gender-lock is preserved (unchanged); Stage 151 adds an explicit age to
 *      EVERY person-bearing reference via withExplicitAge/explicitAgeClause. For an adult the wording is
 *      byte-identical to the Stage 49 adult clause; for a genuine child / stated minor an age-appropriate
 *      NON-adult clause is emitted ("a child, N years old" / "a teenager, N years old" / "a young child")
 *      — an age is never fabricated as adult for a minor, and never omitted.
 *
 *  (2) "Reset to Auto" for the episode SCRIPT (сценарий) regenerates it from scratch by the current rules
 *      (a season-job directive with an EMPTY instruction + force overwrite = "write from the current
 *      story/footage by the current rules", never reuse the stored/manual script). Proven via
 *      scriptResetDirective / isScriptResetDirective.
 *
 *  (3) "Reset to Auto" for the season STORY / plot (сюжет) regenerates it from scratch by the current
 *      rules, driven by the current synopsis + current structure, through the LIVE deterministic builder
 *      (buildFullStoryFromStructure) — the previously stored prose is discarded, never reused. Proven via
 *      rebuildAutoStory.
 *
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage151.ts
 */
import {
  characterShotPrompt,
  characterExtraShotPrompt,
  withForcedGender,
  withExplicitAge,
  explicitAgeClause,
  childAgeClause,
  adultAgeClause,
} from '../lib/full-body-prompt';
import { scriptResetDirective, isScriptResetDirective, rebuildAutoStory } from '../lib/reset-to-auto';
import { buildFullStoryFromStructure } from '../lib/season';

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
  console.log('ok: ' + msg);
}

// ───────────────────────── Requirement 1 — gender AND age explicit in every person reference ─────────

// -- child age clause unit behaviour --
ok(childAgeClause('8', 'a little boy playing in the yard') === 'a child, 8 years old',
  'childAgeClause: numbered young child → "a child, 8 years old"');
ok(childAgeClause('15', 'a teenager') === 'a teenager, 15 years old',
  'childAgeClause: stated-minor teen → "a teenager, 15 years old"');
ok(childAgeClause(null, 'a small girl in a red dress') === 'a young child',
  'childAgeClause: child appearance without a number → "a young child"');
ok(childAgeClause('30', 'an adult standing') === null,
  'childAgeClause: an adult → null (adult clause owns that case)');

// -- adult regression: explicitAgeClause must be byte-identical to the Stage 49 adult clause for adults --
{
  const a = adultAgeClause('34', 'A woman with dark hair.', 'woman');
  const e = explicitAgeClause('34', 'A woman with dark hair.', 'woman');
  ok(a !== null && a === e, 'explicitAgeClause === adultAgeClause for an adult (Stage 49 wording unchanged)');
}

// -- ADULT person reference: gender AND age both explicit, gender-lock intact --
{
  const p = characterShotPrompt('A woman with dark hair.', 'full', 'Мария', 'MAIN', null, false, 'face', null, '34', 'female', 'мать');
  ok(/adult woman/.test(p), 'adult ref: states gender ("adult woman")');
  ok(/34 years old/.test(p), 'adult ref: states age explicitly ("34 years old")');
  ok(/unmistakably a woman/.test(p) && /do NOT render as a man/.test(p),
    'adult ref: Stage 125 gender-lock preserved (unmistakably a woman / do NOT render as a man)');
}

// -- CHILD person reference: age explicit and NON-adult, gender-lock still present --
{
  const p = characterShotPrompt('A 9-year-old boy with freckles.', 'full', 'Коля', 'MAIN', null, false, 'face', null, '9', 'male', 'сын');
  ok(/9 years old/.test(p), 'child ref: states the real age explicitly ("9 years old")');
  ok(!/fully grown adult/.test(p), 'child ref: no fabricated adult age ("fully grown adult" absent)');
  ok(/do NOT render as a woman/.test(p), 'child ref: gender-lock still present for the boy');
}

// -- STATED MINOR (teen) reference: age-appropriate teen wording --
{
  const who = withExplicitAge('A slender youth.', '15', 'a 15 year old teenager', 'man');
  ok(/teenager, 15 years old/.test(who), 'stated-minor ref: "teenager, 15 years old"');
  ok(!/fully grown adult/.test(who), 'stated-minor ref: not rendered as a fully grown adult');
}

// -- extra-angle path also carries gender + age --
{
  const p = characterExtraShotPrompt('A man with a beard.', 'Иван', 1, 'face', null, '40', 'male', 'отец');
  ok(/adult man/.test(p) && /40 years old/.test(p), 'extra-angle ref: gender ("adult man") + age ("40 years old")');
  ok(/do NOT render as a woman/.test(p), 'extra-angle ref: gender-lock preserved');
}

// -- gender-lock regression (Stage 125): withForcedGender still emits the lock --
ok(/This person is unmistakably a woman/.test(withForcedGender('X.', '34', 'A woman.', 'female', 'мать')),
  'withForcedGender regression: gender-lock clause still emitted');

// ───────────────────────── Requirement 2 — reset the SCRIPT to auto (regenerate by current rules) ─────

{
  const d = scriptResetDirective('ep-1');
  ok(JSON.stringify(d) === JSON.stringify({ episodeIds: ['ep-1'], instruction: '', force: true }),
    'scriptResetDirective: { episodeIds:["ep-1"], instruction:"", force:true }');
  ok(isScriptResetDirective(d) === true, 'isScriptResetDirective: true for a genuine reset directive');
  ok(isScriptResetDirective({ instruction: 'make it darker', force: true }) === false,
    'isScriptResetDirective: false when a manual instruction is present (not a reset)');
  ok(isScriptResetDirective({ instruction: '', force: false }) === false,
    'isScriptResetDirective: false without force overwrite (would skip an already-written episode)');
  ok(isScriptResetDirective(null) === false, 'isScriptResetDirective: false for null');
}

// ───────────────────────── Requirement 3 — reset the STORY/plot to auto (rebuild from the synopsis) ───

{
  const structure = {
    title: 'Season One',
    logline: 'A quiet town hides a loud secret.',
    episodes: [
      { number: 1, title: 'Arrival', description: 'SHOT 1: A car rolls into town. SHOT 2: A door slams. CLIFFHANGER (last frame): A shadow on the wall.' },
      { number: 2, title: 'The Note', description: 'SHOT 1: OPENS ON: A shadow on the wall. SHOT 2: A note is found. CLIFFHANGER (last frame): A scream.' },
    ],
  };
  const synopsis = 'In a small mountain town, a newcomer uncovers a decades-old conspiracy.';
  const stale = 'STALE MANUALLY EDITED PLOT TEXT THAT MUST NOT BE REUSED';

  const rebuilt = rebuildAutoStory(structure, 'en', synopsis);
  const fresh = buildFullStoryFromStructure(structure, 'en', synopsis);
  ok(rebuilt === fresh, 'rebuildAutoStory: identical to the live deterministic builder buildFullStoryFromStructure');
  ok(rebuilt !== stale && !rebuilt.includes('STALE'), 'rebuildAutoStory: the stored/manual prose is discarded, not reused');
  ok(rebuilt.includes('Arrival') && rebuilt.includes('The Note'),
    'rebuildAutoStory: driven by the current structure (both episodes present)');
  ok(rebuilt.includes('conspiracy') || rebuilt.includes('mountain town'),
    'rebuildAutoStory: driven by the current synopsis (overview line derived from it)');
}

console.log(`Stage 151: PASS (${passed} checks)`);
