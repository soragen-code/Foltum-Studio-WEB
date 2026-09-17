/** Stage 152: every scene OPENS on a CLOSE-UP of the character who begins speaking.
 *
 * The FIRST board of each scene must be a tight (close-up) shot of the character who delivers that scene's
 * FIRST source dialogue line (speech[0].speaker — NOT the last speaker, NOT the addressee). This supersedes the
 * Stage 146 rule that made the first board a whole-cast WIDE ESTABLISHING group shot. Every LATER board keeps its
 * existing Stage 143/146 coverage (singles / OTS / reverse; a mid-scene group wide still degrades — never to a
 * close-up). An action-only scene (no dialogue) keeps the WIDE ESTABLISHING opener (no speaker to favour).
 *
 * Scene boundaries are threaded from the source builders: each SpokenLine now carries its 1-based `scene` number
 * (storyboard-dialogue.ts), the zod speech schema keeps it (storyboard-direction.ts), and planSceneCoverage
 * (board-coverage.ts) detects a boundary when a board's first line's scene number differs from the previous
 * dialogue board's — so the FIRST board of EVERY scene (not just board 1 of the episode) opens on its close-up.
 *
 * Scene-mode note (documented no-op): the scene-mode prompt (lib/scene-prompt.ts) emits NO per-board opening
 * shot-size directive (only a PACE hint), so there is nothing there to make conditional — it is intentionally
 * left unedited. This test therefore exercises the Storyboard board-planning path only.
 *
 * Pure logic only. No network, no DB, no paid generation.
 *
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage152.ts
 */
import assert from 'node:assert/strict';
import { resolveVisibleCast, planSceneCoverage, buildShotSizeLine, buildOffScreenLine } from '../lib/board-coverage';
import { finalizeDirectedBoards, balanceBoardCount, readBoardDirection, boardShotContext, type RawDirectedBoard, type BoardDirection } from '../lib/storyboard-direction';
import { storyboardSource } from '../lib/storyboard-dialogue';

let passed = 0;
function ok(value: unknown, message: string) { assert.ok(value, message); passed++; }

const cast4 = ['Anna', 'Boris', 'Clara', 'Dmitri'];
const g4 = [{ name: 'Anna', gender: 'female' }, { name: 'Boris', gender: 'male' }, { name: 'Clara', gender: 'female' }, { name: 'Dmitri', gender: 'male' }];
// A speech segment; `scene` is optional so tests can exercise both the tagged and untagged paths.
const sp = (speaker: string, addressee: string, text = 'x', delivery = '', scene?: number) =>
  ({ id: `s-${speaker}-${text}`, sourceId: 'src', speaker, addressee, text, delivery, estimatedSec: 1, ...(scene != null ? { scene } : {}) });
const dir = (over: Partial<BoardDirection>): BoardDirection => ({
  version: 134, cast: cast4, shot: 'over_shoulder', focus: 'Anna', listener: 'Boris', addressee: 'Boris', actionEnglish: 'Anna turns to Boris.',
  speech: [sp('Anna', 'Boris', 'Line', 'calmly')], cameraMode: 'LOCKED_OFF', ...over,
} as BoardDirection);

async function main() {

/* ─────────── (1) resolveVisibleCast: the scene opener (board 0) that starts on dialogue → CLOSE-UP of the FIRST speaker ─────────── */
const openCU = resolveVisibleCast(dir({ shot: 'close_up' }), 0, cast4, 'Anna speaks.');
ok(openCU.shotSize === 'CLOSE-UP' && openCU.visible.join() === 'Anna' && openCU.focus === 'Anna' && openCU.offScreen.join() === 'Boris,Clara,Dmitri',
  '(1) scene opener on dialogue → CLOSE-UP of the first speaker (Anna); everyone else off-screen');
// The opener is a close-up REGARDLESS of the direction's requested shot (it is forced by board position 0).
const openFromOts = resolveVisibleCast(dir({ shot: 'over_shoulder', speech: [sp('Anna', 'Boris')] }), 0, cast4, '');
ok(openFromOts.shotSize === 'CLOSE-UP' && openFromOts.visible.join() === 'Anna', '(1) an opener whose direction asked for OTS is still forced to a CLOSE-UP of the first speaker');
// FIRST speaker, not last: a board that opens with two lines (Anna then Boris) → close-up of Anna, never Boris.
const openTwoLines = resolveVisibleCast(dir({ shot: 'over_shoulder', speech: [sp('Anna', 'Boris'), sp('Boris', 'Anna')] }), 0, cast4, '');
ok(openTwoLines.visible.join() === 'Anna' && openTwoLines.focus === 'Anna', '(1) opener favours speech[0] (Anna), NOT the last speaker (Boris)');

/* ─────────── (2) NON-opener boards keep their existing Stage 143/146 coverage (never turned into an opener close-up) ─────────── */
const midMed = resolveVisibleCast(dir({ shot: 'medium' }), 2, cast4, '');
ok(midMed.shotSize === 'MEDIUM' && midMed.visible.join() === 'Anna', '(2) mid-scene medium → speaker single, unchanged');
const midOts = resolveVisibleCast(dir({ shot: 'over_shoulder' }), 2, cast4, '');
ok(midOts.shotSize === 'OVER-THE-SHOULDER' && midOts.visible.join() === 'Anna,Boris', '(2) mid-scene over_shoulder → speaker + addressee, unchanged');
const midRev = resolveVisibleCast(dir({ shot: 'listener_reverse' }), 2, cast4, '');
ok(midRev.shotSize === 'MEDIUM CLOSE-UP' && midRev.visible.join() === 'Anna,Boris' && midRev.focus === 'Boris', '(2) mid-scene listener_reverse → reaction focus on the addressee, unchanged');
const midGrp = resolveVisibleCast(dir({ shot: 'group' }), 2, cast4, '');
ok(midGrp.shotSize === 'WIDE ESTABLISHING' && midGrp.visible.length === 4, '(2) mid-scene group → whole-cast wide, unchanged (never a close-up)');
// A genuine mid-scene close_up on the speaker stays a single on that speaker.
const midCU = resolveVisibleCast(dir({ shot: 'close_up', focus: 'Boris', speech: [sp('Boris', 'Anna')] }), 2, cast4, '');
ok(midCU.shotSize === 'CLOSE-UP' && midCU.visible.join() === 'Boris', '(2) mid-scene close_up → single on the speaker (Boris), unchanged');

/* ─────────── (3) planSceneCoverage: the FIRST board of EVERY scene → CLOSE-UP of that scene's first speaker (scene boundaries via the `scene` tag) ─────────── */
const scened = planSceneCoverage([
  dir({ speech: [sp('Anna', 'Boris', 'a', '', 1)] }),                       // scene 1 opener → close_up Anna
  dir({ shot: 'medium', speech: [sp('Boris', 'Anna', 'b', '', 1)] }),       // scene 1 non-opener → medium unchanged
  dir({ shot: 'over_shoulder', speech: [sp('Anna', 'Boris', 'c', '', 1)] }),// scene 1 non-opener → OTS unchanged
  dir({ shot: 'group', speech: [sp('Clara', 'Dmitri', 'd', '', 2)] }),      // scene 2 opener → close_up Clara
  dir({ shot: 'over_shoulder', speech: [sp('Dmitri', 'Clara', 'e', '', 2)] }),// scene 2 non-opener → OTS unchanged
]);
ok(scened[0].shot === 'close_up' && scened[0].focus === 'Anna', '(3) scene 1 opener → CLOSE-UP of scene 1 first speaker (Anna)');
ok(scened[1].shot === 'medium' && scened[2].shot === 'over_shoulder', '(3) scene 1 non-opener boards keep their shots (medium / OTS) — NOT turned into openers');
ok(scened[3].shot === 'close_up' && scened[3].focus === 'Clara', '(3) scene 2 opener → CLOSE-UP of scene 2 first speaker (Clara), even though it is not board 0');
ok(scened[4].shot === 'over_shoulder', '(3) scene 2 non-opener keeps its shot');
// A mid-scene group wide still degrades to a character-forward OTS/medium — never to a close-up.
const midDegrade = planSceneCoverage([
  dir({ speech: [sp('Anna', 'Boris', 'a', '', 1)] }),
  dir({ shot: 'group', speech: [sp('Boris', 'Anna', 'b', '', 1)] }),
]);
ok(midDegrade[1].shot === 'over_shoulder' && midDegrade[1].focus === 'Boris', '(3) a mid-scene group wide degrades to OTS on the active speaker (not a close-up)');
// The opener still favours the FIRST speaker when the opening board carries two lines.
const openerTwo = planSceneCoverage([dir({ speech: [sp('Anna', 'Boris', 'a', '', 1), sp('Boris', 'Anna', 'b', '', 1)] })]);
ok(openerTwo[0].shot === 'close_up' && openerTwo[0].focus === 'Anna', '(3) opener close-up favours speech[0] (Anna), not the last line (Boris)');

/* ─────────── (4) End-to-end through storyboardSource → balanceBoardCount → finalizeDirectedBoards: two scenes, each opening on its first speaker ─────────── */
const d1 = 'Anna (firmly): "Is the report ready?"\nBoris (calmly): "Yes, last night."';
const d2 = 'Clara (softly): "I checked the numbers."\nDmitri (nodding): "All good."';
const src = storyboardSource({ description: 'A two-scene meeting.' }, [
  { number: 1, action: 'Anna and Boris stand at the table.', dialogue: d1 },
  { number: 2, action: 'Clara and Dmitri sit by the window.', dialogue: d2 },
], g4);
ok(src.segments.length === 4, '(4) four source lines survive the split across two scenes');
ok(src.segments.map(s => s.scene).join(',') === '1,1,2,2', '(4) each ledger line is tagged with its source scene number');
const raw: RawDirectedBoard[] = balanceBoardCount(src.segments.map((seg, i) => ({
  actionOrDialogue: `Beat ${i + 1}`,
  actionEnglish: 'They talk.',
  durationSec: 5, region: 'room',
  speechIds: [seg.id],
  shot: 'over_shoulder',
})) as RawDirectedBoard[], src.segments);
const boards = finalizeDirectedBoards(raw, src.segments, cast4, src.actionSource);
ok(boards.length === 4, '(4) four boards preserved (no lossy merge)');
const plans = boards.map(b => readBoardDirection(b.directionJson)!);
const covs = plans.map((p, i) => resolveVisibleCast(p, i, cast4, boards[i].actionOrDialogue));
// Scene 1 opener = board 0.
ok(plans[0].speech[0].scene === 1 && plans[0].shot === 'close_up' && plans[0].focus === 'Anna'
  && covs[0].shotSize === 'CLOSE-UP' && covs[0].visible.join() === 'Anna',
  '(4) scene 1 board 0 opens on a CLOSE-UP of Anna (scene 1 first source line)');
// Scene 2 opener = the FIRST board whose first line belongs to scene 2 (a non-zero board index).
const s2Idx = plans.findIndex(p => p.speech[0]?.scene === 2);
ok(s2Idx > 0, '(4) scene 2 begins on a later board (non-zero index)');
ok(plans[s2Idx].shot === 'close_up' && plans[s2Idx].focus === 'Clara'
  && covs[s2Idx].shotSize === 'CLOSE-UP' && covs[s2Idx].visible.join() === 'Clara',
  '(4) scene 2 first board opens on a CLOSE-UP of Clara (scene 2 first source line) — resolveVisibleCast honours the baked-in close_up focus at a non-zero index');
// The FIRST speaker of each scene, not the last / the addressee.
ok(plans[0].speech[0].speaker === src.segments[0].speaker && src.segments[0].speaker === 'Anna', '(4) scene 1 first speaker = scene 1 first source line speaker (Anna), not the addressee (Boris)');
ok(plans[s2Idx].speech[0].speaker === src.segments[2].speaker && src.segments[2].speaker === 'Clara', '(4) scene 2 first speaker = scene 2 first source line speaker (Clara), not the addressee (Dmitri)');
// Non-opener boards were NOT turned into openers.
ok(plans[1].shot !== 'close_up' || plans[1].speech[0]?.speaker !== 'Boris' ? plans[1].shot !== 'close_up' : true, '(4) scene 1 second board is not forced into an opener close-up');
ok(plans[1].shot === 'over_shoulder', '(4) scene 1 second board keeps its OTS coverage');

/* ─────────── (5) Invariants preserved: source-line order (S139), 180-degree axis (S134), exact head-count prompt lines ─────────── */
ok(plans.flatMap(p => p.speech.map(s => s.text)).join('|') === src.segments.map(s => s.text).join('|'),
  '(5) S139: every source line appears exactly once, in source order (coverage never touches speech)');
ok(plans.every(p => p.cast.join() === cast4.join()), '(5) cast list untouched on every board');
const ctx0 = boardShotContext(plans[0], 0, covs[0]);
ok(/180-degree/.test(ctx0), '(5) S134: the 180-degree axis rule is still emitted for the opener close-up');
ok(/SHOT SIZE: CLOSE-UP — EXACTLY 1 character in frame: Anna\./.test(ctx0), '(5) opener shot-size line: EXACTLY 1 character (Anna)');
ok(/OFF-SCREEN[^\n]*Boris, Clara, Dmitri/.test(ctx0), '(5) opener names the rest of the cast OFF-SCREEN');
ok(/^SHOT SIZE: CLOSE-UP — EXACTLY 1 character in frame: Anna\./.test(buildShotSizeLine(covs[0])), '(5) buildShotSizeLine: singular, EXACTLY 1 for the close-up opener');
ok(buildOffScreenLine(covs[0]) === 'OFF-SCREEN (not visible in this frame, remain in the location): Boris, Clara, Dmitri.', '(5) buildOffScreenLine names exactly the invisible cast for the opener');

/* ─────────── (6) Action-only scene → the WIDE ESTABLISHING opener is kept (no speaker to favour) ─────────── */
const actionOpener = resolveVisibleCast(dir({ speech: [], shot: 'action', actionEnglish: 'The room falls silent.' }), 0, cast4, 'The room falls silent.');
ok(actionOpener.shotSize === 'WIDE ESTABLISHING' && actionOpener.visible.length === 4, '(6) an action-only opener (no dialogue) keeps the WIDE ESTABLISHING whole-cast establishing shot');
ok(resolveVisibleCast(null, 0, cast4, 'Everyone waits.').shotSize === 'WIDE ESTABLISHING', '(6) a legacy opener without direction stays WIDE ESTABLISHING');
ok(planSceneCoverage([dir({ speech: [], shot: 'action' })])[0].shot === 'action', '(6) planSceneCoverage never rewrites a speechless (action) board into a close-up');

console.log(`Stage 152: PASS (${passed} checks; pure logic, no network/DB, no paid generation)`);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
