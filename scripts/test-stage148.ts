/** Stage 148: CONTENT-DERIVED storyboard board count (no hard 12–15 window). Previously the planner forced
 * every episode into exactly 12–15 boards: balanceBoardCount split up to a MIN=12 floor / merged down to a
 * MAX=15 ceiling and THREW "after balancing, N boards remain, outside the required 12–15 ..." for anything
 * else, and finalizeDirectedBoards threw "Storyboard planning conflict: exactly 12–15 boards required". A
 * short, sparse-yet-real scene (e.g. ~29s of dialogue across 9 speech segments) that comfortably fits in 9
 * boards of 4–6s was rejected even though NO speech overflowed. Stage 148 derives the count from the content:
 *   - a sparse scene may yield FEWER than 12 boards with no error,
 *   - a dialogue-heavy scene may yield MORE than 15 boards with no error,
 *   - speech is NEVER truncated, omitted, re-ordered or sped up (invariant S139),
 *   - each board stays within its 4–6s budget, and a generous CONTENT-DERIVED ceiling only trims
 *     pathological LLM over-splitting via lossless merges.
 * Pure logic, no network, no paid generation. Stage 133–147 invariants (verbatim in-order speech via
 * reconcileSpeechIds, per-board 4–6s budget, 9:16 vertical, Stage 146 character-forward coverage, SCENES
 * untouched) are re-asserted where they intersect the board-count change. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { storyboardSource, estimatedSpeechSeconds } from '../lib/storyboard-dialogue';
import {
  normalizeBoards, validateBoards, contentBoardBounds, storyboardBoardsSystemPrompt,
  STORYBOARD_MIN_BOARD_SEC, STORYBOARD_MAX_BOARD_SEC,
} from '../lib/storyboard';
import {
  balanceBoardCount, finalizeDirectedBoards, readBoardDirection, reconcileSpeechIds,
  type RawDirectedBoard,
} from '../lib/storyboard-direction';

let passed = 0;
function ok(value: unknown, message: string) { assert.ok(value, message); passed++; }
function noThrow(fn: () => unknown, message: string): unknown {
  try { const r = fn(); passed++; return r; }
  catch (err) { assert.fail(`${message} (threw: ${err instanceof Error ? err.message : String(err)})`); }
}

const cast2 = ['Anna', 'Boris'];
const genders = (names: string[]) => names.map(n => ({ name: n, gender: n === 'Boris' ? 'male' : 'female' }));
const ACTION = 'Anna and Boris talk in the room.';

/** Build a source through the REAL dialogue pipeline (ledger ids match the running app). `lineText(i)` lets
 * a caller control each line's length so we can reproduce specific total-speech durations. */
function buildSource(n: number, lineText: (i: number) => string, action = ACTION) {
  const lines = Array.from({ length: n }, (_, i) => `${cast2[i % 2]} (calmly): "${lineText(i)}"`).join('\n');
  const scenes = [{ number: 1, action, dialogue: lines }];
  return { scenes, src: storyboardSource({ description: 'A conversation.' }, scenes, genders(cast2)) };
}
const D = (extra: Partial<RawDirectedBoard>): RawDirectedBoard =>
  ({ actionOrDialogue: 'Beat', actionEnglish: 'Steady reactions.', durationSec: 5, region: 'at the table', speechIds: [], ...extra });

async function main() {

/* ─────────── 0) contentBoardBounds is pure and content-derived (no fixed 12–15) ─────────── */
{
  const empty = contentBoardBounds([]);
  ok(empty.min === 1, 'contentBoardBounds: a scene with no speech still needs at least one board');
  const nine = contentBoardBounds(Array.from({ length: 9 }, () => 3.2)); // ~29s across 9 segments
  ok(nine.min <= 9 && nine.ceiling >= 9, 'contentBoardBounds: 9 short segments fit at or below the ceiling (9 boards is valid)');
  const many = contentBoardBounds(Array.from({ length: 20 }, () => 4)); // dialogue-heavy
  ok(many.ceiling > 15, 'contentBoardBounds: a dialogue-heavy scene allows a ceiling ABOVE the old max of 15');
}

/* ─────────── 1) THE REGRESSION: ~29s / 9 speech segments → 9 boards, NO conflict, count NOT forced to 12 ─────────── */
{
  const base = buildSource(9, () => 'We really must decide this today.'); // ≈3.2s each
  const seg = base.src.segments;
  const order = seg.map(s => s.id);
  const totalSpeech = seg.reduce((s, x) => s + estimatedSpeechSeconds(x), 0);
  ok(seg.length === 9, 'nine source speech segments are built');
  ok(totalSpeech > 25 && totalSpeech < 40, `episode carries ~${Math.round(totalSpeech)}s of dialogue (the scenario the old planner rejected)`);
  // Model produced exactly 9 boards, one line each — nothing overflows a 4–6s board.
  const plan9: RawDirectedBoard[] = order.map(id => D({ speechIds: [id], shot: 'over_shoulder' }));
  const balanced = noThrow(() => balanceBoardCount(plan9, seg), 'balanceBoardCount does NOT throw for a valid 9-board plan') as RawDirectedBoard[];
  ok(balanced.length === 9, 'the 9-board plan is kept at 9 boards — the count is NOT inflated to the old MIN of 12');
  const fin = noThrow(() => finalizeDirectedBoards(balanced, seg, cast2, base.src.actionSource), 'finalizeDirectedBoards completes with 9 boards (no "planning conflict: exactly 12–15")') as ReturnType<typeof finalizeDirectedBoards>;
  ok(fin.length === 9 && fin.length < 12, 'the finalized episode has 9 boards — fewer than 12 is allowed, no error');
  ok(fin.every(b => b.durationSec >= STORYBOARD_MIN_BOARD_SEC && b.durationSec <= STORYBOARD_MAX_BOARD_SEC), 'every board stays within the 4–6s window');
  const finIds = fin.flatMap(b => readBoardDirection(b.directionJson)!.speech.map(s => s.id));
  ok(JSON.stringify(finIds) === JSON.stringify(order), 'all 9 speech segments appear exactly once, in source order (no truncation — S139)');
  const finText = fin.flatMap(b => readBoardDirection(b.directionJson)!.speech.map(s => s.text));
  ok(JSON.stringify(finText) === JSON.stringify(seg.map(s => s.text)), 'spoken text is restored verbatim from the ledger by ID (no paraphrase)');
}

/* ─────────── 2) SHORT / SPARSE scene → fewer than 12 boards, no error ─────────── */
{
  const base = buildSource(2, () => 'Yes, of course.'); // two short lines
  const seg = base.src.segments;
  // Establishing + two dialogue boards + a closing action board = 4 boards.
  const plan: RawDirectedBoard[] = [
    D({ actionOrDialogue: 'Establishing wide of the room.' }),
    D({ speechIds: [seg[0].id], shot: 'over_shoulder' }),
    D({ speechIds: [seg[1].id], shot: 'listener_reverse' }),
    D({ actionOrDialogue: 'They fall silent.' }),
  ];
  const balanced = noThrow(() => balanceBoardCount(plan, seg), 'balanceBoardCount does NOT throw for a sparse 4-board scene') as RawDirectedBoard[];
  ok(balanced.length === 4 && balanced.length < 12, 'a sparse scene keeps its 4 boards — it is NOT padded up to 12');
  const fin = noThrow(() => finalizeDirectedBoards(balanced, seg, cast2, base.src.actionSource), 'finalize completes for a sub-12 sparse scene') as ReturnType<typeof finalizeDirectedBoards>;
  const finIds = fin.flatMap(b => readBoardDirection(b.directionJson)!.speech.map(s => s.id));
  ok(JSON.stringify(finIds) === JSON.stringify(seg.map(s => s.id)), 'both source lines are preserved exactly once, in order, in the sparse scene');
}

/* ─────────── 3) DIALOGUE-HEAVY scene → MORE than 15 boards, no error (fast path, one line per board) ─────────── */
{
  const base = buildSource(20, () => 'We really must decide this issue now.'); // ≈4.1s each — two never pair in one 6s board
  const seg = base.src.segments;
  const order = seg.map(s => s.id);
  const plan20: RawDirectedBoard[] = order.map(id => D({ speechIds: [id], shot: 'over_shoulder' }));
  const balanced = noThrow(() => balanceBoardCount(plan20, seg), 'balanceBoardCount does NOT throw for a 20-board dialogue-heavy plan') as RawDirectedBoard[];
  ok(balanced.length === 20 && balanced.length > 15, 'a dialogue-heavy scene keeps all 20 boards — MORE than the old max of 15 is allowed');
  const fin = noThrow(() => finalizeDirectedBoards(balanced, seg, cast2, base.src.actionSource), 'finalize completes with 20 boards (no "outside the required 12–15")') as ReturnType<typeof finalizeDirectedBoards>;
  ok(fin.length === 20, 'the finalized episode has 20 boards');
  const finIds = fin.flatMap(b => readBoardDirection(b.directionJson)!.speech.map(s => s.id));
  ok(JSON.stringify(finIds) === JSON.stringify(order), 'all 20 speech segments appear exactly once, in source order (no truncation)');
}

/* ─────────── 4) OVERFLOW FAN-OUT → count grows past 15 from a crammed model plan, never truncating ─────────── */
{
  const base = buildSource(20, () => 'We really must decide this issue now.'); // ≈4.1s each
  const seg = base.src.segments;
  const order = seg.map(s => s.id);
  // Model crammed ALL 20 lines onto 3 boards — every board massively overflows a single 4–6s clip.
  const crammed: RawDirectedBoard[] = [
    D({ speechIds: order.slice(0, 8), shot: 'over_shoulder' }),
    D({ speechIds: order.slice(8, 14), shot: 'over_shoulder' }),
    D({ speechIds: order.slice(14), shot: 'over_shoulder' }),
  ];
  const balanced = noThrow(() => balanceBoardCount(crammed, seg), 'balanceBoardCount fans out a crammed plan without throwing') as RawDirectedBoard[];
  const ledger = new Map(seg.map(s => [s.id, s] as const));
  const speechSec = (b: RawDirectedBoard) => (b.speechIds ?? []).reduce((sum, id) => sum + (ledger.has(id) ? estimatedSpeechSeconds(ledger.get(id)!) : 0), 0);
  ok(balanced.length > 15, `overflow distribution grew the plan to ${balanced.length} boards (> 15) to hold all the speech`);
  ok(balanced.every(b => (b.speechIds?.length ?? 0) <= 2 && speechSec(b) <= STORYBOARD_MAX_BOARD_SEC + 1e-9), 'after balancing, no board overflows its two-line / 4–6s budget');
  const flatIds = balanced.flatMap(b => b.speechIds ?? []);
  ok(JSON.stringify(flatIds) === JSON.stringify(order), 'every source line is preserved exactly once, in source order, through the fan-out (no truncation — S139)');
  const fin = noThrow(() => finalizeDirectedBoards(balanced, seg, cast2, base.src.actionSource), 'finalize completes for a >15 fanned-out plan');
  ok((fin as ReturnType<typeof finalizeDirectedBoards>).length > 15, 'the finalized fanned-out episode keeps more than 15 boards');
}

/* ─────────── 5) normalizeBoards no longer slices to 15; validateBoards no longer enforces 12–15 ─────────── */
{
  const raw20 = Array.from({ length: 20 }, (_, i) => ({ actionOrDialogue: `Board ${i + 1}` }));
  const norm = normalizeBoards(raw20);
  ok(norm.length === 20, 'normalizeBoards keeps all 20 boards (no slice to the old max of 15)');
  ok(validateBoards(norm).length === 0, 'validateBoards accepts 20 boards (no "max 15" problem)');
  const norm9 = normalizeBoards(Array.from({ length: 9 }, (_, i) => ({ actionOrDialogue: `Board ${i + 1}` })));
  ok(validateBoards(norm9).length === 0, 'validateBoards accepts 9 boards (no "need at least 12" problem)');
  ok(validateBoards([]).some(p => /at least one/.test(p)), 'validateBoards still flags a genuinely empty plan (need at least one board)');
}

/* ─────────── 6) The prompt no longer commands a fixed 12–15 count; it asks for a content-derived count ─────────── */
{
  const sys = storyboardBoardsSystemPrompt();
  ok(!/exactly 12[\u2010-\u2015-]15/.test(sys) && !/land on exactly/.test(sys), 'the split prompt no longer orders the model to "land on exactly 12–15 boards"');
  ok(/as many/i.test(sys) && /content/i.test(sys), 'the split prompt now asks for as many boards as the CONTENT needs');
  ok(/9:16/.test(sys), 'the split prompt still specifies the 9:16 vertical format (S147/invariant)');
  ok(/4 and 6|4[\u2010-\u2015-]6/.test(sys), 'the split prompt still holds each board to a 4–6s clip');
}

/* ─────────── 7) reconcileSpeechIds (S139) still guarantees exact-once, in-order allocation ─────────── */
{
  const base = buildSource(5, () => 'A short line.');
  const seg = base.src.segments;
  const order = seg.map(s => s.id);
  const scrambled = reconcileSpeechIds([
    D({ speechIds: [seg[4].id] }), D({ speechIds: [seg[0].id] }), D({ speechIds: [seg[2].id] }),
    D({ speechIds: [seg[1].id] }), D({ speechIds: [seg[3].id] }),
  ], seg);
  ok(JSON.stringify(scrambled.flatMap(b => b.speechIds ?? [])) === JSON.stringify(order), 'reconcileSpeechIds restores strict source order (S139 preserved)');
}

/* ─────────── 8) Stage 146 character-forward coverage survives: board 0 is the wide establishing shot ─────────── */
{
  const base = buildSource(4, () => 'We should really talk this over.');
  const seg = base.src.segments;
  const plan: RawDirectedBoard[] = [
    D({ actionOrDialogue: 'Establishing wide of the room.' }),
    ...seg.map(id => D({ speechIds: [id.id], shot: 'over_shoulder' })),
  ];
  const fin = finalizeDirectedBoards(balanceBoardCount(plan, seg), seg, cast2, base.src.actionSource);
  const board0 = readBoardDirection(fin[0].directionJson)!;
  ok(board0.shot === 'group' || board0.cast.length >= 2, 'board 0 remains a whole-cast establishing shot (Stage 146 character-forward coverage intact)');
}

/* ─────────── 9) SCENES / shared adapters remain byte-identical (Storyboard-only change) ─────────── */
{
  for (const file of ['lib/workers/video-job.ts', 'lib/region-plate.ts', 'lib/assemble.ts', 'lib/wavespeed.ts', 'lib/providers/video-provider.ts']) {
    const baseline = execFileSync('git', ['show', `18b71a09e6c6:${file}`], { encoding: 'utf8' });
    ok(baseline === readFileSync(file, 'utf8'), `unchanged SCENES/shared adapter: ${file}`);
  }
}

console.log(`Stage 148: PASS (${passed} checks; pure logic, no network, no paid generation)`);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
