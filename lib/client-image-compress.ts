/**
 * Stage 234c — browser-side downscale before uploading reference images.
 *
 * Vercel serverless functions reject request bodies above ~4.5 MB
 * (HTTP 413 FUNCTION_PAYLOAD_TOO_LARGE), so a phone PNG of 6-10 MB never
 * reached /api/manual/upload. Anything above SAFE_BYTES is re-encoded on a
 * canvas: longest side ≤ MAX_SIDE, JPEG quality stepped down until it fits.
 * Small files are passed through untouched.
 */
const SAFE_BYTES = 3.5 * 1024 * 1024;
// Files below this can be sent as-is even if we fail to re-encode them: they stay
// under Vercel's ~4.5 MB serverless body limit.
const HARD_MAX_BYTES = 4.3 * 1024 * 1024;
// Try progressively smaller longest-side caps: very large canvases make toBlob()
// return null in some browsers, so we shrink until the encode succeeds.
const MAX_SIDES = [2048, 1600, 1280, 1024, 768];

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("DECODE_FAILED")); };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Downscale/re-encode a reference image so it fits under the serverless body limit.
 * Throws Error("DECODE_FAILED") or Error("TOO_LARGE") (codes mapped to localized
 * messages by the caller). Small, decodable files pass through untouched.
 */
export async function compressImageForUpload(file: File): Promise<File> {
  if (typeof window === "undefined" || file.size <= SAFE_BYTES) return file;

  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    // Couldn't decode (unusual/corrupt PNG, HEIC renamed to .png, etc.). If it's
    // still small enough for the server, let the server try; otherwise give up.
    if (file.size <= HARD_MAX_BYTES) return file;
    throw new Error("DECODE_FAILED");
  }

  for (const maxSide of MAX_SIDES) {
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, w, h);
    for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5]) {
      const blob = await canvasToBlob(canvas, "image/jpeg", quality);
      // blob === null means the canvas was too big to encode → try a smaller maxSide.
      if (!blob) break;
      if (blob.size <= SAFE_BYTES) {
        const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
        return new File([blob], name, { type: "image/jpeg" });
      }
    }
  }
  throw new Error("TOO_LARGE");
}
