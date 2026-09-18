/**
 * Stage 4 (task Stage 4) — the SEASON STATE engine.
 *
 * A PURE, offline-testable module: the zod schema for the world-state shape, a never-throwing normalizer, an
 * initial-state seeder (from the cast + optional drama bible), a compact prompt-block renderer, a PURE
 * contradiction validator, and the generate→validate→targeted-retry loop that refreshes the state after an
 * episode is approved.
 *
 * The state SHAPE + the prompt strings live in the leaf module lib/prompts/season-state.ts; this module owns
 * the runtime logic. It never imports lib/season.ts at runtime.
 */
import { z } from "zod";
import type { DramaBible } from "./prompts/drama-bible";
import type { SeasonStateLike } from "./prompts/scene";
import {
  SEASON_STATE_PROMPT_VERSION,
  SEASON_STATE_UPDATE_SYSTEM,
  seasonStateUpdateUserPrompt,
  seasonStateRetryNote,
  type PlantedSetup,
  type SeasonStateCharacter,
  type SeasonStateData,
  type SeasonStateProp,
  type SeasonStateUpdateUserInput,
} from "./prompts/season-state";

export type {
  PlantedSetup,
  SeasonStateCharacter,
  SeasonStateData,
  SeasonStateProp,
} from "./prompts/season-state";
export { SEASON_STATE_PROMPT_VERSION } from "./prompts/season-state";

/* ───────────────────────────── small helpers ───────────────────────────── */

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const toStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x)).filter((x) => x.length > 0) : [];
const slug = (name: string): string =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "character";

/* ───────────────────────────── zod schema ───────────────────────────── */

const nonEmpty = z.string().trim().min(1);

const characterSchema: z.ZodType<SeasonStateCharacter> = z.object({
  id: nonEmpty,
  name: nonEmpty,
  location: z.string(),
  physicalState: z.string(),
  wardrobe: z.string(),
  knows: z.array(z.string()),
  wants: z.string(),
  relationships: z.record(z.string()),
  arcStage: z.string(),
});

const propSchema: z.ZodType<SeasonStateProp> = z.object({
  id: nonEmpty,
  holder: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  state: z.string(),
});

const plantedSetupSchema: z.ZodType<PlantedSetup> = z.object({
  setup: nonEmpty,
  payoffEpisode: z.number().int().nullable(),
});

export const seasonStateSchema: z.ZodType<SeasonStateData> = z.object({
  characters: z.array(characterSchema),
  props: z.array(propSchema),
  openThreads: z.array(z.string()),
  plantedSetups: z.array(plantedSetupSchema),
  revealedToAudience: z.array(z.string()),
  lastSceneEndState: z.string(),
});

/* ───────────────────────────── errors ───────────────────────────── */

export interface SeasonStateError {
  /** A field / entity path, e.g. "characters[Anna].location" or "props[gun].holder". */
  field: string;
  message: string;
}

export interface SeasonStateValidation {
  ok: boolean;
  errors: SeasonStateError[];
}

/** The whole state matches the zod shape. Returns field-named errors (empty = valid shape). */
export function validateSeasonStateShape(state: unknown): SeasonStateError[] {
  const res = seasonStateSchema.safeParse(state);
  if (res.success) return [];
  return res.error.issues.map((i) => ({
    field: i.path.join(".") || "state",
    message: i.message,
  }));
}

/* ───────────────────────────── normalizer (never throws) ───────────────────────────── */

/**
 * Coerce any raw LLM output into a well-formed SeasonStateData. Unwraps a `{state:{...}}` or
 * `{seasonState:{...}}` wrapper, drops junk, and fills every required field with a safe default so the rest
 * of the pipeline can rely on the shape. NEVER throws.
 */
export function normalizeSeasonState(raw: unknown): SeasonStateData {
  let src: Record<string, unknown> = {};
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (obj.state && typeof obj.state === "object") src = obj.state as Record<string, unknown>;
    else if (obj.seasonState && typeof obj.seasonState === "object") src = obj.seasonState as Record<string, unknown>;
    else src = obj;
  }
  const charactersRaw = Array.isArray(src.characters) ? (src.characters as unknown[]) : [];
  const propsRaw = Array.isArray(src.props) ? (src.props as unknown[]) : [];
  const setupsRaw = Array.isArray(src.plantedSetups) ? (src.plantedSetups as unknown[]) : [];
  return {
    characters: charactersRaw.map((c) => {
      const co = (c ?? {}) as Record<string, unknown>;
      const name = str(co.name);
      const relsRaw = (co.relationships ?? {}) as Record<string, unknown>;
      const relationships: Record<string, string> = {};
      if (relsRaw && typeof relsRaw === "object" && !Array.isArray(relsRaw)) {
        for (const [k, v] of Object.entries(relsRaw)) {
          const key = str(k);
          const val = str(v);
          if (key) relationships[key] = val;
        }
      }
      return {
        id: str(co.id) || slug(name),
        name,
        location: str(co.location),
        physicalState: str(co.physicalState),
        wardrobe: str(co.wardrobe),
        knows: toStringArray(co.knows),
        wants: str(co.wants),
        relationships,
        arcStage: str(co.arcStage),
      };
    }),
    props: propsRaw.map((p) => {
      const po = (p ?? {}) as Record<string, unknown>;
      const holder = str(po.holder);
      const location = str(po.location);
      return {
        id: str(po.id) || slug(str(po.state) || "prop"),
        holder: holder ? holder : null,
        location: location ? location : null,
        state: str(po.state),
      };
    }),
    openThreads: toStringArray(src.openThreads),
    plantedSetups: setupsRaw.map((s) => {
      const so = (s ?? {}) as Record<string, unknown>;
      const ep = typeof so.payoffEpisode === "number" && Number.isFinite(so.payoffEpisode) ? Math.floor(so.payoffEpisode) : NaN;
      return { setup: str(so.setup), payoffEpisode: Number.isFinite(ep) ? ep : null };
    }),
    revealedToAudience: toStringArray(src.revealedToAudience),
    lastSceneEndState: str(src.lastSceneEndState),
  };
}

/* ───────────────────────────── seeding ───────────────────────────── */

export interface SeedCastMember {
  id?: string | null;
  name: string;
  appearance?: string | null;
  wardrobe?: string | null;
  location?: string | null;
}

/**
 * Seed the INITIAL world-state for a season before any episode is approved. Characters come from the cast;
 * their relationships and arc starts are enriched from the drama bible when present (matched by name). Props
 * and threads start empty and are filled as episodes are approved.
 */
export function seedSeasonState(cast: SeedCastMember[], bible?: DramaBible | null): SeasonStateData {
  const rels = (bible?.relationships ?? []).filter((r) => r && r.a && r.b);
  const openThreads = bible?.finaleQuestion ? [str(bible.finaleQuestion)].filter(Boolean) : [];
  const plantedSetups: PlantedSetup[] = (bible?.secrets ?? [])
    .filter((s) => s && s.secret)
    .map((s) => ({ setup: str(s.secret), payoffEpisode: typeof s.revealEpisode === "number" ? s.revealEpisode : null }));
  const characters: SeasonStateCharacter[] = (cast ?? [])
    .filter((c) => c && str(c.name))
    .map((c) => {
      const name = str(c.name);
      const relationships: Record<string, string> = {};
      for (const r of rels) {
        if (str(r.a) === name && str(r.b)) relationships[str(r.b)] = str(r.dynamic) || str(r.tension);
        else if (str(r.b) === name && str(r.a)) relationships[str(r.a)] = str(r.dynamic) || str(r.tension);
      }
      return {
        id: str(c.id) || slug(name),
        name,
        location: str(c.location),
        physicalState: "",
        wardrobe: str(c.wardrobe) || str(c.appearance),
        knows: [],
        wants: "",
        relationships,
        arcStage: "setup",
      };
    });
  return {
    characters,
    props: [],
    openThreads,
    plantedSetups,
    revealedToAudience: [],
    lastSceneEndState: "",
  };
}

/* ───────────────────────────── renderer ───────────────────────────── */

const truncate = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

/**
 * Render a compact SEASON STATE block for the next episode's prompt. Replaces the old ~1200-char continuity
 * text tail: one line per character (location / wardrobe / physical / knows / wants), the live props, the
 * open threads, the setups still awaiting a payoff, and the last-scene end state. `upcomingEpisode` (when
 * given) is used only to mark setups whose payoff is due.
 */
export function renderSeasonStateBlock(state: SeasonStateData, upcomingEpisode?: number | null): string {
  const lines: string[] = ["SEASON STATE (canon — do not contradict; continue from exactly here):"];

  if (state.characters.length) {
    lines.push("CHARACTERS:");
    for (const c of state.characters) {
      const parts: string[] = [];
      if (c.location) parts.push(`at ${c.location}`);
      if (c.wardrobe) parts.push(`wearing ${c.wardrobe}`);
      if (c.physicalState) parts.push(`physical: ${c.physicalState}`);
      if (c.arcStage) parts.push(`arc: ${c.arcStage}`);
      if (c.wants) parts.push(`wants: ${c.wants}`);
      if (c.knows.length) parts.push(`knows: ${truncate(c.knows.join("; "), 200)}`);
      const relEntries = Object.entries(c.relationships).filter(([, v]) => v);
      if (relEntries.length) parts.push(`relationships: ${relEntries.map(([k, v]) => `${k} — ${v}`).join("; ")}`);
      lines.push(`- ${c.name}: ${parts.join(" | ") || "no change on record"}`);
    }
  }

  const props = state.props.filter((p) => p.id);
  if (props.length) {
    lines.push("PROPS:");
    for (const p of props) {
      const where = p.holder ? `held by ${p.holder}` : p.location ? `at ${p.location}` : "unheld";
      lines.push(`- ${p.id}: ${where}${p.state ? ` (${p.state})` : ""}`);
    }
  }

  if (state.openThreads.length) {
    lines.push("OPEN THREADS (must stay consistent; resolve deliberately):");
    for (const t of state.openThreads) lines.push(`- ${t}`);
  }

  const setups = state.plantedSetups.filter((s) => s.setup);
  if (setups.length) {
    lines.push("PLANTED SETUPS (pay these off; never contradict them):");
    for (const s of setups) {
      const due =
        upcomingEpisode != null && s.payoffEpisode != null && s.payoffEpisode <= upcomingEpisode ? " [payoff DUE]" : s.payoffEpisode != null ? ` [payoff ep ${s.payoffEpisode}]` : "";
      lines.push(`- ${s.setup}${due}`);
    }
  }

  if (state.revealedToAudience.length) {
    lines.push("ALREADY REVEALED TO AUDIENCE (do not re-reveal as new):");
    for (const r of state.revealedToAudience) lines.push(`- ${r}`);
  }

  if (state.lastSceneEndState) {
    lines.push("LAST SCENE END STATE (open the next episode continuing from this):");
    lines.push(state.lastSceneEndState);
  }

  return lines.join("\n");
}

/* ───────────────────────────── contradiction validator (PURE) ───────────────────────────── */

/**
 * Flag internal contradictions in a world-state. PURE — no I/O. Detects:
 *  1. a character listed in two different locations (duplicate name, differing location);
 *  2. a prop used without possession / after destruction (holder set but state says destroyed/lost, or a
 *     holder that is not a known character);
 *  3. a character "knowing" a fact that has not been revealed to the audience yet (knows ⊄ revealedToAudience);
 *  4. a wardrobe / physical-state inconsistency (same character name carrying conflicting wardrobe entries);
 *  5. an open thread that references a setup already marked closed / a plantedSetup whose payoffEpisode is in
 *     the past relative to the state's reflected episode yet still listed as un-paid (referencing a closed thread).
 *
 * Returns field/entity-named errors; an empty array means no contradiction.
 */
export function validateContradictions(
  state: SeasonStateData,
  opts: { reflectsEpisodeNumber?: number | null; requireRevealedKnowledge?: boolean } = {}
): SeasonStateError[] {
  const errors: SeasonStateError[] = [];
  const knownNames = new Set(state.characters.map((c) => c.name).filter(Boolean));

  // 1 + 4: per-name location / wardrobe / physical consistency across duplicate entries.
  const byName = new Map<string, SeasonStateCharacter[]>();
  for (const c of state.characters) {
    if (!c.name) continue;
    const arr = byName.get(c.name) ?? [];
    arr.push(c);
    byName.set(c.name, arr);
  }
  for (const [name, entries] of byName) {
    if (entries.length < 2) continue;
    const locs = new Set(entries.map((e) => e.location).filter(Boolean));
    if (locs.size > 1) {
      errors.push({ field: `characters[${name}].location`, message: `${name} is listed in two locations at once: ${[...locs].join(" / ")}` });
    }
    const wards = new Set(entries.map((e) => e.wardrobe).filter(Boolean));
    if (wards.size > 1) {
      errors.push({ field: `characters[${name}].wardrobe`, message: `${name} has conflicting wardrobe entries: ${[...wards].join(" / ")}` });
    }
    const phys = new Set(entries.map((e) => e.physicalState).filter(Boolean));
    if (phys.size > 1) {
      errors.push({ field: `characters[${name}].physicalState`, message: `${name} has conflicting physical-state entries: ${[...phys].join(" / ")}` });
    }
  }

  // 2: prop possession / destruction.
  for (const p of state.props) {
    const st = p.state.toLowerCase();
    const destroyed = /\b(destroyed|shattered|burned|burnt|gone|lost)\b/.test(st);
    if (p.holder) {
      if (destroyed) {
        errors.push({ field: `props[${p.id}].holder`, message: `${p.id} is held by ${p.holder} but its state says "${p.state}" — a destroyed/lost prop cannot be held` });
      }
      if (!knownNames.has(p.holder)) {
        errors.push({ field: `props[${p.id}].holder`, message: `${p.id} is held by unknown character "${p.holder}"` });
      }
    }
  }

  // 3: a character knows a fact not yet revealed to the audience (opt-in: only when we track reveals).
  if (opts.requireRevealedKnowledge) {
    const revealed = new Set(state.revealedToAudience.map((r) => r.toLowerCase()));
    for (const c of state.characters) {
      for (const fact of c.knows) {
        if (!revealed.has(fact.toLowerCase())) {
          errors.push({ field: `characters[${c.name}].knows`, message: `${c.name} knows "${fact}" but it has not been revealed to the audience` });
        }
      }
    }
  }

  // 5: referencing a closed thread — a planted setup whose payoff was due in a past episode but is still open.
  const ref = opts.reflectsEpisodeNumber;
  if (typeof ref === "number" && Number.isFinite(ref)) {
    for (const s of state.plantedSetups) {
      if (s.payoffEpisode != null && s.payoffEpisode < ref) {
        errors.push({ field: `plantedSetups[${s.setup}].payoffEpisode`, message: `setup "${s.setup}" was due to pay off by episode ${s.payoffEpisode} but is still listed as an open planted setup at episode ${ref}` });
      }
    }
  }

  return errors;
}

/** The state matches the zod shape AND has no contradictions. */
export function validateSeasonState(
  state: SeasonStateData,
  opts: { reflectsEpisodeNumber?: number | null; requireRevealedKnowledge?: boolean } = {}
): SeasonStateValidation {
  const shapeErrors = validateSeasonStateShape(state);
  if (shapeErrors.length) return { ok: false, errors: shapeErrors };
  const contradictions = validateContradictions(state, opts);
  return { ok: contradictions.length === 0, errors: contradictions };
}

/* ───────────────────────────── scene mapper ───────────────────────────── */

/**
 * Project the full state into the minimal slice lib/prompts/scene.ts + shot.ts read (SeasonStateLike). The
 * extra fields are dropped; wardrobe / physicalState / location per character + the last-scene end state
 * survive. Returns null for an absent state so the scene / shot blocks fall back structurally.
 */
export function toSceneSeasonState(state?: SeasonStateData | null): SeasonStateLike | null {
  if (!state) return null;
  return {
    characters: state.characters.map((c) => ({
      id: c.id,
      name: c.name,
      physicalState: c.physicalState || null,
      wardrobe: c.wardrobe || null,
      location: c.location || null,
      arcStage: c.arcStage || null,
    })),
    lastSceneEndState: state.lastSceneEndState || null,
  };
}

/* ───────────────────────────── generate → validate → targeted retry ───────────────────────────── */

/** The injected JSON LLM call — same shape as lib/ai `chatJSON`, supplied by the caller (worker / test). */
export type SeasonStateChatFn = (
  system: string,
  user: string,
  opts?: { model?: string; maxTokens?: number; temperature?: number }
) => Promise<unknown>;

export interface GenerateSeasonStateInput {
  /** The state BEFORE this episode (seed for episode 1). */
  currentState: SeasonStateData;
  episodeScript: string;
  seasonTitle?: string | null;
  episodeNumber?: number | null;
  episodeTitle?: string | null;
}

export interface GenerateSeasonStateResult {
  state: SeasonStateData;
  valid: boolean;
  errors: SeasonStateError[];
  attempts: number;
  version: string;
}

/**
 * Refresh the world-state after an episode is approved: render the current state + the approved script into
 * the prompt, call the injected chat fn, normalize + validate (shape + contradictions); on failure append a
 * targeted retry note naming the first failing field and try again (up to maxRetries+1 total attempts).
 * NEVER throws — after exhausting retries it returns the best-effort normalized state with valid:false so the
 * caller can decide whether to persist it (advisory) or keep the previous state.
 */
export async function generateSeasonStateUpdate(
  input: GenerateSeasonStateInput,
  chatFn: SeasonStateChatFn,
  opts: { model?: string; maxRetries?: number } = {}
): Promise<GenerateSeasonStateResult> {
  const maxRetries = opts.maxRetries ?? 2; // 3 attempts total (attempt 0 + 2 retries)
  const baseInput: SeasonStateUpdateUserInput = {
    seasonTitle: input.seasonTitle,
    episodeNumber: input.episodeNumber,
    episodeTitle: input.episodeTitle,
    currentStateJson: JSON.stringify(input.currentState, null, 2),
    episodeScript: input.episodeScript,
  };
  const baseUser = seasonStateUpdateUserPrompt(baseInput);

  let lastResult: GenerateSeasonStateResult = {
    state: input.currentState,
    valid: false,
    errors: [],
    attempts: 0,
    version: SEASON_STATE_PROMPT_VERSION,
  };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const user = attempt === 0 ? baseUser : `${baseUser}\n\n${seasonStateRetryNote(lastResult.errors[0]?.field ?? "shape")}`;
    let raw: unknown = null;
    try {
      raw = await chatFn(SEASON_STATE_UPDATE_SYSTEM, user, { model: opts.model });
    } catch {
      raw = null;
    }
    const state = normalizeSeasonState(raw);
    const validation = validateSeasonState(state, { reflectsEpisodeNumber: input.episodeNumber });
    lastResult = {
      state,
      valid: validation.ok,
      errors: validation.errors,
      attempts: attempt + 1,
      version: SEASON_STATE_PROMPT_VERSION,
    };
    if (validation.ok) return lastResult;
  }
  return lastResult;
}
