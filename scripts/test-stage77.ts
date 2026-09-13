/**
 * Stage 77 — pure tests for the rewrite-in-progress placeholders.
 * Run: npx tsx scripts/test-stage77.ts
 */
import assert from 'node:assert/strict'
import { rewriteViewState } from '../lib/rewrite-view-state'
import { isEpisodeRevisePending } from '../lib/episode-revise-state'

let passed = 0
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`✓ ${name}`) } catch (e) { console.error(`✗ ${name}`); throw e }
}

test('rewriteViewState: busy → placeholder regardless of job status', () => {
  assert.equal(rewriteViewState(true), 'placeholder')
  assert.equal(rewriteViewState(true, 'pending'), 'placeholder')
  assert.equal(rewriteViewState(true, 'processing'), 'placeholder')
  assert.equal(rewriteViewState(true, 'completed'), 'placeholder')
  assert.equal(rewriteViewState(true, 'failed'), 'placeholder')
})

test('rewriteViewState: not busy → text regardless of job status', () => {
  assert.equal(rewriteViewState(false), 'text')
  assert.equal(rewriteViewState(false, 'processing'), 'text')
  assert.equal(rewriteViewState(false, 'canceled'), 'text')
  assert.equal(rewriteViewState(false, 'completed'), 'text')
})

const state = (ids: string[]) => JSON.stringify({ v: 2, step: 'episode', revise: { episodeIds: ids, instruction: 'x' } })

test('isEpisodeRevisePending: active season job with this episode in the revise queue (raw resultData)', () => {
  assert.equal(isEpisodeRevisePending({ id: 'j1', status: 'processing', resultData: state(['ep1']) }, 'ep1'), true)
  assert.equal(isEpisodeRevisePending({ id: 'j1', status: 'pending', resultData: state(['ep2', 'ep1']) }, 'ep1'), true)
})

test('isEpisodeRevisePending: parsed `result` shape (GET /api/jobs/[id]) is accepted', () => {
  assert.equal(isEpisodeRevisePending({ id: 'j1', status: 'processing', result: { v: 2, revise: { episodeIds: ['ep1'] } } }, 'ep1'), true)
  assert.equal(isEpisodeRevisePending({ id: 'j1', status: 'processing', result: { v: 2, revise: { episodeIds: ['ep9'] } } }, 'ep1'), false)
})

test('isEpisodeRevisePending: terminal job → false', () => {
  assert.equal(isEpisodeRevisePending({ id: 'j1', status: 'completed', resultData: state(['ep1']) }, 'ep1'), false)
  assert.equal(isEpisodeRevisePending({ id: 'j1', status: 'failed', resultData: state(['ep1']) }, 'ep1'), false)
  assert.equal(isEpisodeRevisePending({ id: 'j1', status: 'canceled', resultData: state(['ep1']) }, 'ep1'), false)
})

test('isEpisodeRevisePending: other episode / no revise queue (plain season generation) → false', () => {
  assert.equal(isEpisodeRevisePending({ id: 'j1', status: 'processing', resultData: state(['ep2']) }, 'ep1'), false)
  assert.equal(isEpisodeRevisePending({ id: 'j1', status: 'processing', resultData: JSON.stringify({ v: 2, step: 'episode' }) }, 'ep1'), false)
  assert.equal(isEpisodeRevisePending({ id: 'j1', status: 'processing', resultData: null }, 'ep1'), false)
})

test('isEpisodeRevisePending: null job, empty id, malformed JSON → false (no throw)', () => {
  assert.equal(isEpisodeRevisePending(null, 'ep1'), false)
  assert.equal(isEpisodeRevisePending(undefined, 'ep1'), false)
  assert.equal(isEpisodeRevisePending({ id: 'j1', status: 'processing', resultData: state(['ep1']) }, ''), false)
  assert.equal(isEpisodeRevisePending({ id: 'j1', status: 'processing', resultData: '{not json' }, 'ep1'), false)
})

console.log(`\nStage 77: ${passed} tests passed`)
