/**
 * Grid storyboard (Stage 240) — the storyboard is ONE 5×5 sheet of 25 equal 16:9 panels rendered as a
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
/** GPT Image 2.0 sheet aspect. Five 16:9 panels per row → 5*(16/9) wide by 5 tall ≈ 16:9 overall. */
export const GRID_ASPECT_RATIO = "16:9";
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

/**
 * The editable English DEFAULT template. It is stored verbatim so a producer can tweak wording; the
 * placeholders in {curly braces} are replaced by fillGridTemplate. When a producer saves an override we
 * keep THEIR text and only substitute the placeholders that are still present.
 */
export const DEFAULT_GRID_TEMPLATE = `Professional film storyboard sheet laid out as 5 rows by 5 columns of equal 16:9 panels (25 total), thin black borders between panels, dark charcoal background. EVERY PANEL IS A PHOTOREALISTIC LIVE-ACTION FILM STILL: real actors with natural skin texture, real fabric and props, cinematic lighting, shallow depth of field, natural colour grading with subtle film grain — these panels are the first frames of the finished video. NOT a drawing, NOT a sketch, NOT an illustration, NOT grayscale, NOT pencil or ink. Small panel numbers "1.1" to "5.5" in the top-left corner of each panel; bold row labels on the left margin: {ROW_LABELS}. No other text or captions.

STORY LEGIBILITY: each panel is ONE distinct story beat that must read without words — stage exactly the action described for that panel, make the key prop ({KEY_ELEMENT}) and the characters' reactions clearly visible, and let consecutive panels show visible progression (cause → effect). Never repeat a generic pose or a generic wide shot; follow the shot size given for each panel.

CONTINUITY RULE: the last panel of every row and the first panel of the next row show the SAME moment — same positions, same poses, same action — differing only in shot size.

CHARACTER REFERENCES — keep faces, hair and wardrobe consistent in every panel:
{CHARACTER_REFERENCES}
{LOCATION_REFERENCE}

{ROWS}

Clean layout, cinematic compositions, consistent character designs, photoreal throughout.`;

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

/** Row label for row r (1-based): use the first scene title in the row when present, else "BEAT r". */
function rowLabel(beats: GridSceneBeat[], r: number): string {
  const first = beats[(r - 1) * GRID_COLS];
  const t = short((first?.title ?? "").split(" — ")[0], 40);
  return (t || `BEAT ${r}`).toUpperCase();
}

/** Build the CHARACTER REFERENCES block and the ordered ref list (image 1..K for characters). */
function buildCharacterBlock(characters: GridCharacter[]): { block: string; refs: GridRef[] } {
  const refs: GridRef[] = [];
  const lines: string[] = [];
  for (const c of characters) {
    const desc = short(c.appearance, 180) || short(c.role, 80) || "character";
    if (c.refUrl && refs.length < GRID_MAX_CHAR_REFS) {
      refs.push({ url: c.refUrl, kind: "character", label: c.name });
      lines.push(`${c.name} = image ${refs.length}: ${desc}.`);
    } else {
      lines.push(`${c.name} (no reference): ${desc}.`);
    }
  }
  if (!lines.length) lines.push("(no named characters — infer neutral figures from the beats).");
  return { block: lines.join("\n"), refs };
}

/** Build the LOCATION reference line; the location master is the next image number after the characters. */
function buildLocationBlock(location: GridLocation | null | undefined, nextImageNumber: number): { line: string; ref: GridRef | null } {
  if (location?.imageUrl) {
    const objs = short(location.keyObjects, 200) || "the key objects of the set";
    return {
      line: `LOCATION = image ${nextImageNumber}: ${objs}. Use this layout throughout; do not invent rooms or objects not in the reference.`,
      ref: { url: location.imageUrl, kind: "location", label: location.name || "Location" },
    };
  }
  const objs = short(location?.keyObjects, 200);
  return {
    line: `LOCATION (no reference): ${objs || "a single consistent location"}. Keep the same room and objects throughout; do not invent new rooms.`,
    ref: null,
  };
}

/** Build the five ROW blocks with per-panel beats and the continuity hand-off between rows. */
function buildRowsBlock(beats: GridSceneBeat[]): string {
  const rows: string[] = [];
  for (let r = 1; r <= GRID_ROWS; r++) {
    const label = rowLabel(beats, r);
    const panels: string[] = [];
    for (let c = 1; c <= GRID_COLS; c++) {
      const idx = (r - 1) * GRID_COLS + (c - 1);
      const beat = beats[idx];
      const action = short(beat?.action, 240) || short(beat?.title, 60) || "continue the action";
      const isFirst = c === 1;
      const isLast = c === GRID_COLS;
      const size = short(beat?.shotType, 24).replace(/\.$/, "").toLowerCase() || SHOT_SIZES[(r - 1 + c - 1) % SHOT_SIZES.length];
      let text = `${r}.${c} ${size}: ${action}`;
      if (isFirst && r > 1) text = `${r}.${c} ${size}: same moment as ${r - 1}.${GRID_COLS} — ${action}`;
      if (isLast) text += ` (handoff moment)`;
      panels.push(text.replace(/\.$/, "") + ".");
    }
    rows.push(`ROW ${r} ${label}: ${panels.join(" ")}`);
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
  const { line: locLine, ref: locRef } = buildLocationBlock(input.location, charRefs.length + 1);
  const refs: GridRef[] = locRef ? [...charRefs, locRef] : [...charRefs];
  const rowLabels = Array.from({ length: GRID_ROWS }, (_, i) => `"${rowLabel(beats, i + 1)}"`).join(", ");
  const keyElement = short(input.keyElement, 80) || "the single most important plot object";

  const prompt = template
    .replace(/\{KEY_ELEMENT\}/g, keyElement)
    .replace(/\{ROW_LABELS\}/g, rowLabels)
    .replace(/\{CHARACTER_REFERENCES\}/g, charBlock)
    .replace(/\{LOCATION_REFERENCE\}/g, locLine)
    .replace(/\{ROWS\}/g, buildRowsBlock(beats));

  return { prompt, refs };
}
