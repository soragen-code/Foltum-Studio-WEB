/**
 * Deterministic pre-parser for an AUTHOR-PASTED episode script (manual "use my own script" path).
 *
 * The author marks each scene with a header line such as:
 *   "Scene 1· Оазис у водонапорной башни — Насосная яма"
 *   "Сцена 2 — Кухня"
 *   "Scene 3: Street corner"
 *   "SCENE 4 - Roof — Ledge"
 * i.e.  (Scene|Сцена) <N> <sep> <LOCATION> [ — <SUB-LOCATION> ]
 * where <sep> right after the number may be ·, •, ., :, —, –, - or just whitespace, and the whole
 * line may contain non-breaking spaces (\u00A0 / \u202F — both matched by JS "\s").
 *
 * Why this exists: the pasted script is handed to the LLM to STRUCTURE into shooting-script JSON
 * (see lib/season.ts episodeScriptUserPrompt). The model was UNRELIABLE at detecting these headers —
 * a "Scene 1·" with a middle dot and no clear delimiter caused all 5 authored scenes to collapse into
 * ONE. So we split the text deterministically here and re-emit it with UNAMBIGUOUS "=== SCENE N ==="
 * markers plus explicit LOCATION / SUB-LOCATION lines the model cannot miss, while keeping every line
 * of the author's action and dialogue EXACTLY as written.
 *
 * Pure, DB-free and unit-tested (scripts/test-manual-script.ts).
 */

/**
 * A scene header: (Scene|Сцена) + number + optional separator + the rest of the line (LOCATION — SUB-LOCATION).
 * "\s" in JS already covers the non-breaking spaces \u00A0 and \u202F, so tolerating them needs no extra classes.
 */
const SCENE_HEADER_RE = /^\s*(?:сцена|scene)\s*(\d+)\s*[.:·•\-—–]?\s*(.*)$/iu;

export interface ManualScene {
  /** The scene number as written in the author's header. */
  number: number;
  /** The whole place the scene happens in (left side of the header dash). */
  location: string;
  /** The zone / spot within the location (right side of the header dash); "" when the header has no dash. */
  subLocation: string;
  /** The original header line, trimmed. */
  header: string;
  /** Everything after the header up to the next header (frame description + dialogue), trimmed, verbatim. */
  body: string;
}

/** Split a header's "<LOCATION> — <SUB-LOCATION>" tail into its two parts, tolerating em/en dash or a spaced hyphen. */
function splitLocationSubLocation(rest: string): { location: string; subLocation: string } {
  const r = (rest ?? "").trim();
  if (!r) return { location: "", subLocation: "" };
  // First em/en dash (optionally space-surrounded) OR a space-surrounded hyphen — so hyphenated words are not split.
  const m = r.match(/^(.+?)\s*[—–]\s*(.+)$/u) ?? r.match(/^(.+?)\s+-\s+(.+)$/u);
  if (m) return { location: m[1].trim(), subLocation: m[2].trim() };
  return { location: r, subLocation: "" };
}

/**
 * Split an author-pasted script into scenes by its "Scene N" / "Сцена N" header lines.
 * Any text before the first header is ignored as a preamble. Returns [] when no header is found.
 */
export function parseManualScriptScenes(text: string): ManualScene[] {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const scenes: ManualScene[] = [];
  let cur: { number: number; location: string; subLocation: string; header: string; body: string[] } | null = null;
  const flush = () => {
    if (cur) scenes.push({ number: cur.number, location: cur.location, subLocation: cur.subLocation, header: cur.header, body: cur.body.join("\n").trim() });
  };
  for (const line of lines) {
    const m = line.match(SCENE_HEADER_RE);
    if (m) {
      flush();
      const { location, subLocation } = splitLocationSubLocation(m[2] ?? "");
      cur = { number: parseInt(m[1], 10), location, subLocation, header: line.trim(), body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  flush();
  return scenes;
}

/**
 * Rewrite an author-pasted script into a canonical, unambiguous form for the LLM structuring step:
 * each scene becomes a "=== SCENE N ===" block with explicit LOCATION / SUB-LOCATION lines followed by the
 * author's own body (action + dialogue) verbatim. Scenes are re-numbered contiguously 1..N in author order.
 *
 * When fewer than 2 scene headers are detected the text is NOT in the author's multi-scene format, so it is
 * returned unchanged and the LLM handles it exactly as before (no behaviour change for non-matching scripts).
 */
export function normalizeManualScript(text: string): string {
  const raw = (text ?? "").trim();
  if (!raw) return raw;
  const scenes = parseManualScriptScenes(raw);
  if (scenes.length < 2) return raw;
  const blocks = scenes.map((s, i) => {
    const out: string[] = [`=== SCENE ${i + 1} ===`];
    if (s.location) out.push(`LOCATION: ${s.location}`);
    if (s.subLocation) out.push(`SUB-LOCATION: ${s.subLocation}`);
    out.push("");
    if (s.body) out.push(s.body);
    return out.join("\n").trim();
  });
  return blocks.join("\n\n");
}
