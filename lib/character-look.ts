/**
 * Stage 46B-1 — scenes always render the CURRENT character look.
 *
 * A scene's text (videoPrompt, startState, endState and the resolved opening state) is written ONCE at
 * script time and embeds hair / build / clothing of the character version of THAT moment. When the
 * producer later changes Character.appearance, the scene job rewrites every such description with the
 * live appearance via one gpt-4o call per scene. The result is cached on the Scene (`lookCache` JSON)
 * keyed by a hash of the live characters + the original text, so unchanged scenes never call the LLM
 * again. On any failure the original text is used (the [CHARACTER] line is still refreshed separately).
 */
import { createHash } from "node:crypto";
import { chatJSON } from "@/lib/ai";

export const LOOK_MODEL = "gpt-4o";
export const LOOK_TIMEOUT_MS = 90_000;

export const PROMPT_TAGS = ["[SHOT TYPE]", "[VISUAL STYLE]", "[LIGHTING]", "[BLOCKING]", "[GAZE]", "[NON-VERBAL]", "[ACTION]", "[CHARACTER]", "[TRANSITION]"] as const;

export interface LookCharacter {
  characterId: string;
  name: string;
  age?: string | null;
  appearance?: string | null;
}

export interface LookTexts {
  videoPrompt: string;
  startState: string | null;
  endState: string | null;
  openingState: string | null;
}

export interface LookCache extends LookTexts {
  hash: string;
}

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/** Hash of the live character looks + the original scene text: changes iff any appearance/age or the text changes. */
export function lookHash(characters: readonly LookCharacter[], original: LookTexts): string {
  const chars = [...characters]
    .sort((a, b) => a.characterId.localeCompare(b.characterId))
    .map(c => `${c.characterId}|${(c.appearance ?? "").trim()}|${(c.age ?? "").trim()}`)
    .join("\n");
  const text = sha1([original.videoPrompt, original.startState ?? "", original.endState ?? "", original.openingState ?? ""].join("\n---\n"));
  return sha1(`${chars}\n##\n${text}`);
}

/** All 9 tags present, in order, and the prompt is non-empty. */
export function hasAllTagsInOrder(prompt: string): boolean {
  if (!prompt || !prompt.trim()) return false;
  let pos = 0;
  for (const tag of PROMPT_TAGS) {
    const i = prompt.indexOf(tag, pos);
    if (i < 0) return false;
    pos = i + tag.length;
  }
  return true;
}

/**
 * Validate the LLM answer against the original: the videoPrompt must keep all 9 tags in order and be
 * non-empty; a state may only be returned when the original had one and must be a non-empty string.
 * Returns null when the answer is unusable (caller falls back to the original text).
 */
export function validateLookResult(raw: unknown, original: LookTexts): LookTexts | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const videoPrompt = typeof r.videoPrompt === "string" ? r.videoPrompt.trim() : "";
  if (!hasAllTagsInOrder(videoPrompt)) return null;
  const pick = (key: keyof LookTexts): string | null => {
    const orig = original[key];
    if (!orig) return null;
    const v = r[key];
    return typeof v === "string" && v.trim().length >= 20 ? v.trim() : orig;
  };
  return { videoPrompt, startState: pick("startState"), endState: pick("endState"), openingState: pick("openingState") };
}

export function lookSystemPrompt(): string {
  return "You update the text of a short vertical video scene so it renders the CURRENT look of its characters. " +
    "For every character listed below: replace EVERY description of their physical appearance, hair, skin, body build and CLOTHING " +
    "with the CURRENT appearance given below — word-for-word where a description appears (a full description may be shortened to the " +
    "relevant details of the current look, but never keep any detail of the old look). Keep camera, cut list, blocking, action, gaze, " +
    "timing, dialogue cues, [TRANSITION], all 9 tags in their order and EVERYTHING else UNCHANGED. English only. Never add spoken text. " +
    "Return ONLY JSON {\"videoPrompt\": string, \"startState\": string|null, \"endState\": string|null, \"openingState\": string|null} — " +
    "fields that were null in the input stay null.";
}

export function lookUserPrompt(characters: readonly LookCharacter[], original: LookTexts): string {
  const cast = characters
    .filter(c => (c.appearance ?? "").trim())
    .map(c => `- ${c.name}${(c.age ?? "").trim() ? ` (${(c.age ?? "").trim()})` : ""}: ${(c.appearance ?? "").trim().replace(/\s*\n+\s*/g, " ")}`)
    .join("\n");
  return `CURRENT APPEARANCE OF THE CHARACTERS:\n${cast}\n\nINPUT:\n${JSON.stringify(original, null, 2)}`;
}

/** Parse a stored Scene.lookCache JSON; null when absent or malformed. */
export function parseLookCache(raw: string | null | undefined): LookCache | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v.hash === "string" && typeof v.videoPrompt === "string") return v as LookCache;
  } catch { /* ignore */ }
  return null;
}

export type LookLLM = (system: string, user: string) => Promise<unknown>;

const defaultLLM: LookLLM = (system, user) => chatJSON(system, user, { model: LOOK_MODEL, temperature: 0.1, maxTokens: 6000 });

/**
 * Rewrite the scene texts to the current look. Uses the cache when the hash matches; otherwise calls the
 * LLM once (with a timeout). Never throws: on failure returns the original texts and a warning.
 */
export async function rewriteSceneLook(
  characters: readonly LookCharacter[],
  original: LookTexts,
  cache: LookCache | null,
  llm: LookLLM = defaultLLM,
  timeoutMs = LOOK_TIMEOUT_MS,
): Promise<{ texts: LookTexts; cache: LookCache | null; fromCache: boolean; warning?: string }> {
  const withLook = characters.filter(c => (c.appearance ?? "").trim());
  if (!withLook.length) return { texts: original, cache: null, fromCache: false };
  const hash = lookHash(characters, original);
  if (cache && cache.hash === hash) {
    return { texts: { videoPrompt: cache.videoPrompt, startState: cache.startState, endState: cache.endState, openingState: cache.openingState }, cache, fromCache: true };
  }
  try {
    const raw = await Promise.race([
      llm(lookSystemPrompt(), lookUserPrompt(withLook, original)),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`look rewrite timeout after ${timeoutMs} ms`)), timeoutMs)),
    ]);
    const texts = validateLookResult(raw, original);
    if (!texts) return { texts: original, cache: null, fromCache: false, warning: "look rewrite returned an invalid result — original scene text used" };
    return { texts, cache: { hash, ...texts }, fromCache: false };
  } catch (err: any) {
    return { texts: original, cache: null, fromCache: false, warning: `look rewrite failed: ${err?.message ?? "unknown error"} — original scene text used` };
  }
}
