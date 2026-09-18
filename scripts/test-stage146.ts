/** Stage 146: CHARACTER-FORWARD shot direction (both modes) — frames are built AROUND the characters and their
 * faces/actions, not around the location; wide / establishing shots only when the scene requires one.
 *
 * Why: the camera used to drift onto the location. In Scene (video) mode the shared prompt constants made a
 * WIDE / ESTABLISHING beat the dialogue base and BANNED face close-ups ("the face never fills the screen", "NO
 * full-screen face close-ups"), while LOCATION_PRESENCE_RULE pulled the environment forward ("same location from
 * several different angles and distances"). In Storyboard mode planSceneCoverage kept a periodic mid-scene "group"
 * wide as the base of a talking scene.
 *
 * Fix (both modes, no LLM at test time): PACE_DIRECTION / SCALE_DEPTH_RULE / LOCATION_PRESENCE_RULE and the inline
 * script-prompt framing rules now put the CHARACTERS first (medium / medium-close / OTS base, face close-up on an
 * emotional beat, wide only when the scene needs it); planSceneCoverage keeps board 1 as a scene-opening
 * establishing but degrades every LATER mid-scene "group" wide to character-forward coverage.
 *
 * Invariants preserved: static (LOCKED-OFF) camera dialogues, 180° / eyeline / addressee, S139 line integrity
 * (reconcileSpeechIds untouched), English dialogue, 9:16, anchor S142, continuity S144, sequential S145 guard,
 * i2v only in Storyboard. Pure string / logic assertions. No network, no paid generation. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PACE_DIRECTION, SCALE_DEPTH_RULE, LOCATION_PRESENCE_RULE, ACTION_STAGING_RULE,
  episodeScriptSystemPrompt, sceneReviseSystemPrompt,
} from '../lib/season';
import { planSceneCoverage, resolveVisibleCast, type ShotSize } from '../lib/board-coverage';
import type { BoardDirection } from '../lib/storyboard-direction';

let passed = 0;
function ok(value: unknown, message: string) { assert.ok(value, message); passed++; }

const cast4 = ['Anna', 'Boris', 'Clara', 'Dmitri'];
const sp = (speaker: string, addressee: string, text = 'x') => ({ id: `s-${speaker}`, sourceId: 'src', speaker, addressee, text, delivery: '', estimatedSec: 1 });
const dir = (over: Partial<BoardDirection>): BoardDirection => ({
  version: 146, cast: cast4, shot: 'over_shoulder', focus: 'Anna', listener: 'Boris', addressee: 'Boris', actionEnglish: 'Anna turns to Boris.',
  speech: [sp('Anna', 'Boris', 'Line')], cameraMode: 'LOCKED_OFF', ...over,
} as BoardDirection);

/* ─────────── (A) PACE_DIRECTION — Scene VIDEO prompt lever: character-forward, no face-close-up ban ─────────── */
ok(/built AROUND the characters/i.test(PACE_DIRECTION) && /medium \/ medium-close \/ over-the-shoulder/i.test(PACE_DIRECTION),
  'PACE_DIRECTION: base scale is character-forward (medium / medium-close / OTS)');
ok(/face close-up IS allowed and encouraged on an emotional beat/i.test(PACE_DIRECTION),
  'PACE_DIRECTION: face close-up allowed on emotional beats');
ok(!/the face never fills the screen/i.test(PACE_DIRECTION) && !/NO full-screen face close-up/i.test(PACE_DIRECTION) && !/DO NOT push in to a full-screen face close-up/i.test(PACE_DIRECTION),
  'PACE_DIRECTION: the hard face-close-up ban is gone');
ok(/full wide \/ establishing shot is used only when the scene requires it/i.test(PACE_DIRECTION),
  'PACE_DIRECTION: wide / establishing only when the scene requires it');
ok(!/all on WIDE and MEDIUM scales/i.test(PACE_DIRECTION) && !/most of every talking clip stays on wide \/ medium two-shots/i.test(PACE_DIRECTION),
  'PACE_DIRECTION: wide/medium is no longer the mandated base');
// Static-camera / eyeline / staging invariants untouched inside PACE_DIRECTION
ok(/squared off to each other/i.test(PACE_DIRECTION) && /NEVER by both turning frontally to the camera/i.test(PACE_DIRECTION),
  'PACE_DIRECTION: STAGING + EYELINES invariants preserved');

/* ─────────── (B) SCALE_DEPTH_RULE — character-forward, wide only on scenario need ─────────── */
ok(/build every shot around the CHARACTERS, not around the room/i.test(SCALE_DEPTH_RULE),
  'SCALE_DEPTH_RULE: shots built around characters, not the room');
ok(/CHARACTER-FORWARD scales/i.test(SCALE_DEPTH_RULE) && /face CLOSE-UP is allowed on an emotional beat/i.test(SCALE_DEPTH_RULE),
  'SCALE_DEPTH_RULE: character-forward scales + close-up on emotion');
ok(/NOT the mandatory opening and NOT the base scale/i.test(SCALE_DEPTH_RULE) && /use one only when the scene actually requires it/i.test(SCALE_DEPTH_RULE),
  'SCALE_DEPTH_RULE: wide/establishing only when the scene requires it');
ok(!/open every scene with a WIDE or ESTABLISHING beat/i.test(SCALE_DEPTH_RULE) && !/NO full-screen face close-ups/i.test(SCALE_DEPTH_RULE),
  'SCALE_DEPTH_RULE: the mandatory-opening-wide + face-close-up ban are gone');
ok(/never tiny figures lost in a big empty wide/i.test(SCALE_DEPTH_RULE),
  'SCALE_DEPTH_RULE: depth kept behind the characters (no tiny figures in an empty wide)');

/* ─────────── (C) LOCATION_PRESENCE_RULE — softened: environment is background, does not force a wide ─────────── */
ok(/the shot is built around the CHARACTERS/i.test(LOCATION_PRESENCE_RULE) && /environment is context BEHIND them/i.test(LOCATION_PRESENCE_RULE),
  'LOCATION_PRESENCE_RULE: environment is context behind the characters');
ok(/does not dominate the frame/i.test(LOCATION_PRESENCE_RULE) && /does NOT force the camera to pull back to a wide/i.test(LOCATION_PRESENCE_RULE),
  'LOCATION_PRESENCE_RULE: environment does not dominate / does not force a wide');
ok(!/several different angles and distances/i.test(LOCATION_PRESENCE_RULE),
  'LOCATION_PRESENCE_RULE: the "same location from several angles/distances" pull is gone');
// kept: location still a real inhabited space with alive background
ok(/the location is NOT a backdrop/i.test(LOCATION_PRESENCE_RULE) && /The place is ALIVE/i.test(LOCATION_PRESENCE_RULE),
  'LOCATION_PRESENCE_RULE: location presence + alive background preserved');

/* ─────────── (D) episodeScriptSystemPrompt (Scene author) — inline framing rules character-forward ─────────── */
const epPrompt = episodeScriptSystemPrompt('en', 1);
ok(/talking scenes are built AROUND the characters/i.test(epPrompt) && /base cut is a Medium \/ Medium-close \/ Over-the-shoulder/i.test(epPrompt),
  'episode prompt S2 SPEAKER FRAMING: character-forward base');
ok(!/the face NEVER fills the screen: NO full-screen face close-ups/i.test(epPrompt) && !/most of each talking scene stays on wide \/ medium two-shots/i.test(epPrompt),
  'episode prompt: no face-close-up ban left in S2');
ok(/a face CLOSE-UP is used on an emotional beat/i.test(epPrompt),
  'episode prompt [SHOT TYPE]: close-up on emotional beat allowed in the cut-list example');
ok(!/open on a WIDE\/ESTABLISHING beat that shows the characters INSIDE the space/i.test(epPrompt),
  'episode prompt [SHOT TYPE]: no mandatory wide/establishing opening');
// Invariants inside the episode prompt
ok(/STRICTLY in ENGLISH/i.test(epPrompt) && /9:16/.test(epPrompt),
  'episode prompt: English dialogue + 9:16 preserved');
ok(epPrompt.includes(PACE_DIRECTION) && epPrompt.includes(SCALE_DEPTH_RULE) && epPrompt.includes(LOCATION_PRESENCE_RULE),
  'episode prompt: uses the updated shared constants');

/* ─────────── (E) sceneReviseSystemPrompt — inline framing rules character-forward ─────────── */
const rev = sceneReviseSystemPrompt('en');
ok(/Talking scenes are built AROUND the characters/i.test(rev) && /every shot in which a line is spoken is a DIALOGUE shot/i.test(rev) && /is NOT used while any character is speaking/i.test(rev),
  'revise prompt: character-forward talking-scene framing (dialogue shot, no wide while speaking)');
ok(!/Talking scenes stay on wide \/ medium two-shots \/ over-the-shoulder/i.test(rev) && !/NO full-screen face close-ups/i.test(rev),
  'revise prompt: old wide/medium base + face-close-up ban gone');
ok(/character-forward framing/i.test(rev) && rev.includes(ACTION_STAGING_RULE),
  'revise prompt: action-scene exemption references character-forward framing; ACTION_STAGING_RULE intact');

/* ─────────── (F) Storyboard planSceneCoverage — character-forward base, wide only justified ─────────── */
// mid-scene group wide (any position > 0) degrades to character-forward
const mid = planSceneCoverage(Array.from({ length: 6 }, (_, i) => dir({ shot: i === 5 ? 'group' : 'medium', speech: [sp('Anna', 'Boris')] })));
ok(mid[0].shot === 'close_up', 'planSceneCoverage (Stage 152): board 1 is the scene-opening CLOSE-UP of the first speaker');
ok(mid[5].shot === 'over_shoulder', 'planSceneCoverage: a LATE mid-scene group wide degrades to OTS (no periodic wide as base)');
ok(mid.slice(1).every(d => d.shot !== 'group'), 'planSceneCoverage: no mid-scene board stays a group wide');
// without addressee/listener the degrade is a medium single on the speaker
const noAddr = planSceneCoverage([dir({}), dir({ shot: 'group', addressee: '', listener: '', speech: [sp('Clara', '') ] })]);
ok(noAddr[1].shot === 'medium', 'planSceneCoverage: mid-scene group without addressee → medium single');
// close_up requested mid-scene is preserved (character-forward, not forced to wide)
const cuKept = planSceneCoverage([dir({}), dir({ shot: 'close_up', speech: [sp('Anna', 'Boris')] })]);
ok(cuKept[1].shot === 'close_up', 'planSceneCoverage: a mid-scene close_up is preserved (not widened)');

/* ─────────── (G) resolveVisibleCast — dialogue boards > 0 are character-forward; close_up allowed ─────────── */
const cu = resolveVisibleCast(dir({ shot: 'close_up' }), 2, cast4, '');
ok(cu.shotSize === ('CLOSE-UP' as ShotSize) && cu.visible.join() === 'Anna', 'resolveVisibleCast: mid-scene close_up → CLOSE-UP on the speaker');
const ots = resolveVisibleCast(dir({ shot: 'over_shoulder' }), 2, cast4, '');
ok(ots.shotSize === 'OVER-THE-SHOULDER' && ots.visible.join() === 'Anna,Boris', 'resolveVisibleCast: mid-scene OTS → speaker + addressee only');
const md = resolveVisibleCast(dir({ shot: 'medium' }), 2, cast4, '');
ok(md.shotSize === 'MEDIUM' && md.visible.join() === 'Anna', 'resolveVisibleCast: mid-scene medium → speaker single');
// board 1 (position 0) opening on dialogue is a CLOSE-UP of the first speaker (Stage 152)
const b1 = resolveVisibleCast(dir({ shot: 'close_up' }), 0, cast4, '');
ok(b1.shotSize === 'CLOSE-UP' && b1.visible.join() === 'Anna', 'resolveVisibleCast (Stage 152): board 1 opening on dialogue → CLOSE-UP of the first speaker (Anna)');
// group ACTION (3+ named participants) is still a justified wide
const act = resolveVisibleCast(null, 3, cast4, 'Boris, Clara and Dmitri leave through the door.');
ok(act.shotSize === 'WIDE ESTABLISHING' && act.visible.length === 3, 'resolveVisibleCast: group action (3 moving) still a justified wide');

/* ─────────── (H) invariant strings still present in the shared prompts (both modes) ─────────── */
// static camera dialogues + 180 / eyeline live in the storyboard modules; episode/revise carry English + 9:16 + continuity
ok(/SCENE-TO-SCENE CONTINUITY/i.test(epPrompt) && /SCENE-TO-SCENE CONTINUITY/i.test(rev),
  'continuity rule (S144-family) present in both author prompts');
ok(/exactly once|appear exactly once|one line per row/i.test(epPrompt),
  'S139 line-integrity intent present in the episode prompt');
const boardCoverageSrc = readFileSync('lib/board-coverage.ts', 'utf8');
ok(/the speech ledger \(S139\) are untouched/i.test(boardCoverageSrc) && /180° axis|180-degree|S134/i.test(boardCoverageSrc),
  'board-coverage: S139 ledger + S134 axis explicitly left untouched');

console.log(`Stage 146: PASS (${passed} checks; character-forward both modes, no network, no paid generation)`);
