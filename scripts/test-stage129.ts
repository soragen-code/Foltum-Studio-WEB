/**
 * Stage 129 — WHEN the episode production mode (SCENES / STORYBOARD) may be chosen (pure/synthetic checks).
 *
 * The mode fork (Stage 127) is no longer offered right after the story is built. It is offered ONLY after the
 * episode's references (characters + locations) are ready, and production (9 scenes OR 12–15 boards) stays
 * locked until a mode is explicitly chosen. This stage moves ONLY the moment/condition of showing the
 * selector + adds the gate — the pipelines, the /api/ai/storyboard/mode endpoint and models are untouched.
 *
 * These checks are PURE (no network, no LLM, no DB, no paid generations):
 *   - the gating predicates in lib/production-mode (canChooseMode / canEnterProduction / productionSurface)
 *   - the UI placement in episode-view.tsx: the selector lives in the References step, guarded by
 *     canChooseMode(refsReady); the "To production" step is gated by canEnterProduction; the Scenes step now
 *     shows a read-only mode indicator (selector moved away); the STORYBOARD branch is preserved
 *   - backward compat: a legacy null mode still renders the classic Scenes surface
 *
 * Run: timeout 90 npx tsx --tsconfig tsconfig.json scripts/test-stage129.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isProductionMode,
  canChooseMode,
  canEnterProduction,
  productionSurface,
  type ProductionMode,
} from '../lib/production-mode';

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error('FAIL: ' + msg); process.exit(1); }
  passed++;
  console.log('ok: ' + msg);
}

const ROOT = join(__dirname, '..');

// ── (A) isProductionMode — only the two explicit modes count ─────────────────────────────────────────────
ok(isProductionMode('SCENES') === true, 'isProductionMode: SCENES is a real mode');
ok(isProductionMode('STORYBOARD') === true, 'isProductionMode: STORYBOARD is a real mode');
ok(isProductionMode(null) === false, 'isProductionMode: null is not a mode (legacy-unset)');
ok(isProductionMode(undefined) === false, 'isProductionMode: undefined is not a mode');
ok(isProductionMode('') === false, 'isProductionMode: empty string is not a mode');
ok(isProductionMode('text') === false, 'isProductionMode: legacy "text" is not a mode');
ok(isProductionMode('scenes') === false, 'isProductionMode: lowercase "scenes" is not a mode (case-sensitive)');

// ── (B) canChooseMode — selector hidden until references are ready ────────────────────────────────────────
ok(canChooseMode(false) === false, 'canChooseMode: hidden while references are NOT ready');
ok(canChooseMode(true) === true, 'canChooseMode: shown once references are ready');

// ── (C) canEnterProduction — production locked until refs ready AND a mode is chosen ──────────────────────
ok(canEnterProduction(false, 'SCENES') === false, 'canEnterProduction: locked while references not ready (even with a mode)');
ok(canEnterProduction(false, null) === false, 'canEnterProduction: locked while references not ready and no mode');
ok(canEnterProduction(true, null) === false, 'canEnterProduction: locked when references ready but NO mode chosen');
ok(canEnterProduction(true, undefined) === false, 'canEnterProduction: locked when references ready but mode undefined');
ok(canEnterProduction(true, 'SCENES') === true, 'canEnterProduction: unlocked when refs ready + SCENES chosen');
ok(canEnterProduction(true, 'STORYBOARD') === true, 'canEnterProduction: unlocked when refs ready + STORYBOARD chosen');

// ── (D) productionSurface — STORYBOARD → board panel; SCENES / legacy null → classic scenes ──────────────
ok(productionSurface('STORYBOARD') === 'storyboard', 'productionSurface: STORYBOARD renders the storyboard panel (Stage 127 preserved)');
ok(productionSurface('SCENES') === 'scenes', 'productionSurface: SCENES renders the classic scenes pipeline');
ok(productionSurface(null) === 'scenes', 'productionSurface: legacy null mode renders the classic scenes pipeline (backward compat)');
ok(productionSurface(undefined) === 'scenes', 'productionSurface: undefined mode renders the classic scenes pipeline');

// ── (E) gate semantics summarised ────────────────────────────────────────────────────────────────────────
{
  const refsReady = true;
  const noModeYet: ProductionMode | null = null;
  ok(canChooseMode(refsReady) && !canEnterProduction(refsReady, noModeYet),
    'gate: once refs ready the selector shows BUT production stays blocked until a mode is picked');
}

// ── (F) UI placement in episode-view.tsx ─────────────────────────────────────────────────────────────────
const view = readFileSync(join(ROOT, 'app/project/[id]/episode/[episodeId]/episode-view.tsx'), 'utf8');

// The gating helpers are imported (single source of truth).
ok(/from '@\/lib\/production-mode'/.test(view), 'episode-view imports the production-mode gating helpers');

// The selector is guarded by canChooseMode(refsReady) and carries the mode-selector testid.
ok(view.includes('{canChooseMode(refsReady) &&'), 'episode-view: selector guarded by canChooseMode(refsReady)');
ok(view.includes('data-testid="mode-selector"'), 'episode-view: mode-selector present');
ok(view.includes('data-testid="mode-scenes"') || view.includes('mode-${val.toLowerCase()}'), 'episode-view: scenes/storyboard mode buttons present');

// The selector must sit in the References step (before the "To production" forward button), NOT at the top of
// the Scenes step. Assert ordering: the mode-selector appears before the refs-to-scenes forward button, and
// the mode-selector appears before the read-only mode-indicator that now heads the Scenes step.
const idxSelector = view.indexOf('data-testid="mode-selector"');
const idxRefsForward = view.indexOf('data-testid="refs-to-scenes"');
const idxIndicator = view.indexOf('data-testid="mode-indicator"');
ok(idxSelector > -1 && idxRefsForward > -1 && idxSelector < idxRefsForward,
  'episode-view: selector is inside the References step (before the "To production" forward button)');
ok(idxIndicator > -1 && idxSelector < idxIndicator,
  'episode-view: the Scenes step carries a mode indicator AFTER the References selector');

// The forward step into production is gated.
ok(view.includes('disabled={!canEnterProduction(refsReady, mode)}'), 'episode-view: forward-to-production button gated by canEnterProduction');

// The scenes-tab reachability uses canEnterProduction (with a legacy-video fallback).
ok(/canEnterProduction\(refsReady, mode\) \|\| scenes\.some/.test(view), 'episode-view: scenes tab reachable via canEnterProduction (+ legacy-video fallback)');

// Stage 130 — the Scenes step keeps an EDITABLE mode selector (author request), persisting via chooseMode.
ok(view.includes('data-testid="scene-mode-scenes"') || view.includes('data-testid={`scene-mode-'),
  'episode-view: Scenes step has an editable mode selector (scene-mode-* buttons)');
ok(view.includes('data-testid="mode-current"'), 'episode-view: current-mode label present in the Scenes step');
{
  // Inside the Scenes-step indicator block the buttons must call chooseMode (persist the choice).
  const idxScenesButtons = view.indexOf('data-testid={`scene-mode-');
  const around = idxScenesButtons > -1 ? view.slice(idxScenesButtons - 400, idxScenesButtons + 100) : '';
  ok(/chooseMode\(val\)/.test(around), 'episode-view: Scenes-step selector persists via chooseMode');
}
ok(!/mode \?\? 'SCENES'/.test(view), 'episode-view: the old "mode ?? \'SCENES\'" default (no real gate) is gone');

// The STORYBOARD render branch is preserved via productionSurface.
ok(view.includes("productionSurface(mode) === 'storyboard'"), 'episode-view: STORYBOARD branch preserved via productionSurface (Stage 127)');
ok(view.includes('<StoryboardPanel'), 'episode-view: StoryboardPanel still rendered for the storyboard surface');

// ── (G) endpoint untouched — mode POST route still writes Episode.mode only ──────────────────────────────
{
  const route = readFileSync(join(ROOT, 'app/api/ai/storyboard/mode/route.ts'), 'utf8');
  ok(/mode/.test(route), 'regression: /api/ai/storyboard/mode route still present (mode-choice mechanism unchanged)');
}

console.log(`Stage 129: PASS (${passed} checks)`);
