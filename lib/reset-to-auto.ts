/**
 * Stage 151 — "Reset to Auto" for the two generator-produced narrative artifacts.
 *
 * This mirrors the Stage 150 scene/frame reset-to-auto invariant (app/api/ai/scenes/[id]/prompt PUT):
 * a reset NEVER reuses a stored / cached / manually-revised value — it drops it and RECOMPUTES the
 * artifact through the LIVE builder under the CURRENT generation rules. The two artifacts are:
 *
 *   - the episode SCRIPT / screenplay (сценарий): regenerated from the current story via the live season
 *     generator (a season_script job with a one-episode queue, NO author instruction, force overwrite —
 *     persistEpisodeScript deletes the old scenes/keyframes/videos so any per-scene override/lookCache is
 *     dropped too, and rewrites the script from the current 60-second footage under the current rules);
 *   - the season STORY / plot (сюжет): regenerated from the current synopsis via the live deterministic
 *     builder buildFullStoryFromStructure (current rules), discarding whatever prose was stored.
 *
 * The pure helpers below encode exactly those two guarantees so the routes stay thin and the behaviour
 * is unit-testable without any DB / LLM / paid generation.
 */
import { buildFullStoryFromStructure } from "@/lib/season";
import type { IdeaLanguage } from "@/lib/idea";

/**
 * The reset directive fed to `initialSeasonState(episodeCount, directive)` when a SCRIPT is reset to auto.
 * `instruction: ""` is the load-bearing part — an EMPTY instruction means "write from the structure / footage
 * by the current rules", NOT "apply this manual edit"; `force: true` overwrites the existing (possibly
 * manually-revised) script instead of skipping an already-written episode.
 */
export interface ScriptResetDirective {
  episodeIds: string[];
  instruction: "";
  force: true;
}

/** Build the reset-to-auto directive for one episode's script (pure). */
export function scriptResetDirective(episodeId: string): ScriptResetDirective {
  return { episodeIds: [episodeId], instruction: "", force: true };
}

/**
 * True when a season-job revise directive is a genuine "reset to auto" (regenerate by current rules) rather
 * than an author instruction. Used to assert the reset never smuggles a stale/manual instruction through.
 */
export function isScriptResetDirective(d: { instruction?: string | null; force?: boolean } | null | undefined): boolean {
  return !!d && (d.instruction ?? "").trim() === "" && d.force === true;
}

/**
 * Stage 158 — "insert your own full episode script" directive. The script-level analog of the Stage 155
 * plot upload: the author pastes a COMPLETE episode shooting script and it becomes the AUTHORITATIVE source
 * fed to the SAME season-script LLM path, which only STRUCTURES it into the required shooting-script JSON
 * (splitting into shots + synthesizing technical fields) while preserving the author's scenes, dialogue and
 * action verbatim. `instruction: ""` (empty = not an author revise hint) and `force: true` (overwrite the
 * existing script) match scriptResetDirective; the extra `userScript` carries the author's pasted text.
 */
export interface ManualScriptDirective {
  episodeIds: string[];
  instruction: "";
  force: true;
  userScript: string;
}

/** Build the manual-script directive for one episode (pure). */
export function manualScriptDirective(episodeId: string, userScript: string): ManualScriptDirective {
  return { episodeIds: [episodeId], instruction: "", force: true, userScript };
}

/**
 * True when a season-job revise directive carries an author-supplied full episode script (Stage 158): empty
 * instruction + force + a non-empty userScript. Distinguishes the manual-script path from a plain reset-to-auto.
 */
export function isManualScriptDirective(
  d: { instruction?: string | null; force?: boolean; userScript?: string | null } | null | undefined,
): boolean {
  return (
    !!d &&
    (d.instruction ?? "").trim() === "" &&
    d.force === true &&
    typeof d.userScript === "string" &&
    d.userScript.trim().length > 0
  );
}

/** The minimal season structure the story builder needs (title + logline + ordered episodes). */
export interface StoryResetStructure {
  title?: string | null;
  logline?: string | null;
  episodes: { number: number; title: string; description?: string | null }[];
}

/**
 * Rebuild the season STORY/plot prose from scratch for a "reset to auto": run the LIVE builder over the
 * current structure + current synopsis (current rules). The previously stored / manually-revised prose is
 * NOT an input — it is discarded — so the result always reflects the current rules and the current synopsis.
 */
export function rebuildAutoStory(
  structure: StoryResetStructure,
  language: IdeaLanguage,
  synopsis: string | null | undefined,
): string {
  return buildFullStoryFromStructure(structure, language, synopsis);
}
