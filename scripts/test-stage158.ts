/**
 * Stage 158 — "insert your own full episode script" (manual script choice), verified with pure logic only
 * (no network, no LLM, no DB, no paid generations):
 *
 *  (1) MANUAL-SCRIPT DIRECTIVE — manualScriptDirective builds the one-episode queue directive carrying the
 *      author's pasted text (empty instruction = not an author revise hint; force = overwrite the existing
 *      script). isManualScriptDirective recognises it, and rejects a plain reset-to-auto (no userScript) and
 *      null/blank userScript.
 *
 *  (2) AUTHORITATIVE PROMPT BLOCK — episodeScriptUserPrompt WITH userScript emits the AUTHOR-PROVIDED FULL
 *      EPISODE SCRIPT block (the strongest source), carries the pasted text verbatim, instructs to keep the
 *      author's scenes/dialogue EXACTLY as written, and states THIS SCRIPT WINS; WITHOUT userScript the block
 *      is absent.
 *
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage158.ts
 */
import { manualScriptDirective, isManualScriptDirective, scriptResetDirective } from '../lib/reset-to-auto';
import { episodeScriptUserPrompt } from '../lib/season';

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
  console.log('ok: ' + msg);
}

// ───────────────────────── (1) manual-script directive ─────────────────────────
const d = manualScriptDirective('ep1', 'MY FULL SCRIPT TEXT — scene one, dialogue.');
ok(Array.isArray(d.episodeIds) && d.episodeIds.length === 1 && d.episodeIds[0] === 'ep1',
  'manualScriptDirective: queues exactly the one episode');
ok(d.instruction === '', 'manualScriptDirective: empty instruction (not an author revise hint)');
ok(d.force === true, 'manualScriptDirective: force=true (overwrite existing script)');
ok(d.userScript === 'MY FULL SCRIPT TEXT — scene one, dialogue.', 'manualScriptDirective: carries the pasted userScript');

ok(isManualScriptDirective(d) === true, 'isManualScriptDirective: true for a manual-script directive');
ok(isManualScriptDirective(scriptResetDirective('ep1')) === false,
  'isManualScriptDirective: false for a plain reset-to-auto (no userScript)');
ok(isManualScriptDirective(null) === false, 'isManualScriptDirective: false for null');
ok(isManualScriptDirective({ instruction: '', force: true, userScript: '' }) === false,
  'isManualScriptDirective: false for a blank userScript');
ok(isManualScriptDirective({ instruction: '', force: true, userScript: '   ' }) === false,
  'isManualScriptDirective: false for a whitespace-only userScript');
ok(isManualScriptDirective({ instruction: 'rewrite the ending', force: true, userScript: 'x'.repeat(50) }) === false,
  'isManualScriptDirective: false when an author instruction is present');

// ───────────────────────── (2) authoritative prompt block ─────────────────────────
const baseInput = {
  synopsis: 'A drama.',
  season: { title: 'S', logline: 'L', episodes: [] },
  episode: { number: 2, title: 'Ep Two', arcRole: 'rising', logline: 'It continues.', cliffhanger: 'A door opens.', locationName: 'Temple', locationDesc: 'INT — temple — night', characters: [] } as any,
  characters: [],
  previous: [{ number: 1, title: 'Ep One', logline: 'It began.', cliffhanger: 'A figure appears.' }],
  previousEnding: null,
};

const MY_SCRIPT = 'SCENE 1. Anna enters the temple.\nANNA: We should not be here.\nSCENE 2. A shadow moves.';
const withScript = episodeScriptUserPrompt({ ...baseInput, userScript: MY_SCRIPT });
ok(/AUTHOR-PROVIDED FULL EPISODE SCRIPT/.test(withScript),
  'episodeScriptUserPrompt: emits the author-script authoritative marker when userScript is present');
ok(withScript.includes(MY_SCRIPT), 'episodeScriptUserPrompt: carries the pasted userScript verbatim');
ok(/EXACTLY as written/.test(withScript), 'episodeScriptUserPrompt: instructs to keep dialogue EXACTLY as written');
ok(/THIS SCRIPT WINS/.test(withScript), 'episodeScriptUserPrompt: states THIS SCRIPT WINS');
ok(/only[\s\S]*STRUCTURE it/i.test(withScript) || /ONLY to STRUCTURE it/.test(withScript),
  'episodeScriptUserPrompt: instructs to ONLY structure the author script');

const withoutScript = episodeScriptUserPrompt(baseInput);
ok(!/AUTHOR-PROVIDED FULL EPISODE SCRIPT/.test(withoutScript),
  'episodeScriptUserPrompt: no author-script block when userScript absent');
const blankScript = episodeScriptUserPrompt({ ...baseInput, userScript: '   ' });
ok(!/AUTHOR-PROVIDED FULL EPISODE SCRIPT/.test(blankScript),
  'episodeScriptUserPrompt: no author-script block for a blank userScript');

console.log(`test-stage158 PASS (${passed} checks)`);
