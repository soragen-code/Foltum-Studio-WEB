/**
 * Stage 149 — LEANER CONDITIONAL VIDEO-CLIP PROMPT.
 *
 * Four fixes to the emitted Seedance clip prompt (buildScenePrompt — used by BOTH Scene and
 * Storyboard clips via the video job), changing nothing else visual:
 *
 *  (1) DROP absent-character naming — the emitted OPENING/END STATE keeps only the positive
 *      "IN FRAME:" roster; the screenwriter's "NOT IN FRAME: <names>" clause is stripped (naming
 *      the absent cast tends to summon them). The numeric people counter + generic "no other
 *      people" guard stay.
 *  (2) NO CYRILLIC — every emitted string is ASCII English; residual Cyrillic (crowd / location
 *      names, REFERENCE MAP echoes, state text) is romanised centrally.
 *  (3) GUARD [TRANSITION] — the tag no longer renders the NEXT shot's content; it is replaced with
 *      a fixed neutral hard-cut note. Internal seam metadata (openingState/endState) is untouched.
 *  (4) MODULARISE the rules — two-party dialogue staging (EYELINES CONNECT) only with 2+ speakers;
 *      the CONFRONTATION block only for confrontation/fight; interior-only environment rules
 *      (LOCATION ANCHOR / TABLE-SURFACE props) only for interiors.
 *
 * Pure/synthetic checks only — no network, no LLM, no DB, no paid generations.
 * Run: timeout 120 npx tsx --tsconfig tsconfig.json scripts/test-stage149.ts
 */
import {
  buildScenePrompt,
  SINGLE_SPEAKER_DIRECTION,
  NEUTRAL_TRANSITION_LINE,
  GAZE_AT_LISTENER_LINE,
  LOCATION_ANCHOR_LINE,
  SURFACE_PROPS_IMMUTABLE_LINE,
  stripNotInFrame,
  neutralizeTransition,
  distinctSpeakerCount,
  isInteriorLocation,
  isConfrontation,
} from '../lib/scene-prompt';
import { hasCyrillic, transliterateCyrillic } from '../lib/sanitize-prompt';
import { PACE_DIRECTION, CONFRONTATION_STAGING_SENTENCE } from '../lib/season';
import { VISUAL_STYLE_ID, REFERENCE_ASPECT_RATIO } from '../lib/visual-style';

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
  console.log('ok: ' + msg);
}

const url = (s: string) => 'https' + '://media.invalid/' + VISUAL_STYLE_ID + '/' + s + '.png';

/* ============================================================================================= */
/*  (0) UNIT — the Stage-149 helpers in isolation                                                 */
/* ============================================================================================= */

// stripNotInFrame — removes the absent-cast clause, keeps the positive IN FRAME listing + counter.
{
  const state =
    'WORLD: the office. IN FRAME: Alex at the desk. (b) NOT IN FRAME: Mara, Delacroix. PEOPLE IN FRAME: exactly 1 person.';
  const out = stripNotInFrame(state);
  ok(!/NOT\s+IN\s+FRAME/i.test(out), 'stripNotInFrame: the "NOT IN FRAME: <names>" clause is removed');
  ok(!/Mara/.test(out) && !/Delacroix/.test(out), 'stripNotInFrame: the absent names are gone');
  ok(/IN FRAME: Alex at the desk/.test(out), 'stripNotInFrame: the positive IN FRAME roster is kept');
  ok(/PEOPLE IN FRAME: exactly 1 person/.test(out), 'stripNotInFrame: the numeric people counter is kept');
  // bare (non-parenthesised) form is stripped too
  ok(!/NOT IN FRAME/i.test(stripNotInFrame('IN FRAME: Kara. NOT IN FRAME: Bob.')),
    'stripNotInFrame: bare "NOT IN FRAME:" form is stripped as well');
}

// neutralizeTransition — replaces the [TRANSITION] content, keeps the token, drops the next-shot copy.
{
  const p = 'body\n[TRANSITION]: Cut to the next shot of Alex entering the office and greeting Mara.\ntail';
  const out = neutralizeTransition(p);
  ok(out.includes(NEUTRAL_TRANSITION_LINE), 'neutralizeTransition: injects the neutral hard-cut line');
  ok(!/entering the office/.test(out), 'neutralizeTransition: the next-shot content is gone');
  ok(/\[TRANSITION\]/.test(out), 'neutralizeTransition: the [TRANSITION] token itself is preserved');
  ok(out.includes('body') && out.includes('tail'), 'neutralizeTransition: surrounding copy is untouched');
}

// transliterateCyrillic / hasCyrillic — romanise Cyrillic, pass everything else through.
{
  ok(transliterateCyrillic('Прохожие на улице') === 'Prokhozhie na ulitse',
    'transliterateCyrillic: romanises a Cyrillic crowd name deterministically');
  ok(!hasCyrillic(transliterateCyrillic('Улица мегаполиса')),
    'transliterateCyrillic: output has no residual Cyrillic');
  ok(transliterateCyrillic('café — "quote" é') === 'café — "quote" é',
    'transliterateCyrillic: non-Cyrillic (em-dash, curly quotes, accented Latin) passes through unchanged');
}

// distinctSpeakerCount / isInteriorLocation / isConfrontation — the gate predicates.
ok(distinctSpeakerCount('ALEX: "Hi."') === 1, 'distinctSpeakerCount: one labelled speaker → 1');
ok(distinctSpeakerCount('ALEX: "Hi."\nMARA: "Hey."\nALEX: "Bye."') === 2,
  'distinctSpeakerCount: two distinct speakers → 2 (repeats deduped)');
ok(isInteriorLocation('INT. kitchen — day', false) === true, 'isInteriorLocation: INT. slate → interior');
ok(isInteriorLocation('EXT. city street — day', true) === false,
  'isInteriorLocation: EXT. slate → exterior even with plates');
ok(isInteriorLocation(null, true) === true, 'isInteriorLocation: no slate + plates → interior (fallback)');
ok(isConfrontation({ sceneKind: 'action' }) === true, 'isConfrontation: an action scene → true');
ok(isConfrontation({ sceneKind: 'dialogue', action: 'He shoves her against the wall.' }) === true,
  'isConfrontation: fight keyword in the action → true');
ok(isConfrontation({ sceneKind: 'dialogue', action: 'They sip coffee quietly.' }) === false,
  'isConfrontation: an ordinary dialogue scene → false');

/* ============================================================================================= */
/*  Shared fixtures for the buildScenePrompt integration checks                                   */
/* ============================================================================================= */

const interiorLocation = {
  id: 'loc', name: 'Kitchen',
  imageUrl: url('kitchen-wide'), imageReverse: url('kitchen-layout'),
  setInventory: 'long table — center; white mug — on the table, left',
};
const exteriorLocation = {
  id: 'loc2', name: 'City Street',
  imageUrl: url('street-wide'), imageReverse: url('street-layout'),
  setInventory: 'lamp post — left; bench — right',
};
const twoChars = [
  { characterId: 'c1', name: 'Alex', imageFull: url('alex'), appearance: 'grey coat', tier: 'MAIN' },
  { characterId: 'c2', name: 'Mara', imageFull: url('mara'), appearance: 'red scarf', tier: 'MAIN' },
];
const oneChar = [
  { characterId: 'c1', name: 'Alex', imageFull: url('alex'), appearance: 'grey coat', tier: 'MAIN' },
];

/* ============================================================================================= */
/*  (1) DROP absent-character naming from the emitted OPENING / END STATE                         */
/* ============================================================================================= */
{
  const scene = {
    id: 's1', number: 1, episodeId: 'ep1', status: 'generating', sceneKind: 'dialogue',
    continuesFrom: 'new-sequence',
    locationDesc: 'INT. kitchen — day',
    videoPrompt: '[SHOT TYPE]: medium\n[ACTION]: Alex talks.',
    dialogue: 'ALEX: "You came."\nMARA: "I did."',
    action: 'Alex talks to Mara across the table.',
    startState: 'WORLD: the kitchen. IN FRAME: Alex and Mara at the table. (a) NOT IN FRAME: Delacroix, Sylvie. PEOPLE IN FRAME: exactly 2 persons.',
    endState: 'WORLD: the kitchen. IN FRAME: Alex and Mara. NOT IN FRAME: Delacroix. PEOPLE IN FRAME: exactly 2 persons.',
  } as any;
  const built = buildScenePrompt({ scene, characters: twoChars, location: interiorLocation, previous: null } as any);
  ok(!/NOT\s+IN\s+FRAME/i.test(built.prompt), 'scene: the emitted prompt contains NO "NOT IN FRAME" clause');
  ok(!/Delacroix/.test(built.prompt) && !/Sylvie/.test(built.prompt),
    'scene: the absent-character names never reach the emitted prompt');
  ok(/IN FRAME: Alex and Mara/.test(built.prompt), 'scene: the positive IN FRAME roster survives');
  ok(/exactly 2 persons/.test(built.prompt), 'scene: the numeric people counter survives');
  // the RAW returned state (used internally) is untouched — only the emitted copy is stripped
  ok(/NOT IN FRAME/i.test(built.openingState ?? ''), 'scene: the returned openingState (internal) is NOT stripped');
}

/* ============================================================================================= */
/*  (2) NO CYRILLIC anywhere in the emitted prompt                                                */
/* ============================================================================================= */
{
  const scene = {
    id: 's2', number: 1, episodeId: 'ep1', status: 'generating', sceneKind: 'dialogue',
    continuesFrom: 'new-sequence',
    locationDesc: 'EXT. Улица мегаполиса — day',
    videoPrompt: '[SHOT TYPE]: wide\n[ACTION]: Alex walks.',
    dialogue: 'ALEX: "Keep moving."',
    action: 'Alex walks down the street.',
    startState: 'WORLD: Улица мегаполиса at dusk. IN FRAME: Alex. PEOPLE IN FRAME: exactly 1 person.',
    endState: 'WORLD: the street corner. IN FRAME: Alex.',
  } as any;
  const crowdChars = [
    { characterId: 'c1', name: 'Alex', imageFull: url('alex'), appearance: 'grey coat', tier: 'MAIN' },
    { characterId: 'cr', name: 'Прохожие на улице', imageFull: url('crowd'), appearance: 'city pedestrians', tier: 'CROWD' },
  ];
  const built = buildScenePrompt({ scene, characters: crowdChars, location: exteriorLocation, previous: null } as any);
  ok(!hasCyrillic(built.prompt), 'scene: the emitted prompt is fully ASCII — no Cyrillic anywhere');
  ok(!hasCyrillic(built.basePrompt), 'scene: basePrompt is fully ASCII too');
  ok(built.prompt.includes('Ulitsa megapolisa') || built.prompt.includes('ulitsa megapolisa'),
    'scene: the Cyrillic location name is romanised into the prompt');
  ok(built.prompt.includes('Keep moving'), 'scene: the English dialogue line is preserved verbatim');
}

/* ============================================================================================= */
/*  (3) GUARD [TRANSITION] — no next-shot content rendered inside this clip                       */
/* ============================================================================================= */
{
  const scene = {
    id: 's3', number: 1, episodeId: 'ep1', status: 'generating', sceneKind: 'dialogue',
    continuesFrom: 'new-sequence',
    locationDesc: 'INT. office — day',
    videoPrompt: '[SHOT TYPE]: medium\n[ACTION]: Alex signs a form.\n[TRANSITION]: Cut to the next shot of Alex entering the boardroom and confronting the panel.',
    dialogue: 'ALEX: "Done."',
    action: 'Alex signs a form at the desk.',
    startState: 'WORLD: the office. IN FRAME: Alex.',
    endState: 'WORLD: the office. IN FRAME: Alex.',
  } as any;
  const built = buildScenePrompt({ scene, characters: oneChar, location: interiorLocation, previous: null } as any);
  ok(built.prompt.includes(NEUTRAL_TRANSITION_LINE), 'scene: the neutral hard-cut [TRANSITION] line is emitted');
  ok(!/entering the boardroom/.test(built.prompt) && !/confronting the panel/.test(built.prompt),
    'scene: the scripted next-shot content is NOT rendered into the clip prompt');
  ok(/\[TRANSITION\]/.test(built.prompt), 'scene: the [TRANSITION] tag token is preserved (9-tag order intact)');
}

/* ============================================================================================= */
/*  (4a) MODULARISE — a SINGLE-speaker dialogue clip omits the two-party staging rules            */
/* ============================================================================================= */
{
  const scene = {
    id: 's4', number: 1, episodeId: 'ep1', status: 'generating', sceneKind: 'dialogue',
    continuesFrom: 'new-sequence',
    locationDesc: 'INT. study — night',
    videoPrompt: '[SHOT TYPE]: medium-close\n[ACTION]: Alex speaks to himself.',
    dialogue: 'ALEX: "I should have known."',
    action: 'Alex sits alone, thinking aloud.',
    startState: 'WORLD: the study. IN FRAME: Alex.',
    endState: 'WORLD: the study. IN FRAME: Alex.',
  } as any;
  const built = buildScenePrompt({ scene, characters: oneChar, location: interiorLocation, previous: null } as any).prompt;
  ok(built.includes(SINGLE_SPEAKER_DIRECTION), 'single-speaker: the compact SINGLE_SPEAKER_DIRECTION is used');
  ok(!built.includes(PACE_DIRECTION), 'single-speaker: the two-party PACE_DIRECTION is NOT emitted');
  ok(!built.includes(GAZE_AT_LISTENER_LINE), 'single-speaker: EYELINES CONNECT (two-party) is NOT emitted');
  ok(!built.includes(CONFRONTATION_STAGING_SENTENCE), 'single-speaker: no confrontation block (ordinary beat)');
  ok(built.includes('I should have known'), 'single-speaker: the English line is preserved verbatim');
}

/* ============================================================================================= */
/*  (4b) MODULARISE — an EXTERIOR clip omits the interior-only environment rules                  */
/* ============================================================================================= */
{
  const scene = {
    id: 's5', number: 1, episodeId: 'ep1', status: 'generating', sceneKind: 'dialogue',
    continuesFrom: 'new-sequence',
    locationDesc: 'EXT. city street — day',
    videoPrompt: '[SHOT TYPE]: wide\n[ACTION]: Alex and Mara walk.',
    dialogue: 'ALEX: "This way."\nMARA: "Right behind you."',
    action: 'Alex and Mara walk down the street.',
    startState: 'WORLD: the street. IN FRAME: Alex and Mara.',
    endState: 'WORLD: the street corner. IN FRAME: Alex and Mara.',
  } as any;
  const built = buildScenePrompt({ scene, characters: twoChars, location: exteriorLocation, previous: null } as any).prompt;
  ok(!built.includes(LOCATION_ANCHOR_LINE), 'exterior: the interior LOCATION ANCHOR rule is NOT emitted');
  ok(!built.includes(SURFACE_PROPS_IMMUTABLE_LINE), 'exterior: the interior TABLE/SURFACE PROPS rule is NOT emitted');
  // two-party staging is still present (this IS a 2-speaker dialogue)
  ok(built.includes(GAZE_AT_LISTENER_LINE), 'exterior: EYELINES CONNECT is still present (two speakers)');
}

/* ============================================================================================= */
/*  (4c) CONTROL — a 2-speaker INTERIOR dialogue KEEPS all the modular rules                      */
/* ============================================================================================= */
{
  const scene = {
    id: 's6', number: 1, episodeId: 'ep1', status: 'generating', sceneKind: 'dialogue',
    continuesFrom: 'new-sequence',
    locationDesc: 'INT. kitchen — day',
    videoPrompt: '[SHOT TYPE]: medium two-shot\n[ACTION]: Alex faces Mara.',
    dialogue: 'ALEX: "You stayed."\nMARA: "I did."',
    action: 'Alex faces Mara across the table.',
    startState: 'WORLD: the kitchen. IN FRAME: Alex and Mara at the table.',
    endState: 'WORLD: the kitchen. IN FRAME: Alex and Mara.',
  } as any;
  const built = buildScenePrompt({ scene, characters: twoChars, location: interiorLocation, previous: null } as any).prompt;
  ok(built.includes(PACE_DIRECTION), 'interior 2-speaker: the two-party PACE_DIRECTION is emitted');
  ok(built.includes(GAZE_AT_LISTENER_LINE), 'interior 2-speaker: EYELINES CONNECT is emitted');
  ok(built.includes(LOCATION_ANCHOR_LINE), 'interior 2-speaker: the LOCATION ANCHOR rule is emitted');
  ok(built.includes(SURFACE_PROPS_IMMUTABLE_LINE), 'interior 2-speaker: the TABLE/SURFACE PROPS rule is emitted');
  ok(!built.includes(SINGLE_SPEAKER_DIRECTION), 'interior 2-speaker: the single-speaker tail is NOT used');
  ok(!built.includes(CONFRONTATION_STAGING_SENTENCE), 'interior 2-speaker (calm): no confrontation block');
}

/* ============================================================================================= */
/*  (4d) CONFRONTATION — a fight beat DOES pull in the confrontation staging                      */
/* ============================================================================================= */
{
  const scene = {
    id: 's7', number: 1, episodeId: 'ep1', status: 'generating', sceneKind: 'dialogue',
    continuesFrom: 'new-sequence',
    locationDesc: 'INT. warehouse — night',
    videoPrompt: '[SHOT TYPE]: medium\n[ACTION]: Alex shoves Mara.',
    dialogue: 'ALEX: "Where is it?"\nMARA: "I do not know!"',
    action: 'Alex shoves Mara against the crates and grabs her collar.',
    startState: 'WORLD: the warehouse. IN FRAME: Alex and Mara.',
    endState: 'WORLD: the warehouse. IN FRAME: Alex and Mara.',
  } as any;
  const built = buildScenePrompt({ scene, characters: twoChars, location: interiorLocation, previous: null } as any).prompt;
  ok(built.includes(CONFRONTATION_STAGING_SENTENCE), 'confrontation: the CONFRONTATION staging block is emitted for a fight beat');
}

/* ============================================================================================= */
/*  (5) REGRESSION — invariants that must not shift                                               */
/* ============================================================================================= */
ok(REFERENCE_ASPECT_RATIO === '9:16', 'regression: reference aspect ratio is still 9:16');

console.log(`Stage 149: PASS (${passed} checks)`);
