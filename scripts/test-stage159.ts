/**
 * Stage 159 — manual (author-provided) script: accept the author's own dialogue language and speaker
 * names instead of HARD-rejecting them. Verified with pure logic only (no network, no LLM, no DB, no
 * paid generations).
 *
 * Bug: a pasted script with non-English (e.g. Russian) dialogue and speaker names outside the project
 * cast was run through the SAME rigid gate as an auto-generated LLM script. On the FIRST attempt the
 * "dialogue is not English" and "speaker not from the cast" problems are HARD → the manual job throws,
 * exhausts its retries and hard-fails ("uploaded my script but it didn't regenerate").
 *
 * Fix: validateEpisode now takes a `manual` opt and, like `finalAttempt`, passes
 * `languageIsSoft: true` — the author's language + speaker names become soft (logged, never fatal). The
 * spoken track is still forced to English downstream (ensureEnglishDialogue) and the author's original
 * lines are preserved in dialogueLocal, so the author's script is accepted exactly as written.
 *
 *  (1) SEASON-LEVEL GATE — validateEpisodeScript with languageIsSoft:false emits the language + cast
 *      problems as HARD; with languageIsSoft:true the SAME input emits them only as "soft:" (0 hard).
 *  (2) WORKER-LEVEL FIX — validateEpisode({ manual:true }) does NOT throw on a Russian, non-cast script;
 *      validateEpisode({}) (first attempt, non-manual) DOES throw on the same input.
 *
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage159.ts
 */
import { validateEpisodeScript, hardProblems, type EpisodeScript } from '../lib/season';
import { validateEpisode } from '../lib/workers/season-script-job';
import type { CharacterCard } from '../lib/idea';

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
  console.log('ok: ' + msg);
}

// A complete videoPrompt carrying all nine required prompt tags (and > 40 chars) so the ONLY problems
// under test are the language + speaker-name ones.
const VP = '[SHOT TYPE] medium two-shot [VISUAL STYLE] cinematic realism [LIGHTING] soft office light ' +
  '[BLOCKING] two workers at a desk [GAZE] eye contact [NON-VERBAL] a nod [ACTION] they talk ' +
  '[CHARACTER] office worker in a grey suit [TRANSITION] hard cut';

// Russian dialogue with speaker names that are NOT in the project cast — exactly the real failing case.
const RU_DIALOGUE =
  'СОТРУДНИК 1: "Привет, как у тебя сегодня дела на работе?"\n' +
  'СОТРУДНИК 2: "Всё хорошо, спасибо большое, а у тебя как?"';

function scene(number: number) {
  return {
    number,
    shotType: 'medium two-shot',
    durationSec: 10,
    locationDesc: 'INT — open-plan office — day',
    characters: [],
    action: 'Two office workers talk at a desk while others pass behind them.',
    dialogue: RU_DIALOGUE,
    sceneKind: 'dialogue',
    videoPrompt: VP,
    endState: 'Both workers stay seated at the desk, facing each other, the room quiet behind them.',
    startState: 'Both workers are seated at the desk, facing each other, morning light from the left.',
  };
}

// A full 9-scene episode (EPISODE_SCENE_COUNT) with Russian, non-cast dialogue in every scene.
const rawEpisode = {
  visualIdentity: 'A grounded modern office drama, muted colours, handheld realism.',
  scenes: Array.from({ length: 9 }, (_, i) => scene(i + 1)),
};

const cast: CharacterCard[] = [{ name: 'Mark Ellison' } as unknown as CharacterCard];

// ───────────────────────── (1) season-level gate: soft vs hard ─────────────────────────
const script = rawEpisode as unknown as EpisodeScript;

const hardWhenStrict = hardProblems(
  validateEpisodeScript(script, { characterNames: ['Mark Ellison'], languageIsSoft: false }),
);
ok(hardWhenStrict.length > 0,
  'validateEpisodeScript(languageIsSoft:false): Russian, non-cast dialogue yields HARD problems (first-attempt gate)');
ok(hardWhenStrict.some((p) => /not English/.test(p)),
  'validateEpisodeScript(languageIsSoft:false): a HARD "dialogue is not English" problem is present');
ok(hardWhenStrict.some((p) => /not from the cast/.test(p)),
  'validateEpisodeScript(languageIsSoft:false): a HARD "speaker name(s) not from the cast" problem is present');

const allWhenSoft = validateEpisodeScript(script, { characterNames: ['Mark Ellison'], languageIsSoft: true });
const hardWhenSoft = hardProblems(allWhenSoft);
ok(hardWhenSoft.length === 0,
  'validateEpisodeScript(languageIsSoft:true): the SAME script yields ZERO hard problems (manual/final path)');
ok(allWhenSoft.some((p) => /^soft: .*not English/.test(p)),
  'validateEpisodeScript(languageIsSoft:true): the language problem is still reported, but only as "soft:"');
ok(allWhenSoft.some((p) => /^soft: .*not from the cast/.test(p)),
  'validateEpisodeScript(languageIsSoft:true): the cast problem is still reported, but only as "soft:"');

// ───────────────────────── (2) worker-level fix: manual opt ─────────────────────────
let threwOnFirstAttempt = false;
try {
  validateEpisode(structuredClone(rawEpisode), 1, cast, {});
} catch {
  threwOnFirstAttempt = true;
}
ok(threwOnFirstAttempt,
  'validateEpisode({}) : a first-attempt AUTO script with Russian, non-cast dialogue THROWS (unchanged behaviour)');

let manualScript: EpisodeScript | null = null;
let manualThrew = false;
try {
  manualScript = validateEpisode(structuredClone(rawEpisode), 1, cast, { manual: true });
} catch (e) {
  manualThrew = true;
  console.error('  (manual validateEpisode threw:', (e as Error).message, ')');
}
ok(!manualThrew,
  'validateEpisode({ manual:true }) : the SAME author script does NOT throw (accepted as written)');
ok(manualScript !== null && manualScript.scenes.length === 9,
  'validateEpisode({ manual:true }) : returns the normalized 9-scene episode');
ok(manualScript !== null && manualScript.scenes.every((s) => /[\u0400-\u04FF]/.test(s.dialogue)),
  'validateEpisode({ manual:true }) : the author\'s original (Cyrillic) dialogue is preserved on the script');

// finalAttempt alone (the pre-Stage-159 escape hatch) must still work the same way.
let finalThrew = false;
try {
  validateEpisode(structuredClone(rawEpisode), 1, cast, { finalAttempt: true });
} catch {
  finalThrew = true;
}
ok(!finalThrew,
  'validateEpisode({ finalAttempt:true }) : still does not throw (pre-existing soft-language path intact)');

console.log(`test-stage159 PASS (${passed} checks)`);
