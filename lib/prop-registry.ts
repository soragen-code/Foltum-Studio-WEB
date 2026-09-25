/**
 * Stage 54 — EPISODE-LEVEL PROP REGISTRY (variant B: verbatim substitution).
 *
 * A "prop" here is a key recurring physical object of the episode (a blue tin, a leather ledger, a
 * brass key) — NOT the location and NOT the clothing that is already visible on the character's
 * full-body reference photo. Left to the per-scene text alone, such an object drifts: a blue tin in
 * scene 1 quietly turns green by scene 5 because each scene was written independently. The registry
 * fixes that by storing ONE canonical English description per prop for the whole episode; every scene
 * that mentions the prop substitutes that exact same description string VERBATIM into its
 * «CLOTHING & PROPS» section, so the object looks identical in every clip.
 *
 * This is DATA, not a UI/behaviour toggle: the registry is a JSON snapshot cached on
 * `Episode.propRegistry` (exactly like `Scene.lookCache` / `Location.visualPromptAuto`). It is
 * auto-populated — never edited by hand — from the finished episode script, and re-extracted only
 * when the script changes (the cache is keyed by a hash of the script). Extraction is best-effort:
 * on any LLM failure the episode simply has no registry and scenes fall back to their own text, so a
 * prop never blocks generation. The matching + verbatim substitution used at prompt-assembly time is
 * PURE and deterministic (`matchPropsInText`), which is what the unit tests pin down.
 */
import { createHash } from "node:crypto";
import { chatJSON } from "@/lib/ai";

export const PROP_MODEL = "openai/gpt-4o";
export const PROP_TIMEOUT_MS = 90_000;
/** Hard cap on how many props an episode registry keeps (defensive — a script never needs more). */
export const PROP_REGISTRY_CAP = 24;

export interface PropRegistryEntry {
  /** deterministic slug of the name (stable id for the prop). */
  id: string;
  /** short human name used to detect the prop in a scene's text (case-insensitive substring). */
  name: string;
  /** the canonical English description substituted VERBATIM into every scene that shows the prop. */
  description: string;
}

export interface PropRegistry {
  /** hash of the source script — the registry is rebuilt only when this changes. */
  hash: string;
  props: PropRegistryEntry[];
}

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/** Deterministic slug used as the prop id. */
export function propSlug(name: string): string {
  return (name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "prop";
}

/** Hash of the episode script text: the registry is invalidated (re-extracted) iff the script changes. */
export function propRegistryHash(script: string | null | undefined): string {
  return sha1((script ?? "").trim());
}

/** Parse a stored Episode.propRegistry JSON; null when absent or malformed. */
export function parsePropRegistry(raw: string | null | undefined): PropRegistry | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v.hash === "string" && Array.isArray(v.props)) {
      const props = v.props.filter(
        (p: unknown): p is PropRegistryEntry =>
          !!p && typeof (p as any).name === "string" && typeof (p as any).description === "string",
      );
      return { hash: v.hash, props };
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Validate the LLM answer into a clean, de-duplicated, capped prop list. Each entry needs a non-empty
 * name and a non-trivial description (≥ 8 chars). Returns [] when nothing usable (an empty registry is
 * a valid outcome — the episode just has no shared props). Never throws.
 */
export function validatePropRegistryResult(raw: unknown): PropRegistryEntry[] {
  const arr = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as any).props)
      ? (raw as any).props
      : [];
  const seen = new Set<string>();
  const out: PropRegistryEntry[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const name = typeof (item as any).name === "string" ? (item as any).name.trim() : "";
    const description = typeof (item as any).description === "string"
      ? (item as any).description.trim().replace(/\s*\n+\s*/g, " ")
      : "";
    if (!name || description.length < 8) continue;
    const id = propSlug(name);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, description });
    if (out.length >= PROP_REGISTRY_CAP) break;
  }
  return out;
}

/**
 * Props whose NAME appears (case-insensitive substring) in the given scene text. PURE and
 * deterministic — the single source of truth for which props a scene shows, shared by the prompt
 * builder and the worker. Registry order is preserved so two scenes with the same prop always emit
 * the description in the same place with the same words.
 */
export function matchPropsInText(props: readonly PropRegistryEntry[], text: string | null | undefined): PropRegistryEntry[] {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return [];
  return props.filter(p => {
    const n = (p.name ?? "").trim().toLowerCase();
    return n.length > 0 && t.includes(n);
  });
}

export function propRegistrySystemPrompt(): string {
  return "You extract the KEY recurring physical PROPS of a short vertical-video episode so each one looks " +
    "identical in every scene. A prop is a distinctive hand-held or set object that matters to the story and " +
    "appears in more than one moment (e.g. a blue enamel tin, a leather ledger, a brass key, a red envelope). " +
    "Do NOT list: the location or its architecture, furniture that is part of the set, the clothing the " +
    "characters are already wearing, vague categories (\"a cup\", \"papers\"), or anything mentioned only once in passing. " +
    "For every prop give a SHORT canonical English description of its fixed visual identity — colour, material, " +
    "size, shape and any distinctive marks — that can be reused word-for-word in every scene (no scene-specific action). " +
    "Return ONLY JSON {\"props\": [{\"name\": string, \"description\": string}]} — an empty array when the episode has no such recurring prop. " +
    "Keep it to the few genuinely recurring objects (at most a dozen). English only.";
}

export function propRegistryUserPrompt(script: string): string {
  return `EPISODE SCRIPT:\n${(script ?? "").trim()}`;
}

export type PropLLM = (system: string, user: string) => Promise<unknown>;

const defaultLLM: PropLLM = (system, user) => chatJSON(system, user, { model: PROP_MODEL, temperature: 0, maxTokens: 4000 });

/**
 * Build (or reuse) the episode prop registry. Uses the cache when the script hash matches; otherwise
 * calls the LLM once (temperature 0, with a timeout). Never throws: on any failure returns an empty
 * registry and a warning, so a scene always falls back to its own text.
 */
export async function buildPropRegistry(
  script: string | null | undefined,
  cache: PropRegistry | null,
  llm: PropLLM = defaultLLM,
  timeoutMs = PROP_TIMEOUT_MS,
): Promise<{ registry: PropRegistry; fromCache: boolean; warning?: string }> {
  const hash = propRegistryHash(script);
  if (cache && cache.hash === hash) return { registry: cache, fromCache: true };
  const text = (script ?? "").trim();
  if (!text) return { registry: { hash, props: [] }, fromCache: false };
  try {
    const raw = await Promise.race([
      llm(propRegistrySystemPrompt(), propRegistryUserPrompt(text)),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`prop registry timeout after ${timeoutMs} ms`)), timeoutMs)),
    ]);
    const props = validatePropRegistryResult(raw);
    return { registry: { hash, props }, fromCache: false };
  } catch (err: any) {
    return { registry: { hash, props: [] }, fromCache: false, warning: `prop registry extraction failed: ${err?.message ?? "unknown error"} — scenes use their own text` };
  }
}
