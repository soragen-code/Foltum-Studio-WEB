/**
 * «Новый проект v2.0» — отдельный поток идея → синопсис.
 *
 * Единый источник правды для промптов синопсиса v2: и превью (роут .../preview), и генерация
 * (воркер synopsis-v2-job) собирают РАЗДЕЛЬНО system и user через ОДНИ и те же функции, чтобы
 * отредактированный пользователем промпт точно соответствовал тому, что показывалось на превью.
 *
 * В этом режиме для LLM используется ТОЛЬКО одна модель — «Claude Fable 5.1» (лейбл для UI/логов);
 * на бэкенд отправляется реальный slug WaveSpeed (Claude Opus 5), под которым работает шлюз.
 */
import { z } from "zod";
// Из v1 берём только ДАННЫЕ/утилиты (жанры, определение языка) — промпт-шаблоны v2 собственные.
import { GENRE_BY_ID, genresToEnglish, detectLanguage, type IdeaLanguage } from "@/lib/idea";

/** Реальный slug модели на шлюзе WaveSpeed (то, что уходит в бэкенд). */
export const FABLE_MODEL = "anthropic/claude-opus-5";
/**
 * Стадия проекта, на которой ЗАВЕРШАЕТСЯ поток v2 (пока — после генерации синопсиса).
 * Это отдельное значение, НЕ входящее в пайплайн v1 (idea/logline/synopsis/structure/...),
 * поэтому проект не подхватывается экранами/стадиями v1 и остаётся на экране v2 с результатом.
 */
export const SYNOPSIS_V2_STAGE = "synopsis_v2";

/**
 * Промежуточная стадия потока v2: логлайн сгенерирован и ждёт аппрува пользователя
 * (Идея → Логлайн → Синопсис). Тоже вне пайплайна v1.
 */
export const LOGLINE_V2_STAGE = "logline_v2";

/** Человекочитаемый лейбл модели для UI и превью промпта. */
export const FABLE_MODEL_LABEL = "Claude Fable 5.1";

export interface SynopsisV2Input {
  /** Идея, описанная пользователем (может быть пустой, если выбран набор жанров). */
  idea?: string | null;
  /** Идентификаторы выбранных жанров (используются, когда идея не задана). */
  genres?: string[];
  /** Утверждённый логлайн — если задан, синопсис разворачивает именно его. */
  logline?: string | null;
  /** Пожелания продюсера (только для режима жанров, шаг логлайна). */
  wishes?: string | null;
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
  const logline = (input.logline ?? "").trim();
  if (logline) {
    const source = idea
      ? `\n\nORIGINAL IDEA (for context):\n${idea}`
      : input.genres?.length
        ? `\n\nGENRE(S): ${genresToEnglish(input.genres).join(", ")}`
        : "";
    return `LOGLINE:\n${logline}${source}\n\nWrite the season synopsis prose expanding THIS logline (7-10 sentences: backstory, the awaited main hook near the end, and the ending). Keep the logline's hero, goal and stakes; keep character names exactly as in the logline.`;
  }
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
 * Пояснение для UI: передаётся ли в промпт синопсиса v2 какой-либо дополнительный контекст проекта.
 *
 * Для шага синопсиса доп. контекст НЕ подмешивается: промпт формируется ТОЛЬКО из идеи/жанров
 * пользователя (см. synopsisV2SystemPrompt / synopsisV2UserPrompt) — ни RAG, ни история проекта,
 * ни ранее сохранённые данные в него не попадают.
 */
export const SYNOPSIS_V2_CONTEXT_INCLUDED = false;
export const SYNOPSIS_V2_CONTEXT_NOTE =
  "Контекст проекта не передаётся — синопсис генерируется только из вашей идеи/жанров.";

/**
 * Собрать РАЗДЕЛЬНО system и user синопсиса v2 + лейбл модели и индикатор контекста.
 *
 * Один источник правды: и превью-роут, и воркер генерации собирают промпт через эту функцию.
 * Пользователь видит и редактирует ДВА отдельных блока — что уходит в system и что в user;
 * в модель они отправляются двумя messages в одном вызове streamChatText.
 */
/**
 * Assistant «prefill» синопсиса. По умолчанию пуст: модель пишет ответ с чистого листа. Пользователь
 * может задать его в модалке просмотра промпта — тогда он уйдёт третьим (assistant) message и модель
 * продолжит с него. Держим отдельной функцией, чтобы при желании задать дефолтный зачин в одном месте.
 */
export function synopsisV2AssistantPrefill(_input: SynopsisV2Input): string {
  return "";
}

export function buildSynopsisV2Parts(input: SynopsisV2Input): {
  system: string;
  user: string;
  assistant: string;
  model: string;
  contextIncluded: boolean;
  contextNote: string;
} {
  return {
    system: synopsisV2SystemPrompt(input),
    user: synopsisV2UserPrompt(input),
    assistant: synopsisV2AssistantPrefill(input),
    model: FABLE_MODEL_LABEL,
    contextIncluded: SYNOPSIS_V2_CONTEXT_INCLUDED,
    contextNote: (input.logline ?? "").trim()
      ? "Синопсис строится на основе утверждённого логлайна (+ ваша идея/жанры). Другой контекст проекта не передаётся."
      : SYNOPSIS_V2_CONTEXT_NOTE,
  };
}

/* ───────────── Мета-вызов v2: {title, language} из готовой прозы синопсиса ───────────── */

/** Схема ответа мета-вызова v2 (собственная, не зависит от шаблонов v1). */
export const synopsisV2MetaSchema = z.object({
  title: z.string().max(120).optional().nullable(),
  language: z.string().max(16).optional().nullable(),
});
export type SynopsisV2Meta = z.infer<typeof synopsisV2MetaSchema>;

/** System-промпт мета-вызова v2: название сериала + язык прозы, строго JSON. */
export function synopsisV2MetaSystemPrompt(): string {
  return `You are a series editor for short-form vertical AI drama. You receive a finished season synopsis (prose) and name the series.

Return ONLY a valid JSON object with exactly these keys:
{
  "title": "<an original, catchy series title of 1-4 words, written in the SAME language as the synopsis, without quotes or trailing punctuation>",
  "language": "<ISO 639-1 code of the language the synopsis is written in, e.g. \"ru\" or \"en\">"
}

RULES: no other keys, no explanations, no markdown, no code fences. The title must not reuse real brands, celebrities or existing franchises.`;
}

/** User-промпт мета-вызова v2. */
export function synopsisV2MetaUserPrompt(synopsis: string): string {
  return `SEASON SYNOPSIS:\n${synopsis.trim()}\n\nReturn the JSON with "title" and "language" now.`;
}

/* ───────────── Логлайн v2: Идея/жанры → 1 предложение по формуле ───────────── */

/** Пример формулы логлайна для русского UI (в API уходят английские правила LOGLINE_V2_RULES). */
export const LOGLINE_V2_FORMULA_RU = "Когда [событие], [герой] должен [цель], иначе [ставка].";
export const LOGLINE_V2_EXAMPLE_RU =
  "Когда банк отбирает его дом, бывший трейдер должен за 30 дней отыграть миллион на рынке, где сам же всех и обманул.";

/** Правила логлайна v2 (английский — уходит в system). */
const LOGLINE_V2_RULES = `Write ONE LOGLINE for the season — exactly ONE sentence — following this formula:
"When [event], [hero] must [goal], or else [stakes]."

- [event] — the inciting incident that shatters the hero's normal life.
- [hero] — the protagonist, with a short defining trait or role (you may name them).
- [goal] — a concrete, visual goal the hero must achieve, ideally with a deadline or a sharp constraint.
- [stakes] — what the hero loses if they fail; make it personal and high.

Adapt the connecting words naturally to the output language, but keep the four parts of the formula in this order.

FORMAT: output ONLY the single sentence — no title, no label, no quotes around it, no markdown, no explanations, no alternatives.

CRAFT: gripping, specific and concrete, made for short vertical AI-drama episodes (cliffhanger-driven, mobile vertical feed). No generic filler, no clichés.

ORIGINALITY: all characters, names and places are invented and original — never real people, celebrities, brands, landmarks or existing franchises. If a character is named, the name is ALWAYS an English first name + surname in Latin letters (A-Z), regardless of the story's setting or language.`;

export function loglineV2SystemPrompt(input: SynopsisV2Input): string {
  const idea = (input.idea ?? "").trim();
  const languageRule = idea
    ? "LANGUAGE: write the logline in the SAME language as the user's idea (Russian idea → Russian logline, English idea → English logline, etc.). Character names stay in Latin letters."
    : "LANGUAGE: no idea text was given, only genres — write the logline in Russian. Character names stay in Latin letters.";
  return `You are a head writer for short-form vertical AI drama series.

${LOGLINE_V2_RULES}

${languageRule}`;
}

export function loglineV2UserPrompt(input: SynopsisV2Input): string {
  const idea = (input.idea ?? "").trim();
  const tail = `\n\nWrite the one-sentence logline now: "When [event], [hero] must [goal], or else [stakes]."`;
  if (idea) return `IDEA:\n${idea}${tail}`;
  const genres = input.genres ?? [];
  const english = genresToEnglish(genres);
  const premises = genres
    .map((g) => (GENRE_BY_ID[(g ?? "").trim().toLowerCase()] as { premise?: string } | undefined)?.premise)
    .filter(Boolean) as string[];
  const premiseBlock = premises.length
    ? `\n\nGENRE PREMISE(S) TO FOLLOW:\n${premises.map((p) => `- ${p}`).join("\n")}`
    : "";
  const wishes = (input.wishes ?? "").trim();
  const wishesBlock = wishes ? `\n\nPRODUCER'S WISHES (incorporate into the logline):\n${wishes}` : "";
  return `The producer has NOT written a story. Invent an original, gripping story in the following genre(s): ${english.join(", ") || "drama"}. Combine them if more than one is given, avoid clichés, and surprise the viewer while staying coherent.${premiseBlock}${wishesBlock}${tail}`;
}

/** Assistant-prefill логлайна — по умолчанию пуст. */
export function loglineV2AssistantPrefill(_input: SynopsisV2Input): string {
  return "";
}

export const LOGLINE_V2_CONTEXT_NOTE =
  "Контекст проекта не передаётся — логлайн генерируется только из вашей идеи/жанров.";

export function buildLoglineV2Parts(input: SynopsisV2Input): {
  system: string;
  user: string;
  assistant: string;
  model: string;
  contextIncluded: boolean;
  contextNote: string;
} {
  return {
    system: loglineV2SystemPrompt(input),
    user: loglineV2UserPrompt(input),
    assistant: loglineV2AssistantPrefill(input),
    model: FABLE_MODEL_LABEL,
    contextIncluded: false,
    contextNote: LOGLINE_V2_CONTEXT_NOTE,
  };
}
