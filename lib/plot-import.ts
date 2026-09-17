/**
 * Stage 155 — "Bring your own plot file".
 *
 * After the synopsis is generated the author may either let the app build the season plot automatically
 * (the default, unchanged) OR upload their OWN finished plot file (.txt/.md/.docx/.pdf). When a plot file
 * is uploaded, its extracted text is stored in `Season.fullStory` (the same field the auto plot uses, so
 * every downstream reader stays uniform) and `Season.userPlotUploaded` is set — that flag makes the
 * per-episode SCRIPT generator treat the uploaded plot as the AUTHORITATIVE source.
 *
 * This module holds only the PURE, side-effect-free helpers (boundary detection, plot-source selection,
 * upload validation, extractor dispatch). The actual text extraction reuses lib/parse-story.ts; the routes
 * stay thin and the behaviour is unit-testable with no DB / LLM / network / paid generation.
 */
import { storyKindFromName, STORY_MAX_BYTES, type StoryKind } from "@/lib/parse-story";

/** Accept attribute for the plot-file <input> (mirrors lib/parse-story STORY_ACCEPT). */
export const PLOT_ACCEPT = ".txt,.md,.markdown,.docx,.pdf";
/** Max upload size for a plot file (same 8 MB budget as the idea-stage story upload). */
export const PLOT_MAX_BYTES = STORY_MAX_BYTES;

/** MIME → extractor kind, so a file with the right content-type but a missing/odd extension still resolves. */
export const PLOT_MIME_KIND: Record<string, StoryKind> = {
  "text/plain": "txt",
  "text/markdown": "md",
  "text/x-markdown": "md",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

/**
 * Choose the text extractor for an uploaded plot file. The filename extension wins (authoritative for the
 * four supported formats); if it is missing/unknown, fall back to the declared MIME type. Returns the
 * StoryKind (consumed by lib/parse-story parseStoryFile) or null when neither identifies a supported format.
 * PURE.
 */
export function pickExtractor(filename: string, mime?: string | null): StoryKind | null {
  const byExt = storyKindFromName(filename || "");
  if (byExt) return byExt;
  const m = (mime || "").split(";")[0].trim().toLowerCase();
  return PLOT_MIME_KIND[m] ?? null;
}

export type PlotUploadValidation = { ok: true; kind: StoryKind } | { ok: false; error: string };

/**
 * Validate an uploaded plot file's metadata (filename, MIME, byte size) BEFORE any extraction. Returns a
 * graceful, user-facing RUSSIAN error for a disallowed type or an oversize/empty file. PURE.
 */
export function validatePlotUpload(input: { filename: string; mime?: string | null; size: number }): PlotUploadValidation {
  const kind = pickExtractor(input.filename, input.mime);
  if (!kind) {
    return { ok: false, error: "Неподдерживаемый формат файла. Загрузите файл .txt, .md, .docx или .pdf." };
  }
  if (!Number.isFinite(input.size) || input.size <= 0) {
    return { ok: false, error: "Файл пустой — загрузите файл с текстом сюжета." };
  }
  if (input.size > PLOT_MAX_BYTES) {
    const mb = Math.floor(PLOT_MAX_BYTES / (1024 * 1024));
    return { ok: false, error: `Файл слишком большой (максимум ${mb} МБ).` };
  }
  return { ok: true, kind };
}

/** One detected episode/series boundary in an uploaded plot. */
export interface PlotBoundary {
  /** The episode number parsed from the marker. */
  number: number;
  /** Any title text on the same line after the marker (may be empty). */
  title: string;
  /** Index of the marker line within the split text. */
  lineIndex: number;
}

/** One episode section carved out of an uploaded plot (the marker line's body up to the next marker). */
export interface PlotEpisode {
  number: number;
  title: string;
  body: string;
}

/**
 * A line that opens a new episode/series/chapter: «Серия N», «Эпизод N», "Episode N", «Глава N»,
 * "Chapter N", «Часть N», "Part N" — case-insensitive, optionally prefixed with № or #, and allowing a
 * trailing separator (":", ".", ")", "-") before an optional title. Anchored to the start of a trimmed line.
 */
const EPISODE_MARKER = /^\s*(?:серия|эпизод|episode|глава|chapter|часть|part)\s*[№#]?\s*(\d+)\b[\s.:)\-–—]*(.*)$/i;

/**
 * Detect the author's own episode/series division in a plot text. Returns the ordered list of boundaries
 * (empty when the text has no explicit markers). PURE.
 */
export function detectEpisodeBoundaries(text: string): PlotBoundary[] {
  const lines = (text || "").split(/\r?\n/);
  const out: PlotBoundary[] = [];
  lines.forEach((line, i) => {
    const m = line.match(EPISODE_MARKER);
    if (m) out.push({ number: parseInt(m[1], 10), title: (m[2] || "").trim(), lineIndex: i });
  });
  return out;
}

/**
 * Split an uploaded plot into episodes along the author's OWN markers. Each episode is the text between its
 * marker line and the next marker (or the end). Returns an EMPTY array when the plot has no explicit episode
 * division — the caller then falls back to the existing (auto) episode-structuring logic. PURE.
 */
export function splitPlotIntoEpisodes(text: string): PlotEpisode[] {
  const lines = (text || "").split(/\r?\n/);
  const marks = detectEpisodeBoundaries(text);
  if (marks.length === 0) return [];
  return marks.map((mk, idx) => {
    const start = mk.lineIndex + 1;
    const end = idx + 1 < marks.length ? marks[idx + 1].lineIndex : lines.length;
    return { number: mk.number, title: mk.title, body: lines.slice(start, end).join("\n").trim() };
  });
}

/**
 * Select the authoritative story/plot source for downstream generation (episode scripts): the author's
 * UPLOADED plot when present (non-empty after trim), otherwise the auto-built story. PURE — this is the one
 * decision both the season job and the reset-to-auto path use so "uploaded plot wins" stays consistent.
 */
export function selectPlotSource(input: { uploadedPlot?: string | null; autoStory?: string | null }): string {
  const uploaded = (input.uploadedPlot ?? "").trim();
  if (uploaded) return uploaded;
  return (input.autoStory ?? "").trim();
}
