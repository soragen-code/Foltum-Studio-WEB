/** Stage 153: sequential scene generation continues SERVER-SIDE while the user is NOT on the site.
 *
 * Sequential scene chains ("Сгенерировать все") advance server-side (finalizeVideoJob → continueChainRun),
 * but the hand-off only fires once a long provider prediction is finalized, which historically relied on the
 * browser polling GET /api/jobs/[id] → resumeVideoJob. When the tab is closed the chain stalls. Stage 153 adds
 * a Vercel-cron sweeper (/api/cron/advance-chains) that (1) resumes quiet video jobs and (2) re-arms stalled
 * chains — guarded so only the scheduler / an internal caller may invoke it.
 *
 * This test exercises the PURE decision + auth helpers only. No network, no DB, no paid generation.
 *
 * Asserts:
 *   1. active chain, scene N generated + N+1 pending + nothing in flight → advance fn selects N+1.
 *   2. does NOT start N+1 while N is still generating.
 *   3. never starts two at once / idempotent (an active job on the target ⇒ no start).
 *   4. sequential mode OFF (chainRunActive=false) → sweeper does not force ordering.
 *   5. auth guard rejects an unauthenticated sweeper call, accepts the cron / worker secret.
 *
 * Run: npx tsx --tsconfig tsconfig.json scripts/test-stage153.ts
 */
import assert from 'node:assert/strict';
import { chainSceneToResume, type ChainResumeSceneLike } from '../lib/chain-run';
import { authorizeCron } from '../lib/jobs';

let passed = 0;
function ok(value: unknown, message: string) { assert.ok(value, message); passed++; }

const P = 'a video prompt'; // a non-empty prompt makes a scene part of the chain

function scene(number: number, over: Partial<ChainResumeSceneLike> = {}): ChainResumeSceneLike {
  return { id: `s${number}`, number, videoPrompt: P, videoUrl: null, status: null, hasActiveJob: false, ...over };
}

/* ── 1) N generated, N+1 pending, nothing in flight → select N+1 ──────────────────────────────── */
{
  const scenes = [
    scene(1, { videoUrl: 'https://cdn/s1.mp4', status: 'generated' }),
    scene(2), // pending, idle
    scene(3),
  ];
  const target = chainSceneToResume({ chainRunActive: true, scenes });
  ok(target?.number === 2, '1: selects the next pending scene (N+1) when N is generated and idle');

  // The very first scene of a fresh chain (nothing generated yet) is also correctly selected.
  const fresh = chainSceneToResume({ chainRunActive: true, scenes: [scene(1), scene(2)] });
  ok(fresh?.number === 1, '1b: selects scene 1 when nothing is generated yet');
}

/* ── 2) does NOT start N+1 while N is still generating ─────────────────────────────────────────── */
{
  const scenes = [
    scene(1, { videoUrl: 'https://cdn/s1.mp4', status: 'generated' }),
    scene(2, { status: 'generating' }), // N is rendering
    scene(3),
  ];
  const target = chainSceneToResume({ chainRunActive: true, scenes });
  ok(target === null, '2: returns null while the earliest ungenerated scene is still generating');
}

/* ── 3) never starts two at once / idempotent ─────────────────────────────────────────────────── */
{
  // The target scene already has an in-flight video job → do not start a second.
  const withActiveJob = [
    scene(1, { videoUrl: 'https://cdn/s1.mp4', status: 'generated' }),
    scene(2, { hasActiveJob: true }),
    scene(3),
  ];
  ok(chainSceneToResume({ chainRunActive: true, scenes: withActiveJob }) === null,
    '3: returns null when the target scene already has an active job (no double-start)');

  // Only ONE scene is ever returned — the lowest-numbered idle gap, never a later one.
  const gap = [
    scene(1, { videoUrl: 'https://cdn/s1.mp4', status: 'generated' }),
    scene(2), // idle gap — must be chosen
    scene(3), // must NOT be chosen ahead of 2
  ];
  const only = chainSceneToResume({ chainRunActive: true, scenes: gap });
  ok(only?.number === 2, '3b: returns the lowest-numbered idle scene, never skips ahead');

  // All prompted scenes generated → nothing to start.
  const allDone = [
    scene(1, { videoUrl: 'https://cdn/s1.mp4', status: 'generated' }),
    scene(2, { videoUrl: 'https://cdn/s2.mp4', status: 'generated' }),
  ];
  ok(chainSceneToResume({ chainRunActive: true, scenes: allDone }) === null,
    '3c: returns null when every prompted scene is already generated');

  // Unprompted middle scene is skipped (not part of the chain), the next prompted one is chosen.
  const unprompted = [
    scene(1, { videoUrl: 'https://cdn/s1.mp4', status: 'generated' }),
    scene(2, { videoPrompt: '' }), // not part of the chain
    scene(3),
  ];
  ok(chainSceneToResume({ chainRunActive: true, scenes: unprompted })?.number === 3,
    '3d: skips an unprompted scene and selects the next prompted pending scene');
}

/* ── 4) sequential mode OFF → sweeper does not force ordering ──────────────────────────────────── */
{
  const scenes = [
    scene(1, { videoUrl: 'https://cdn/s1.mp4', status: 'generated' }),
    scene(2), // pending, but chain is OFF
  ];
  ok(chainSceneToResume({ chainRunActive: false, scenes }) === null,
    '4: returns null when chainRunActive is false (mode off)');
  ok(chainSceneToResume({ chainRunActive: null, scenes }) === null,
    '4b: returns null when chainRunActive is null/undefined');
}

/* ── 5) auth guard: rejects unauthenticated, accepts cron / worker secret ──────────────────────── */
{
  const CRON = 'cron-secret-xyz';
  const WORKER = 'worker-secret-abc';
  const savedCron = process.env.CRON_SECRET;
  const savedWorker = process.env.WORKER_SECRET;
  const savedAuth = process.env.AUTH_SECRET;
  const savedNextAuth = process.env.NEXTAUTH_SECRET;
  process.env.CRON_SECRET = CRON;
  process.env.WORKER_SECRET = WORKER;
  delete process.env.AUTH_SECRET;
  delete process.env.NEXTAUTH_SECRET;

  const req = (headers: Record<string, string>) => new Request('https://x/api/cron/advance-chains', { headers });

  ok(authorizeCron(req({})) === false, '5: rejects a request with no auth headers');
  ok(authorizeCron(req({ authorization: 'Bearer wrong' })) === false, '5b: rejects a wrong bearer token');
  ok(authorizeCron(req({ authorization: `Bearer ${CRON}` })) === true, '5c: accepts Vercel cron Bearer CRON_SECRET');
  ok(authorizeCron(req({ 'x-worker-secret': WORKER })) === true, '5d: accepts the internal x-worker-secret header');
  ok(authorizeCron(req({ 'x-worker-secret': 'nope' })) === false, '5e: rejects a wrong worker secret');

  // With NO secret configured at all, every call is denied (never an open trigger).
  delete process.env.CRON_SECRET;
  delete process.env.WORKER_SECRET;
  ok(authorizeCron(req({ authorization: 'Bearer ' })) === false, '5f: denies when no secret is configured');

  // restore env
  if (savedCron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = savedCron;
  if (savedWorker === undefined) delete process.env.WORKER_SECRET; else process.env.WORKER_SECRET = savedWorker;
  if (savedAuth !== undefined) process.env.AUTH_SECRET = savedAuth;
  if (savedNextAuth !== undefined) process.env.NEXTAUTH_SECRET = savedNextAuth;
}

console.log(`Stage 153: PASS (${passed} checks)`);
