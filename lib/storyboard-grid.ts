/**
 * Grid storyboard (Stage 240) — the storyboard is ONE 5×5 sheet of 25 equal PORTRAIT 9:16 panels rendered as a
 * single image by GPT Image 2.0 from an EDITABLE English prompt template. Placeholders are filled from the
 * project data (characters with their reference-image numbers + short appearance, the single location master
 * frame with its key objects, and the 25 scene beats grouped into 5 rows with a continuity hand-off between
 * rows). After the producer approves the sheet it is sliced into 25 panels; each panel becomes the START
 * FRAME of the matching scene.
 *
 * This module is PURE (no I/O) so it can be unit-tested and reused by the worker and the API. The prompt is
 * always English (it is sent to the image model); only the surrounding UI is bilingual.
 */

export const GRID_ROWS = 5;
export const GRID_COLS = 5;
export const GRID_PANELS = GRID_ROWS * GRID_COLS; // 25
/** GPT Image 2.0 sheet aspect. Five 9:16 panels per row × 5 rows → (5·9):(5·16) = exactly 9:16 overall. */
export const GRID_ASPECT_RATIO = "9:16";
/** Sheet resolution tier: 4k (2160×3840) so each of the 25 vertical panels is ≈ 430×770 px after slicing. */
export const GRID_RESOLUTION = "4k" as const;
/** GPT Image 2.0 accepts up to 10 image_inputs; keep the char refs + 1 location master under that cap. */
export const GRID_MAX_CHAR_REFS = 8;

/** One reference image passed to the grid model, in the exact order the prompt numbers them (image 1..N). */
export interface GridRef {
  url: string;
  /** "character" ref (neutral background) or the single "location" master plate. */
  kind: "character" | "location";
  /** Human label for the "View Prompt" reference list (bilingual is applied in the UI, not here). */
  label: string;
}

export interface GridCharacter {
  id: string;
  name: string;
  appearance?: string | null;
  role?: string | null;
  /** Neutral-background reference image URL (imageFront preferred). Absent → rendered "(no reference)". */
  refUrl?: string | null;
}

export interface GridLocation {
  id: string;
  name: string;
  /** Single master wide plate URL (LOCATION_REF_COUNT = 1). */
  imageUrl?: string | null;
  /** Short description of the key objects (visualPrompt / description / set inventory). */
  keyObjects?: string | null;
  /** Grid rows (1..5) that take place in this location; empty/absent = the whole sheet. */
  rows?: number[];
}

export interface GridSceneBeat {
  number: number;
  title?: string | null;
  /** Short readable action for the panel (English). */
  action?: string | null;
  shotType?: string | null;
}

export interface BuildGridPromptInput {
  characters: GridCharacter[];
  location?: GridLocation | null;
  /** Several locations (one per group of rows). When present and non-empty it wins over `location`. */
  locations?: GridLocation[] | null;
  scenes: GridSceneBeat[];
  /** Optional plot/magic element that may carry a colour accent. */
  keyElement?: string | null;
  /** Optional producer-edited template. When absent the DEFAULT_GRID_TEMPLATE is used. */
  template?: string | null;
}

export interface BuiltGridPrompt {
  /** The final English prompt sent to GPT Image 2.0. */
  prompt: string;
  /** References in the exact order the prompt refers to them as "image 1..N". */
  refs: GridRef[];
}

/** Shot-size rotation so each row opens/closes on a different size (wide → medium → close-up). */
const SHOT_SIZES = ["wide", "medium", "close-up", "medium", "wide"] as const;
/** Per-panel beat text cap — long enough for "[Who] [position] [verb] [object]; [second] [position] [what]. Looks at [target]." */
export const GRID_BEAT_MAX_CHARS = 320;
/** Soft prompt cap (GPT Image 2.0 accepts up to 32 000 chars); beats are shortened progressively to fit. */
export const GRID_PROMPT_MAX_CHARS = 30_000;

/**
 * The editable English DEFAULT template. It is stored verbatim so a producer can tweak wording; the
 * placeholders in {curly braces} are replaced by fillGridTemplate. When a producer saves an override we
 * keep THEIR text and only substitute the placeholders that are still present.
 */
export const DEFAULT_GRID_TEMPLATE = `Photorealistic live-action film storyboard sheet: 5 rows × 5 columns of equal PORTRAIT 9:16 panels (25 total), thin black borders, dark grey background, NO margins, NO labels, NO text of any kind inside or outside panels — only the panels edge to edge. Each panel is a cinematic photoreal film still: real skin, real fabric, physically correct light, film grain. NOT drawing, NOT illustration.

CONTINUITY: the last panel of every row and the first panel of the next row show the SAME moment (same positions, poses, hands, gaze) — only the shot size differs. Within a row nobody changes position unless a bit says so. Each panel adds exactly ONE new action to the previous panel.

CHARACTERS (identical face, hair, wardrobe in every panel): {CHARACTER_REFERENCES}

{LOCATION_REFERENCE}

{ROWS}`;

function short(text: string | null | undefined, max = 160): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  // cut on a sentence/word boundary
  const cut = t.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (lastStop > max * 0.5) return cut.slice(0, lastStop + 1).trim();
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim() + "…";
}

/**
 * Normalize an arbitrary scene list to EXACTLY 25 beats (5×5). Fewer → pad by repeating the last beat's
 * shell (so the sheet still has 25 panels); more → keep the first 25. The caller is responsible for the
 * scene count normalization at the data layer; this is a display-safety net for the prompt.
 */
export function normalizeToGridBeats(scenes: GridSceneBeat[]): GridSceneBeat[] {
  const out = scenes.slice(0, GRID_PANELS);
  while (out.length < GRID_PANELS) {
    const n = out.length + 1;
    out.push({ number: n, title: null, action: null, shotType: null });
  }
  return out.map((s, i) => ({ ...s, number: s.number || i + 1 }));
}

/** Build the CHARACTER REFERENCES block and the ordered ref list (image 1..K for characters). */
function buildCharacterBlock(characters: GridCharacter[]): { block: string; refs: GridRef[] } {
  const refs: GridRef[] = [];
  const lines: string[] = [];
  for (const c of characters) {
    const desc = short(c.appearance, 180) || short(c.role, 80) || "character";
    if (c.refUrl && refs.length < GRID_MAX_CHAR_REFS) {
      refs.push({ url: c.refUrl, kind: "character", label: c.name });
      lines.push(`${c.name} = image ${refs.length}.`);
    } else {
      lines.push(`${c.name} (no reference image) = ${desc}.`);
    }
  }
  if (!lines.length) lines.push("(no named characters — infer neutral figures from the beats).");
  return { block: lines.join(" "), refs };
}

/** "ROWS 1–3" / "ROW 2" / "ROWS 1, 3" label for a location's rows. */
function rowsLabel(rows: number[] | undefined): string {
  const r = Array.from(new Set((rows ?? []).filter((n) => n >= 1 && n <= GRID_ROWS))).sort((a, b) => a - b);
  if (!r.length || r.length === GRID_ROWS) return "";
  if (r.length === 1) return `ROW ${r[0]}`;
  const contiguous = r.every((n, i) => i === 0 || n === r[i - 1] + 1);
  return contiguous ? `ROWS ${r[0]}–${r[r.length - 1]}` : `ROWS ${r.join(", ")}`;
}

/**
 * Build the LOCATION block; each location master is the next image number after the characters (in the
 * exact order the refs are passed to the model). Several locations → one line each, with the rows it covers.
 */
function buildLocationBlock(
  locations: GridLocation[],
  nextImageNumber: number,
  maxRefs: number,
): { line: string; refs: GridRef[] } {
  const refs: GridRef[] = [];
  const lines: string[] = [];
  const multi = locations.length > 1;
  for (const location of locations) {
    const name = short(location.name, 60) || "location";
    const layout = short(location.keyObjects, 320);
    const rows = multi ? rowsLabel(location.rows) : "";
    const head = rows ? `LOCATION for ${rows}` : "LOCATION";
    const fixed = `Fixed layout: ${layout || "keep the room and its objects exactly as in the reference"}. Nobody leaves this space.`;
    if (location.imageUrl && refs.length < maxRefs) {
      refs.push({ url: location.imageUrl, kind: "location", label: location.name || "Location" });
      lines.push(`${head} = image ${nextImageNumber + refs.length - 1} (${name}). ${fixed}`);
    } else {
      lines.push(`${head} (no reference image): ${name}. ${fixed}`);
    }
  }
  if (!lines.length) lines.push("LOCATION (no reference): a single consistent location. Keep the same room and objects throughout; do not invent new rooms. Nobody leaves this space.");
  return { line: lines.join("\n"), refs };
}

/** Build the five ROW blocks: "ROW r: r.1 size: beat. r.2 size: beat. …" (no labels — the sheet carries no text). */
function buildRowsBlock(beats: GridSceneBeat[], beatMax = GRID_BEAT_MAX_CHARS): string {
  const rows: string[] = [];
  for (let r = 1; r <= GRID_ROWS; r++) {
    const panels: string[] = [];
    for (let c = 1; c <= GRID_COLS; c++) {
      const idx = (r - 1) * GRID_COLS + (c - 1);
      const beat = beats[idx];
      const action = short(beat?.action, beatMax) || short(beat?.title, 60) || "continue the action";
      const size = short(beat?.shotType, 24).replace(/\.$/, "").toLowerCase() || SHOT_SIZES[(r - 1 + c - 1) % SHOT_SIZES.length];
      let text = `${r}.${c} ${size}: ${action}`;
      if (c === 1 && r > 1) text = `${r}.${c} ${size}: same moment as ${r - 1}.${GRID_COLS} — ${action}`;
      panels.push(text.replace(/\.$/, "") + ".");
    }
    rows.push(`ROW ${r}: ${panels.join(" ")}`);
  }
  return rows.join("\n");
}

/**
 * Fill the placeholders of a template with the project data. Producer overrides that removed a placeholder
 * simply keep their literal text. Returns the final prompt and the ordered reference images.
 */
export function buildGridPrompt(input: BuildGridPromptInput): BuiltGridPrompt {
  const template = (input.template && input.template.trim()) ? input.template : DEFAULT_GRID_TEMPLATE;
  const beats = normalizeToGridBeats(input.scenes ?? []);
  const { block: charBlock, refs: charRefs } = buildCharacterBlock(input.characters ?? []);
  const locations: GridLocation[] = input.locations?.length ? input.locations : input.location ? [input.location] : [];
  // GPT Image 2.0 accepts at most 10 image inputs: characters first (numbered 1..K), then the location plates.
  const { line: locLine, refs: locRefs } = buildLocationBlock(locations, charRefs.length + 1, Math.max(0, 10 - charRefs.length));
  const refs: GridRef[] = [...charRefs, ...locRefs];
  const keyElement = short(input.keyElement, 80) || "the single most important plot object";

  const fill = (beatMax: number) => template
    .replace(/\{KEY_ELEMENT\}/g, keyElement)
    .replace(/\{ROW_LABELS\}/g, "")
    .replace(/\{CHARACTER_REFERENCES\}/g, charBlock)
    .replace(/\{LOCATION_REFERENCE\}/g, locLine)
    .replace(/\{ROWS\}/g, buildRowsBlock(beats, beatMax));

  // Stay under the model's prompt limit: shorten the per-beat text progressively (never below 120 chars).
  let beatMax = GRID_BEAT_MAX_CHARS;
  let prompt = fill(beatMax);
  while (prompt.length > GRID_PROMPT_MAX_CHARS && beatMax > 120) {
    beatMax -= 40;
    prompt = fill(beatMax);
  }

  return { prompt, refs };
}
