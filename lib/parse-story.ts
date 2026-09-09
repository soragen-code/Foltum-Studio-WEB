/**
 * Stage 12 — server-side parsing of an uploaded story file into plain text.
 * Supports .txt, .md (markdown), .docx (via mammoth) and .pdf (via pdf-parse/pdfjs).
 * The extracted text becomes the CANON story that the idea generator structures into a season.
 */

export const STORY_ACCEPT = ".txt,.md,.markdown,.docx,.pdf";
export const STORY_MAX_BYTES = 8 * 1024 * 1024; // 8 MB
/** Hard cap on extracted characters fed to the LLM (keeps prompt within budget). */
export const STORY_MAX_CHARS = 60_000;

export type StoryKind = "txt" | "md" | "docx" | "pdf";

export function storyKindFromName(name: string): StoryKind | null {
  const n = (name || "").toLowerCase();
  if (n.endsWith(".txt")) return "txt";
  if (n.endsWith(".md") || n.endsWith(".markdown")) return "md";
  if (n.endsWith(".docx")) return "docx";
  if (n.endsWith(".pdf")) return "pdf";
  return null;
}

/** Collapse excessive whitespace but keep paragraph breaks. */
export function cleanStoryText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, STORY_MAX_CHARS);
}

async function parseDocx(buf: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const res = await mammoth.extractRawText({ buffer: buf });
  return res.value ?? "";
}

async function parsePdf(buf: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const res = await parser.getText();
    return res?.text ?? "";
  } finally {
    // free pdfjs worker/document handles
    await (parser as any).destroy?.().catch?.(() => {});
  }
}

/**
 * Extract plain text from an uploaded story file buffer. Throws a user-facing Error
 * (Russian) on unsupported type or empty content.
 */
export async function parseStoryFile(filename: string, buf: Buffer): Promise<{ kind: StoryKind; text: string }> {
  const kind = storyKindFromName(filename);
  if (!kind) throw new Error("Неподдерживаемый формат. Загрузите .txt, .md, .docx или .pdf");
  let raw = "";
  if (kind === "txt" || kind === "md") {
    raw = buf.toString("utf8");
  } else if (kind === "docx") {
    raw = await parseDocx(buf);
  } else if (kind === "pdf") {
    raw = await parsePdf(buf);
  }
  const text = cleanStoryText(raw);
  if (text.length < 20) throw new Error("Не удалось извлечь текст из файла (файл пуст, отсканирован как изображение или защищён).");
  return { kind, text };
}
