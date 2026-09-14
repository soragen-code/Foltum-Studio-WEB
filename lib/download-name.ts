/**
 * Stage 46E — file names for downloaded reference frames.
 *   <CharacterName>_<face|profile|full-body|extra-N>.<ext>
 *   <LocationName>_<master|reverse|detail|extra-N>.<ext>
 * Cyrillic is kept; only path-unsafe / control characters are stripped.
 */
export const CHARACTER_SLOT_FILE_LABELS: Record<string, string> = { front: "face", profile: "profile", full: "height" };
export const LOCATION_SLOT_FILE_LABELS: Record<string, string> = { master: "master", layout: "layout", reverse: "layout", detail: "detail" };

/** Strip characters that are illegal or risky in file names (keeps letters of any script, digits, space, -, _, .). */
export function safeFileStem(name: string, fallback = "reference"): string {
  const cleaned = (name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

/** File extension from an image URL (png / jpg / jpeg / webp); defaults to png. */
export function extFromUrl(url: string): string {
  const m = /\.(png|jpe?g|webp|gif)(?:[?#].*)?$/i.exec(url ?? "");
  return m ? m[1].toLowerCase() : "png";
}

export function slotFileLabel(kind: "character" | "location", slot: string, index?: number): string {
  if (slot === "extra") return `extra-${(index ?? 0) + 1}`;
  const map = kind === "character" ? CHARACTER_SLOT_FILE_LABELS : LOCATION_SLOT_FILE_LABELS;
  return map[slot] ?? safeFileStem(slot, "frame");
}

/** `<Name>_<slotLabel>.<ext>` for one frame. */
export function referenceFileName(kind: "character" | "location", name: string, slot: string, url: string, index?: number): string {
  return `${safeFileStem(name)}_${slotFileLabel(kind, slot, index)}.${extFromUrl(url)}`;
}

/** `<Name>_references.zip` for the whole set. */
export function referencesZipName(name: string): string {
  return `${safeFileStem(name)}_references.zip`;
}

/** RFC 5987 Content-Disposition value with an ASCII fallback + UTF-8 encoded real name. */
export function attachmentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
