import { hasCyrillic, transliterateCyrillic } from "@/lib/sanitize-prompt";

/* ====================================================================================== */
/*  English-only guarantee for media prompts                                               */
/*                                                                                         */
/*  Every final prompt that is dispatched to the media providers (WaveSpeed Seedance for   */
/*  video scenes, WaveSpeed Seedream for reference / scene-frame images) MUST be English.  */
/*  These models are English-native; Cyrillic in the prompt both degrades adherence and    */
/*  pulls the model toward rendering Cyrillic on-screen text.                               */
/*                                                                                         */
/*  Russian text can leak into an assembled prompt from DB fields authored by the user or  */
/*  by the Russian-language script pipeline (Scene.action, Scene.locationDesc,             */
/*  Scene.subLocation, Location.name/visualPrompt, Character.appearance, etc.).             */
/*                                                                                         */
/*  `ensureEnglishPrompt` is applied centrally at the provider dispatch layer so no         */
/*  emitter can leak Cyrillic, regardless of which builder produced the prompt:            */
/*    - fast path: no Cyrillic → returned unchanged (no LLM call);                          */
/*    - LLM path: Cyrillic present → translate the WHOLE prompt to natural English via the  */
/*      existing chat() helper (gpt-4o), preserving structural markers and Latin names;     */
/*    - deterministic fallback: transliterateCyrillic() romanises anything the LLM leaves   */
/*      (or the entire prompt if the LLM call fails), so the output is ALWAYS Cyrillic-free. */
/* ====================================================================================== */

/** Regex mirror of hasCyrillic — kept here as the documented safety detector. */
export const CYRILLIC_RE = /[\u0400-\u04FF\u0500-\u052F]/;

const TRANSLATE_SYSTEM = [
  "You are a translator for AI image/video generation prompts.",
  "You receive a generation prompt that may mix English with Russian (Cyrillic) text.",
  "Return the prompt with every Russian (Cyrillic) fragment rendered in natural, fluent English so a text-to-image / text-to-video model can follow it.",
  "Rules:",
  "- Translate every Russian word or phrase into English, preserving the exact meaning and all visual/technical detail.",
  "- Any text that is ALREADY in English (e.g. spoken dialogue lines, camera/lens directions) MUST be copied EXACTLY, word-for-word and character-for-character — do NOT paraphrase, rephrase or 'improve' it.",
  "- Keep proper character names in Latin letters exactly as written; if a name appears in Cyrillic, transliterate it to Latin.",
  "- Preserve ALL structural markers, tags and technical directives verbatim: reference tokens like [Image1]...[ImageN], bracketed tags like [ACTION]/[NON-VERBAL]/[BLOCKING], section headers, camera/lens/framing directions, aspect ratios, line breaks and overall layout.",
  "- Do NOT add, remove, summarise or reorder content. Do NOT add commentary, quotes or code fences.",
  "- Output ONLY the resulting prompt text, fully in English.",
].join("\n");

/** In-memory cache so identical prompts (e.g. regeneration of the same scene) translate once. */
const _cache = new Map<string, string>();
const CACHE_MAX = 500;

function cacheGet(key: string): string | undefined {
  return _cache.get(key);
}
function cacheSet(key: string, value: string): void {
  if (_cache.size >= CACHE_MAX) {
    // Drop the oldest entry (Map preserves insertion order).
    const first = _cache.keys().next().value;
    if (first !== undefined) _cache.delete(first);
  }
  _cache.set(key, value);
}

/**
 * Guarantee an English-only prompt before it is sent to a media provider.
 * Never throws — on any translation failure it falls back to deterministic transliteration,
 * so the returned string is ALWAYS free of Cyrillic.
 */
export async function ensureEnglishPrompt(prompt: string | null | undefined): Promise<string> {
  const input = prompt ?? "";
  if (!input || !hasCyrillic(input)) return input; // fast path: already English/Latin

  const cached = cacheGet(input);
  if (cached !== undefined) return cached;

  let out = input;
  try {
    // Lazy import keeps this module dependency-light and avoids import cycles.
    const { chat } = await import("@/lib/ai");
    const translated = (
      await chat(TRANSLATE_SYSTEM, input, { model: "anthropic/claude-opus-5", temperature: 0.2, maxTokens: 4096 })
    ).trim();
    if (translated) out = translated;
  } catch {
    // fall through to deterministic fallback below
  }

  // Safety net: if the LLM left any Cyrillic (or the call failed), romanise the remainder.
  if (hasCyrillic(out)) out = transliterateCyrillic(out);

  cacheSet(input, out);
  return out;
}
