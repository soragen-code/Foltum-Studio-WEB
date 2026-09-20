/**
 * Stage 7 (task Stage 7 — critic-driven generation) — a reusable RUBRIC CRITIC framework.
 *
 * The old generation flow leaned on a repair / clamp / retry-note cascade: generate once, then patch the
 * output when it failed a check. Stage 7 replaces that with a critic-driven loop:
 *
 *   - SYNOPSIS / SEASON MAP: generate 3 PARALLEL variants at temperature 0.9 → critique each on a rubric →
 *     pick the best → attach the best variant's notes with an "improve" action → ONE targeted-improve pass.
 *   - EPISODE SCRIPT: generate 2 variants → critique → pick best → dialoguePolish → continuity check;
 *     a generate → critique → targeted-fix loop of at most 3 iterations (stop on "accept" or after 3).
 *
 * This module owns the PURE, unit-testable core (rubric shape, response parsing with defensive fallback,
 * score aggregation that treats continuityRisk as a RISK, best-variant selection, fix-instruction assembly,
 * and GenerationLog record shaping) plus thin LLM-calling wrappers that isolate the network behind an
 * INJECTABLE client so tests pass a stub and NEVER hit the network.
 *
 * All prompts / comments are English. No network is performed by the pure helpers.
 */

/** Bumped whenever the rubric axes / critic prompt contract changes; stored on GenerationLog.promptVersion. */
export const CRITIC_PROMPT_VERSION = "7.0.0";

/* ───────────────────────── rubric ───────────────────────── */

/**
 * The rubric axes (Stage P6). These score VERIFIABLE craft qualities, NOT subjective "interestingness":
 * the critic no longer gates on hook/trope/cliffhanger appeal. All are scored 1–10; every axis EXCEPT
 * `continuityRisk` is "higher is better". `continuityRisk` is a RISK (a HIGH score = HIGH risk of a
 * continuity break), so it is INVERTED when folded into the overall score (see aggregateScore).
 *
 * The axis SCORES are ADVISORY (they rank variants and feed the log); the ACCEPT / IMPROVE gate is driven
 * by the concrete blocking DEFECTS below, never by a subjective engagement threshold.
 */
export const RUBRIC_AXES = [
  "causalLogic",
  "clarity",
  "stagingConcreteness",
  "dialoguePurity",
  "characterDistinctness",
  "continuityRisk",
] as const;

export type RubricAxis = (typeof RUBRIC_AXES)[number];

/** The single axis that is a RISK (lower is better) rather than a quality (higher is better). */
export const RISK_AXES: ReadonlySet<RubricAxis> = new Set<RubricAxis>(["continuityRisk"]);

export type RubricScores = Record<RubricAxis, number>;

export type CriticAction = "improve" | "accept";

/** Severity of a concrete defect: a `blocking` defect must be fixed to accept; `advisory` is optional. */
export type DefectSeverity = "blocking" | "advisory";

/**
 * ONE concrete, verifiable defect: the offending FRAGMENT, WHY it is wrong, and an actionable FIX.
 * This is what the critic emits instead of a bare score — the fix instruction is built directly from these.
 */
export interface CriticDefect {
  /** The exact fragment / element of the candidate the defect refers to (quoted, short). */
  fragment: string;
  /** Why it is a defect — the concrete rule or logic it breaks. */
  reason: string;
  /** A concrete, actionable fix. */
  fix: string;
  severity: DefectSeverity;
}

export interface Critique {
  scores: RubricScores;
  /** 0–10 aggregate (risk axes inverted). Higher is better. ADVISORY — used to rank variants, not to gate. */
  overall: number;
  /** Up to 3 short, actionable notes (kept for backward compatibility; derived from defects when absent). */
  notes: string[];
  /** Concrete verifiable defects (fragment + reason + fix), split into blocking vs advisory by severity. */
  defects: CriticDefect[];
  action: CriticAction;
}

/** True when the critique carries at least one BLOCKING defect (the accept/improve gate). Pure. */
export function hasBlockingDefect(defects: CriticDefect[] | undefined | null): boolean {
  return Array.isArray(defects) && defects.some((d) => d && d.severity === "blocking");
}

/** The score assigned to a missing / unparseable axis — a cautious mid value. */
export const DEFAULT_AXIS_SCORE = 5;

/** overall ≥ this (out of 10) means the candidate is good enough to accept without another pass. */
export const ACCEPT_THRESHOLD = 7.5;

const clampScore = (n: unknown): number => {
  const v = typeof n === "number" && Number.isFinite(n) ? n : DEFAULT_AXIS_SCORE;
  return Math.min(10, Math.max(1, Math.round(v * 10) / 10));
};

const oneLine = (t: unknown): string => (typeof t === "string" ? t : "").replace(/\s+/g, " ").trim();

/* ───────────────────────── pure: score aggregation ───────────────────────── */

/**
 * Fold the per-axis scores into a single 0–10 overall. Quality axes contribute their score; each RISK
 * axis contributes its INVERTED value (11 − score), so a low continuityRisk raises the overall and a
 * high continuityRisk lowers it. The result is the mean across all axes. Pure.
 */
export function aggregateScore(scores: Partial<RubricScores>): number {
  let sum = 0;
  for (const axis of RUBRIC_AXES) {
    const s = clampScore(scores[axis]);
    sum += RISK_AXES.has(axis) ? 11 - s : s;
  }
  return Math.round((sum / RUBRIC_AXES.length) * 100) / 100;
}

/** Decide the action from an overall score: accept when it clears the threshold, else improve. Pure. */
export function actionForOverall(overall: number): CriticAction {
  return overall >= ACCEPT_THRESHOLD ? "accept" : "improve";
}

/* ───────────────────────── pure: response parsing (defensive) ───────────────────────── */

/**
 * Parse a raw critic response (already JSON-parsed object, or a JSON string) into a well-formed Critique.
 * DEFENSIVE: any missing / malformed axis defaults to DEFAULT_AXIS_SCORE, notes are trimmed to ≤3 strings,
 * the overall is RE-COMPUTED from the parsed scores (never trusted from the model), and the action is
 * derived from the overall unless the model explicitly said "accept"/"improve". Never throws. Pure.
 */
export function parseCriticResponse(raw: unknown): Critique {
  let obj: any = raw;
  let parsedOk = true;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, ""));
    } catch {
      obj = {};
      parsedOk = false;
    }
  }
  if (!obj || typeof obj !== "object") { obj = {}; parsedOk = false; }
  const rawScores = (obj.scores && typeof obj.scores === "object" ? obj.scores : obj) as Record<string, unknown>;
  const scores = {} as RubricScores;
  for (const axis of RUBRIC_AXES) scores[axis] = clampScore(rawScores[axis]);

  const defects = parseDefects(obj.defects);

  // Notes: prefer explicit notes; otherwise derive one short note per defect (fragment → fix).
  const notesSrc = Array.isArray(obj.notes) ? obj.notes : Array.isArray(obj.feedback) ? obj.feedback : [];
  let notes = notesSrc.map(oneLine).filter((s: string) => s.length > 0).slice(0, 3);
  if (!notes.length && defects.length) notes = defects.slice(0, 3).map((d) => defectToNote(d));

  const overall = aggregateScore(scores);
  const explicit = oneLine(obj.action).toLowerCase();
  // The gate is DEFECT-DRIVEN (P6): accept only when there is no BLOCKING defect — never a subjective
  // score threshold. An unparseable / empty response is treated cautiously as "improve".
  let action: CriticAction;
  if (explicit === "accept" || explicit === "improve") action = explicit as CriticAction;
  else if (!parsedOk) action = "improve";
  else action = hasBlockingDefect(defects) ? "improve" : "accept";
  return { scores, overall, notes, defects, action };
}

/** Parse a raw defects array defensively into well-formed CriticDefect records (severity defaults to advisory). */
function parseDefects(raw: unknown): CriticDefect[] {
  if (!Array.isArray(raw)) return [];
  const out: CriticDefect[] = [];
  for (const d of raw) {
    if (!d || typeof d !== "object") continue;
    const fragment = oneLine((d as any).fragment);
    const reason = oneLine((d as any).reason);
    const fix = oneLine((d as any).fix);
    if (!reason && !fix && !fragment) continue;
    const sev = oneLine((d as any).severity).toLowerCase();
    out.push({ fragment, reason, fix, severity: sev === "blocking" ? "blocking" : "advisory" });
  }
  return out.slice(0, 8);
}

/** Render a defect as one short actionable note ("<fix> (<fragment>)"). Pure. */
function defectToNote(d: CriticDefect): string {
  const base = d.fix || d.reason || d.fragment;
  return d.fragment && d.fix ? `${d.fix} — re: "${d.fragment}"` : base;
}

/* ───────────────────────── pure: best-variant selection ───────────────────────── */

/**
 * Return the INDEX of the best critique (highest overall). Ties break toward the earlier variant. Returns
 * -1 for an empty list. Pure.
 */
export function pickBestVariant(critiques: Array<Pick<Critique, "overall">>): number {
  let best = -1;
  let bestScore = -Infinity;
  critiques.forEach((c, i) => {
    if (c && c.overall > bestScore) {
      bestScore = c.overall;
      best = i;
    }
  });
  return best;
}

/* ───────────────────────── pure: fix-instruction assembly ───────────────────────── */

/**
 * Build a targeted-fix instruction from the critic's notes, appended to the generation prompt on an
 * "improve" pass. Empty notes → an empty string (the caller then skips the improve pass). Pure.
 */
export function buildFixInstruction(notes: string[], opts: { label?: string } = {}): string {
  const clean = (notes ?? []).map(oneLine).filter(Boolean).slice(0, 3);
  if (!clean.length) return "";
  const head = opts.label ? `Revise this ${opts.label} to fix the following, keeping everything that already works:` : "Revise the draft to fix the following, keeping everything that already works:";
  return `${head}\n${clean.map((n, i) => `${i + 1}. ${n}`).join("\n")}\nReturn the full corrected result only.`;
}

/* ───────────────────────── pure: GenerationLog record shaping ───────────────────────── */

export type GenerationKind = "synopsis" | "seasonMap" | "episodeScript" | "dramaBible" | string;

export interface GenerationLogInput {
  projectId?: string | null;
  seasonId?: string | null;
  episodeId?: string | null;
  kind: GenerationKind;
  model: string;
  promptVersion: string;
  attempts: number;
  finalScore?: number | null;
  accepted: boolean;
  notes?: string[] | null;
  error?: string | null;
}

/** The exact shape written to the GenerationLog table (JSON-serialisable). Pure — no DB call. */
export interface GenerationLogRecord {
  projectId: string | null;
  seasonId: string | null;
  episodeId: string | null;
  kind: string;
  model: string;
  promptVersion: string;
  attempts: number;
  finalScore: number | null;
  accepted: boolean;
  notes: string[] | null;
  error: string | null;
}

/**
 * Shape a GenerationLog row from a generation outcome. Normalises optional ids to null, clamps attempts to
 * ≥0, trims notes, and truncates a long error. Pure — the caller persists the returned record. */
export function buildGenerationLog(input: GenerationLogInput): GenerationLogRecord {
  const notes = Array.isArray(input.notes) ? input.notes.map(oneLine).filter(Boolean).slice(0, 6) : null;
  return {
    projectId: input.projectId ?? null,
    seasonId: input.seasonId ?? null,
    episodeId: input.episodeId ?? null,
    kind: oneLine(input.kind) || "unknown",
    model: oneLine(input.model) || "unknown",
    promptVersion: oneLine(input.promptVersion) || CRITIC_PROMPT_VERSION,
    attempts: Math.max(0, Math.round(input.attempts || 0)),
    finalScore: typeof input.finalScore === "number" && Number.isFinite(input.finalScore) ? input.finalScore : null,
    accepted: !!input.accepted,
    notes: notes && notes.length ? notes : null,
    error: input.error ? oneLine(input.error).slice(0, 1000) : null,
  };
}

/* ───────────────────────── critic system prompt + injectable wrappers ───────────────────────── */

/** The critic's system prompt — reports CONCRETE VERIFIABLE defects and rubric scores, returns strict JSON. */
export const CRITIC_SYSTEM = [
  "You are a precise script editor for a short-form vertical (9:16) AI drama.",
  "Assess ONLY verifiable craft defects. Do NOT judge subjective 'interestingness', hook appeal, trope",
  "coolness, or how badly a viewer wants the next episode — those are NOT your job and must NOT affect the",
  "outcome. Judge what can be checked against the text and the rules.",
  "",
  "Score the CANDIDATE on this rubric, each axis an integer 1–10 (advisory — used only to rank variants):",
  "- causalLogic: do events follow from prior events (cause → effect); does the ending follow from what happened?",
  "- clarity: is who-wants-what / who-does-what unambiguous and easy to follow?",
  "- stagingConcreteness: are there concrete actions/reactions/beats, not plot retelling or vague summary?",
  "- dialoguePurity: are spoken lines FREE of stage directions/action/blocking/narration (spoken words + tone only)?",
  "- characterDistinctness: do characters read as distinct, non-interchangeable voices?",
  "- continuityRisk: RISK of a continuity break (1 = airtight, 10 = likely to contradict established facts). LOWER IS BETTER.",
  "",
  "Then list CONCRETE DEFECTS. Each defect names the offending FRAGMENT (short quote), the REASON it breaks a",
  "rule or logic, and an actionable FIX. Mark each defect's severity:",
  "- 'blocking': a real defect that must be fixed — a causal gap/non-sequitur ending, stage directions inside a",
  "  spoken line, an unclear who-does-what, an outright continuity contradiction.",
  "- 'advisory': a genuine improvement that is NOT required to accept.",
  "Do NOT invent defects to look thorough, and never raise a blocking defect for weak 'engagement', a soft",
  "cliffhanger, or a trope you dislike. If there are no blocking defects, the candidate is acceptable.",
  "",
  'Return STRICT JSON: { "scores": { "causalLogic": n, "clarity": n, "stagingConcreteness": n, "dialoguePurity": n, "characterDistinctness": n, "continuityRisk": n }, "defects": [ { "fragment": "...", "reason": "...", "fix": "...", "severity": "blocking"|"advisory" } ], "action": "improve"|"accept" }.',
  "Set action to 'accept' when there are no blocking defects, otherwise 'improve'. Keep each field short and specific.",
].join("\n");

/** Build the critic user message for a candidate. Pure. */
export function criticUserPrompt(kind: GenerationKind, candidate: string, context?: string | null): string {
  const ctx = oneLine(context);
  return [`KIND: ${kind}`, ctx ? `CONTEXT: ${ctx}` : "", "CANDIDATE:", candidate, "", "Score it on the rubric and return the JSON only."].filter(Boolean).join("\n");
}

/** An injectable JSON chat client — matches lib/ai.ts chatJSON's shape so the worker passes it directly. */
export type CriticChatJSON = (system: string, user: string, opts?: any) => Promise<unknown>;

/**
 * Critique ONE candidate via the injected client. Any client / parse failure returns a DEFENSIVE neutral
 * critique (mid scores, "improve" action) so a critic outage never breaks generation — it simply yields no
 * useful notes and the caller falls back to the first valid variant.
 */
export async function critiqueCandidate(
  chatJSON: CriticChatJSON,
  kind: GenerationKind,
  candidate: string,
  context?: string | null,
  opts?: any
): Promise<Critique> {
  try {
    const raw = await chatJSON(CRITIC_SYSTEM, criticUserPrompt(kind, candidate, context), { temperature: 0.2, maxTokens: 700, ...opts });
    return parseCriticResponse(raw);
  } catch {
    const scores = {} as RubricScores;
    for (const axis of RUBRIC_AXES) scores[axis] = DEFAULT_AXIS_SCORE;
    return { scores, overall: aggregateScore(scores), notes: [], defects: [], action: "improve" };
  }
}

/* ───────────────────────── orchestrators (injectable — testable with stubs) ───────────────────────── */

export interface CriticVariantOutcome<T> {
  /** The chosen (and possibly improved) result. */
  best: T;
  /** The critique of the chosen variant BEFORE the improve pass. */
  critique: Critique;
  /** How many candidate generations ran in total (variants + any improve pass). */
  attempts: number;
  /** Whether the flow ended on an accepted critique (best already ≥ threshold, or improved). */
  accepted: boolean;
  /** The best variant's notes (also the improve-pass instructions). */
  notes: string[];
}

/**
 * SYNOPSIS / SEASON MAP flow: generate `variantCount` variants IN PARALLEL, critique each, pick the best,
 * and — when the best is not already "accept" — run ONE targeted-improve pass using its notes. Every LLM
 * call is injected, so tests drive it with pure stubs and no network. Defensive: if all variants fail to
 * generate it throws (nothing to work with); if the critic is useless the first variant is returned.
 */
export async function generateBestOfN<T>(args: {
  variantCount: number;
  /** Generate one variant (index i). Should already carry temperature ~0.9. */
  generate: (i: number) => Promise<T>;
  /** Turn a candidate into the text the critic reads. */
  render: (candidate: T) => string;
  /** Critique a rendered candidate. */
  critique: (rendered: string) => Promise<Critique>;
  /** Run the single improve pass with the best variant's fix instruction. */
  improve?: (best: T, fixInstruction: string, notes: string[]) => Promise<T>;
  kind?: GenerationKind;
}): Promise<CriticVariantOutcome<T>> {
  const n = Math.max(1, Math.round(args.variantCount));
  const settled = await Promise.allSettled(Array.from({ length: n }, (_, i) => args.generate(i)));
  const variants: T[] = settled.filter((s) => s.status === "fulfilled").map((s) => (s as PromiseFulfilledResult<T>).value);
  if (!variants.length) throw new Error("generateBestOfN: every variant failed to generate");
  let attempts = variants.length;

  const critiques = await Promise.all(variants.map((v) => args.critique(args.render(v))));
  const bestIdx = Math.max(0, pickBestVariant(critiques));
  let best = variants[bestIdx];
  const critique = critiques[bestIdx];
  let accepted = critique.action === "accept";
  const notes = critique.notes;

  if (!accepted && args.improve) {
    const fix = buildFixInstruction(notes, { label: args.kind });
    if (fix) {
      try {
        best = await args.improve(best, fix, notes);
        attempts += 1;
        accepted = true; // one targeted-improve pass is the contract; we accept its result
      } catch {
        // keep the best pre-improve variant on failure
      }
    }
  }
  return { best, critique, attempts, accepted, notes };
}

/**
 * EPISODE SCRIPT flow: a generate → critique → targeted-fix loop of at most `maxIterations` (default 3).
 * Iteration 0 generates `variantCount` variants (default 2) and critiques each, picking the best. While the
 * best critique says "improve" and iterations remain, apply a targeted fix (built from its notes) and
 * re-critique; stop on "accept" or when iterations run out. All LLM calls are injected. Post-steps
 * (dialoguePolish, continuity) are the caller's job — this returns the chosen script + the outcome.
 */
export async function runCriticLoop<T>(args: {
  variantCount?: number;
  maxIterations?: number;
  generate: (i: number) => Promise<T>;
  render: (candidate: T) => string;
  critique: (rendered: string) => Promise<Critique>;
  fix: (current: T, fixInstruction: string, notes: string[]) => Promise<T>;
  kind?: GenerationKind;
}): Promise<CriticVariantOutcome<T>> {
  const variantCount = Math.max(1, Math.round(args.variantCount ?? 2));
  const maxIterations = Math.max(1, Math.round(args.maxIterations ?? 3));

  const settled = await Promise.allSettled(Array.from({ length: variantCount }, (_, i) => args.generate(i)));
  const variants: T[] = settled.filter((s) => s.status === "fulfilled").map((s) => (s as PromiseFulfilledResult<T>).value);
  if (!variants.length) throw new Error("runCriticLoop: every variant failed to generate");
  let attempts = variants.length;

  const critiques = await Promise.all(variants.map((v) => args.critique(args.render(v))));
  let bestIdx = Math.max(0, pickBestVariant(critiques));
  let current = variants[bestIdx];
  let critique = critiques[bestIdx];

  let iteration = 1; // iteration 0 was the initial variant round
  while (critique.action === "improve" && iteration < maxIterations) {
    const fix = buildFixInstruction(critique.notes, { label: args.kind });
    if (!fix) break;
    try {
      current = await args.fix(current, fix, critique.notes);
      attempts += 1;
      critique = await args.critique(args.render(current));
    } catch {
      break; // a fix / re-critique failure stops the loop with the last good candidate
    }
    iteration += 1;
  }
  return { best: current, critique, attempts, accepted: critique.action === "accept", notes: critique.notes };
}
