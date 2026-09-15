/**
 * Stage 118 — three changes:
 *  A) New "Hiding identity" genre template: a hidden-master power-fantasy arc the model must follow.
 *  B) Cast continuity across shots/scenes — the on-screen group never silently swaps between cuts.
 *  C) A scene's "Generate Video" button is gated on the previous scene being generated first.
 * Run: timeout 90 npx tsx --tsconfig tsconfig.json scripts/test-stage118.ts
 */
import { GENRES, GENRE_BY_ID, genresToEnglish, ideaAutoUserPrompt } from '../lib/idea';
import { buildScenePrompt, CAST_CONTINUITY_LINE } from '../lib/scene-prompt';
import { CONTINUITY_RULE } from '../lib/season';
import { isPrevSceneReady } from '../app/project/[id]/_components/scenes-stage';
import { VISUAL_STYLE_ID } from '../lib/visual-style';

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
  console.log('ok: ' + msg);
}

// ── A) Hiding identity genre template ────────────────────────────────────────
const hiding = GENRES.find((g) => g.id === 'hiding_identity') as { id: string; label: string; en: string; premise?: string } | undefined;
ok(!!hiding, 'GENRES contains a hiding_identity entry');
ok(hiding!.label === 'Hiding identity', 'hiding_identity label is "Hiding identity"');
ok(typeof hiding!.premise === 'string' && hiding!.premise.length > 200, 'hiding_identity carries a non-empty premise');
ok(GENRE_BY_ID['hiding_identity'] === hiding, 'GENRE_BY_ID indexes hiding_identity');
ok(genresToEnglish(['hiding_identity']).join('') === 'hidden-master power fantasy',
  'genresToEnglish maps hiding_identity to its English descriptor');
ok(genresToEnglish(['horror']).join('') === 'horror', 'genresToEnglish still maps existing genres (horror)');

const prem = hiding!.premise ?? '';
ok(/hidden master|hidden-master/i.test(prem), 'premise mentions the hidden-master trope');
ok(/janitor|homeless|beggar|servant/i.test(prem), 'premise names a lowly disguise (janitor / homeless / beggar / servant)');
ok(/mock|humiliat|underestimat/i.test(prem), 'premise: the hero is mocked / humiliated / underestimated');
ok(/one by one|one after another/i.test(prem), 'premise: enemies are defeated one by one, escalating');
ok(/beg .*mercy|grovel/i.test(prem), 'premise: the defeated beg for mercy');
ok(/sunset/i.test(prem), 'premise: he walks off into the sunset');

const autoHiding = ideaAutoUserPrompt(['hiding_identity']);
ok(/STORY TEMPLATE TO FOLLOW \(mandatory arc\)/.test(autoHiding), 'ideaAutoUserPrompt injects the STORY TEMPLATE block for hiding_identity');
ok(autoHiding.includes(prem), 'ideaAutoUserPrompt embeds the full premise text');
ok(/make all specifics fresh/i.test(autoHiding), 'ideaAutoUserPrompt: follow the arc but make specifics fresh');

const autoHorror = ideaAutoUserPrompt(['horror']);
ok(!/STORY TEMPLATE TO FOLLOW/.test(autoHorror), 'ideaAutoUserPrompt: a genre without a premise gets NO STORY TEMPLATE block');
const autoNone = ideaAutoUserPrompt([]);
ok(!/STORY TEMPLATE TO FOLLOW/.test(autoNone), 'ideaAutoUserPrompt: empty genres get NO STORY TEMPLATE block');
// combined selection still injects the template once
const autoCombo = ideaAutoUserPrompt(['action', 'hiding_identity']);
ok(/STORY TEMPLATE TO FOLLOW/.test(autoCombo) && autoCombo.includes('hidden-master power fantasy'),
  'ideaAutoUserPrompt: template injected when hiding_identity is combined with another genre');

// ── B) Cast continuity across the cut ────────────────────────────────────────
ok(typeof CAST_CONTINUITY_LINE === 'string' && CAST_CONTINUITY_LINE.length > 0, 'CAST_CONTINUITY_LINE is exported');
ok(/CAST CONTINUITY ACROSS THE CUT/.test(CAST_CONTINUITY_LINE), 'CAST_CONTINUITY_LINE: header');
ok(/carry over from the end of the previous shot/.test(CAST_CONTINUITY_LINE), 'CAST_CONTINUITY_LINE: cast carries over');
ok(/do NOT swap the on-screen group/.test(CAST_CONTINUITY_LINE), 'CAST_CONTINUITY_LINE: no silent group swap');
ok(/SHOW them leaving/.test(CAST_CONTINUITY_LINE) && /SHOW them entering/.test(CAST_CONTINUITY_LINE),
  'CAST_CONTINUITY_LINE: entrances and exits are shown');
ok(/Nobody vanishes/.test(CAST_CONTINUITY_LINE), 'CAST_CONTINUITY_LINE: nobody vanishes between cuts');

// season CONTINUITY_RULE strengthened with the cast carry-over clause
ok(/SAME CAST CARRIES OVER/.test(CONTINUITY_RULE), 'CONTINUITY_RULE: SAME CAST CARRIES OVER clause added');
ok(/replace a group of N people with a different group/.test(CONTINUITY_RULE), 'CONTINUITY_RULE: forbids replacing a group of N people');

// buildScenePrompt includes the line on a continuous seam
const url = (s: string) => 'https' + '://media.invalid/' + VISUAL_STYLE_ID + '/' + s + '.png';
const hero = { characterId: 'h', name: 'Kara', imageFull: url('kara'), appearance: 'leather armor', age: '28', tier: 'LEAD' };
const location = { id: 'loc', name: 'Hall', imageUrl: url('hall'), imageReverse: url('hall2') };
const prevScene = {
  id: 's1', number: 1, episodeId: 'ep1', endStateActual: 'Kara stands by the door, guard beside her.',
} as any;
const contScene = {
  id: 's2', number: 2, episodeId: 'ep1', status: 'generating', continuesFrom: 'same-scene',
  videoPrompt: '[SHOT TYPE]: medium\n[ACTION]: Kara turns to the guard.\n[CHARACTER]: Kara\n[TRANSITION]: cut',
  dialogue: 'KARA: "Stay here."', action: 'Kara turns to the guard.',
  startState: 'WORLD: Kara by door.\nCAMERA: medium', endState: 'Kara faces the guard.',
} as any;
const contBuilt = buildScenePrompt({ scene: contScene, characters: [hero], location, previous: prevScene } as any);
ok(contBuilt.prompt.includes(CAST_CONTINUITY_LINE), 'buildScenePrompt: continuous seam carries the cast-continuity directive');

// a sequence-breaking scene (location-change) with no previous seam does NOT force it
const breakScene = {
  id: 's3', number: 3, episodeId: 'ep1', status: 'generating', continuesFrom: 'location-change',
  videoPrompt: '[SHOT TYPE]: wide\n[ACTION]: Kara arrives at a new plaza.\n[CHARACTER]: Kara\n[TRANSITION]: cut',
  dialogue: 'KARA: "Finally."', action: 'Kara walks into the plaza.',
  startState: 'WORLD: Kara enters plaza.\nCAMERA: wide', endState: 'Kara stops in the plaza.',
} as any;
const breakBuilt = buildScenePrompt({ scene: breakScene, characters: [hero], location, previous: prevScene } as any);
ok(!breakBuilt.prompt.includes(CAST_CONTINUITY_LINE), 'buildScenePrompt: a location-change break does NOT force the cast-continuity directive');

// ── C) Generate-Video gate on the previous scene ─────────────────────────────
const scenesNone = [
  { id: 'a', number: 1, status: 'pending' },
  { id: 'b', number: 2, status: 'pending' },
  { id: 'c', number: 3, status: 'pending' },
] as any[];
ok(isPrevSceneReady(scenesNone, 0) === true, 'isPrevSceneReady: first scene is always allowed');
ok(isPrevSceneReady(scenesNone, 1) === false, 'isPrevSceneReady: second scene blocked while the first has no video');
ok(isPrevSceneReady(scenesNone, 2) === false, 'isPrevSceneReady: third scene blocked while the second has no video');

const scenesOne = [
  { id: 'a', number: 1, status: 'generated', videoUrl: 'https://x/v.mp4' },
  { id: 'b', number: 2, status: 'pending' },
  { id: 'c', number: 3, status: 'pending' },
] as any[];
ok(isPrevSceneReady(scenesOne, 1) === true, 'isPrevSceneReady: second scene allowed once the first has a videoUrl');
ok(isPrevSceneReady(scenesOne, 2) === false, 'isPrevSceneReady: third scene still blocked while the second has no video');

const scenesStatus = [
  { id: 'a', number: 1, status: 'accepted' },
  { id: 'b', number: 2, status: 'pending' },
] as any[];
ok(isPrevSceneReady(scenesStatus, 1) === true, 'isPrevSceneReady: accepted previous scene counts as ready');

console.log('Stage 118: PASS (' + passed + ' checks)');
