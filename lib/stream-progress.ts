/**
 * Streaming-progress helpers.
 *
 * Text-generating jobs (idea / synopsis / episode-synopsis / script) run inside a background worker
 * and stream their output from the model via `streamChatText`'s `onDelta`. To let the frontend show
 * that text appearing progressively — WITHOUT requiring the tab to stay open — the worker persists the
 * accumulated visible text into `GenerationJob.streamedText` as it grows. The frontend already polls
 * GET /api/jobs/[id] every few seconds, so it just renders whatever `streamedText` it last saw; a
 * reopened tab immediately shows the accumulated partial (or the final text once the job completes).
 *
 * DB writes are throttled (time + growth based) so a token-by-token stream does not hammer Postgres.
 * All writes are best-effort and swallow errors — a failed preview write must NEVER break generation.
 */
import { updateJob } from "@/lib/jobs";

export type JobStreamWriter = (delta: string, accumulated: string) => void;

/**
 * Build an `onDelta` callback that throttles persistence of the running text into
 * `GenerationJob.streamedText`. Pass the result straight to `streamChatText({ onDelta })`.
 *
 * @param jobId     the GenerationJob to write into
 * @param opts.field when the stream is a JSON object, extract this string field's value for the preview
 *                   (tolerant of the not-yet-closed JSON while streaming). Omit for plain-text streams.
 * @param opts.minIntervalMs minimum ms between DB writes (default 900)
 * @param opts.minGrowth     minimum extra characters since the last write (default 40)
 * @param opts.transform     optional final transform applied to the text before writing
 */
export function makeJobStreamWriter(
  jobId: string,
  opts?: { field?: string; minIntervalMs?: number; minGrowth?: number; transform?: (s: string) => string },
): JobStreamWriter {
  const minIntervalMs = opts?.minIntervalMs ?? 900;
  const minGrowth = opts?.minGrowth ?? 40;
  let lastWriteAt = 0;
  let lastLen = 0;
  let inFlight = false;

  return (_delta: string, accumulated: string) => {
    try {
      let text = opts?.field ? extractProseField(accumulated, opts.field) : accumulated;
      if (opts?.transform) text = opts.transform(text);
      if (!text) return;
      const now = Date.now();
      // Throttle: only write when enough time has passed AND the text grew enough (or shrank/reset).
      if (inFlight) return;
      if (now - lastWriteAt < minIntervalMs) return;
      if (text.length - lastLen < minGrowth && text.length >= lastLen) return;
      lastWriteAt = now;
      lastLen = text.length;
      inFlight = true;
      // Fire-and-forget; never await inside the model's delta loop.
      void updateJob(jobId, { streamedText: text.slice(0, 60000) })
        .catch(() => {})
        .finally(() => { inFlight = false; });
    } catch {
      inFlight = false;
    }
  };
}

/**
 * Persist the final text into `streamedText` once (used after a stream completes, to guarantee the
 * frontend's last poll sees the full accumulated text even if the throttle skipped the last delta).
 */
export async function flushStreamedText(jobId: string, text: string): Promise<void> {
  try {
    if (text) await updateJob(jobId, { streamedText: text.slice(0, 60000) });
  } catch {}
}

/**
 * Turn a partial (possibly still-streaming, unclosed) JSON blob into readable prose for a LIVE preview:
 * keep the string VALUES, drop the structural noise (braces/brackets/quotes/commas) and the field-name
 * keys, and join values with separators. Used for structured steps (episode breakdown / shooting script)
 * where there is no single prose field to extract but we still want the producer to watch text appear.
 * Purely cosmetic — the authoritative parsed result is unaffected.
 */
export function stripJsonForPreview(accumulated: string): string {
  if (!accumulated) return "";
  const out: string[] = [];
  let i = 0;
  const n = accumulated.length;
  while (i < n) {
    const ch = accumulated[i];
    if (ch === '"') {
      // Read a full (or partial) string token.
      let s = "";
      let escaped = false;
      i++;
      let closed = false;
      for (; i < n; i++) {
        const c = accumulated[i];
        if (escaped) {
          if (c === "n") s += "\n"; else if (c === "t") s += " "; else if (c === "r") s += ""; else s += c;
          escaped = false; continue;
        }
        if (c === "\\") { escaped = true; continue; }
        if (c === '"') { closed = true; i++; break; }
        s += c;
      }
      // Skip whitespace to see whether this string is a KEY (followed by ':').
      let j = i;
      while (j < n && /\s/.test(accumulated[j])) j++;
      const isKey = closed && accumulated[j] === ":";
      if (!isKey && s.trim()) out.push(s.trim());
      continue;
    }
    i++;
  }
  return out.join("\n").slice(-60000);
}

/**
 * Tolerantly extract the string value of `field` from a JSON blob that may still be STREAMING
 * (unclosed). Finds `"field"` then the opening quote of its value, and returns the raw characters up
 * to the (possibly missing) closing quote, unescaping the common sequences so the live preview reads
 * as prose rather than escaped JSON. Returns "" when the field/value has not started yet.
 */
export function extractProseField(accumulated: string, field: string): string {
  if (!accumulated) return "";
  const keyRe = new RegExp(`"${field}"\\s*:\\s*"`);
  const m = keyRe.exec(accumulated);
  if (!m) return "";
  const start = m.index + m[0].length;
  let out = "";
  let escaped = false;
  for (let i = start; i < accumulated.length; i++) {
    const ch = accumulated[i];
    if (escaped) {
      // Unescape the sequences a JSON string can contain.
      if (ch === "n") out += "\n";
      else if (ch === "t") out += "\t";
      else if (ch === "r") out += "";
      else if (ch === "u") {
        const hex = accumulated.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; }
      } else out += ch; // \" \\ \/ etc.
      escaped = false;
      continue;
    }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') break; // end of the value
    out += ch;
  }
  return out;
}
