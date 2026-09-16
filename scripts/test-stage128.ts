/**
 * Stage 128 — STORY STRUCTURE = one detailed CONTINUOUS episode synopsis (no 30/30 shot split); cliffhanger KEPT.
 *
 * The season/story build no longer emits the rigid "SHOT 1 (30 s) / SHOT 2 (30 s) / CLIFFHANGER" per episode.
 * Each episode "description" is now ONE flowing, detailed synopsis paragraph (set-up → development → turn →
 * ending) followed by a single closing "CLIFFHANGER: …" line. The cliffhanger stays (separate JSON field +
 * closing line). Legacy episodes still saved in the old 3-line footage format keep parsing (backward compat,
 * no auto-migration). Both production modes (Scenes, Storyboard) build from this new continuous format.
 *
 * These checks are PURE (no network, no LLM, no DB, no paid generations):
 *   (A) the structure / revise / story-revise prompts drop every shot/beat/30-second split marker AND state the
 *       new continuous-synopsis rule + the closing CLIFFHANGER line
 *   (B) parseEpisodeSynopsis splits new format, merges the legacy footage format, and handles plain prose
 *   (C) validateEpisodeSynopses flags a shot-split / a missing cliffhanger, and PASSES a good detailed synopsis
 *   (D) hasShotSplitMarkers / stripShotSplitLabels behave
 *   (E) repairEpisodeSynopses with a DEAD llm still converges deterministically to a valid synopsis
 *   (F) storyboard detailedEpisodeStory turns a new-format description into one through-line (no split markers)
 *   (G) buildFullStoryFromStructure keeps the ═══ headers and renders the prose + CLIFFHANGER line
 *   (H) grep-level UI assertions: episode-footage.tsx / story-stage.tsx carry the new wording, not "(30 s)"
 *
 * Run: timeout 120 npx tsx --tsconfig tsconfig.json scripts/test-stage128.ts
 */
import {
  seasonStructureSystemPrompt,
  seasonReviseSystemPrompt,
  seasonStoryReviseSystemPrompt,
  parseEpisodeSynopsis,
  validateEpisodeSynopses,
  hasShotSplitMarkers,
  stripShotSplitLabels,
  buildFullStoryFromStructure,
  CLIFFHANGER_LINE_LABEL,
  SHOT1_LABEL,
  SHOT2_LABEL,
  CLIFFHANGER_LABEL,
  EPISODE_SYNOPSIS_MAX_WORDS,
} from '../lib/season';
import { repairEpisodeSynopses } from '../lib/footage-repair';
import { detailedEpisodeStory, hasSplitMarkers } from '../lib/storyboard';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
  console.log('ok: ' + msg);
}

const ROOT = join(__dirname, '..');
const SHOT_MARKERS = ['SHOT 1', 'SHOT 2', 'BEAT 1', 'BEAT 2', '30 s', '30 sec', '30 seconds', 'first 30', 'last 30', '60-second'];

// ── (A) prompts drop the shot/beat/30-second split, state the continuous-synopsis rule ───────────────────
for (const [label, prompt] of [
  ['structure', seasonStructureSystemPrompt('en', 6)],
  ['revise', seasonReviseSystemPrompt('en', 6)],
  ['story-revise', seasonStoryReviseSystemPrompt('en', 6)],
] as const) {
  // A prompt is allowed to say "no SHOT 1 / 30 s" as a PROHIBITION; assert it never PRESCRIBES a shot split.
  ok(/CONTINUOUS SYNOPSIS/i.test(prompt), `${label} prompt states the CONTINUOUS SYNOPSIS rule`);
  ok(prompt.includes(CLIFFHANGER_LINE_LABEL), `${label} prompt keeps the closing "${CLIFFHANGER_LINE_LABEL}" line`);
  ok(/do not divide the episode into shots/i.test(prompt), `${label} prompt forbids dividing the episode into shots`);
  // it must NOT prescribe a 3-line footage plan any more (the old "SHOT 1: ... SHOT 2: ..." recipe)
  ok(!/write\s+shot\s*1/i.test(prompt) && !/shot\s*1\s*\(30/i.test(prompt), `${label} prompt does not prescribe a SHOT 1 (30 s) footage plan`);
}
// The structure prompt in Russian also carries the rule (localised build still uses the English rule text).
ok(/CONTINUOUS SYNOPSIS/i.test(seasonStructureSystemPrompt('ru', 8)), 'ru structure prompt still carries the synopsis rule');

// ── (B) parseEpisodeSynopsis: new format / legacy footage / plain prose ──────────────────────────────────
const newDesc = 'A tired nurse enters a dim ward at night and checks a sleeping patient while the monitor hums. Moments later it flatlines and she fights to revive him as the corridor lights die one by one. She finally gets a pulse back, but the room has gone silent and cold.\n' + CLIFFHANGER_LINE_LABEL + ' A shadow rises behind the curtain.';
{
  const { synopsis, cliffhanger } = parseEpisodeSynopsis(newDesc);
  ok(/nurse/i.test(synopsis) && /flatlines/i.test(synopsis), 'parseEpisodeSynopsis keeps the prose synopsis');
  ok(!/cliffhanger/i.test(synopsis), 'parseEpisodeSynopsis strips the CLIFFHANGER line out of the synopsis body');
  ok(cliffhanger === 'A shadow rises behind the curtain.', 'parseEpisodeSynopsis extracts the closing cliffhanger');
}
// legacy 3-line footage merges into ONE synopsis + the footage cliffhanger
const legacyDesc = `${SHOT1_LABEL} OPENS ON: a shadow rises behind the curtain. The nurse backs toward the door.\n${SHOT2_LABEL} She sprints down the corridor as the lights chase her.\n${CLIFFHANGER_LABEL} A hand grabs her shoulder from the dark.`;
{
  const { synopsis, cliffhanger } = parseEpisodeSynopsis(legacyDesc);
  ok(/nurse/i.test(synopsis) && /corridor/i.test(synopsis), 'parseEpisodeSynopsis merges legacy SHOT 1 + SHOT 2 into one synopsis');
  ok(!/shot\s*1/i.test(synopsis) && !/shot\s*2/i.test(synopsis), 'merged legacy synopsis has no SHOT 1 / SHOT 2 labels');
  ok(cliffhanger === 'A hand grabs her shoulder from the dark.', 'parseEpisodeSynopsis keeps the legacy footage cliffhanger');
}
// plain prose without a cliffhanger line
{
  const { synopsis, cliffhanger } = parseEpisodeSynopsis('Just a plain paragraph with no hook line at all.');
  ok(synopsis === 'Just a plain paragraph with no hook line at all.' && cliffhanger === null, 'parseEpisodeSynopsis handles plain prose (no cliffhanger)');
}

// ── (C) validateEpisodeSynopses ─────────────────────────────────────────────────────────────────────────
ok(validateEpisodeSynopses([{ number: 1, description: newDesc }]).length === 0, 'validateEpisodeSynopses passes a good detailed synopsis + cliffhanger');
{
  const bad = 'SHOT 1 (30 s): a nurse enters the ward. SHOT 2 (30 s): the monitor flatlines.\n' + CLIFFHANGER_LINE_LABEL + ' A shadow rises.';
  const probs = validateEpisodeSynopses([{ number: 1, description: bad }]);
  ok(probs.some((p) => /shot\/beat\/timing split/i.test(p)), 'validateEpisodeSynopses flags a shot/30 s split');
}
{
  const noCliff = 'A nurse enters the ward at night and revives a patient as the lights fail around her.';
  const probs = validateEpisodeSynopses([{ number: 2, description: noCliff }]);
  ok(probs.some((p) => /missing the closing/i.test(p)), 'validateEpisodeSynopses flags a missing cliffhanger line');
}
{
  const missing = validateEpisodeSynopses([{ number: 3, description: '' }]);
  ok(missing.some((p) => /description is missing/i.test(p)), 'validateEpisodeSynopses flags a missing description');
}

// ── (D) hasShotSplitMarkers / stripShotSplitLabels ──────────────────────────────────────────────────────
ok(hasShotSplitMarkers('the last 30 seconds show a chase') === true, 'hasShotSplitMarkers detects a "30 seconds" timing');
ok(hasShotSplitMarkers('SHOT 2 begins here') === true, 'hasShotSplitMarkers detects a SHOT 2 marker');
ok(hasShotSplitMarkers('one continuous synopsis of the whole episode') === false, 'hasShotSplitMarkers passes a clean synopsis');
{
  const stripped = stripShotSplitLabels('SHOT 1: a nurse enters. SHOT 2: she runs.');
  ok(!/shot\s*1/i.test(stripped) && !/shot\s*2/i.test(stripped), 'stripShotSplitLabels removes the SHOT labels');
  ok(/nurse/i.test(stripped) && /runs/i.test(stripped), 'stripShotSplitLabels keeps the surrounding prose');
}

// ── (E) repairEpisodeSynopses converges with a DEAD llm (deterministic clamp) ────────────────────────────
async function main() {
  const deadLLM = async () => { throw new Error('no network in tests'); };
  const broken = [
    { number: 1, title: 'Descent', description: 'SHOT 1 (30 s): a squad climbs into a dugout. SHOT 2 (30 s): the radio crackles with a rescue voice.\nCLIFFHANGER: five glowing eyes open in the dark.', cliffhanger: 'five glowing eyes open in the dark.' },
    { number: 2, title: 'Swarm', description: 'first 30: the creatures pour in. last 30: the leader shoves the child behind him.', cliffhanger: 'a clawed hand closes on the ankle.' },
  ];
  ok(validateEpisodeSynopses(broken).length > 0, 'repair input starts INVALID (shot/timing split present)');
  const res = await repairEpisodeSynopses(broken, 'en', deadLLM, { log: () => {} });
  ok(validateEpisodeSynopses(res.episodes).length === 0, 'repairEpisodeSynopses converges to a VALID synopsis even with a dead llm');
  for (const e of res.episodes) {
    ok(!hasShotSplitMarkers(e.description), `repaired episode ${e.number} has no shot/beat/timing markers`);
    ok((e.description ?? '').includes(CLIFFHANGER_LINE_LABEL), `repaired episode ${e.number} has a closing CLIFFHANGER line`);
    ok((e.cliffhanger ?? '').trim().length > 0, `repaired episode ${e.number} mirrors the cliffhanger field`);
  }
  ok(res.clamped.length === 2, 'repairEpisodeSynopses clamped both episodes deterministically');

  // ── (F) storyboard detailedEpisodeStory on a NEW-format description → one through-line, no split markers ──
  const story = detailedEpisodeStory(newDesc);
  ok(story.length > 0, 'detailedEpisodeStory produces a non-empty through-line from a new-format synopsis');
  ok(!hasSplitMarkers(detailedEpisodeStory(newDesc)), 'detailedEpisodeStory through-line has no split markers (fresh string)');
  ok(/nurse/i.test(story) && /flatlines/i.test(story), 'storyboard through-line still carries the story events');

  // ── (G) buildFullStoryFromStructure keeps ═══ headers + prose + CLIFFHANGER line ────────────────────────
  const full = buildFullStoryFromStructure(
    { title: 'Test', logline: 'A season logline.', episodes: [
      { number: 1, title: 'Descent', description: newDesc },
      { number: 2, title: 'Swarm', description: 'The shadow lunges and the nurse fights it off in the dark corridor.\n' + CLIFFHANGER_LINE_LABEL + ' The exit door slams shut on its own.' },
    ] },
    'en',
  );
  ok(/═══\s*EPISODE\s*1/i.test(full), 'buildFullStoryFromStructure keeps the ═══ EPISODE 1 header');
  ok(/═══\s*EPISODE\s*2/i.test(full), 'buildFullStoryFromStructure keeps the ═══ EPISODE 2 header');
  ok(/nurse/i.test(full) && full.includes(CLIFFHANGER_LINE_LABEL), 'full story renders the prose synopsis + CLIFFHANGER line');

  // ── (H) UI grep assertions ──────────────────────────────────────────────────────────────────────────────
  const footageTsx = readFileSync(join(ROOT, 'app/project/[id]/_components/episode-footage.tsx'), 'utf8');
  ok(footageTsx.includes('episode-synopsis'), 'episode-footage.tsx renders the new episode-synopsis block');
  ok(!/\(30 s\)/.test(footageTsx), 'episode-footage.tsx no longer prints a "(30 s)" label');
  const storyTsx = readFileSync(join(ROOT, 'app/project/[id]/_components/story-stage.tsx'), 'utf8');
  ok(/continuous synopsis/i.test(storyTsx), 'story-stage.tsx chrome describes a continuous synopsis');
  ok(!/30-second shots/i.test(storyTsx) && !/two 30-second/i.test(storyTsx), 'story-stage.tsx chrome no longer mentions 30-second shots');

  console.log(`Stage 128: PASS (${passed} checks)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
