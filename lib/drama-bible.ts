/**
 * Stage 1 (task Stage 1: dramaBible) — STORY BIBLE zod schema, validators, generate→validate→retry loop,
 * and the bible→prose-synopsis derivation.
 *
 * A PURE, offline-testable module: the zod schema for the bible shape, field-named validators (count ranges,
 * secret.revealEpisode within the episode count, required non-empty fields), a tolerant normalizer that never
 * throws, a mapper that projects the bible into the slice the season map reads, and a two-step orchestrator
 * that generates the bible FIRST and then derives the prose synopsis FROM it. It reads the shape/bounds/prompts
 * from lib/prompts/drama-bible (a leaf that imports nothing back), and it takes the LLM call as an INJECTED
 * function so it never imports lib/ai — the worker wires chatJSON/chat + SCRIPT_MODEL in, the tests wire a
 * pure fake in.
 */

import { z } from "zod";
import {
  GENRE_TROPES_MIN,
  GENRE_TROPES_MAX,
  ESCALATION_LADDER_MIN,
  ESCALATION_LADDER_MAX,
  SECRETS_MIN,
  SECRETS_MAX,
  DRAMA_BIBLE_SYSTEM,
  SYNOPSIS_FROM_BIBLE_SYSTEM,
  dramaBibleUserPrompt,
  dramaBibleRetryNote,
  synopsisFromBibleUserPrompt,
  type DramaBible,
} from "@/lib/prompts/drama-bible";
import type { DramaBibleForMap } from "@/lib/prompts/season-map";

export type { DramaBible } from "@/lib/prompts/drama-bible";

/* ───────────────────────── zod schema (bible shape) ───────────────────────── */

const nonEmpty = z.string().trim().min(1);

export const dramaBibleSchema: z.ZodType<DramaBible> = z.object({
  theme: nonEmpty,
  genreTropes: z.array(nonEmpty).min(GENRE_TROPES_MIN).max(GENRE_TROPES_MAX),
  protagonist: z.object({
    want: nonEmpty,
    need: nonEmpty,
    flaw: nonEmpty,
    arcStart: nonEmpty,
    arcEnd: nonEmpty,
  }),
  antagonist: z.object({
    goal: nonEmpty,
    pressureMechanism: nonEmpty,
    escalationLadder: z.array(nonEmpty).min(ESCALATION_LADDER_MIN).max(ESCALATION_LADDER_MAX),
  }),
  secrets: z
    .array(
      z.object({
        secret: nonEmpty,
        knownBy: z.array(nonEmpty).min(1),
        revealEpisode: z.number().int().min(1),
      })
    )
    .min(SECRETS_MIN)
    .max(SECRETS_MAX),
  midpointReversal: nonEmpty,
  finaleQuestion: nonEmpty,
  bLine: z.object({
    conflict: nonEmpty,
    characters: z.array(nonEmpty).min(1),
  }),
  relationships: z
    .array(
      z.object({
        a: nonEmpty,
        b: nonEmpty,
        dynamic: nonEmpty,
        tension: nonEmpty,
      })
    )
    .min(1),
});

/* ───────────────────────── error shape ───────────────────────── */

export interface DramaBibleError {
  /** Dotted field path the error concerns (e.g. "genreTropes", "secrets[1].revealEpisode"). */
  field: string;
  message: string;
}

/* ───────────────────────── individual validators (pure, field-named) ───────────────────────── */

/** The whole bible matches the zod shape (all required fields present + non-empty, counts within range). */
export function validateBibleShape(bible: unknown): DramaBibleError[] {
  const res = dramaBibleSchema.safeParse(bible);
  if (res.success) return [];
  return res.error.issues.map((issue) => ({
    field: issue.path.length ? issue.path.join(".") : "bible",
    message: issue.message,
  }));
}

/** genreTropes / escalationLadder / secrets counts are within their documented ranges (field-named). */
export function validateBibleCounts(bible: DramaBible): DramaBibleError[] {
  const errors: DramaBibleError[] = [];
  const tropes = (bible.genreTropes ?? []).filter(Boolean);
  if (tropes.length < GENRE_TROPES_MIN || tropes.length > GENRE_TROPES_MAX) {
    errors.push({ field: "genreTropes", message: `genreTropes must have ${GENRE_TROPES_MIN}-${GENRE_TROPES_MAX} items; got ${tropes.length}.` });
  }
  const ladder = (bible.antagonist?.escalationLadder ?? []).filter(Boolean);
  if (ladder.length < ESCALATION_LADDER_MIN || ladder.length > ESCALATION_LADDER_MAX) {
    errors.push({ field: "antagonist.escalationLadder", message: `escalationLadder must have ${ESCALATION_LADDER_MIN}-${ESCALATION_LADDER_MAX} steps; got ${ladder.length}.` });
  }
  const secrets = (bible.secrets ?? []).filter((s) => s && s.secret);
  if (secrets.length < SECRETS_MIN || secrets.length > SECRETS_MAX) {
    errors.push({ field: "secrets", message: `secrets must have ${SECRETS_MIN}-${SECRETS_MAX} items; got ${secrets.length}.` });
  }
  return errors;
}

/**
 * Every secret's revealEpisode is a valid 1-based episode within the season. When `episodeCount` is known,
 * revealEpisode must be <= episodeCount; always must be >= 1. Field-named per offending secret.
 */
export function validateSecretReveals(bible: DramaBible, episodeCount?: number | null): DramaBibleError[] {
  const errors: DramaBibleError[] = [];
  const n = typeof episodeCount === "number" && episodeCount > 0 ? episodeCount : null;
  (bible.secrets ?? []).forEach((s, i) => {
    const ep = s?.revealEpisode;
    if (typeof ep !== "number" || !Number.isInteger(ep) || ep < 1) {
      errors.push({ field: `secrets[${i}].revealEpisode`, message: `revealEpisode must be an integer >= 1; got ${ep}.` });
      return;
    }
    if (n !== null && ep > n) {
      errors.push({ field: `secrets[${i}].revealEpisode`, message: `revealEpisode ${ep} is beyond the season's ${n} episodes.` });
    }
  });
  return errors;
}

/** Required scalar text fields are present and non-empty (field-named). */
export function validateBibleRequired(bible: DramaBible): DramaBibleError[] {
  const errors: DramaBibleError[] = [];
  const check = (v: unknown, field: string) => {
    if (typeof v !== "string" || !v.trim()) errors.push({ field, message: `${field} is required and must be non-empty.` });
  };
  check(bible.theme, "theme");
  check(bible.midpointReversal, "midpointReversal");
  check(bible.finaleQuestion, "finaleQuestion");
  check(bible.protagonist?.want, "protagonist.want");
  check(bible.protagonist?.need, "protagonist.need");
  check(bible.protagonist?.flaw, "protagonist.flaw");
  check(bible.protagonist?.arcStart, "protagonist.arcStart");
  check(bible.protagonist?.arcEnd, "protagonist.arcEnd");
  check(bible.antagonist?.goal, "antagonist.goal");
  check(bible.antagonist?.pressureMechanism, "antagonist.pressureMechanism");
  check(bible.bLine?.conflict, "bLine.conflict");
  if (!(bible.bLine?.characters ?? []).filter(Boolean).length) errors.push({ field: "bLine.characters", message: "bLine.characters must list at least one character." });
  if (!(bible.relationships ?? []).filter((r) => r && r.a && r.b).length) errors.push({ field: "relationships", message: "relationships must list at least one relationship." });
  return errors;
}

/* ───────────────────────── aggregate validator ───────────────────────── */

export interface DramaBibleValidation {
  ok: boolean;
  errors: DramaBibleError[];
}

/**
 * Run every rule. Order matters for the targeted retry: the shape check first (it catches most malformations),
 * then the count / secret-schedule / required-field checks; the retry note names the FIRST failing field.
 */
export function validateDramaBible(bible: DramaBible, opts: { episodeCount?: number | null } = {}): DramaBibleValidation {
  const errors: DramaBibleError[] = [
    ...validateBibleShape(bible),
    ...validateBibleCounts(bible),
    ...validateSecretReveals(bible, opts.episodeCount),
    ...validateBibleRequired(bible),
  ];
  return { ok: errors.length === 0, errors };
}

/* ───────────────────────── defensive normalization ───────────────────────── */

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "string" ? x.trim() : String(x ?? "").trim())).filter(Boolean);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Coerce arbitrary LLM output into a well-shaped DramaBible. Accepts either a bare bible object or a
 * { dramaBible: {...} } / { bible: {...} } wrapper. NEVER throws — worst case it returns a fully-defaulted
 * (empty-ish) bible which the validators will then flag, driving a targeted retry / advisory persist.
 */
export function normalizeDramaBible(raw: unknown): DramaBible {
  let src: Record<string, unknown> = {};
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (obj.dramaBible && typeof obj.dramaBible === "object") src = obj.dramaBible as Record<string, unknown>;
    else if (obj.bible && typeof obj.bible === "object") src = obj.bible as Record<string, unknown>;
    else src = obj;
  }
  const p = (src.protagonist ?? {}) as Record<string, unknown>;
  const a = (src.antagonist ?? {}) as Record<string, unknown>;
  const b = (src.bLine ?? {}) as Record<string, unknown>;
  const secretsRaw = Array.isArray(src.secrets) ? (src.secrets as unknown[]) : [];
  const relsRaw = Array.isArray(src.relationships) ? (src.relationships as unknown[]) : [];
  return {
    theme: str(src.theme),
    genreTropes: toStringArray(src.genreTropes),
    protagonist: {
      want: str(p.want),
      need: str(p.need),
      flaw: str(p.flaw),
      arcStart: str(p.arcStart),
      arcEnd: str(p.arcEnd),
    },
    antagonist: {
      goal: str(a.goal),
      pressureMechanism: str(a.pressureMechanism),
      escalationLadder: toStringArray(a.escalationLadder),
    },
    secrets: secretsRaw.map((s) => {
      const so = (s ?? {}) as Record<string, unknown>;
      const ep = typeof so.revealEpisode === "number" && Number.isFinite(so.revealEpisode) ? Math.floor(so.revealEpisode) : NaN;
      return {
        secret: str(so.secret),
        knownBy: toStringArray(so.knownBy),
        revealEpisode: Number.isFinite(ep) && ep >= 1 ? ep : 1,
      };
    }),
    midpointReversal: str(src.midpointReversal),
    finaleQuestion: str(src.finaleQuestion),
    bLine: {
      conflict: str(b.conflict),
      characters: toStringArray(b.characters),
    },
    relationships: relsRaw.map((r) => {
      const ro = (r ?? {}) as Record<string, unknown>;
      return { a: str(ro.a), b: str(ro.b), dynamic: str(ro.dynamic), tension: str(ro.tension) };
    }),
  };
}

/* ───────────────────────── mapper into the season-map slice ───────────────────────── */

/**
 * Project the bible into the slice the season map reads (lib/prompts/season-map DramaBibleForMap). Each
 * secret's own text is its stable id; the finale secret is the one whose revealEpisode is the latest (it
 * answers the finaleQuestion). Returns null for an absent bible so the season map falls back structurally.
 */
export function toDramaBibleForMap(bible?: DramaBible | null): DramaBibleForMap | null {
  if (!bible) return null;
  const escalationLadder = (bible.antagonist?.escalationLadder ?? []).filter(Boolean);
  const secrets = (bible.secrets ?? [])
    .filter((s) => s && s.secret)
    .map((s) => ({ id: s.secret, revealEpisode: s.revealEpisode }));
  const finaleQuestion = str(bible.finaleQuestion) || null;
  // The finale-answering secret = the one revealed latest (defensive: the last by revealEpisode).
  let finaleSecretId: string | null = null;
  if (finaleQuestion && secrets.length) {
    finaleSecretId = secrets.reduce((best, s) => (s.revealEpisode >= best.revealEpisode ? s : best), secrets[0]).id;
  }
  return {
    escalationLadder: escalationLadder.length ? escalationLadder : null,
    secrets: secrets.length ? secrets : null,
    finaleQuestion,
    finaleSecretId,
  };
}

/* ───────────────────────── generate → validate → targeted retry ───────────────────────── */

/** The injected JSON LLM call — same shape as lib/ai `chatJSON` but supplied by the caller (worker / test). */
export type DramaBibleChatFn = (
  system: string,
  user: string,
  opts?: { model?: string; maxTokens?: number; temperature?: number }
) => Promise<unknown>;

/** The injected prose LLM call — same shape as lib/ai `chat` but supplied by the caller (worker / test). */
export type DramaBibleProseFn = (
  system: string,
  user: string,
  opts?: { model?: string; maxTokens?: number; temperature?: number }
) => Promise<string>;

export interface GenerateDramaBibleInput {
  idea?: string | null;
  genres?: string[] | null;
  episodeCount?: number | null;
}

export interface GenerateDramaBibleResult {
  bible: DramaBible;
  valid: boolean;
  errors: DramaBibleError[];
  attempts: number;
}

/**
 * Generate a validated story bible: build the prompt, call the injected chat fn, normalize + validate; on
 * failure append a targeted retry note naming the first failing field and try again (up to maxRetries+1 total
 * attempts). NEVER throws — after exhausting retries it returns the best-effort normalized bible with
 * valid:false so the caller can persist it as advisory (or skip persisting) and log the outstanding fields.
 */
export async function generateDramaBible(
  input: GenerateDramaBibleInput,
  chatFn: DramaBibleChatFn,
  opts: { model?: string; maxRetries?: number } = {}
): Promise<GenerateDramaBibleResult> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseUser = dramaBibleUserPrompt({ idea: input.idea, genres: input.genres, episodeCount: input.episodeCount });

  let lastResult: GenerateDramaBibleResult = { bible: normalizeDramaBible(null), valid: false, errors: [], attempts: 0 };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const user = attempt === 0 ? baseUser : `${baseUser}\n\n${dramaBibleRetryNote(lastResult.errors[0]?.field ?? "shape")}`;
    let raw: unknown = null;
    try {
      raw = await chatFn(DRAMA_BIBLE_SYSTEM, user, { model: opts.model });
    } catch {
      // Treat an LLM/transport failure like empty output — normalize to a defaulted bible and keep looping.
      raw = null;
    }
    const bible = normalizeDramaBible(raw);
    const validation = validateDramaBible(bible, { episodeCount: input.episodeCount });
    lastResult = { bible, valid: validation.ok, errors: validation.errors, attempts: attempt + 1 };
    if (validation.ok) return lastResult;
  }
  return lastResult;
}

/**
 * Derive the prose synopsis FROM a bible (the SECOND step of the flow). Calls the injected prose fn with the
 * bible rendered into the user prompt. Returns the trimmed synopsis text; NEVER throws — on a transport
 * failure it returns "" so the caller can fall back to its existing synopsis generation.
 */
export async function synopsisFromBible(
  bible: DramaBible,
  proseFn: DramaBibleProseFn,
  opts: { model?: string } = {}
): Promise<string> {
  try {
    const text = await proseFn(SYNOPSIS_FROM_BIBLE_SYSTEM, synopsisFromBibleUserPrompt(bible), { model: opts.model });
    return (text ?? "").trim();
  } catch {
    return "";
  }
}

export interface BibleThenSynopsisResult {
  bible: DramaBible;
  bibleValid: boolean;
  errors: DramaBibleError[];
  attempts: number;
  synopsis: string;
}

/**
 * The full ordered flow: generate + validate the bible FIRST, THEN derive the prose synopsis FROM it. This is
 * the pure orchestrator the worker uses and the tests assert ordering on (the bible system prompt fires before
 * the synopsis system prompt). NEVER throws.
 */
export async function generateBibleThenSynopsis(
  input: GenerateDramaBibleInput,
  chatFn: DramaBibleChatFn,
  proseFn: DramaBibleProseFn,
  opts: { model?: string; maxRetries?: number } = {}
): Promise<BibleThenSynopsisResult> {
  const gen = await generateDramaBible(input, chatFn, { model: opts.model, maxRetries: opts.maxRetries });
  const synopsis = await synopsisFromBible(gen.bible, proseFn, { model: opts.model });
  return { bible: gen.bible, bibleValid: gen.valid, errors: gen.errors, attempts: gen.attempts, synopsis };
}
