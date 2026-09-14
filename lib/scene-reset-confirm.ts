// Stage 83 — confirmation gate for the destructive scene reset.
//
// Rewriting the episode's plot / synopsis / script re-plans the whole episode: the season-script
// job deletes every existing Scene row and recreates them from the new text, so all scene prompts
// (and any already-generated clips) are lost. When scenes already exist this is destructive, so the
// UI must ask the author to confirm first. When there are no scenes yet there is nothing to lose,
// so the rewrite runs immediately without a prompt.
//
// This does NOT touch the per-scene «Изменить» / «Перегенерировать» buttons (Stage 79a): those act
// on a single scene/clip and stay instant, with no confirmation. The gate here is only for the
// episode-wide rewrite that resets ALL scenes.

/** Confirmation copy shown before the destructive episode-wide scene reset. */
export const SCENE_RESET_CONFIRM_MESSAGE =
  "Changing the plot / synopsis / script will reset all current scenes and their prompts. Continue?";

/**
 * True when rewriting the episode text would destroy existing scenes and therefore needs the
 * confirmation dialog. No scenes → nothing to lose → run immediately, no confirmation.
 */
export function needsSceneResetConfirm(sceneCount: number | null | undefined): boolean {
  return (sceneCount ?? 0) > 0;
}
