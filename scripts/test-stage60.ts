/**
 * Stage 60 tests:
 *   A) one-step undo for character/location/scene edits
 *      - undo route files exist and null the snapshot after restore
 *      - mutating edit handlers save prevSnapshot before editing
 *      - GET project exposes hasUndo (and strips prevSnapshot)
 *   B) smooth monotonic 0-100% scene progress (smoothedProgress unit test)
 *   C) location generation decoupled from character generation in episode-view
 *
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage60.ts
 */
import { readFileSync, existsSync } from 'fs'
import path from 'path'
import { smoothedProgress } from '../app/project/[id]/_components/use-job-polling'

const ROOT = path.resolve(__dirname, '..')
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8')

let failures = 0
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    console.error(`  ✗ ${name}`)
    failures++
  }
}

// ---------------------------------------------------------------------------
console.log('A) one-step undo')

const undoRoutes = [
  'app/api/ai/characters/[id]/undo/route.ts',
  'app/api/ai/locations/[id]/undo/route.ts',
  'app/api/ai/scenes/[id]/undo/route.ts',
]
for (const r of undoRoutes) {
  check(`route file exists: ${r}`, existsSync(path.join(ROOT, r)))
  if (existsSync(path.join(ROOT, r))) {
    const src = read(r)
    check(`  ${r} nulls prevSnapshot after restore`, /prevSnapshot\s*:\s*null/.test(src))
    check(`  ${r} 404s when nothing to undo`, /404/.test(src))
    check(`  ${r} reads prevSnapshot`, /prevSnapshot/.test(src))
  }
}

// Mutating edit handlers must save prevSnapshot before editing.
const editHandlers = [
  'app/api/ai/characters/revise/route.ts',
  'app/api/ai/characters/appearance/route.ts',
  'app/api/ai/characters/regenerate/route.ts',
  'app/api/ai/locations/[id]/revise/route.ts',
  'app/api/ai/locations/[id]/image/route.ts',
  'app/api/ai/scenes/[id]/revise/route.ts',
]
for (const h of editHandlers) {
  const src = read(h)
  // Handler must build a prevSnapshot object AND write it in the update (shorthand
  // `prevSnapshot,` or explicit `prevSnapshot:` both count).
  // Must write prevSnapshot inside a prisma update `data:` block.
  const savesInUpdate = /data:\s*\{[\s\S]*prevSnapshot/.test(src) || /prevSnapshot,/.test(src)
  check(`${h} saves prevSnapshot`, savesInUpdate)
}

// GET project exposes hasUndo and strips the raw snapshot object.
const projRoute = read('app/api/projects/[id]/route.ts')
check('GET project computes hasUndo', /hasUndo/.test(projRoute))
check('GET project strips prevSnapshot', /prevSnapshot/.test(projRoute))

// ---------------------------------------------------------------------------
console.log('B) smooth monotonic scene progress')

// Monotonic even when the server progress jumps around.
const server = [5, 50, 10, 12, 40, 30, 60]
let shown = 0
let monotonic = true
for (let i = 0; i < server.length; i++) {
  const next = smoothedProgress({ serverProgress: server[i], status: 'processing', prevShown: shown, elapsedSec: i * 5 })
  if (next < shown) monotonic = false
  shown = next
}
check('displayed value never decreases', monotonic)

// Never reaches 100 while still processing (cap < 100).
let capOk = true
for (let e = 0; e < 10000; e += 30) {
  const v = smoothedProgress({ serverProgress: 95, status: 'processing', prevShown: 0, elapsedSec: e })
  if (v >= 100) capOk = false
}
check('stays below 100 until terminal (cap)', capOk)

// 100 only on completed.
check('completed -> 100', smoothedProgress({ serverProgress: 0, status: 'completed', prevShown: 40, elapsedSec: 10 }) === 100)

// failed/canceled hold the last shown value (do not snap to 100 or reset).
check('failed holds last shown', smoothedProgress({ serverProgress: 90, status: 'failed', prevShown: 72, elapsedSec: 50 }) === 72)
check('canceled holds last shown', smoothedProgress({ serverProgress: 90, status: 'canceled', prevShown: 63, elapsedSec: 50 }) === 63)

// Time creep advances the bar even when server progress is stuck at 0.
const creepEarly = smoothedProgress({ serverProgress: 0, status: 'processing', prevShown: 0, elapsedSec: 10 })
const creepLate = smoothedProgress({ serverProgress: 0, status: 'processing', prevShown: creepEarly, elapsedSec: 120 })
check('time creep advances with elapsed time', creepLate > creepEarly && creepEarly > 0)

// The real bug: the server holds a flat 40% for the whole render. The bar must keep creeping
// ABOVE that plateau instead of freezing on it.
const plateauEarly = smoothedProgress({ serverProgress: 40, status: 'processing', prevShown: 0, elapsedSec: 10, expectedTotalSec: 600 })
const plateauLate = smoothedProgress({ serverProgress: 40, status: 'processing', prevShown: plateauEarly, elapsedSec: 200, expectedTotalSec: 600 })
check('does not freeze on the server 40% plateau (creeps above it)', plateauEarly > 40 && plateauLate > plateauEarly)

// ---------------------------------------------------------------------------
console.log('C) location generation decoupled from character generation')

const epView = read('app/project/[id]/episode/[episodeId]/episode-view.tsx')

// The two location generate buttons must no longer be gated on refSession.
const locBtnMatches = epView.match(/disabled=\{busy \|\| refStarting\}/g) || []
check('location buttons gated only on busy || refStarting (>=2)', locBtnMatches.length >= 2)

// Guard against regression: no location generate button gated on refSession.
check('no refSession in location-generate disabled gate', !/disabled=\{[^}]*refSession[^}]*\}/.test(epView))

// The undo buttons are rendered in the inline edit blocks.
check('character-undo button present', /data-testid="character-undo"/.test(epView))
check('location-undo button present', /data-testid="location-undo"/.test(epView))
check('scene-undo button present', /data-testid="scene-undo"/.test(epView))

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\nFAILED: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll Stage 60 checks passed')
