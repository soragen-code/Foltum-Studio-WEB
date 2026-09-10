import { createHash } from "node:crypto";
import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { createS3Client, getBucketConfig } from "@/lib/aws-config";
import { uploadBufferToS3 } from "@/lib/s3-upload";

/**
 * Stage 33 — lean reference images for Seedance.
 *
 * Every reference URL (character portraits, location angle, crowd groups, the chained last frame)
 * is downscaled ONCE to a 768px-wide JPEG (q90) and published under a deterministic S3 key derived
 * from the source URL, so repeated generations of the same scene reuse the same object instead of
 * re-encoding. Any failure (fetch, sharp, S3) falls back to the ORIGINAL url with a warning — a
 * downscale problem must never fail a paid video job.
 */
export const REFERENCE_WIDTH = 768;
const JPEG_QUALITY = 90;

/** In-process cache: source url → published 768px url (also short-circuits the S3 HEAD). */
const cache = new Map<string, string>();

function publicUrl(bucketName: string, key: string) {
  const region = process.env.AWS_REGION ?? "us-east-1";
  return `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
}

function downscaledKey(url: string, projectId: string, folderPrefix: string) {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 24);
  return `${folderPrefix}public/references/${projectId}/${REFERENCE_WIDTH}w/${hash}-${REFERENCE_WIDTH}w.jpg`;
}

/** Already a published 768px derivative — never downscale twice. */
function isDownscaled(url: string) {
  return url.includes(`/${REFERENCE_WIDTH}w/`) && url.endsWith(`-${REFERENCE_WIDTH}w.jpg`);
}

/**
 * Returns the 768px JPEG url for `url` (creating it if missing), or `url` itself on any failure.
 */
export async function downscaleReference(url: string, projectId: string): Promise<string> {
  if (!url || isDownscaled(url)) return url;
  const cached = cache.get(url);
  if (cached) return cached;
  try {
    const { bucketName, folderPrefix } = getBucketConfig();
    if (!bucketName) return url;
    const key = downscaledKey(url, projectId, folderPrefix);
    const target = publicUrl(bucketName, key);
    const s3 = createS3Client();
    // Skip the work when the derivative already exists (deterministic key).
    const exists = await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: key })).then(() => true).catch(() => false);
    if (exists) { cache.set(url, target); return target; }

    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const source = Buffer.from(await res.arrayBuffer());
    const { default: sharp } = await import("sharp");
    const out = await sharp(source)
      .rotate()
      .resize({ width: REFERENCE_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    const stored = await uploadBufferToS3(out, key, "image/jpeg");
    cache.set(url, stored);
    return stored;
  } catch (error) {
    console.warn("[video-job] reference downscale fallback to original:", { url, error: error instanceof Error ? error.message : String(error) });
    return url;
  }
}

/** Downscale a whole reference list in parallel, preserving order. */
export async function downscaleReferences(urls: string[], projectId: string): Promise<string[]> {
  return Promise.all(urls.map(u => downscaleReference(u, projectId)));
}
