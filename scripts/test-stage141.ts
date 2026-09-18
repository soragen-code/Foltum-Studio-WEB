/** Stage 141 (Storyboard only). Three changes, all verified WITHOUT any paid generation or network:
 *
 *  (1) i2v ANIMATION PROGRESS — the image-to-video (Seedance) step now shows a monotonic 0–100 %
 *      numeric bar. Seedance emits no per-frame percent, so the panel feeds the coarse time-based
 *      server checkpoints through the existing pure `smoothedProgress()` easing helper (the same one
 *      SCENES uses): the shown value never decreases, creeps upward with elapsed time off a flat
 *      server plateau, stays capped <100 % until the job is truly done, and only 'completed' reaches
 *      100. Frame generation keeps its own raw JobProgressBar (untouched).
 *
 *  (2) ALL DIALOGUE IS SPOKEN IN ENGLISH — overrides the earlier "verbatim in the source/original
 *      language" rule. The worker translates every non-English source line to English BEFORE building
 *      the immutable speech ledger, so the verbatim per-line text restored into every board (and fed
 *      to the i2v payload / voicing / board display) is English, in the format NAME (delivery): "line".
 *      The split & repair prompts and the animation payload are updated to say ENGLISH. Attribution,
 *      source order and the exact-once ledger integrity (Stage 139) are unchanged — only the LANGUAGE
 *      of the spoken words is normalized. `storyboardSource` still preserves its input verbatim.
 *
 *  (3) 9:16 PLAYER — the assembled clip and per-board viewer are fixed portrait 9:16 with
 *      object-contain + black letterbox, height bounded by the viewport, never auto-fullscreen /
 *      stretched / cropped (asserted on the panel source).
 *
 * Invariants regressed here: Stage 139 exact-once ordered ledger; Stage 140 persistent set anchors;
 * SCENES / shared adapters byte-identical. Pure logic + source assertions; no network, no paid generation. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { smoothedProgress } from '../app/project/[id]/_components/use-job-polling';
import { buildSetAnchorsLine, deriveSetAnchors } from '../lib/set-anchors';
import { detectSpokenLanguage, translateDialogue } from '../lib/voiceover';
import { storyboardSource } from '../lib/storyboard-dialogue';
import { balanceBoardCount, finalizeDirectedBoards, type RawDirectedBoard } from '../lib/storyboard-direction';
import {
  STORYBOARD_BOARDS_JSON_HINT,
  storyboardBoardsSystemPrompt,
  dialogueRepairSystemPrompt,
} from '../lib/storyboard';
import { buildStoryboardAnimationPrompt } from '../lib/storyboard-animation';

let passed = 0;
function ok(value: unknown, message: string) { assert.ok(value, message); passed++; }

async function main() {

/* ─────────── (1) i2v ANIMATION PROGRESS — smoothedProgress easing (Feature 1) ─────────── */
// completed is the ONLY path to 100.
ok(smoothedProgress({ serverProgress: 40, status: 'completed', prevShown: 40, elapsedSec: 10, expectedTotalSec: 60 }) === 100,
  'i2v: status completed → exactly 100 %');
// failed / canceled hold the last shown value, never snap to 100.
ok(smoothedProgress({ serverProgress: 40, status: 'failed', prevShown: 55, elapsedSec: 10, expectedTotalSec: 60 }) === 55,
  'i2v: status failed → holds the last shown value (never snaps to 100)');
ok(smoothedProgress({ serverProgress: 40, status: 'canceled', prevShown: 55, elapsedSec: 10, expectedTotalSec: 60 }) === 55,
  'i2v: status canceled → holds the last shown value');
// Never decreases even when the raw server signal jumps backwards.
const held = smoothedProgress({ serverProgress: 5, status: 'processing', prevShown: 62, elapsedSec: 30, expectedTotalSec: 60 });
ok(held >= 62, 'i2v: monotonic — a backwards server jump never lowers the shown percent');
// Creeps upward with elapsed time off a FLAT server plateau (Seedance emits no per-frame percent).
const flat = 15;
let prev = 0; const seq: number[] = [];
for (const t of [0, 5, 15, 30, 45, 60, 90]) {
  const v = smoothedProgress({ serverProgress: flat, status: 'processing', prevShown: prev, elapsedSec: t, expectedTotalSec: 60 });
  seq.push(v); prev = v;
}
ok(seq.every((v, i) => i === 0 || v >= seq[i - 1]), 'i2v: shown percent is non-decreasing across ticks');
ok(seq[seq.length - 1] > seq[1], 'i2v: percent creeps up over elapsed time even while the server percent stays flat');
// Capped <100 until truly done.
ok(seq.every(v => v < 100), 'i2v: while processing the bar stays capped below 100 %');
ok(smoothedProgress({ serverProgress: 999, status: 'processing', prevShown: 0, elapsedSec: 5, expectedTotalSec: 60, cap: 96 }) <= 96,
  'i2v: an over-range server percent is clamped to the cap');

/* ─────────── (1)+(3) PANEL source: SmoothProgress for i2v, 9:16 object-contain player ─────────── */
const panel = readFileSync('app/project/[id]/episode/[episodeId]/storyboard-panel.tsx', 'utf8');
ok(/import \{[^}]*\bSmoothProgress\b[^}]*\}\s+from\s+'\.\.\/\.\.\/_components\/use-job-polling'/.test(panel),
  'panel: imports the SmoothProgress component');
ok(/animatePoll\.isActive && animatePoll\.job && <div[^>]*><SmoothProgress job=\{animatePoll\.job\}/.test(panel),
  'panel: the i2v (animate) job renders a SmoothProgress bar');
ok(/framePoll\.isActive && framePoll\.job && <div[^>]*><JobProgressBar job=\{framePoll\.job\}/.test(panel),
  'panel: frame generation keeps its own JobProgressBar (not broken)');
ok(!/const activeJob/.test(panel), 'panel: the old shared activeJob progress bar is removed');
// 9:16 portrait, object-contain (never object-cover), viewport-bounded, letterboxed — no auto-fullscreen.
ok(/aspect-\[9\/16\][^]*max-h-\[80vh\][^]*object-contain/.test(panel),
  'panel: assembled clip is a fixed 9:16 player, viewport-bounded, object-contain (letterboxed)');
ok(!/object-cover/.test(panel), 'panel: no object-cover anywhere (nothing is cropped/stretched)');
ok(!/requestFullscreen|webkitRequestFullscreen|allowFullScreen/i.test(panel), 'panel: no fullscreen API call (no auto/forced fullscreen behaviour)');

/* ─────────── (2) ENGLISH dialogue — split / repair prompts + animation payload (Feature 2) ─────────── */
const split = storyboardBoardsSystemPrompt();
ok(/ALL dialogue is spoken in ENGLISH/i.test(split), 'split prompt: states all dialogue is spoken in ENGLISH');
ok(/NAME \(delivery\):\s*\\?"?line/.test(STORYBOARD_BOARDS_JSON_HINT) && /in ENGLISH/i.test(STORYBOARD_BOARDS_JSON_HINT),
  'split JSON hint: dialogue text is ENGLISH in the format NAME (delivery): "line"');
ok(/Never translate the segment text yourself/i.test(split), 'split prompt: model must never translate the (already-English) segment text');
// the old "translate" carve-out is gone from the speechIds rule (we no longer forbid "translate" there — text is English upstream).
ok(!/Do not rewrite, translate, summarize/i.test(split), 'split prompt: the stale "do not translate" phrasing was updated');
const repair = dialogueRepairSystemPrompt();
ok(/quoted LINES \(already in ENGLISH\)/i.test(repair), 'repair prompt: the lines it attributes are already in ENGLISH');
// animation payload speaks ENGLISH verbatim.
const cast = ['Anna', 'Boris'];
const animPrompt = buildStoryboardAnimationPrompt({
  actionOrDialogue: 'Anna (calmly): "We should leave before dawn."',
  characters: cast,
  durationSec: 5,
});
ok(/audible ENGLISH on-scene dialogue/i.test(animPrompt), 'i2v payload: audio track is audible ENGLISH on-scene dialogue');
ok(/ENGLISH SPOKEN LINES \(verbatim/i.test(animPrompt), 'i2v payload: lines are labelled ENGLISH SPOKEN LINES (verbatim)');
ok(/no re-translation, paraphrase/i.test(animPrompt), 'i2v payload: speak the English lines exactly, no re-translation/paraphrase');
ok(animPrompt.includes('We should leave before dawn.'), 'i2v payload: the exact English line text is carried verbatim');
// stale original-language phrasing is gone from the animation payload.
ok(!/original-language/i.test(animPrompt), 'i2v payload: no "original-language" wording remains');

/* ─────────── (2) detectSpokenLanguage guard + translateDialogue fail-safe (worker wiring) ─────────── */
ok(detectSpokenLanguage('Привет, как дела?') === 'Russian', 'detect: a Cyrillic line is classified Russian (triggers translation upstream)');
ok(detectSpokenLanguage('We should leave before dawn.') === 'English', 'detect: an English line is classified English (no translation needed)');
// translateDialogue is fail-closed: with no network / @/lib/ai available here it returns the source unchanged (never throws).
const back = await translateDialogue('Привет', 'English');
ok(typeof back === 'string' && back.length > 0, 'translate: returns a string and never throws even with no network (fail-safe to source)');

/* ─────────── (2) storyboardSource preserves the (English) input VERBATIM — ledger never re-translates ─────────── */
const englishLines = 'Anna (calmly): "We should leave before dawn."\nBoris (firmly): "Not without the ledger."\nAnna (calmly): "Then hurry."\nBoris (firmly): "I am."\nAnna (softly): "Good."\nBoris (calmly): "Ready."';
const scenes = [{ number: 1, action: 'Anna and Boris confer at the desk.', dialogue: englishLines }];
const genders = cast.map(n => ({ name: n, gender: n === 'Boris' ? 'male' : 'female' }));
const src = storyboardSource({ description: 'Anna and Boris talk in the library.' }, scenes, genders);
const seg = src.segments;
ok(seg.length >= 6, 'ledger: all six English speech segments are parsed');
ok(seg.every(s => /^[\x00-\x7F]*$/.test(s.text)), 'ledger: every segment text is ASCII/English (no Cyrillic leaked through)');
ok(seg.some(s => s.text === 'We should leave before dawn.'), 'ledger: the English line text is preserved verbatim (not re-translated)');

/* ─────────── (2) Stage 139 exact-once ordered integrity holds on the English ledger ─────────── */
const D = (extra: Partial<RawDirectedBoard>): RawDirectedBoard => ({ actionOrDialogue: 'Beat', actionEnglish: 'Steady reactions at the desk.', durationSec: 5, region: 'at the desk', speechIds: [], ...extra });
const modelRaw: RawDirectedBoard[] = [
  D({ speechIds: [seg[0].id], shot: 'over_shoulder' }),
  D({ speechIds: [seg[1].id], shot: 'listener_reverse' }),
  D({ speechIds: [seg[2].id], shot: 'over_shoulder' }),
  D({ speechIds: [seg[3].id], shot: 'listener_reverse' }),
  D({ speechIds: [seg[4].id], shot: 'over_shoulder' }),
  D({ speechIds: [seg[5].id], shot: 'listener_reverse' }),
  D({}), D({}), D({}), D({}), D({}), D({}),
];
const balanced = balanceBoardCount(modelRaw, seg);
const fin = finalizeDirectedBoards(balanced, seg, cast, src.actionSource);
// The application restores each segment's verbatim line into the board text as NAME (delivery): "line".
const restored = fin.map(b => b.actionOrDialogue);
const allText = restored.join('\n');
const expectedLines = seg.map(s => `${s.speaker}${s.delivery ? ` (${s.delivery})` : ''}: "${s.text}"`);
// each source segment appears EXACTLY ONCE across all boards
for (const line of expectedLines) {
  const count = restored.filter(t => t.includes(line)).length;
  ok(count === 1, `S139: source segment used exactly once — ${JSON.stringify(line.slice(0, 40))} (found ${count})`);
}
// and in strict source order
const positions = expectedLines.map(line => allText.indexOf(line));
ok(positions.every(p => p >= 0), 'S139: every source segment line is present in the restored boards');
ok(positions.every((p, i) => i === 0 || p > positions[i - 1]), 'S139: source segments appear in strict source order');
// restored board text is the verbatim English ledger line in NAME (delivery): "line" format.
const spoken = restored.filter(t => /\(.*\):\s*"/.test(t));
ok(spoken.every(t => /^[A-Za-z].*\(.*\):\s*".*"/.test(t)), 'S139/EN: restored board text is NAME (delivery): "line" in English');
ok(spoken.some(t => t.includes('We should leave before dawn.')), 'S139/EN: the exact English line is restored into a board verbatim');

/* ─────────── Stage 140 persistent set anchors still intact ─────────── */
const anchors = deriveSetAnchors('A large central librarian desk holds an ink pad and a returns ledger; reading chairs occupy the windows.', []);
ok(anchors.some(a => /desk/i.test(a)), 'S140: set anchors still derive the large desk from the location');
ok(/PERSISTENT SET PIECES/.test(buildSetAnchorsLine(anchors)), 'S140: the PERSISTENT SET PIECES line still builds');

/* ─────────── SCENES / shared adapters byte-identical (Storyboard-only change) ─────────── */
for (const file of ['lib/region-plate.ts', 'lib/assemble.ts', 'lib/wavespeed.ts', 'lib/providers/video-provider.ts']) {
  const baseline = execFileSync('git', ['show', `18b71a09e6c6:${file}`], { encoding: 'utf8' });
  ok(baseline === readFileSync(file, 'utf8'), `unchanged SCENES/shared adapter: ${file}`);
}

console.log(`Stage 141: PASS (${passed} checks; pure logic + source assertions, no paid generation)`);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
