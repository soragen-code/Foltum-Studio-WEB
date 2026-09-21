"use client";

/**
 * Save a generated mp4 clip to the device.
 *
 * On a phone we want the clip to land in the MEDIA LIBRARY (Photos / camera roll / gallery), not just
 * the Files/Downloads area. A plain `<a download>` cannot do that on iOS Safari. The reliable path is
 * the Web Share API with a File: `navigator.share({ files })` shows the native share sheet whose
 * "Save Video" (iOS) / "Save to gallery" (Android) action writes the clip into the media library.
 *
 * The bytes are pulled through our SAME-ORIGIN proxy (/api/files/download-video) so there is no
 * cross-origin CORS problem when turning the response into a File. On desktop, or wherever file
 * sharing is unsupported, we fall back to a normal object-URL download.
 */

/** Build the same-origin proxy URL that streams this owned video as an mp4 attachment. */
function proxyUrl(videoUrl: string, fileStem: string): string {
  const p = new URLSearchParams({ url: videoUrl, name: fileStem });
  return `/api/files/download-video?${p.toString()}`;
}

/** True on phones/tablets, where "save to media library" via the share sheet makes sense. */
function isMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/** Plain download fallback (desktop, or when file sharing is unavailable). */
function downloadBlob(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 15_000);
}

/**
 * Save `videoUrl` to the device. `fileStem` is the base name (no extension) shown to the user.
 * Returns "shared" (went through the native share sheet → user can save to the media library),
 * "downloaded" (plain file download), or "cancelled" (user dismissed the share sheet).
 */
export async function saveVideoToDevice(videoUrl: string, fileStem: string): Promise<"shared" | "downloaded" | "cancelled"> {
  const fileName = `${fileStem}.mp4`;
  const src = proxyUrl(videoUrl, fileStem);

  // Fetch the bytes once from our same-origin proxy (cookies included for the auth check).
  const res = await fetch(src, { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const blob = await res.blob();
  const file = new File([blob], fileName, { type: blob.type || "video/mp4" });

  // On a phone, prefer the native share sheet so the user can pick "Save Video" → media library.
  const canShareFiles =
    isMobile() &&
    typeof navigator !== "undefined" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] }) &&
    typeof navigator.share === "function";

  if (canShareFiles) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return "shared";
    } catch (err) {
      // The user dismissing the sheet throws AbortError — that is not a failure, and we must NOT
      // then silently download. Any other error falls through to the plain download fallback.
      if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
    }
  }

  downloadBlob(blob, fileName);
  return "downloaded";
}
