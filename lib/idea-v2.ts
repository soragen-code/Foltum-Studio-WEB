/**
 * «Новый проект v2.0» — отдельный поток идея → синопсис.
 *
 * Единый источник правды для промптов синопсиса v2: и превью (роут .../preview), и генерация
 * (воркер synopsis-v2-job) собирают system/user через ОДНИ и те же функции, чтобы отредактированный
 * пользователем промпт точно соответствовал тому, что показывалось на превью.
 *
 * В этом режиме для LLM используется ТОЛЬКО одна модель — «Claude Fable 5.1» (лейбл для UI/логов);
 * на бэкенд отправляется реальный slug WaveSpeed (Claude Opus 5), под которым работает шлюз.
 */
import { GENRE_BY_ID, genresToEnglish, detectLanguage, type IdeaLanguage } from "@/lib/idea";

/** Реальный slug модели на шлюзе WaveSpeed (то, что уходит в бэкенд). */
export const FABLE_MODEL = "anthropic/claude-opus-5";
/** Человекочитаемый лейбл модели для UI и превью промпта. */
export const FABLE_MODEL_LABEL = "Claude Fable 5.1";

export interface SynopsisV2Input {
  /** Идея, описанная пользователем (может быть пустой, если выбран набор жанров). */
  idea?: string | null;
  /** Идентификаторы выбранных жанров (используются, когда идея не задана). */
  genres?: string[];
}

/**
 * Язык вывода: язык идеи пользователя; если задан только набор жанров — по умолчанию русский.
 */
export function resolveV2Language(input: SynopsisV2Input): IdeaLanguage {
  const idea = (input.idea ?? "").trim();
  if (idea) return detectLanguage(idea);
  return "ru";
}

/** Общие правила формата синопсиса v2 (7–10 предложений: предыстория, основной хук, концовка). */
const SYNOPSIS_V2_RULES = `Write a SINGLE season SYNOPSIS as flowing prose of 7 to 10 sentences. Output ONLY the prose — no title, no headings, no labels, no bullet points, no markdown.

The synopsis MUST contain the following three elements, woven naturally into the prose. Do NOT print the words "backstory", "hook" or "ending" as labels — they must be felt as content, not written as headers:
1. BACKSTORY — the setting and the situation before the central conflict: who the protagonist is, the world they live in, and what is at stake.
2. THE MAIN HOOK — the single payoff the audience anticipates from the very first episode. It lands near the END of the season and is the central cliffhanger, the awaited moment the whole series builds toward. Make unmistakably clear WHAT that awaited moment is.
3. THE ENDING — how the season resolves or twists after the hook pays off.

CRAFT: a strong protagonist with a clear want and a clear fear, escalating conflict, real dramatic turning points, and an emotional, gripping tone made for short vertical AI-drama episodes (very short, cliffhanger-driven, mobile vertical feed). Be specific and concrete — no generic filler.

ORIGINALITY: all characters, names and places are invented and original — never real people, celebrities, brands, landmarks or existing franchises. Character names are ALWAYS an English first name + surname in Latin letters (A-Z), regardless of the story's setting or language.`;

/** System-промпт синопсиса v2. Правила — на английском; язык ВЫВОДА зависит от идеи/жанров. */
export function synopsisV2SystemPrompt(input: SynopsisV2Input): string {
  const idea = (input.idea ?? "").trim();
  const languageRule = idea
    ? "LANGUAGE: write the synopsis in the SAME language as the user's idea (Russian idea → Russian synopsis, English idea → English synopsis, etc.)."
    : "LANGUAGE: no idea text was given, only genres — write the synopsis in Russian.";
  return `You are a head writer for short-form vertical AI drama series.

${SYNOPSIS_V2_RULES}

${languageRule}`;
}

/** User-промпт синопсиса v2: либо идея пользователя, либо задание придумать историю по жанрам. */
export function synopsisV2UserPrompt(input: SynopsisV2Input): string {
  const idea = (input.idea ?? "").trim();
  if (idea) {
    return `IDEA:\n${idea}\n\nWrite the season synopsis prose now (7-10 sentences: backstory, the awaited main hook near the end, and the ending).`;
  }
  const genres = input.genres ?? [];
  const english = genresToEnglish(genres);
  const premises = genres
    .map((g) => {
      const entry = GENRE_BY_ID[(g ?? "").trim().toLowerCase()] as { premise?: string } | undefined;
      return entry?.premise;
    })
    .filter(Boolean) as string[];
  const premiseBlock = premises.length
    ? `\n\nGENRE PREMISE(S) TO FOLLOW:\n${premises.map((p) => `- ${p}`).join("\n")}`
    : "";
  return `The producer has NOT written a story. Invent an original, gripping story in the following genre(s): ${english.join(", ") || "drama"}. Combine them if more than one is given, avoid clichés, and surprise the viewer while staying coherent.${premiseBlock}\n\nWrite the season synopsis prose now (7-10 sentences: backstory, the awaited main hook near the end, and the ending).`;
}

/**
 * Собрать промпт синопсиса v2 (system/user) + лейбл модели для отображения.
 * Используется и превью-роутом, и воркером генерации, чтобы гарантировать идентичность.
 */
export function buildSynopsisV2Prompt(input: SynopsisV2Input): { system: string; user: string; model: string } {
  return {
    system: synopsisV2SystemPrompt(input),
    user: synopsisV2UserPrompt(input),
    model: FABLE_MODEL_LABEL,
  };
}
