/**
 * Stage 77 — which block a text-rewrite screen shows: the current text or the
 * "rewrite in progress" placeholder. Pure so it can be unit tested.
 *
 * `busy` is the component-level flag (request in flight OR job pending/processing); it wins
 * regardless of the job status snapshot — while busy the OLD text must never be visible.
 * Once busy drops (completed / failed / canceled / no jobId) the text block returns.
 */
export type RewriteViewState = 'text' | 'placeholder'

export function rewriteViewState(busy: boolean, _jobStatus?: string): RewriteViewState {
  return busy ? 'placeholder' : 'text'
}
