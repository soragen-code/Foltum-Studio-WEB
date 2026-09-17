/**
 * Stage 155 — "Bring your own plot file", verified with pure/synthetic logic only (no network, no LLM, no
 * DB, no paid generations; the actual text parsers are MOCKED):
 *
 *  (1) PLOT-SOURCE SELECTION — selectPlotSource returns the author's UPLOADED plot when present, and falls
 *      back to the auto-built story when the upload is empty/absent. This is the one decision the season job
 *      and the per-episode script reset both use, so "uploaded plot wins" stays consistent.
 *
 *  (2) EPISODE-BOUNDARY DETECTION — splitPlotIntoEpisodes splits an uploaded plot with explicit
 *      «Серия N» / «Эпизод N» / "Episode N" (and chapter) markers into the right number of episodes, and
 *      falls back cleanly (empty array) when the plot has no explicit division.
 *
 *  (3) TEXT-EXTRACTION DISPATCH — pickExtractor selects the right extractor by extension (authoritative) or,
 *      when the extension is missing/unknown, by MIME type, and rejects unsupported files (parsers mocked).
 *
 *  (4) UPLOAD VALIDATION — validatePlotUpload rejects a disallowed type and an oversize file with a graceful
 *      RUSSIAN error, and accepts a valid small file.
 *
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage155.ts
 */
import {
  selectPlotSource,
  detectEpisodeBoundaries,
  splitPlotIntoEpisodes,
  pickExtractor,
  validatePlotUpload,
  PLOT_MAX_BYTES,
} from '../lib/plot-import';
import type { StoryKind } from '../lib/parse-story';

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
  console.log('ok: ' + msg);
}

// ───────────────────────── (1) plot-source selection ─────────────────────────
ok(selectPlotSource({ uploadedPlot: 'MY OWN PLOT', autoStory: 'auto built story' }) === 'MY OWN PLOT',
  'selectPlotSource: uploaded plot wins when present');
ok(selectPlotSource({ uploadedPlot: '   ', autoStory: 'auto built story' }) === 'auto built story',
  'selectPlotSource: blank upload falls back to the auto story');
ok(selectPlotSource({ uploadedPlot: null, autoStory: 'auto built story' }) === 'auto built story',
  'selectPlotSource: null upload falls back to the auto story');
ok(selectPlotSource({ uploadedPlot: null, autoStory: null }) === '',
  'selectPlotSource: nothing present → empty string');

// ───────────────────────── (2) episode-boundary detection ─────────────────────────
const ruPlot = [
  'Серия 1. Прибытие',
  'Герой приезжает в город и находит записку.',
  '',
  'Серия 2: Тайна',
  'Он начинает расследование.',
  '',
  'Эпизод 3 — Развязка',
  'Всё раскрывается.',
].join('\n');
const ruEps = splitPlotIntoEpisodes(ruPlot);
ok(ruEps.length === 3, 'splitPlotIntoEpisodes: three Russian markers → 3 episodes');
ok(ruEps[0].number === 1 && ruEps[0].title === 'Прибытие' && ruEps[0].body.includes('находит записку'),
  'splitPlotIntoEpisodes: first section carries its number, title and body');
ok(ruEps[2].number === 3 && ruEps[2].body.includes('раскрывается'),
  'splitPlotIntoEpisodes: last section runs to the end of the text');

const enPlot = 'Episode 1 The Arrival\nA newcomer steps off the ferry.\nEpisode 2 The Note\nA clue surfaces.';
ok(splitPlotIntoEpisodes(enPlot).length === 2, 'splitPlotIntoEpisodes: English "Episode N" markers → 2 episodes');
ok(detectEpisodeBoundaries('Chapter 1\ntext\nГлава 2\ntext').length === 2,
  'detectEpisodeBoundaries: mixed chapter/«Глава» markers detected');

const noMarkers = 'Just a long flowing plot with no episode headings at all. It keeps going and going.';
ok(splitPlotIntoEpisodes(noMarkers).length === 0,
  'splitPlotIntoEpisodes: no markers → empty array (caller falls back to auto structuring)');
ok(detectEpisodeBoundaries(noMarkers).length === 0, 'detectEpisodeBoundaries: no markers → none');
// A plain number in prose must NOT be mistaken for a marker (must be line-anchored).
ok(splitPlotIntoEpisodes('He watched episode 4 of the show on TV that night.').length === 0,
  'splitPlotIntoEpisodes: "episode 4" mid-sentence is not a marker');

// ───────────────────────── (3) text-extraction dispatch (parsers MOCKED) ─────────────────────────
const calls: string[] = [];
const mockExtractors: Record<StoryKind, () => string> = {
  txt: () => { calls.push('txt'); return 'txt-text'; },
  md: () => { calls.push('md'); return 'md-text'; },
  docx: () => { calls.push('docx'); return 'docx-text'; },
  pdf: () => { calls.push('pdf'); return 'pdf-text'; },
};
function dispatchExtract(filename: string, mime: string | null): string | null {
  const kind = pickExtractor(filename, mime);
  return kind ? mockExtractors[kind]() : null;
}
ok(dispatchExtract('plot.txt', null) === 'txt-text' && calls[calls.length - 1] === 'txt', 'dispatch: .txt → txt parser');
ok(dispatchExtract('plot.md', null) === 'md-text', 'dispatch: .md → md parser');
ok(dispatchExtract('plot.markdown', null) === 'md-text', 'dispatch: .markdown → md parser');
ok(dispatchExtract('plot.docx', null) === 'docx-text', 'dispatch: .docx → docx parser');
ok(dispatchExtract('plot.pdf', null) === 'pdf-text', 'dispatch: .pdf → pdf parser');
// MIME fallback when the extension is missing/unknown.
ok(dispatchExtract('plotfile', 'application/pdf') === 'pdf-text', 'dispatch: MIME fallback → pdf parser');
ok(dispatchExtract('plotfile', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') === 'docx-text',
  'dispatch: MIME fallback → docx parser');
ok(pickExtractor('plot.pdf', 'text/plain') === 'pdf', 'pickExtractor: extension wins over a conflicting MIME');
ok(dispatchExtract('malware.exe', 'application/octet-stream') === null, 'dispatch: unsupported type → no parser');

// ───────────────────────── (4) upload validation (RUSSIAN errors) ─────────────────────────
const cyr = /[А-Яа-яЁё]/;
const bad = validatePlotUpload({ filename: 'notes.rtf', mime: 'application/rtf', size: 1000 });
ok(!bad.ok && cyr.test(bad.error) && /формат/i.test(bad.error), 'validatePlotUpload: disallowed type → Russian format error');
const big = validatePlotUpload({ filename: 'plot.pdf', mime: 'application/pdf', size: PLOT_MAX_BYTES + 1 });
ok(!big.ok && cyr.test(big.error) && /большой/i.test(big.error), 'validatePlotUpload: oversize → Russian size error');
const empty = validatePlotUpload({ filename: 'plot.txt', mime: 'text/plain', size: 0 });
ok(!empty.ok && cyr.test(empty.error), 'validatePlotUpload: empty file → Russian error');
const good = validatePlotUpload({ filename: 'plot.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 5000 });
ok(good.ok && good.kind === 'docx', 'validatePlotUpload: valid small .docx → ok with kind');

console.log(`Stage 155: PASS (${passed} checks)`);
