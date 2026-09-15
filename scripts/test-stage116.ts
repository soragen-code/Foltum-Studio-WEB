/**
 * Stage 116 — detailed, script-driven video prompts; better fight choreography; no forced frontal / camera-facing poses.
 *  A) References define APPEARANCE ONLY, not pose or camera orientation (anti frontal line-up).
 *  B) Detailed combat mechanics; a crowd that fights in an ACTION scene is an ACTIVE OPPONENT, promoted above the location plates.
 *  C) episodeScriptSystemPrompt forces real fight mechanics for logline battles / creature / pack.
 * Run: timeout 90 npx tsx --tsconfig tsconfig.json scripts/test-stage116.ts
 */
import {
  buildScenePrompt,
  characterReferenceNote,
  REFERENCE_APPEARANCE_ONLY_LINE,
} from '../lib/scene-prompt';
import { ACTION_STAGING_RULE, episodeScriptSystemPrompt } from '../lib/season';
import { VISUAL_STYLE_ID } from '../lib/visual-style';

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
  console.log('ok: ' + msg);
}

// ── A) references define appearance only ─────────────────────────────────────
ok(typeof REFERENCE_APPEARANCE_ONLY_LINE === 'string' && REFERENCE_APPEARANCE_ONLY_LINE.length > 0,
  'REFERENCE_APPEARANCE_ONLY_LINE is exported');
ok(/APPEARANCE ONLY/.test(REFERENCE_APPEARANCE_ONLY_LINE),
  'appearance-only line: references define appearance only');
ok(/NOT POSE OR CAMERA ORIENTATION/.test(REFERENCE_APPEARANCE_ONLY_LINE),
  'appearance-only line: not pose or camera orientation');
ok(/IGNORE the frontal, standing, camera-facing pose/.test(REFERENCE_APPEARANCE_ONLY_LINE),
  'appearance-only line: ignore the frontal / standing / camera-facing reference pose');
ok(/three-quarter/.test(REFERENCE_APPEARANCE_ONLY_LINE) && /in profile/.test(REFERENCE_APPEARANCE_ONLY_LINE) && /from behind/.test(REFERENCE_APPEARANCE_ONLY_LINE),
  'appearance-only line: allows three-quarter / profile / from behind');
ok(/line the characters up frontally/.test(REFERENCE_APPEARANCE_ONLY_LINE),
  'appearance-only line: anti line-up (do NOT line up frontally in a row)');
ok(/do NOT have them all look at the camera/.test(REFERENCE_APPEARANCE_ONLY_LINE),
  'appearance-only line: not everyone looks at the camera');
ok(/foreground \/ mid-ground \/ background/.test(REFERENCE_APPEARANCE_ONLY_LINE),
  'appearance-only line: distribute through the depth of the frame');
ok(/ONLY when the beat truly requires it/.test(REFERENCE_APPEARANCE_ONLY_LINE),
  'appearance-only line: face to camera only when the beat requires it');

// characterReferenceNote — identity only, pose from the scene
const note = characterReferenceNote('Kara');
ok(/appearance and identity ONLY/.test(note), 'characterReferenceNote: appearance & identity only');
ok(/NOT their pose or camera orientation/.test(note), 'characterReferenceNote: not pose or camera orientation');
ok(/from THIS scene's action/.test(note), 'characterReferenceNote: pose comes from the scene action');
ok(/need not face the camera/.test(note), 'characterReferenceNote: need not face the camera');
ok(note.includes('Kara'), 'characterReferenceNote: names the character');

// ── B) combat choreography rule ─────────────────────────────────────────────
ok(/ACTION STAGING/.test(ACTION_STAGING_RULE), 'ACTION_STAGING_RULE: action staging header');
ok(/MECHANICS/.test(ACTION_STAGING_RULE), 'ACTION_STAGING_RULE: MECHANICS section');
ok(/who does what to whom/.test(ACTION_STAGING_RULE), 'ACTION_STAGING_RULE: names who does what to whom');
ok(/CONTACT & IMPACT/.test(ACTION_STAGING_RULE), 'ACTION_STAGING_RULE: CONTACT & IMPACT section');
ok(/VISIBLE physical contact/.test(ACTION_STAGING_RULE) && /struck body REACTS/.test(ACTION_STAGING_RULE),
  'ACTION_STAGING_RULE: visible contact and body reaction');
ok(/DIFFERENT poses/.test(ACTION_STAGING_RULE), 'ACTION_STAGING_RULE: participants hold different poses');
ok(/CREATURE \/ PACK FIGHTS/.test(ACTION_STAGING_RULE), 'ACTION_STAGING_RULE: creature / pack fights section');
ok(/ACTIVE OPPONENT in direct physical contact/.test(ACTION_STAGING_RULE),
  'ACTION_STAGING_RULE: creature is an active opponent in contact');
ok(/COLLIDING in the SAME frame/.test(ACTION_STAGING_RULE), 'ACTION_STAGING_RULE: creature and hero collide in the same frame');
ok(/never merely standing in the background/.test(ACTION_STAGING_RULE), 'ACTION_STAGING_RULE: creature is not a backdrop');
// old symmetrical "squared toward the opponent" wording removed
ok(!/bodies squared toward the opponent/.test(ACTION_STAGING_RULE),
  'ACTION_STAGING_RULE: legacy "bodies squared toward the opponent" phrasing removed');

// ── C) episode script system prompt forces real fight mechanics ──────────────
const sys = episodeScriptSystemPrompt('en', 1);
ok(/R9\. ACTION SCENES/.test(sys), 'episodeScriptSystemPrompt: R9 action-scenes rule present');
ok(/anything the logline promises/.test(sys), 'R9: logline battle / attack becomes an action scene');
ok(/a monster \/ creature \/ pack assault/.test(sys), 'R9: names creature / pack assaults');
ok(/never merely a conversation ABOUT fighting/.test(sys), 'R9: not a conversation about fighting');
ok(/REAL MECHANICS beat by beat/.test(sys), 'R9: action text names real mechanics beat by beat');
ok(/never a vague "they fight", "they battle" or "they clash"/.test(sys), 'R9: rejects vague "they fight"');
ok(/that creature is an ACTIVE attacker in direct contact with the hero/.test(sys),
  'R9: creature opponent is an active attacker, not a backdrop');
ok(/sceneKind/.test(sys) && sys.includes('"action"'), 'R9: fight beats carry sceneKind action');

// ── B/C) buildScenePrompt: combat crowd promoted above location plates in an action scene ─
const url = (s: string) => 'https' + '://media.invalid/' + VISUAL_STYLE_ID + '/' + s + '.png';
const hero = { characterId: 'h', name: 'Kara', imageFull: url('kara'), appearance: 'battered leather armor', age: '28', tier: 'LEAD' };
const wolves = { characterId: 'w', name: 'the wolf pack', imageFull: url('wolves'), appearance: 'grey dire wolves, glowing eyes', tier: 'CROWD' };
const location = { id: 'loc', name: 'Frozen ravine', imageUrl: url('ravine-wide'), imageReverse: url('ravine-layout') };

const actionScene = {
  id: 's-a', number: 3, episodeId: 'ep1', status: 'generating',
  sceneKind: 'action',
  videoPrompt: '[SHOT TYPE]: low wide\n[ACTION]: Kara swings her axe as the wolf pack lunges at her, one wolf knocked back, another biting her arm.\n[CHARACTER]: Kara\n[TRANSITION]: cut',
  dialogue: 'KARA (snarling): "Come on, then!"',
  action: 'Kara fights off the wolf pack: she dodges the first lunge, swings her axe into the second wolf, is knocked to one knee.',
  startState: 'WORLD: Kara cornered.\nCAMERA: low wide', endState: 'Kara standing over a fallen wolf.',
} as any;

const actionBuilt = buildScenePrompt({ scene: actionScene, characters: [hero, wolves], location, previous: null } as any);
const aKinds = actionBuilt.retryRefs.map(r => r.kind);
ok(aKinds.includes('crowd'), 'action scene: crowd reference is present');
const crowdIdx = aKinds.indexOf('crowd');
const firstLocIdx = aKinds.indexOf('location');
ok(crowdIdx >= 0 && firstLocIdx >= 0 && crowdIdx < firstLocIdx,
  `action scene: combat crowd sits BEFORE the location plates (crowd@${crowdIdx} < loc@${firstLocIdx})`);
const combatRef = actionBuilt.retryRefs[crowdIdx];
ok(/ACTIVE OPPONENT/.test(combatRef.note ?? ''), 'action scene: combat crowd note flags it an ACTIVE OPPONENT');
ok(/direct physical contact with the hero/.test(combatRef.note ?? ''), 'action scene: combat crowd note says in contact with the hero');
ok(actionBuilt.prompt.includes(REFERENCE_APPEARANCE_ONLY_LINE),
  'action scene: prompt body carries the appearance-only / anti-frontal directive');
ok(actionBuilt.prompt.includes('Kara'), 'action scene: prompt references the scene participants');

// dialogue scene with the SAME crowd mentioned → stays a background extra, LAST after location plates
const dialogueScene = {
  id: 's-d', number: 4, episodeId: 'ep1', status: 'generating',
  sceneKind: 'dialogue',
  videoPrompt: '[SHOT TYPE]: medium\n[ACTION]: Kara talks about the wolf pack she survived.\n[CHARACTER]: Kara\n[TRANSITION]: cut',
  dialogue: 'KARA: "The wolf pack nearly killed me."',
  action: 'Kara sits by the fire and describes the wolf pack.',
  startState: 'WORLD: Kara by fire.\nCAMERA: medium', endState: 'Kara looks into the flames.',
} as any;
const dlgBuilt = buildScenePrompt({ scene: dialogueScene, characters: [hero, wolves], location, previous: null } as any);
const dKinds = dlgBuilt.retryRefs.map(r => r.kind);
const dCrowdIdx = dKinds.indexOf('crowd');
const dLastLocIdx = dKinds.lastIndexOf('location');
ok(dCrowdIdx >= 0 && dLastLocIdx >= 0 && dCrowdIdx > dLastLocIdx,
  `dialogue scene: mentioned crowd stays a background extra AFTER the location plates (crowd@${dCrowdIdx} > loc@${dLastLocIdx})`);
const dCrowdRef = dlgBuilt.retryRefs[dCrowdIdx];
ok(/extras/.test(dCrowdRef.note ?? '') && !/ACTIVE OPPONENT/.test(dCrowdRef.note ?? ''),
  'dialogue scene: crowd keeps the plain extras note (not an active opponent)');

// prompt must stay far below the old 24k-char bloat bug
ok(actionBuilt.prompt.length < 12000, `action prompt stays compact, not bloated (${actionBuilt.prompt.length} chars)`);

console.log(`Stage 116: PASS (${passed} checks)`);
