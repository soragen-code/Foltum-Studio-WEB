/** Stage 143: per-board VISIBLE CAST + hard SHOT SIZE + deterministic scene coverage (Storyboard only).
 * Every board used to get the identity refs of the WHOLE cast in image_input, a whole-cast prompt with soft
 * framing ("Choose ONE framing", "not everyone must be visible", "CAMERA: free") and — since S142 — a wide anchor
 * frame with everybody, so every board came out as the same wide group shot. Fix: resolveVisibleCast() decides
 * EXACTLY who is in frame and at what shot size (board 1 of a scene = wide establishing; dialogue = speaker single /
 * OTS / reverse; wide at most once per WIDE_MIN_GAP boards, enforced at PLANNING time by planSceneCoverage());
 * only the visible characters' refs are attached; the prompt carries SHOT SIZE (EXACTLY N) + OFF-SCREEN lines; the
 * anchor line says the anchor's people are not a framing/cast reference.
 * Pure logic + a mocked REAL board_image worker. No network, no paid generation. */
import assert from 'node:assert/strict';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolveVisibleCast, planSceneCoverage, castNamesInText, buildShotSizeLine, buildOffScreenLine, WIDE_MIN_GAP } from '../lib/board-coverage';
import { finalizeDirectedBoards, balanceBoardCount, readBoardDirection, boardShotContext, type RawDirectedBoard, type BoardDirection } from '../lib/storyboard-direction';
import { storyboardSource } from '../lib/storyboard-dialogue';
import { buildBoardFramePrompt } from '../lib/storyboard-prompt';
import { buildStoryboardAnimationPrompt } from '../lib/storyboard-animation';
import { buildSceneAnchorLine, BOARD_BODY_FURNITURE_LINE } from '../lib/board-anchor';

let passed = 0;
function ok(value: unknown, message: string) { assert.ok(value, message); passed++; }
const u = (n: string) => ["https:/", "boards.s3.amazonaws.com", `${n}.png`].join("/");

const cast4 = ['Anna', 'Boris', 'Clara', 'Dmitri'];
const g4 = [{ name: 'Anna', gender: 'female' }, { name: 'Boris', gender: 'male' }, { name: 'Clara', gender: 'female' }, { name: 'Dmitri', gender: 'male' }];
const sp = (speaker: string, addressee: string, text = 'x', delivery = '') => ({ id: `s-${speaker}`, sourceId: 'src', speaker, addressee, text, delivery, estimatedSec: 1 });
const dir = (over: Partial<BoardDirection>): BoardDirection => ({
  version: 134, cast: cast4, shot: 'over_shoulder', focus: 'Anna', listener: 'Boris', addressee: 'Boris', actionEnglish: 'Anna turns to Boris.',
  speech: [sp('Anna', 'Boris', 'Line', 'calmly')], cameraMode: 'LOCKED_OFF', ...over,
} as BoardDirection);

async function main() {

/* ─────────── (A) resolveVisibleCast — pure ─────────── */
const first = resolveVisibleCast(dir({ shot: 'close_up' }), 0, cast4, 'Anna speaks.');
ok(first.shotSize === 'CLOSE-UP' && first.visible.join() === 'Anna' && first.offScreen.join() === 'Boris,Clara,Dmitri' && first.focus === 'Anna', 'Stage 152: the scene opener (board 1) that starts on dialogue is a CLOSE-UP of the first speaker (Anna), the rest off-screen');
const cu = resolveVisibleCast(dir({ shot: 'close_up' }), 2, cast4, '');
ok(cu.shotSize === 'CLOSE-UP' && cu.visible.join() === 'Anna' && cu.offScreen.join() === 'Boris,Clara,Dmitri' && cu.focus === 'Anna', 'close_up → speaker only; the other three are off-screen');
const md = resolveVisibleCast(dir({ shot: 'medium' }), 2, cast4, '');
ok(md.shotSize === 'MEDIUM' && md.visible.join() === 'Anna', 'medium → speaker only');
const ots = resolveVisibleCast(dir({ shot: 'over_shoulder' }), 2, cast4, '');
ok(ots.shotSize === 'OVER-THE-SHOULDER' && ots.visible.join() === 'Anna,Boris' && ots.offScreen.join() === 'Clara,Dmitri', 'over_shoulder → speaker + addressee (cast order), rest off-screen');
const rev = resolveVisibleCast(dir({ shot: 'listener_reverse' }), 2, cast4, '');
ok(rev.shotSize === 'MEDIUM CLOSE-UP' && rev.visible.join() === 'Anna,Boris' && rev.focus === 'Boris', 'listener_reverse → speaker + addressee, focus on the addressee (reaction)');
const two = resolveVisibleCast(dir({ shot: 'two_shot' }), 2, cast4, '');
ok(two.shotSize === 'TWO-SHOT' && two.visible.length === 2, 'two_shot → exactly two');
const three = resolveVisibleCast(dir({ shot: 'three_shot' }), 2, cast4, '');
ok(three.shotSize === 'THREE-SHOT' && three.visible.join() === 'Anna,Boris,Clara' && three.offScreen.join() === 'Dmitri', 'three_shot → pair + one more, the fourth off-screen');
const grp = resolveVisibleCast(dir({ shot: 'group' }), 2, cast4, '');
ok(grp.shotSize === 'WIDE ESTABLISHING' && grp.visible.length === 4, 'group → wide with the whole cast');
// speaker resolved from the LAST speech line, addressee from the direction; no addressee in a 4-hander → single
const noAddr = resolveVisibleCast(dir({ shot: 'over_shoulder', addressee: '', listener: '', speech: [sp('Clara', '', 'All of you.')] }), 2, cast4, '');
ok(noAddr.shotSize === 'MEDIUM' && noAddr.visible.join() === 'Clara', 'a group-addressed line without addressee in a 4-hander → medium single on the speaker');
const twoHander = resolveVisibleCast(dir({ shot: 'over_shoulder', cast: ['Anna', 'Boris'], addressee: '', listener: '' }), 2, ['Anna', 'Boris'], '');
ok(twoHander.visible.join() === 'Anna,Boris' && twoHander.shotSize === 'OVER-THE-SHOULDER', 'two-hander without explicit addressee → the other person is the partner');
// action boards (no speech): participants parsed from the action text
ok(castNamesInText('Boris and Clara carry the ledger to the door; Dmitri watches.', cast4).join() === 'Boris,Clara,Dmitri', 'castNamesInText: names found in cast order');
ok(castNamesInText('Annabelle enters.', ['Anna']).length === 0 && castNamesInText('ANNA nods.', ['Anna']).join() === 'Anna', 'castNamesInText: word boundaries respected, case-insensitive');
const act1 = resolveVisibleCast(dir({ speech: [], actionEnglish: 'Boris closes the ledger.' }), 3, cast4, 'Борис закрывает журнал.');
ok(act1.shotSize === 'MEDIUM' && act1.visible.join() === 'Boris', 'action board without speech: the one named participant → medium single');
const act2 = resolveVisibleCast(null, 3, cast4, 'Anna and Clara exchange a glance.');
ok(act2.shotSize === 'TWO-SHOT' && act2.visible.join() === 'Anna,Clara', 'legacy board without direction: two named → two-shot');
const act3 = resolveVisibleCast(null, 3, cast4, 'Boris, Clara and Dmitri leave through the door.');
ok(act3.shotSize === 'WIDE ESTABLISHING' && act3.visible.length === 3 && act3.offScreen.join() === 'Anna', 'group action (3 moving) → wide, only the 3 participants');
const act4 = resolveVisibleCast(null, 3, cast4, 'The room falls silent.');
ok(act4.shotSize === 'WIDE ESTABLISHING' && act4.visible.length === 4, 'action board naming nobody → whole cast wide');
ok(resolveVisibleCast(dir({ shot: 'close_up', focus: 'Nobody', speech: [sp('Nobody', '')] }), 2, cast4, '').visible.length === 4, 'unknown speaker never yields an empty frame (falls back to the whole cast)');
ok(resolveVisibleCast(dir({}), 2, [], '').visible.length === 0 && resolveVisibleCast(dir({}), 2, [], '').offScreen.length === 0, 'empty cast → nothing to frame, no crash');

/* ─────────── (B) prompt lines ─────────── */
const otsLine = buildShotSizeLine(ots);
ok(/^SHOT SIZE: OVER-THE-SHOULDER — EXACTLY 2 characters in frame: Anna, Boris\./.test(otsLine), 'SHOT SIZE line: shot size + EXACTLY N + names');
ok(/No other people, faces, silhouettes or crowd visible anywhere in the frame, including the background\./.test(otsLine), 'SHOT SIZE line: nobody else anywhere, background included');
ok(/back of Boris's shoulder/.test(otsLine) && /Anna in focus/.test(otsLine), 'SHOT SIZE line (OTS): foreground shoulder of the addressee, speaker in focus');
ok(/EXACTLY 1 character in frame: Anna\./.test(buildShotSizeLine(cu)), 'SHOT SIZE line: singular for one character');
ok(buildOffScreenLine(ots) === 'OFF-SCREEN (not visible in this frame, remain in the location): Clara, Dmitri.', 'OFF-SCREEN line names exactly the invisible cast');
ok(buildOffScreenLine(grp) === '', 'OFF-SCREEN line is empty when everybody is in frame');
const anchorLine = buildSceneAnchorLine(3);
ok(/The PEOPLE in the anchor frame are NOT a framing or cast reference/.test(anchorLine) && /frame ONLY the characters listed in SHOT SIZE at the stated shot size/.test(anchorLine), 'anchor line: people in the anchor are NOT a framing/cast reference');
ok(/EXACT same furniture and props/.test(anchorLine) && /anchor frame wins/.test(anchorLine), 'anchor line: S142 set-geometry mandate kept');

/* ─────────── (C) planning-time scene coverage through the REAL finalizeDirectedBoards ─────────── */
const d4 = 'Anna (firmly): "Отчёт готов?"\nBoris (calmly): "Да, вчера вечером."\nClara (softly): "Я проверила цифры."\nDmitri asks Clara: "Все цифры?"\nAnna (nodding): "Отлично."\nBoris (smiling): "Тогда идём."';
const src = storyboardSource({ description: 'A team meeting.' }, [{ number: 1, action: 'Anna, Boris, Clara and Dmitri stand around the table.', dialogue: d4 }], g4);
ok(src.segments.length === 6, 'six speech lines survive the split');
const raw: RawDirectedBoard[] = balanceBoardCount(Array.from({ length: 12 }, (_, i) => ({
  actionOrDialogue: i < 6 ? `Beat ${i + 1}` : i === 6 ? 'Boris closes the ledger.' : i === 7 ? 'Boris, Clara and Dmitri leave through the door.' : `Beat ${i + 1}`,
  actionEnglish: i === 6 ? 'Boris closes the ledger.' : i === 7 ? 'Boris, Clara and Dmitri leave through the door.' : 'The team confers.',
  durationSec: 5, region: 'at the table',
  speechIds: i < 6 ? [src.segments[i].id] : [],
  // The LLM asked for wides on boards 1, 2 and 4 — only board 1 may keep it (gap rule), the others degrade.
  shot: i === 0 ? 'close_up' : i === 1 ? 'group' : i === 3 ? 'group' : i === 4 ? 'listener_reverse' : 'over_shoulder',
})) as RawDirectedBoard[], src.segments);
const boards = finalizeDirectedBoards(raw, src.segments, cast4, src.actionSource);
const plans = boards.map(b => readBoardDirection(b.directionJson)!);
const covs = plans.map((p, i) => resolveVisibleCast(p, i, cast4, boards[i].actionOrDialogue));
ok(plans[0].shot === 'close_up' && covs[0].shotSize === 'CLOSE-UP' && covs[0].visible.join() === 'Anna' && plans[0].focus === 'Anna', 'Stage 152: board 1 (scene opener on dialogue) is a CLOSE-UP of the first speaker (Anna)');
ok(plans[1].shot === 'over_shoulder' && covs[1].visible.join() === 'Anna,Boris' && plans[1].focus === 'Boris', 'board 2: a consecutive wide degrades to OTS on the speaker (Boris → Anna)');
ok(covs[2].shotSize === 'OVER-THE-SHOULDER' && covs[2].visible.join() === 'Boris,Clara', 'board 3: Clara answers Boris → speaker + addressee only');
ok(plans[3].shot === 'over_shoulder' && covs[3].visible.join() === 'Clara,Dmitri' && covs[3].shotSize !== 'WIDE ESTABLISHING', 'board 4: wide requested 3 boards after the last wide → degraded to OTS (Dmitri → Clara)');
ok(plans[4].shot === 'listener_reverse' && covs[4].shotSize === 'MEDIUM CLOSE-UP' && covs[4].visible.join() === 'Anna,Dmitri' && covs[4].focus === 'Dmitri', 'board 5: listener reverse kept — Anna + her addressee Dmitri, reaction focus on Dmitri');
ok(covs[5].visible.length === 2 && covs[5].visible.includes('Boris'), 'board 6: OTS pair on the speaker Boris');
ok(covs[6].shotSize === 'MEDIUM' && covs[6].visible.join() === 'Boris', 'board 7 (action, no speech): the one named participant → single');
ok(covs[7].shotSize === 'WIDE ESTABLISHING' && covs[7].visible.join() === 'Boris,Clara,Dmitri' && covs[7].offScreen.join() === 'Anna', 'board 8 (group exit): justified wide with the 3 moving participants only');
const wideIdx = covs.map((c, i) => c.shotSize === 'WIDE ESTABLISHING' ? i : -1).filter(i => i >= 0);
ok(wideIdx.every((w, k) => k === 0 || w - wideIdx[k - 1] >= WIDE_MIN_GAP || plans[w].speech.length === 0), `dialogue wides at least ${WIDE_MIN_GAP} boards apart (wides at ${wideIdx.map(i => i + 1).join(',')})`);
// Stage 146 — character-forward planSceneCoverage: a mid-scene group wide ALWAYS degrades (no periodic wide)
const late = planSceneCoverage(Array.from({ length: 6 }, (_, i) => dir({ shot: i === 5 ? 'group' : 'medium', speech: [sp('Anna', 'Boris')] })));
ok(late[5].shot === 'over_shoulder' && late[1].shot === 'medium' && late[0].shot === 'close_up', 'planSceneCoverage (Stage 152): a mid-scene group wide degrades to character-forward OTS even late in the scene; board 1 is the scene-opening CLOSE-UP of the first speaker; singles untouched');
const early = planSceneCoverage([dir({}), dir({ shot: 'group' }), dir({ shot: 'group', addressee: '', listener: '' })]);
ok(early[1].shot === 'over_shoulder' && early[2].shot === 'medium', 'planSceneCoverage: too-early wides → OTS (with addressee) / medium (without)');
// S139 integrity, S134 sides/axis
ok(plans.filter(p => p.speech.length).flatMap(p => p.speech.map(s => s.text)).join('|') === src.segments.map(s => s.text).join('|'), 'S139: every original line reaches exactly one board, in order (coverage never touches speech)');
ok(plans.every((p, i) => p.cast.join() === cast4.join() && p.speech.every(s => s.speaker === src.segments.find(seg => seg.text === s.text)!.speaker)), 'S139/S134: cast + speakers untouched by the coverage pass');
const ctx3 = boardShotContext(plans[3], 3, covs[3]);
ok(/^SHOT SIZE: OVER-THE-SHOULDER — EXACTLY 2 characters in frame: Clara, Dmitri\./m.test(ctx3), 'boardShotContext: SHOT SIZE line present with the exact pair');
ok(/OFF-SCREEN \(not visible in this frame, remain in the location\): Anna, Boris\./.test(ctx3), 'boardShotContext: OFF-SCREEN names the rest');
ok(/Clara: staging position 3/.test(ctx3) && /Dmitri: staging position 4/.test(ctx3) && !/Anna: staging position/.test(ctx3), 'boardShotContext: staging positions only for the visible cast, indexed by the full-cast order (S134 sides kept)');
ok(/180-degree/.test(ctx3) && /Dmitri → Clara/.test(ctx3) && /PRESENT AND REACTING[^\n]*Clara/.test(ctx3), 'boardShotContext: axis, eyeline to the real addressee, in-frame listener reacting');
ok(/FIXED by the SHOT SIZE line above/.test(ctx3) && !/Choose ONE framing/.test(ctx3) && !/not everyone must be visible/i.test(ctx3), 'boardShotContext: framing fixed by SHOT SIZE, soft wording gone');

/* ─────────── (D) frame prompt (pure) ─────────── */
const links = g4.map(c => ({ name: c.name, gender: c.gender, appearance: `${c.name} appearance`, age: 'adult' }));
const fp0 = buildBoardFramePrompt({ board: { index: 0, actionOrDialogue: boards[0].actionOrDialogue, directionJson: boards[0].directionJson }, characters: links, hasPlate: true, anchorRefIndex: null });
const fp3 = buildBoardFramePrompt({ board: { index: 3, actionOrDialogue: boards[3].actionOrDialogue, directionJson: boards[3].directionJson }, characters: links, locationName: 'Office', hasPlate: true, anchorRefIndex: 3 });
ok(/CHARACTERS IN FRAME \(EXACTLY these 2 — nobody else\):\nClara: [^\n]*\nDmitri: /.test(fp3.prompt) && !/Anna: [^\n]*appearance/.test(fp3.prompt) && !/Boris: [^\n]*appearance/.test(fp3.prompt), 'frame prompt: identity lines only for the visible pair');
ok(/SHOT SIZE: OVER-THE-SHOULDER — EXACTLY 2 characters in frame: Clara, Dmitri\./.test(fp3.prompt) && /OFF-SCREEN[^\n]*Anna, Boris\./.test(fp3.prompt), 'frame prompt: SHOT SIZE + OFF-SCREEN blocks');
ok(!/Choose ONE framing/.test(fp3.prompt) && !/not everyone must be visible/i.test(fp3.prompt) && !/CAMERA: free/.test(fp3.prompt), 'frame prompt: soft framing wording removed');
ok(/CAMERA: angle, height and lens are free/.test(fp3.prompt) && /FIXED by the SHOT SIZE line/.test(fp3.prompt) && /never widen the frame to include anyone else/.test(fp3.prompt) && /no fixed camera/.test(fp3.prompt), 'frame prompt: camera angle free, shot size + cast fixed');
ok(fp3.prompt.includes(buildSceneAnchorLine(3)) && fp3.prompt.includes(BOARD_BODY_FURNITURE_LINE) && /GEOMETRY AUTHORITY/.test(fp3.prompt) && /9:16/.test(fp3.prompt), 'frame prompt: S142 anchor (with people caveat) + body/furniture, S131 geometry, 9:16 preserved');
ok(/clearly female/i.test(fp3.prompt) && /clearly male/i.test(fp3.prompt), 'frame prompt: gender lock preserved for the visible pair');
ok(/EXACTLY these 1 — nobody else/.test(fp0.prompt) && /SHOT SIZE: CLOSE-UP — EXACTLY 1 character in frame: Anna\./.test(fp0.prompt) && /OFF-SCREEN[^\n]*Boris, Clara, Dmitri/.test(fp0.prompt), 'Stage 152: frame prompt (board 1) is a CLOSE-UP of the first speaker (Anna), the rest named OFF-SCREEN');
const legacy = buildBoardFramePrompt({ board: { index: 5, actionOrDialogue: 'Anna: "Ты готов?" Boris nods.' }, characters: links });
ok(/SHOT SIZE: TWO-SHOT — EXACTLY 2 characters in frame: Anna, Boris\./.test(legacy.prompt) && /OFF-SCREEN[^\n]*Clara, Dmitri/.test(legacy.prompt) && /DIALOGUE COVERAGE: the shot size and the exact cast in frame are fixed/.test(legacy.prompt), 'frame prompt (legacy board without direction): named participants only, coverage fixed');
// The total is dominated by the pre-existing S131/S140/S142 blocks; Stage 143 adds ~3 short lines and REMOVES the identity lines of the off-screen cast.
// Stage 152 — board 0 is now a CLOSE-UP of the first speaker (a single identity line), so fp0 is smaller than the old whole-cast wide;
// fp3 (a 2-character OTS with anchor + continuity refs) legitimately sits ~1.1k above it. Both are still well within the anti-bloat ceiling.
ok(fp3.prompt.length < 9000 && fp3.prompt.length < fp0.prompt.length + 1300, `frame prompt not bloated (${fp3.prompt.length} chars)`);

/* ─────────── (E) i2v motion prompt lists only the visible cast ─────────── */
const mp = buildStoryboardAnimationPrompt({ actionOrDialogue: boards[3].actionOrDialogue, directionJson: boards[3].directionJson, characters: cast4, durationSec: 5, boardIndex: 3 });
ok(/SHOT SIZE: OVER-THE-SHOULDER — EXACTLY 2 characters in frame: Clara, Dmitri\./.test(mp) && /OFF-SCREEN[^\n]*Anna, Boris/.test(mp), 'i2v prompt: same SHOT SIZE / OFF-SCREEN as the frame');
ok(/ENGLISH SPOKEN LINES/.test(mp) && /SPEAKER: Dmitri; TO: Clara/.test(mp) && /CAMERA MODE: LOCKED-OFF/.test(mp), 'i2v prompt: S139/S141 verbatim speech + static camera kept');
const mpLegacy = buildStoryboardAnimationPrompt({ actionOrDialogue: 'Anna and Clara exchange a glance.', characters: cast4, durationSec: 5, boardIndex: 4 });
ok(/SCENE CAST CONTEXT — IN FRAME: Anna, Clara; nobody else appears in the frame/.test(mpLegacy), 'i2v prompt (legacy): only the named participants are in frame');

/* ─────────── (F) SCENES / shared adapters byte-identical ─────────── */
for (const file of ['lib/region-plate.ts', 'lib/assemble.ts', 'lib/wavespeed.ts', 'lib/providers/video-provider.ts']) {
  const baseline = execFileSync('git', ['show', `18b71a09e6c6:${file}`], { encoding: 'utf8' });
  ok(baseline === readFileSync(file, 'utf8'), `unchanged SCENES/shared adapter: ${file}`);
}
for (const file of ['lib/storyboard-direction.ts', 'lib/storyboard-prompt.ts', 'lib/board-coverage.ts']) {
  const s = readFileSync(file, 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  ok(!/Choose ONE framing/.test(s) && !/not everyone must be visible/i.test(s), `${file}: no soft framing wording left in code`);
}

await workerFlowCheck(boards.map(b => b.directionJson as string), boards.map(b => b.actionOrDialogue));

/* ─────────── (G) REAL board_image worker: only the visible refs go into image_input ─────────── */
async function workerFlowCheck(directionJsons: string[], actions: string[]) {
  const internal = Module as unknown as { _load: (...args: any[]) => any };
  const originalLoad = internal._load;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('Unexpected network in worker mock test'); }) as typeof fetch;
  process.env.BOARD_ANCHOR_WAIT_POLL_MS = '5';
  const ref: Record<string, string> = { Anna: u('anna-ref'), Boris: u('boris-ref'), Clara: u('clara-ref'), Dmitri: u('dmitri-ref') };
  const episode = { id: 'ep1', mode: 'STORYBOARD', locationId: 'loc1', locationName: 'Office', locationDesc: 'A long meeting table.' };
  const mk = (i: number): Record<string, any> => ({ id: `b${i}`, episodeId: 'ep1', index: i, actionOrDialogue: actions[i], motionEn: null, directionJson: directionJsons[i], region: 'at the table', status: 'pending', imageUrl: null, imagePrompt: null, anchorUrl: null, anchorBoardId: null });
  const saved = [0, 1, 2, 3, 4, 5, 6, 7].map(mk);
  const failures: string[] = [];
  const calls: Array<{ image_input: string[]; prompt: string }> = [];
  let renderCount = 0;
  const prisma = {
    board: {
      findUnique: async ({ where }: any) => { const b = saved.find(s => s.id === where.id); return b ? { ...b, episode } : null; },
      findMany: async ({ where }: any) => saved.filter(s => !where?.episodeId || s.episodeId === where.episodeId),
      update: async ({ where, data }: any) => { const b = saved.find(s => s.id === where.id); if (b) Object.assign(b, data); return b; },
    },
    episodeCharacter: { findMany: async () => g4.map(c => ({ character: { name: c.name, imageFull: ref[c.name], gender: c.gender, appearance: `${c.name} appearance`, age: 'adult' } })) },
    location: { findUnique: async () => ({ id: 'loc1', name: 'Office', imageUrl: u('wide'), imageReverse: u('layout'), regionPlates: null }) },
  };
  const mocks: Record<string, unknown> = {
    '@/lib/db': { prisma },
    '@/lib/jobs': { updateJob: async () => {}, completeJob: async () => {}, isCancelRequested: async () => false, markCanceled: async () => {}, failJob: async (_id: string, message: string) => { failures.push(message); } },
    '@/lib/s3-upload': { uploadRemoteToS3: async (url: string) => url },
    '@/lib/providers/image-provider': {
      WAVESPEED_IMAGE_MAX_REFS: 10,
      generateImage: async (req: any) => { calls.push({ image_input: req.image_input ?? [], prompt: req.prompt }); renderCount++; return u(`frame-${renderCount}`); },
      GenerationCanceledError: class extends Error {},
    },
  };
  internal._load = function(id: string, ...rest: any[]) {
    const key = id.replace(/^.*\/lib\//, '@/lib/').replace(/\.(?:ts|js)$/, '');
    return mocks[key] ?? originalLoad.call(this, id, ...rest);
  };
  try {
    const workers = require('../lib/workers/storyboard-job');
    for (const b of [...saved]) await workers.runBoardImageJob(`job-${b.id}`, 'project1', b.id);
    ok(failures.length === 0 && calls.length === 8, `worker: 8 boards rendered without failures (${failures.join(' | ') || 'none'})`);
    const anchor = saved[0].imageUrl as string;
    ok(calls[0].image_input.join() === [ref.Anna, u('wide'), u('layout')].join() && !/SCENE ANCHOR FRAME/.test(calls[0].prompt), 'Stage 152: worker board 1 (scene opener close-up) → ONLY the first speaker Anna\'s ref + plates; becomes the anchor');
    ok(calls[1].image_input.join() === [ref.Anna, ref.Boris, anchor, u('wide'), u('layout')].join(), 'worker board 2 (OTS Boris→Anna): ONLY Anna + Boris refs → anchor → plates; Clara/Dmitri refs absent');
    ok(calls[3].image_input.join() === [ref.Clara, ref.Dmitri, u('frame-3'), anchor, u('wide'), u('layout')].join() && /SCENE ANCHOR FRAME \(reference image 4\)/.test(calls[3].prompt) && /CONTINUITY FRAME \(reference image 3\)/.test(calls[3].prompt), 'worker board 4: Clara + Dmitri refs, S144 continuity frame (board 3) as ref image 3, anchor now reference image 4');
    ok(calls[6].image_input.join() === [ref.Boris, u('frame-6'), anchor, u('wide'), u('layout')].join() && /SCENE ANCHOR FRAME \(reference image 3\)/.test(calls[6].prompt) && /CONTINUITY FRAME \(reference image 2\)/.test(calls[6].prompt), 'worker board 7 (action single): Boris ref, continuity (board 6) ref image 2, anchor now reference image 3 (S144)');
    ok(calls[7].image_input.join() === [ref.Boris, ref.Clara, ref.Dmitri, u('frame-7'), anchor, u('wide'), u('layout')].join(), 'worker board 8 (group exit): the 3 participants + continuity (board 7) + anchor, Anna ref absent (S144)');
    ok(calls.slice(1).every(c => c.image_input.includes(anchor)) && calls.slice(1).every(c => /NOT a framing or cast reference/.test(c.prompt)), 'worker: anchor attached to every later board with the people caveat');
    ok(/SHOT SIZE: OVER-THE-SHOULDER — EXACTLY 2 characters in frame: Anna, Boris\./.test(calls[1].prompt) && /OFF-SCREEN[^\n]*Clara, Dmitri\./.test(calls[1].prompt), 'worker board 2 prompt: SHOT SIZE + OFF-SCREEN');
    ok(!/Clara: [^\n]*appearance/.test(calls[1].prompt) && /Anna: [^\n]*appearance/.test(calls[1].prompt), 'worker board 2 prompt: identity lines only for the visible pair');
    ok(calls.every(c => c.prompt.includes(BOARD_BODY_FURNITURE_LINE) && /PERSISTENT SET PIECES|GEOMETRY AUTHORITY/.test(c.prompt) && !/Choose ONE framing/.test(c.prompt) && !/not everyone must be visible/i.test(c.prompt)), 'worker: S140/S142 lines kept, soft wording gone in every prompt');
    ok(saved.every(b => b.status === 'frame_ready') && saved.slice(1).every(b => b.anchorBoardId === 'b0'), 'worker: statuses + S142 anchor persistence unchanged');
  } finally {
    internal._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
  console.log(`Stage 143: PASS (${passed} checks; transport mocked, no paid generation)`);
}
}

main().catch(err => { console.error(err); process.exitCode = 1; });
