/**
 * Stage 242 — the EDITABLE scene-prompt template (project-level).
 *
 * This module holds ONLY the default template string and the pure render helper, with NO other
 * imports, so it is safe to import from client components (e.g. the "Prompt template" editor on the
 * Scenes page) without pulling the whole scene-prompt module graph into the client bundle.
 *
 * buildScenePrompt() (in ./scene-prompt) renders the NON-override final prompt from this template
 * instead of a hard-coded block structure. Tokens are substituted per block, empty blocks (and bare
 * "Header:" lines with no content) are dropped, and the surviving blocks are joined with a blank line
 * — this reproduces the previous output BYTE-FOR-BYTE for the default template, so existing projects
 * see no change until a user edits their template.
 *
 * Supported tokens (everything else is fixed instruction text applied to every scene):
 *   {{SETTING}}     → the ordered "image N — LOCATION / START FRAME" lines
 *   {{CHARACTERS}}  → the ordered "image N — <name>." appearance-anchor lines
 *   {{ACTIONS}}     → the ACTIONS body (blocking/action/gaze/non-verbal + dialogue + narrator)
 * Any unknown {{TOKEN}} is replaced with an empty string.
 */
export const DEFAULT_SCENE_PROMPT_TEMPLATE = `Setting:
{{SETTING}}

Characters (appearance only):
{{CHARACTERS}}

ACTIONS:
{{ACTIONS}}

FRAMING: the scene must end on a shot size different from the one it opens with (wide / medium / close-up). If it opens wide, it ends medium or close; if it opens close, it ends medium or wide. Never return to the opening framing.`;

/**
 * Render a scene-prompt template into the final NON-override prompt string.
 * Blocks are split on blank lines, tokens substituted per block, then a block is DROPPED when — after
 * trimming — it is empty or a lone "Header:" line with no content (regex ^[^\n]*:\s*$). Surviving blocks
 * join with a blank line. Splitting the template BEFORE substitution ensures multi-line token values
 * (e.g. several Setting lines) never create new blocks.
 */
export function renderSceneTemplate(template: string, tokens: Record<string, string>): string {
  const blocks = template.split(/\n\s*\n/);
  const rendered = blocks.map((block) =>
    block.replace(/\{\{([A-Z_]+)\}\}/g, (_m, name: string) => tokens[name] ?? ""),
  );
  const kept = rendered.filter((block) => {
    const t = block.trim();
    if (!t) return false;
    if (/^[^\n]*:\s*$/.test(t)) return false; // lone "Header:" with no content
    return true;
  });
  return kept.join("\n\n");
}
