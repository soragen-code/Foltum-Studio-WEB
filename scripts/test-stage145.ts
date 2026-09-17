/** Stage 145 — TWO changes, both verified with pure logic + string checks (no network, no paid generation):
 *
 * (A) STRICTLY SEQUENTIAL generation in BOTH modes, reinforced with a HARD backend guard:
 *   - Storyboard: a new pure gate boardFramePrecondition() blocks rendering board N's frame until the
 *     previous board's frame is ready (a valid imageUrl). The first board and regenerating an already-
 *     framed board are always allowed. Wired into app/api/ai/storyboard/[boardId]/frame/route.ts (409).
 *   - Scenes: the existing assertPredecessorReady()/resolveVideoPredecessor() guard (returns 409 from
 *     app/api/ai/generate-video/route.ts) is re-verified — the previous scene video must be `generated`
 *     with a videoUrl; the series opening (episode 1 scene 1) is allowed.
 *   - UI: the storyboard frame button and the scene "Generate scene" button are disabled until the
 *     previous element is ready, with the English tooltip "Generate the previous shot/scene first".
 *
 * (B) MUSIC too loud during assembly — lib/ffmpeg.ts buildMusicMixFilter (the single-track path used by
 *   lib/assemble.ts) now mixes the music at a LOWER named level (MUSIC_BED_VOLUME) AND ducks it under the
 *   clip's speech with sidechaincompress (named MUSIC_DUCK_* params), mirroring the segmented soundtrack.
 *   Policy unchanged: ONE music track, hard cuts — only the level and the ducking change.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { boardFramePrecondition } from '../lib/board-anchor';
import { assertPredecessorReady, resolveVideoPredecessor, type Predecessor } from '../lib/reangle';
import {
  buildMusicMixFilter, buildFinalRenderArgs, buildMusicSegmentsMixFilter,
  MUSIC_BED_VOLUME, MUSIC_DUCK_THRESHOLD, MUSIC_DUCK_RATIO, MUSIC_DUCK_ATTACK, MUSIC_DUCK_RELEASE,
} from '../lib/ffmpeg';

let passed = 0;
function ok(value: unknown, message: string) { assert.ok(value, message); passed++; }
const u = (n: string) => ['https:/', 'boards.s3.amazonaws.com', `${n}.png`].join('/');

async function main() {

/* ─────────── (A1) boardFramePrecondition — storyboard sequential gate ─────────── */
// A three-board episode; boards carry only { index, imageUrl } for the gate.
const framed = (i: number) => ({ index: i, imageUrl: u(`frame-${i}`) });
const empty = (i: number) => ({ index: i, imageUrl: null });

ok(boardFramePrecondition(empty(0), [empty(0), empty(1), empty(2)]).allowed, 'gate: the FIRST board (index 0) is always allowed even with nothing rendered');
const blocked = boardFramePrecondition(empty(1), [empty(0), empty(1)]);
ok(!blocked.allowed && blocked.reason === 'Generate the previous shot first.', 'gate: board 1 is BLOCKED (409 reason) while board 0 has no frame');
ok(boardFramePrecondition(empty(1), [framed(0), empty(1), empty(2)]).allowed, 'gate: board 1 is allowed once board 0 has a ready frame');
ok(!boardFramePrecondition(empty(2), [framed(0), empty(1), empty(2)]).allowed, 'gate: board 2 stays blocked while its immediate predecessor (board 1) has no frame');
ok(boardFramePrecondition(empty(2), [framed(0), framed(1), empty(2)]).allowed, 'gate: board 2 is allowed once board 1 has a ready frame');
// Regenerating an already-framed board is always allowed regardless of the predecessor's state.
ok(boardFramePrecondition(framed(2), [framed(0), empty(1), framed(2)]).allowed, 'gate: regenerating an ALREADY-framed board is allowed even if an earlier board lost its frame');
// "Ready" follows the frame (imageUrl), so a predecessor whose status advanced past frame_ready (its clip
// was animated → its imageUrl is still set) still unblocks the next board.
ok(boardFramePrecondition(empty(1), [{ index: 0, imageUrl: u('done-frame') }, empty(1)]).allowed, 'gate: a predecessor keeps its frame (imageUrl) after animating → next board unblocked');
// Only the IMMEDIATE predecessor matters, not every earlier board.
ok(boardFramePrecondition(empty(3), [empty(0), empty(1), framed(2), empty(3)]).allowed, 'gate: only the immediate predecessor (board 2) must be ready — a gap earlier does not re-block');

/* ─────────── (A2) SCENE guard — assertPredecessorReady / resolveVideoPredecessor ─────────── */
const prevOf = (over: Partial<Predecessor>): Predecessor => ({ id: 'p', number: 1, videoUrl: u('v'), lastFrameUrl: u('lf'), status: 'generated', ...over });
assert.doesNotThrow(() => assertPredecessorReady(null)); passed++; // series opening (allowed)
ok((() => { try { assertPredecessorReady(prevOf({ status: 'pending', videoUrl: null })); return false; } catch (e: any) { return /Finish the previous scene video/.test(e.message); } })(), 'scene guard: throws when the previous scene is NOT generated');
ok((() => { try { assertPredecessorReady(prevOf({ status: 'generated', videoUrl: u('v'), lastFrameUrl: null })); return false; } catch (e: any) { return /has no extracted last frame/.test(e.message); } })(), 'scene guard: a generated-but-frameless predecessor is still rejected (recover its last frame first)');
assert.doesNotThrow(() => assertPredecessorReady(prevOf({ status: 'generated', videoUrl: u('v'), lastFrameUrl: u('lf') }))); passed++; // fully ready → allowed

// resolveVideoPredecessor: number>1 finds the prior scene; episode 1 scene 1 → null (series opening).
const db = {
  scene: { findFirst: async ({ where, orderBy }: any) => {
    if (where.episodeId === 'ep1' && where.number === 1) return { id: 's1', number: 1, videoUrl: u('v1'), lastFrameUrl: u('lf1'), status: 'generated' };
    return null;
  } },
  episode: {
    findUnique: async ({ where }: any) => (where.id === 'ep1' ? { number: 1, seasonId: 'se1' } : null),
    findFirst: async () => null,
  },
};
ok((await resolveVideoPredecessor(db, { episodeId: 'ep1', number: 2 }))?.id === 's1', 'resolveVideoPredecessor: scene 2 resolves scene 1 as its predecessor');
ok((await resolveVideoPredecessor(db, { episodeId: 'ep1', number: 1 })) === null, 'resolveVideoPredecessor: episode 1 scene 1 is the series opening (null → allowed)');

/* ─────────── (A3) routes/UI wire the guards ─────────── */
const frameRoute = readFileSync('app/api/ai/storyboard/[boardId]/frame/route.ts', 'utf8');
ok(/boardFramePrecondition/.test(frameRoute) && /status:\s*409/.test(frameRoute) && /episodeId: board\.episodeId/.test(frameRoute), 'frame route: imports the gate, loads siblings by episode, returns 409 when blocked');
const videoRoute = readFileSync('app/api/ai/generate-video/route.ts', 'utf8');
ok(/assertPredecessorReady\(await resolveVideoPredecessor/.test(videoRoute) && /status:\s*409/.test(videoRoute), 'video route: still guards the predecessor and returns 409 (scene guard unchanged)');
const sbPanel = readFileSync('app/project/[id]/episode/[episodeId]/storyboard-panel.tsx', 'utf8');
ok(/frameLocked/.test(sbPanel) && /Generate the previous shot first/.test(sbPanel) && /boardFramePrecondition/.test(sbPanel), 'storyboard UI: frame button disabled via frameLocked with the English tooltip');
const epView = readFileSync('app/project/[id]/episode/[episodeId]/episode-view.tsx', 'utf8');
ok(/sceneLocked/.test(epView) && /Generate the previous scene first/.test(epView), 'scene UI: Generate button disabled via sceneLocked with the English tooltip');
ok(/disabled=\{sceneLocked\}/.test(epView), 'scene UI: the not-yet-generated Generate button carries disabled={sceneLocked}');

/* ─────────── (B1) buildMusicMixFilter — lower level + sidechain ducking ─────────── */
ok(MUSIC_BED_VOLUME < 0.18, `music: the bed level (${MUSIC_BED_VOLUME}) is lower than the historical 0.18`);
const mix = buildMusicMixFilter({ durationSec: 90 });
ok(mix.includes(`volume=${MUSIC_BED_VOLUME}`), 'music mix: the music is set to the lowered MUSIC_BED_VOLUME by default');
ok(!mix.includes('volume=0.18'), 'music mix: the old 0.18 level is gone');
ok(mix.includes(`sidechaincompress=threshold=${MUSIC_DUCK_THRESHOLD}:ratio=${MUSIC_DUCK_RATIO}:attack=${MUSIC_DUCK_ATTACK}:release=${MUSIC_DUCK_RELEASE}`), 'music mix: the music bed is ducked under speech with the named sidechaincompress params');
ok(/\[0:a\][^;]*asplit=2\[c\]\[ckey\]/.test(mix), 'music mix: the clip audio is split into a main copy + a sidechain key');
ok(/\[m\]\[ckey\]sidechaincompress[^;]*\[ducked\]/.test(mix), 'music mix: the music (input 1) is the compressed signal, the clip voice (ckey) is the sidechain key');
ok(/\[c\]\[ducked\]amix=inputs=2:duration=first:dropout_transition=0:normalize=0\[aout\]/.test(mix), 'music mix: the main clip audio is mixed back on top of the ducked music (duration=first, no normalize), output [aout]');
// An explicit override still wins (back-compat for any caller that passes a volume).
ok(buildMusicMixFilter({ durationSec: 90, volume: 0.2 }).includes('volume=0.2'), 'music mix: an explicit volume override is still honored');

/* ─────────── (B2) buildFinalRenderArgs — single-track path carries the ducking ─────────── */
const single = buildFinalRenderArgs({ input: 'in.mp4', output: 'out.mp4', quality: '480p', fps: 30, musicPath: 'music.mp3', durationSec: 90 });
const fc = single.args[single.args.indexOf('-filter_complex') + 1];
ok(single.reencodesAudio === true && fc.includes('sidechaincompress') && fc.includes(`volume=${MUSIC_BED_VOLUME}`), 'final render (single track): the filtergraph uses the lowered level + sidechain ducking');
// No music → no music filter at all (native copy path is untouched).
const nomusic = buildFinalRenderArgs({ input: 'in.mp4', output: 'out.mp4', quality: '480p', fps: 30, musicPath: null, durationSec: 90 });
ok(nomusic.reencodesVideo === false && !nomusic.args.includes('-filter_complex'), 'final render (no music): native 480p/30 stays a pure -c copy with no music filter');

/* ─────────── (B3) segmented soundtrack path unchanged (still ducks) ─────────── */
const seg = buildMusicSegmentsMixFilter({ segments: [{ path: 'a.mp3', startSec: 0, endSec: 90, intensity: 1 }], hasVoice: true, totalDuration: 90 });
ok(seg.includes('sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300') && seg.includes('[aout]'), 'segmented soundtrack: its existing sidechain ducking is unchanged (S79 path still works)');

/* ─────────── (C) invariants: SCENES / shared adapters byte-identical to the S144 baseline ─────────── */
// Music is a level/ducking change ONLY: assemble.ts is untouched, and the SCENES pipeline never changes.
for (const file of ['lib/assemble.ts', 'lib/workers/video-job.ts', 'lib/scene-prompt.ts', 'lib/region-plate.ts', 'lib/wavespeed.ts', 'lib/providers/video-provider.ts']) {
  const baseline = execFileSync('git', ['show', `18b71a09e6c6:${file}`], { encoding: 'utf8' });
  ok(baseline === readFileSync(file, 'utf8'), `unchanged SCENES/shared/assembly file: ${file}`);
}

console.log(`Stage 145: PASS (${passed} checks; transport mocked, no paid generation)`);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
