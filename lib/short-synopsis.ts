/**
 * Stage 46A — SHORT synopsis step between the idea and the season script.
 *
 * After the idea is submitted the app no longer chains straight into the season structure. Instead a
 * fast model writes a SHORT synopsis (season premise, 3–5 sentences + ONE-line logline per episode) that
 * the author approves («Одобрить и написать сценарий») or sends back with a comment («Переделать»).
 * The approved text is stored in Project.shortSynopsis and passed into the season-structure prompt as
 * a MANDATORY outline, so the long script follows the loglines the author signed off on.
 */
import { z } from "zod";
import { LANGUAGE_NAMES, type IdeaLanguage, type CharacterCard } from "@/lib/idea";
import { PACING_RULE, SEASON_MIN_EPISODES, SEASON_MAX_EPISODES } from "@/lib/season";

export const shortSynopsisSchema = z.object({
  premise: z.string().min(20),
  episodes: z
    .array(z.object({ number: z.number().int().min(1), logline: z.string().min(10) }))
    .min(1),
});
export type ShortSynopsis = z.infer<typeof shortSynopsisSchema>;

/** Clamp the requested episode count to the product limits (same as the season route). */
export function clampEpisodeCount(n: unknown, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.min(SEASON_MAX_EPISODES, Math.max(SEASON_MIN_EPISODES, v));
}

export function shortSynopsisSystemPrompt(language: IdeaLanguage, episodeCount: number): string {
  const lang = LANGUAGE_NAMES[language] ?? "the story language";
  return `You are a showrunner pitching a vertical short-form drama series. Write a SHORT synopsis of the whole season.
Return ONLY JSON: {"premise": string, "episodes": [{"number": 1, "logline": string}, ...]}.
Rules:
- "premise": the season premise in 3–5 sentences — who the protagonist is, what they want, what stands in the way, what is at stake and the emotional core. Concrete, no marketing fluff.
- "episodes": EXACTLY ${episodeCount} entries, numbered 1..${episodeCount} in order. Each "logline" is ONE sentence (max ~30 words) naming the concrete dramatic event of that episode and how it pushes the story forward; the last episode resolves the season arc (a hook for a next season is allowed).
- Continuous story: every episode follows from the previous one, no repetition, no summaries like "tension rises".
- ${PACING_RULE}
- Use only the characters from the input (names verbatim); do not invent new leads.
- Original content — never reuse names, plots or lines of existing films/series. Keep it safe for a general audience (no explicit sex, no graphic gore, no hate).
- All text in ${lang}.`;
}

export function shortSynopsisUserPrompt(opts: { idea: string; synopsis: string; characters: CharacterCard[]; episodeCount: number; previous?: ShortSynopsis | null; comment?: string }): string {
  const cast = opts.characters.length
    ? opts.characters.map((c) => `- ${c.name} (${c.tier ?? "MAIN"}) — ${c.role}`).join("\n")
    : "(no cast defined yet)";
  const base = `IDEA:\n${opts.idea}\n\nLONG SYNOPSIS (background, keep the story consistent with it):\n${opts.synopsis}\n\nCHARACTERS:\n${cast}\n\nEPISODES IN THE SEASON: ${opts.episodeCount}`;
  if (opts.previous && opts.comment?.trim()) {
    return `${base}\n\nPREVIOUS SHORT SYNOPSIS (to be reworked):\n${renderShortSynopsis(opts.previous)}\n\nAUTHOR'S FEEDBACK — rewrite the short synopsis so that it follows this feedback, keep what still works:\n${opts.comment.trim()}`;
  }
  if (opts.previous) return `${base}\n\nPREVIOUS SHORT SYNOPSIS (the author asked for a DIFFERENT take — propose a noticeably different version):\n${renderShortSynopsis(opts.previous)}`;
  return base;
}

/** Normalise the model output: keep exactly `episodeCount` loglines, renumber 1..N. */
export function normalizeShortSynopsis(raw: unknown, episodeCount: number): ShortSynopsis {
  const parsed = shortSynopsisSchema.parse(raw);
  const eps = parsed.episodes.slice(0, episodeCount).map((e, i) => ({ number: i + 1, logline: e.logline.trim() }));
  if (eps.length < episodeCount) throw new Error(`Short synopsis has ${eps.length} episodes, expected ${episodeCount}`);
  return { premise: parsed.premise.trim(), episodes: eps };
}

/** Plain-text rendering used for storage-independent display and for the season-structure prompt. */
export function renderShortSynopsis(s: ShortSynopsis): string {
  return `${s.premise}\n\n${s.episodes.map((e) => `${e.number}. ${e.logline}`).join("\n")}`;
}

/** Project.shortSynopsis is stored as JSON; tolerate legacy/plain text. */
export function parseStoredShortSynopsis(value: string | null | undefined): ShortSynopsis | null {
  if (!value) return null;
  try {
    const r = shortSynopsisSchema.safeParse(JSON.parse(value));
    if (r.success) return r.data;
  } catch { /* plain text */ }
  return null;
}
