/**
 * «Новый проект v2.0» — отдельный поток идея → синопсис.
 *
 * Единый источник правды для промптов синопсиса v2: и превью (роут .../preview), и генерация
 * (воркер synopsis-v2-job) собирают messages через ОДНИ и те же функции, чтобы отредактированный
 * пользователем промпт точно соответствовал тому, что показывалось на превью. Диалог ВСЕГДА начинается
 * с роли system (правила), далее user (задание / L0-источник) → assistant → … → крайний user (см. V2Msg).
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

/**
 * Сообщение диалога v2: system (правила — ВСЕГДА первым, чтобы модель не дрейфовала) → user (задание / L0-источник)
 * → assistant (ответ) → user (правка) → … → крайний user. Первый user содержит ТОЛЬКО своё содержимое, без правил.
 */
export type V2Msg = { role: "system" | "user" | "assistant"; content: string };

/** Склеить system-текст и user-текст в один текст (system первым). Для одиночных вызовов, где нужен один user. */
export function mergeSystemIntoUser(system: string, user: string): string {
  const s = (system ?? "").trim();
  const u = (user ?? "").trim();
  return s && u ? `${s}\n\n${u}` : s || u;
}

/** Собрать messages из частей: [system, user, (assistant-prefill)]. */
export function legacyPartsToMessages(system: string, user: string, assistant?: string | null): V2Msg[] {
  const out: V2Msg[] = [];
  const sys = (system ?? "").trim();
  if (sys) out.push({ role: "system", content: sys });
  out.push({ role: "user", content: (user ?? "").trim() });
  const a = (assistant ?? "").trim();
  if (a) out.push({ role: "assistant", content: a });
  return out;
}

/**
 * Если в начале user-текста стоит system-текст (старый формат «правила слиты в первый user», сохранённые
 * черновики/override) — отрезаем его. Иначе текст как есть.
 */
export function stripSystemPrefix(system: string, content: string): string {
  const sys = (system ?? "").trim();
  const c = (content ?? "").trim();
  return sys && c.startsWith(sys) ? c.slice(sys.length).replace(/^\s+/, "") : c;
}

/**
 * Нормализация присланного диалога (override из модалки, старые данные) к каноническому виду с system первым:
 *   • system уже есть первым → оставляем как есть (в т.ч. отредактированный пользователем);
 *   • system нет → вставляем автоматический из шаблона правил (defaultSystem);
 *   • из первого user отрезаем префикс system-текста, если он там обнаружен (старый слитый формат).
 * Прочие system-сообщения не на первой позиции отбрасываются.
 */
export function normalizeV2Messages(messages: V2Msg[], defaultSystem: string): V2Msg[] {
  const list = (messages ?? []).filter((m) => m && typeof m.content === "string");
  const sys = list[0]?.role === "system" ? list[0].content.trim() : (defaultSystem ?? "").trim();
  const rest = list.filter((m) => m.role !== "system");
  const firstUser = rest.findIndex((m) => m.role === "user");
  const body = rest.map((m, i) =>
    i === firstUser
      ? { role: "user" as const, content: stripSystemPrefix(sys, stripSystemPrefix(defaultSystem, m.content)) }
      : m,
  );
  return sys ? [{ role: "system", content: sys }, ...body] : body;
}

/** Плоский текст диалога для prompt-log («SYSTEM:/USER:/ASSISTANT:», хронологически). */
export function flattenV2Messages(messages: V2Msg[]): string {
  return messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join("\n\n");
}

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
  /**
   * Правка логлайна: что продюсер хочет изменить в ТЕКУЩЕМ логлайне (input.logline).
   * Если задано вместе с logline — промпт логлайна собирается в режиме уточнения
   * (контекст сохраняется: модель дорабатывает текущий логлайн, а не пишет с нуля).
   */
  refine?: string | null;
  /**
   * Первый (базовый) логлайн L0, сгенерированный без правок. Нужен, чтобы собрать реальный
   * диалог system→user→assistant для messages-режима (модель видит собственные прежние ответы).
   */
  loglineBase?: string | null;
  /**
   * Применённые пары «правка → полученный логлайн» по порядку. Каждая пара становится ходом
   * user(правка)→assistant(логлайн) в транскрипте, поэтому прежние правки не отменяются моделью.
   */
  loglineTurns?: { refine: string; logline: string }[] | null;
  /** Язык вывода логлайна (английское название: "Russian", "English", …); whitelist LOGLINE_LANGUAGES, дефолт Russian. */
  loglineLanguage?: string | null;
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
    return `LOGLINE:\n${logline}${source}\n\nWrite the season synopsis prose expanding THIS logline (7-10 sentences: backstory, the awaited main hook near the end, and the ending). Keep the logline's hero, goal and stakes. The logline deliberately names no characters — invent original names yourself (English first name + surname in Latin letters).`;
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
  /** Что реально уходит в модель: system (правила) → user (задание) → (assistant-prefill). */
  messages: V2Msg[];
} {
  const system = synopsisV2SystemPrompt(input);
  const user = synopsisV2UserPrompt(input);
  const assistant = synopsisV2AssistantPrefill(input);
  return {
    system,
    user,
    assistant,
    messages: legacyPartsToMessages(system, user, assistant),
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

/* ───────────── Логлайн v2: Идея/жанры → 1 предложение (25–40 слов, без имён, сезонный вопрос) ───────────── */

/** Языки вывода логлайна (whitelist для API; значение — английское название языка, подставляется в system). */
export const LOGLINE_LANGUAGES = ["Russian", "English", "Spanish", "German", "French"] as const;
export type LoglineLanguage = (typeof LOGLINE_LANGUAGES)[number];
export const DEFAULT_LOGLINE_LANGUAGE: LoglineLanguage = "Russian";
/** Соответствие языка логлайна ISO-коду Project.language. */
export const LOGLINE_LANGUAGE_CODES: Record<LoglineLanguage, IdeaLanguage> = {
  Russian: "ru",
  English: "en",
  Spanish: "es",
  German: "de",
  French: "fr",
};
/** Нормализация значения с клиента: whitelist, иначе дефолт ("Russian"). */
export function normalizeLoglineLanguage(value: unknown): LoglineLanguage {
  const v = typeof value === "string" ? value.trim() : "";
  const hit = LOGLINE_LANGUAGES.find((l) => l.toLowerCase() === v.toLowerCase());
  return hit ?? DEFAULT_LOGLINE_LANGUAGE;
}

/** Краткое описание правил логлайна для русского UI (в API уходят английские правила LOGLINE_V2_RULES). */
export const LOGLINE_V2_FORMULA_RU =
  "одно предложение, 25–40 слов, в настоящем времени, без имён персонажей: герой (профессия или черта), событие, цель, антагонист или дилемма и сезонный вопрос";
export const LOGLINE_V2_EXAMPLE_RU =
  "Уволенная реставраторша икон соглашается подделать чудотворный образ для криминального епископа, чтобы выкупить дочь из долгов, но подлинник начинает исцелять людей, и к финалу сезона придётся решить, кто из них настоящая святая.";

/** Правила логлайна v2 (английский — уходит в system; строка OUTPUT LANGUAGE добавляется из выбора пользователя). */
const LOGLINE_V2_RULES = `You are a development executive writing loglines for a vertical micro-series (60–100 second episodes, 50–60 episodes per season, cliffhanger-driven).

INPUT HANDLING
The user message is free text. Classify it yourself:
- Only genres listed (e.g. "thriller, romance, post-apocalypse") → invent protagonist, world and situation from scratch.
- A story idea (one or more sentences) → treat it as the seed: keep its core mechanic and protagonist's situation, you may invent everything else. Infer the genres from it.
- Genres + idea → genres are hard constraints, idea is the seed.
- If the input references an existing film, book or show, borrow only its mechanic — never its plot, names or world.

LOGLINE RULES
One sentence, 25–40 words, present tense, no character names. It must contain:
1. Protagonist defined by a job or trait
2. The event that breaks their normal
3. Their goal
4. The antagonistic force or dilemma
5. The season question — the unresolved tension planted in the premise that can only pay off near the end of the season, not in one scene
Every logline must include at least one concrete noun that could only exist in this genre combination (an object, a job, a rule of the world).

OUTPUT
Return exactly one logline following all rules above. Logline only — no title, no preamble, no commentary, no explanation.`;

/** Авто-system логлайна: правила + одна строка с языком вывода. Единый источник для job, preview и «Сбросить к авто». */
export function loglineV2SystemPrompt(input: SynopsisV2Input): string {
  const lang = normalizeLoglineLanguage(input.loglineLanguage);
  return `${LOGLINE_V2_RULES}\nOUTPUT LANGUAGE: write the logline in ${lang}.`;
}

/**
 * Первый user — буквально ввод пользователя, без обёрток и инструкций:
 * жанры (английские названия через запятую) первой строкой, затем идея и/или пожелания (уже на английском),
 * разделённые пустой строкой.
 */
function loglineV2Source(input: SynopsisV2Input): string {
  const idea = (input.idea ?? "").trim();
  const english = genresToEnglish(input.genres ?? []).filter(Boolean);
  const wishes = (input.wishes ?? "").trim();
  const blocks = [english.join(", "), idea, wishes].filter(Boolean);
  return blocks.join("\n\n") || "drama";
}

/** Ход-правка — голый текст пожелания (уже переведённый на английский). */
function loglineV2RefineInstruction(refine: string): string {
  return refine.trim();
}

export function loglineV2UserPrompt(input: SynopsisV2Input): string {
  const source = loglineV2Source(input);
  const refine = (input.refine ?? "").trim();
  const prev = (input.logline ?? "").trim();

  // Fallback (нет транскрипта): одноходовая правка с текущим логлайном — минимально.
  if (refine && prev) {
    return `${source}\n\nCurrent logline: "${prev}"\n\n${loglineV2RefineInstruction(refine)}`;
  }

  return source;
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
  /**
   * Что реально уходит в модель: system (правила + язык) → user (ввод пользователя) → assistant (L0) →
   * user (правка 1) → assistant (логлайн 1) → ... → крайний user (текущая правка).
   * Без базы L0 (напр. после перезагрузки) базой становится текущий логлайн (input.logline): история
   * правок пуста, но модель всё равно видит прежний ответ как свой.
   */
  messages: V2Msg[];
} {
  const system = loglineV2SystemPrompt(input);
  const user = loglineV2UserPrompt(input);
  const assistant = loglineV2AssistantPrefill(input);

  const refine = (input.refine ?? "").trim();
  const base = (input.loglineBase ?? "").trim() || (input.logline ?? "").trim();
  const turns = (input.loglineTurns ?? []).filter(
    (t) => t && (t.refine ?? "").trim() && (t.logline ?? "").trim(),
  );

  let messages: V2Msg[];
  if (refine && base) {
    // Реальный диалог: модель видит собственные прежние ответы, и прежние правки не отменяются.
    messages = [
      { role: "system", content: system },
      { role: "user", content: loglineV2Source(input) },
      { role: "assistant", content: base },
    ];
    for (const t of turns) {
      messages.push({ role: "user", content: loglineV2RefineInstruction((t.refine ?? "").trim()) });
      messages.push({ role: "assistant", content: (t.logline ?? "").trim() });
    }
    messages.push({ role: "user", content: loglineV2RefineInstruction(refine) });
  } else {
    messages = legacyPartsToMessages(system, user, assistant);
  }

  return {
    system,
    user,
    assistant,
    model: FABLE_MODEL_LABEL,
    contextIncluded: false,
    contextNote: LOGLINE_V2_CONTEXT_NOTE,
    messages,
  };
}
