/**
 * Stage 107b — make episode-footage validation CONVERGE instead of failing the job.
 *
 * The LLM overshoots the 20/14/50 caps (or slips a quoted line in) on 1–3 episodes out of 8; one failed retry
 * used to kill the whole plot rewrite. Now: (1) targeted REPAIR passes — a small JSON call that rewrites ONLY
 * the failing episodes; (2) a deterministic HARD CLAMP that always yields a description passing
 * validateEpisodeDescriptions; (3) the OPENS ON of episode N+1 is re-synced whenever N's CLIFFHANGER changes.
 */
import {
  validateEpisodeDescriptions,
  parseEpisodeFootage,
  countWords,
  EPISODE_FOOTAGE_RULE,
  EPISODE_FOOTAGE_MAX_WORDS,
  FOOTAGE_SHOT_MAX_WORDS,
  FOOTAGE_CLIFFHANGER_MAX_WORDS,
  SHOT1_LABEL,
  SHOT2_LABEL,
  CLIFFHANGER_LABEL,
  OPENS_ON_LABEL,
} from "./season";
import type { IdeaLanguage } from "./idea";

export type RepairableEpisode = { number: number; title?: string; description?: string | null; cliffhanger?: string | null };
/** Minimal JSON LLM: (system, user) → parsed JSON. Injected so tests can fake it. */
export type RepairLLM = (system: string, user: string) => Promise<unknown>;
export type RepairResult<T extends RepairableEpisode> = { episodes: T[]; repaired: number[]; clamped: number[] };

export const REPAIR_MAX_PASSES = 3;

/** Group the validator's problem strings by episode number ("episode 3: ..."). */
export function groupProblems(problems: string[]): Map<number, string[]> {
  const map = new Map<number, string[]>();
  for (const p of problems) {
    const m = /^episode (\d+):\s*(.*)$/.exec(p);
    if (!m) continue;
    const n = Number(m[1]);
    map.set(n, [...(map.get(n) ?? []), m[2]]);
  }
  return map;
}

export function footageRepairSystemPrompt(language: IdeaLanguage): string {
  return `You fix episode "description" lines that failed a strict format check. Rewrite ONLY the episodes you are given, keep their story beats and the same characters, CUT WORDS — add no new content, no new events. Text after each label in the story language (${language}); labels in English verbatim.
${EPISODE_FOOTAGE_RULE}
For every episode after the first, SHOT 1 MUST begin with "${OPENS_ON_LABEL} <the given previous cliffhanger, verbatim>" (that repetition is not counted in the caps).
Return ONLY JSON: {"episodes":[{"number":<int>,"description":"<${SHOT1_LABEL} ...\\n${SHOT2_LABEL} ...\\n${CLIFFHANGER_LABEL} ...>"}]}.`;
}

export function footageRepairUserPrompt(items: { number: number; title?: string; description: string; previousCliffhanger: string | null; problems: string[] }[]): string {
  return items.map((it) => [
    `EPISODE ${it.number}${it.title ? ` "${it.title}"` : ""}`,
    it.previousCliffhanger ? `Previous episode's CLIFFHANGER (SHOT 1 must open on it): ${it.previousCliffhanger}` : `(first episode — no OPENS ON)`,
    `Current description:\n${it.description}`,
    `Problems: ${it.problems.join("; ")}`,
  ].join("\n")).join("\n\n");
}

/* ───────────── deterministic clamp ───────────── */

const QUOTE_SEGMENT_RE = /(:)?\s*[«“”"][^«»“”"\n]*[»”“"]/g;

/** Remove quoted segments and the punctuation debris they leave behind. */
export function stripQuotes(text: string): string {
  return text
    // `He says: "Stay."` → `He says.` (the introducing colon closes the sentence); bare quotes vanish.
    .replace(QUOTE_SEGMENT_RE, (_m, colon: string | undefined) => (colon ? "." : ""))
    .replace(/\.\s*([.!?])/g, "$1")
    .replace(/[«»“”"]/g, "")
    .replace(/\s+([,;:.!?])/g, "$1")
    .replace(/([,;:])\s*([,;:])+/g, "$1")
    .replace(/[,;:]\s*([.!?])/g, "$1")
    .replace(/^[\s,;:.!?—–-]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Split into sentences (same terminator rule as countSentences). */
export function splitSentences(text: string): string[] {
  return text.trim().split(/(?<=[.!?…]["»”')]*)\s+(?=\p{Lu})/u).map((s) => s.trim()).filter(Boolean);
}

function endWithPeriod(s: string): string {
  const t = s.trim().replace(/[,;:—–-]+$/, "").trim();
  if (!t) return t;
  return /[.!?…]["»”')]*$/.test(t) ? t : `${t}.`;
}

/** Cut a line to ≤ maxWords / ≤ maxSentences: whole sentences first, then a hard word cut. Never empty when the input isn't. */
export function clampLine(text: string, maxWords: number, maxSentences: number): string {
  const clean = stripQuotes(text);
  const sentences = splitSentences(clean);
  if (!sentences.length) return "";
  const kept: string[] = [];
  for (const s of sentences) {
    if (kept.length >= maxSentences) break;
    if (countWords([...kept, s].join(" ")) > maxWords) break;
    kept.push(s);
  }
  if (kept.length) return endWithPeriod(kept.join(" "));
  // The first sentence alone is over the cap → hard cut at the word boundary.
  const words = sentences[0].split(/\s+/).slice(0, maxWords);
  return endWithPeriod(words.join(" "));
}

function assemble(shot1Body: string, shot2: string, cliffhanger: string, opensOn: string | null): string {
  const s1 = opensOn ? `${OPENS_ON_LABEL} ${opensOn} ${shot1Body}`.trim() : shot1Body;
  return `${SHOT1_LABEL} ${s1}\n${SHOT2_LABEL} ${shot2}\n${CLIFFHANGER_LABEL} ${cliffhanger}`;
}

/** Body of SHOT 1 without the OPENS ON repetition (the known previous cliffhanger wins over the parsed guess). */
function shot1BodyOf(f: { shot1: string; opensOn?: string }, knownOpensOn?: string | null): string {
  const own = f.shot1.replace(/^\s*opens\s+on\s*:\s*/i, "").trim();
  if (knownOpensOn && own.startsWith(knownOpensOn)) return own.slice(knownOpensOn.length).trim();
  if (f.opensOn && own.includes(f.opensOn)) return own.slice(own.indexOf(f.opensOn) + f.opensOn.length).trim();
  return own;
}

/**
 * Deterministic clamp of ONE description so it passes every per-line rule (quotes, sentences, 20/14/50 caps).
 * `previousCliffhanger` (episode ≥ 2) is written verbatim as the OPENS ON repetition.
 */
export function clampDescription(description: string, previousCliffhanger: string | null, oldOpensOn?: string | null): string {
  const f = parseEpisodeFootage(description);
  let shot1: string, shot2: string, cliff: string;
  if (f) {
    shot1 = shot1BodyOf(f, oldOpensOn); shot2 = f.shot2; cliff = f.cliffhanger;
  } else {
    // Not even the 3-line format: spread the sentences over the three lines.
    const sentences = splitSentences(stripQuotes(description));
    shot1 = sentences[0] ?? "The scene opens."; shot2 = sentences[1] ?? sentences[0] ?? "The action escalates."; cliff = sentences[sentences.length - 1] ?? "The frame holds on the final image.";
  }
  shot1 = clampLine(shot1, FOOTAGE_SHOT_MAX_WORDS, 2) || "The camera holds on the group.";
  shot2 = clampLine(shot2, FOOTAGE_SHOT_MAX_WORDS, 2) || "The action escalates.";
  cliff = clampLine(cliff, FOOTAGE_CLIFFHANGER_MAX_WORDS, 1) || "The frame freezes on the final image.";
  // Total budget: trim the shot lines last-sentence-first, then hard-cut words.
  const total = () => countWords(shot1) + countWords(shot2) + countWords(cliff);
  let guard = 0;
  while (total() > EPISODE_FOOTAGE_MAX_WORDS && guard++ < 20) {
    const target = countWords(shot2) >= countWords(shot1) ? "shot2" : "shot1";
    const cur = target === "shot2" ? shot2 : shot1;
    const sentences = splitSentences(cur);
    const next = sentences.length > 1 ? endWithPeriod(sentences.slice(0, -1).join(" ")) : endWithPeriod(cur.split(/\s+/).slice(0, Math.max(3, countWords(cur) - (total() - EPISODE_FOOTAGE_MAX_WORDS))).join(" "));
    if (target === "shot2") shot2 = next; else shot1 = next;
  }
  return assemble(shot1, shot2, cliff, previousCliffhanger);
}

/** Replace (or insert) the OPENS ON repetition in SHOT 1 of `description` with `cliffhanger`. */
export function resyncOpensOn(description: string, cliffhanger: string, oldOpensOn?: string | null): string {
  const f = parseEpisodeFootage(description);
  if (!f) return description;
  return assemble(shot1BodyOf(f, oldOpensOn), f.shot2, f.cliffhanger, cliffhanger);
}

const cliffOf = (d: string | null | undefined) => parseEpisodeFootage(d)?.cliffhanger ?? null;

/** After descriptions changed: every episode ≥ 2 opens on the (new) cliffhanger of the previous one; the `cliffhanger` field mirrors the CLIFFHANGER line. */
function syncChain<T extends RepairableEpisode>(episodes: T[], previousCliffs?: Map<number, string | null>): T[] {
  const sorted = [...episodes].sort((a, b) => a.number - b.number);
  return sorted.map((e, i) => {
    let description = e.description ?? "";
    const prevCliff = i > 0 ? cliffOf(sorted[i - 1].description) : null;
    const f = parseEpisodeFootage(description);
    if (f && prevCliff && (f.opensOn ?? "") !== prevCliff) description = resyncOpensOn(description, prevCliff, previousCliffs?.get(e.number - 1) ?? null);
    const cliff = cliffOf(description);
    return { ...e, description, ...(cliff && e.cliffhanger !== undefined ? { cliffhanger: cliff } : {}) };
  });
}

/**
 * Validate → up to REPAIR_MAX_PASSES targeted LLM passes on the failing episodes only → deterministic clamp.
 * NEVER throws on validation problems; the returned episodes always pass validateEpisodeDescriptions.
 */
export async function repairEpisodeDescriptions<T extends RepairableEpisode>(
  input: T[],
  language: IdeaLanguage,
  llm: RepairLLM,
  opts?: { maxPasses?: number; log?: (msg: string) => void },
): Promise<RepairResult<T>> {
  const log = opts?.log ?? ((m: string) => console.warn(m));
  const maxPasses = opts?.maxPasses ?? REPAIR_MAX_PASSES;
  let episodes = [...input].sort((a, b) => a.number - b.number);
  const repaired = new Set<number>();
  const clamped = new Set<number>();

  let problems = validateEpisodeDescriptions(episodes);
  if (!problems.length) return { episodes, repaired: [], clamped: [] };

  for (let pass = 0; pass < maxPasses && problems.length; pass++) {
    const grouped = groupProblems(problems);
    const items = [...grouped.entries()].map(([n, probs]) => {
      const e = episodes.find((x) => x.number === n)!;
      const prev = episodes.find((x) => x.number === n - 1);
      return { number: n, title: e.title, description: e.description ?? "", previousCliffhanger: prev ? cliffOf(prev.description) ?? prev.cliffhanger ?? null : null, problems: probs };
    });
    const oldCliffs = new Map(episodes.map((e) => [e.number, cliffOf(e.description)]));
    log(`[footage-repair] pass ${pass + 1}: repairing episodes ${items.map((i) => i.number).join(", ")}`);
    let fixes: { number: number; description: string }[] = [];
    try {
      const raw = (await llm(footageRepairSystemPrompt(language), footageRepairUserPrompt(items))) as { episodes?: unknown };
      fixes = Array.isArray(raw?.episodes)
        ? (raw.episodes as unknown[]).filter((x): x is { number: number; description: string } => !!x && typeof (x as any).number === "number" && typeof (x as any).description === "string" && (x as any).description.trim().length > 0)
        : [];
    } catch (err) {
      log(`[footage-repair] pass ${pass + 1} LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const failing = new Set(items.map((i) => i.number));
    episodes = episodes.map((e) => {
      const fix = fixes.find((f) => f.number === e.number);
      if (!fix || !failing.has(e.number)) return e;
      repaired.add(e.number);
      return { ...e, description: fix.description.replace(/\*\*/g, "").trim() };
    });
    episodes = syncChain(episodes, oldCliffs);
    problems = validateEpisodeDescriptions(episodes);
  }

  if (problems.length) {
    // Deterministic clamp — one round per still-failing set. A clamp of episode N shortens N's cliffhanger, which
    // (after the chain re-sync) may surface a new OPENS ON mismatch downstream, hence the bounded loop.
    let guard = 0;
    while (problems.length && guard++ < episodes.length + 2) {
      const oldCliffs = new Map(episodes.map((e) => [e.number, cliffOf(e.description)]));
      for (const n of groupProblems(problems).keys()) {
        const idx = episodes.findIndex((e) => e.number === n);
        if (idx < 0) continue;
        const prevCliff = idx > 0 ? cliffOf(episodes[idx - 1].description) : null;
        episodes[idx] = { ...episodes[idx], description: clampDescription(episodes[idx].description ?? "", prevCliff, oldCliffs.get(n - 1) ?? null) };
        clamped.add(n);
      }
      episodes = syncChain(episodes, oldCliffs);
      problems = validateEpisodeDescriptions(episodes);
    }
    log(`[footage-repair] clamped episodes ${[...clamped].sort((a, b) => a - b).join(", ")} deterministically${problems.length ? ` — STILL INVALID: ${problems.join("; ")}` : ""}`);
  }

  return { episodes, repaired: [...repaired].sort((a, b) => a - b), clamped: [...clamped].sort((a, b) => a - b) };
}
