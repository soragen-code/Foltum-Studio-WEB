/**
 * Stage 165 (task Stage 6) — deterministic, block-assembled scene video prompts.
 *
 * The scene prompt is built from 9 ordered, individually-testable pure blocks (see ./scene). This
 * barrel re-exports the block builders and the assembly helpers, and owns the single source of truth
 * for the prompt schema version.
 *
 * PROMPT_VERSION is stamped onto the scene record (Scene.promptVersion) whenever a prompt is
 * assembled, so a stored prompt can be traced back to the block rules that produced it. Bump it
 * whenever the block ordering / wording changes in a way that alters assembled output.
 */
export const PROMPT_VERSION = "6.0.0";

export * from "./scene";
