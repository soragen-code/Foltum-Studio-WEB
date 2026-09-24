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
const MAX_SIDE = 2048;

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Cannot decode image")); };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function compressImageForUpload(file: File): Promise<File> {
  if (typeof window === "undefined" || file.size <= SAFE_BYTES) return file;
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return file;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  for (const quality of [0.92, 0.85, 0.75, 0.65, 0.55]) {
    const blob = await canvasToBlob(canvas, "image/jpeg", quality);
    if (blob && blob.size <= SAFE_BYTES) {
      const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
      return new File([blob], name, { type: "image/jpeg" });
    }
  }
  throw new Error("Image is too large even after compression");
}
