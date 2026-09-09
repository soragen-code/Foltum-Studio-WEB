/**
 * C2PA / Content-Credentials detection for reference images.
 *
 * Seedream (bytedance) PNG references carry C2PA "content credentials" metadata.
 * Seedance moderation (error E005) can drop references whose provenance metadata
 * has been stripped, so every reference we store MUST keep this metadata intact.
 *
 * We never re-encode reference bytes (see uploadRemoteToS3 — a raw fetch → PUT),
 * so the metadata is preserved by construction. This module is a NON-BLOCKING
 * diagnostic: it inspects the stored bytes and confirms the marks are present,
 * so we can flag a regression instead of silently shipping stripped references.
 *
 * Detection is a byte-signature scan (no external deps): C2PA embeds a JUMBF box
 * whose labels contain these ASCII markers, and Seedream also writes an XMP packet.
 */

/** ASCII signatures that indicate C2PA / content-credentials / provenance metadata. */
const C2PA_SIGNATURES = [
  "c2pa",
  "jumbf",
  "jumd",
  "contentcredentials",
  "content_credentials",
  "urn:c2pa",
  "c2pa.assertions",
  "c2pa.claim",
] as const;

/** XMP packet markers (Seedream writes AI/provenance info into XMP too). */
const XMP_SIGNATURES = [
  "<x:xmpmeta",
  "http://ns.adobe.com/xap/",
  "photoshop:Credit",
  "dc:rights",
] as const;

export interface C2paResult {
  /** true if any C2PA / provenance signature was found. */
  ok: boolean;
  /** the specific signatures that matched (for logging / diagnostics). */
  signatures: string[];
  /** whether an XMP packet was present (weaker signal, still provenance). */
  xmp: boolean;
  /** byte length inspected. */
  bytes: number;
}

/**
 * Scan raw image bytes for C2PA / content-credentials / XMP provenance markers.
 * Case-insensitive latin1 scan — safe for binary PNG/JPEG buffers.
 */
export function detectC2pa(data: Buffer | Uint8Array): C2paResult {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  // latin1 keeps every byte as a 1:1 char so ASCII markers survive the scan.
  const hay = buf.toString("latin1").toLowerCase();

  const signatures: string[] = [];
  for (const sig of C2PA_SIGNATURES) {
    if (hay.includes(sig.toLowerCase())) signatures.push(sig);
  }

  let xmp = false;
  for (const sig of XMP_SIGNATURES) {
    if (hay.includes(sig.toLowerCase())) {
      xmp = true;
      break;
    }
  }

  return {
    ok: signatures.length > 0 || xmp,
    signatures,
    xmp,
    bytes: buf.length,
  };
}

/**
 * Fetch a stored/remote reference and check its C2PA marks. Never throws —
 * on any error it returns ok:false so callers can log a warning without crashing.
 */
export async function detectC2paFromUrl(url: string): Promise<C2paResult> {
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, signatures: [], xmp: false, bytes: 0 };
    const buf = Buffer.from(await res.arrayBuffer());
    return detectC2pa(buf);
  } catch {
    return { ok: false, signatures: [], xmp: false, bytes: 0 };
  }
}
