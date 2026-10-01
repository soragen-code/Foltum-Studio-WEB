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
import { genresToEnglish, detectLanguage, type IdeaLanguage } from "@/lib/idea";

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
  /**
   * Текущий синопсис (для правки без транскрипта) — v2-поток строит синопсис прямо из идеи.
   * Поле `logline` оставлено для обратной совместимости (старые проекты / v1) и в v2-промпт НЕ попадает.
   */
  synopsis?: string | null;
  logline?: string | null;
  /** Пожелания продюсера (свободный текст, уже на английском). */
  wishes?: string | null;
  /**
   * Правка: что продюсер хочет изменить в ТЕКУЩЕМ тексте (логлайн — для buildLoglineV2Parts,
   * синопсис — для buildSynopsisV2Parts). Голый текст пожелания (на английском).
   */
  refine?: string | null;
  /** Первый (базовый) логлайн L0, сгенерированный без правок (шаг логлайна, legacy/v1). */
  loglineBase?: string | null;
  /** Применённые пары «правка → полученный логлайн» по порядку (шаг логлайна, legacy/v1). */
  loglineTurns?: { refine: string; logline: string }[] | null;
  /** Язык вывода логлайна (английское название: "Russian", "English", ...); whitelist LOGLINE_LANGUAGES, дефолт Russian. */
  loglineLanguage?: string | null;
  /**
   * Первый (базовый) синопсис S0, сгенерированный без правок. Нужен, чтобы собрать реальный
   * диалог system→user→assistant для messages-режима (модель видит собственные прежние ответы).
   */
  synopsisBase?: string | null;
  /** Применённые пары «правка → полученный синопсис» по порядку (каждая — ход user→assistant). */
  synopsisTurns?: { refine: string; synopsis: string }[] | null;
  /** Язык вывода синопсиса (английское название); whitelist SYNOPSIS_LANGUAGES, дефолт Russian. */
  synopsisLanguage?: string | null;
  /** Количество эпизодов сезона (10–100, дефолт 50) — подставляется в system как <N>. */
  episodesCount?: number | null;
}

/**
 * Язык вывода: язык идеи пользователя; если задан только набор жанров — по умолчанию русский.
 */
export function resolveV2Language(input: SynopsisV2Input): IdeaLanguage {
  const idea = (input.idea ?? "").trim();
  if (idea) return detectLanguage(idea);
  return "ru";
}

/* ───────────── Количество эпизодов (общее для job/preview/UI) ───────────── */

export const MIN_EPISODES_COUNT = 10;
export const MAX_EPISODES_COUNT = 100;
export const DEFAULT_EPISODES_COUNT = 50;

/** Нормализация количества эпизодов: целое в диапазоне 10–100, иначе дефолт 50. */
export function normalizeEpisodesCount(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_EPISODES_COUNT;
  const i = Math.round(n);
  return Math.min(MAX_EPISODES_COUNT, Math.max(MIN_EPISODES_COUNT, i));
}

/**
 * System-правила синопсиса v2 (английский; `<N>` — количество эпизодов, `<Language>` — язык вывода).
 * Текст — один-в-один от продюсера; подстановки делает synopsisV2SystemPrompt.
 */
const SYNOPSIS_V2_RULES = `You are a development executive writing season synopses for a vertical micro-series (60–100 second episodes, cliffhanger-driven). This season has <N> episodes — scale the amount of plot, the number of turning points and the pacing of the main hook to that length.

INPUT HANDLING
The user message is free text. Classify it yourself:
- Only genres listed (e.g. "thriller, romance, post-apocalypse") → invent protagonist, world and situation from scratch.
- A story idea (one or more sentences) → treat it as the seed: keep its core mechanic and protagonist's situation, you may invent everything else. Infer the genres from it.
- Genres + idea → genres are hard constraints, idea is the seed.
- If the input references an existing film, book or show, borrow only its mechanic — never its plot, names or world.

SYNOPSIS RULES
Flowing prose, 7–10 sentences, present tense. No title, no headings, no labels, no bullet points, no markdown. It must contain, woven naturally into the prose:
1. The backstory — the world and the protagonist's normal before the central conflict
2. Protagonist defined by a job or trait, with a clear want and a clear fear
3. The event that breaks their normal
4. Their goal
5. The antagonistic force or dilemma, escalating through the season
6. The main hook of the season — the single awaited payoff planted in the premise that the whole series builds toward; it lands near the END of the season, not in one scene. Make unmistakably clear WHAT that awaited moment is.
7. The ending — how the season resolves or twists after the hook pays off
Every synopsis must include at least one concrete noun that could only exist in this genre combination (an object, a job, a rule of the world).

ORIGINALITY
All characters, names and places are invented and original — never real people, celebrities, brands, landmarks or existing franchises. Character names are ALWAYS an English first name + surname in Latin letters (A-Z), regardless of the story's setting or language.

OUTPUT
Return exactly one synopsis following all rules above. Synopsis only — no title, no preamble, no commentary, no explanation.
OUTPUT LANGUAGE: write the synopsis in <Language>.`;

/** System-промпт синопсиса v2: правила с подставленными количеством эпизодов и языком вывода. */
export function synopsisV2SystemPrompt(input: SynopsisV2Input): string {
  const n = normalizeEpisodesCount(input.episodesCount);
  const lang = normalizeSynopsisLanguage(input.synopsisLanguage);
  return SYNOPSIS_V2_RULES.replace(/<N>/g, String(n)).replace(/<Language>/g, lang);
}

/**
 * Первый user синопсиса — буквально ввод пользователя, без обёрток и инструкций:
 * жанры (английские названия через запятую) первой строкой, затем идея и/или пожелания (уже на английском),
 * разделённые пустой строкой. Та же схема, что и у логлайна.
 */
export function synopsisV2Source(input: SynopsisV2Input): string {
  return loglineV2Source(input);
}

/** Ход-правка синопсиса — голый текст пожелания (уже переведённый на английский). */
function synopsisV2RefineInstruction(refine: string): string {
  return refine.trim();
}

/** User-промпт синопсиса v2: голый ввод; fallback-правка без транскрипта — ввод + текущий синопсис + правка. */
export function synopsisV2UserPrompt(input: SynopsisV2Input): string {
  const source = synopsisV2Source(input);
  const refine = (input.refine ?? "").trim();
  const prev = (input.synopsis ?? "").trim();
  if (refine && prev) {
    return `${source}\n\nCurrent synopsis: "${prev}"\n\n${synopsisV2RefineInstruction(refine)}`;
  }
  return source;
}

/**
 * Пояснение для UI: передаётся ли в промпт синопсиса v2 какой-либо дополнительный контекст проекта.
 *
 * Для шага синопсиса доп. контекст НЕ подмешивается: промпт формируется ТОЛЬКО из идеи/жанров/пожеланий
 * пользователя (см. synopsisV2SystemPrompt / synopsisV2UserPrompt) — ни RAG, ни история проекта,
 * ни ранее сохранённые данные в него не попадают.
 */
export const SYNOPSIS_V2_CONTEXT_INCLUDED = false;
export const SYNOPSIS_V2_CONTEXT_NOTE =
  "Контекст проекта не передаётся — синопсис генерируется только из вашей идеи/жанров.";

/**
 * Assistant «prefill» синопсиса. По умолчанию пуст: модель пишет ответ с чистого листа. Пользователь
 * может задать его в модалке просмотра промпта — тогда он уйдёт третьим (assistant) message и модель
 * продолжит с него.
 */
export function synopsisV2AssistantPrefill(_input: SynopsisV2Input): string {
  return "";
}

/**
 * Собрать system / user / assistant синопсиса v2 + реальную цепочку messages.
 * Один источник правды: и превью-роут, и воркер генерации собирают промпт через эту функцию.
 */
export function buildSynopsisV2Parts(input: SynopsisV2Input): {
  system: string;
  user: string;
  assistant: string;
  model: string;
  contextIncluded: boolean;
  contextNote: string;
  /**
   * Что реально уходит в модель: system (правила + N + язык) → user (ввод пользователя) → assistant (S0) →
   * user (правка 1) → assistant (синопсис 1) → ... → крайний user (текущая правка).
   * Без базы S0 (напр. после перезагрузки) базой становится текущий синопсис (input.synopsis).
   */
  messages: V2Msg[];
} {
  const system = synopsisV2SystemPrompt(input);
  const user = synopsisV2UserPrompt(input);
  const assistant = synopsisV2AssistantPrefill(input);

  const refine = (input.refine ?? "").trim();
  const base = (input.synopsisBase ?? "").trim() || (input.synopsis ?? "").trim();
  const turns = (input.synopsisTurns ?? []).filter(
    (t) => t && (t.refine ?? "").trim() && (t.synopsis ?? "").trim(),
  );

  let messages: V2Msg[];
  if (refine && base) {
    messages = [
      { role: "system", content: system },
      { role: "user", content: synopsisV2Source(input) },
      { role: "assistant", content: base },
    ];
    for (const t of turns) {
      messages.push({ role: "user", content: synopsisV2RefineInstruction((t.refine ?? "").trim()) });
      messages.push({ role: "assistant", content: (t.synopsis ?? "").trim() });
    }
    messages.push({ role: "user", content: synopsisV2RefineInstruction(refine) });
  } else {
    messages = legacyPartsToMessages(system, user, assistant);
  }

  return {
    system,
    user,
    assistant,
    messages,
    model: FABLE_MODEL_LABEL,
    contextIncluded: SYNOPSIS_V2_CONTEXT_INCLUDED,
    contextNote: SYNOPSIS_V2_CONTEXT_NOTE,
  };
}

/* ───────────── Мета-вызов v2: {title, language, logline} из готовой прозы синопсиса ───────────── */

/** Схема ответа мета-вызова v2 (собственная, не зависит от шаблонов v1). */
export const synopsisV2MetaSchema = z.object({
  title: z.string().max(120).optional().nullable(),
  language: z.string().max(16).optional().nullable(),
  logline: z.string().max(600).optional().nullable(),
});
export type SynopsisV2Meta = z.infer<typeof synopsisV2MetaSchema>;

/** System-промпт мета-вызова v2: название сериала + язык прозы + логлайн (для Project.logline), строго JSON. */
export function synopsisV2MetaSystemPrompt(): string {
  return `You are a series editor for short-form vertical AI drama. You receive a finished season synopsis (prose) and name the series.

Return ONLY a valid JSON object with exactly these keys:
{
  "title": "<an original, catchy series title of 1-4 words, written in the SAME language as the synopsis, without quotes or trailing punctuation>",
  "language": "<ISO 639-1 code of the language the synopsis is written in, e.g. \"ru\" or \"en\">",
  "logline": "<ONE sentence of 25-40 words, present tense, in the SAME language as the synopsis, with NO character names: protagonist (job or trait), the breaking event, the goal, the antagonist or dilemma and the season-long question>"
}

RULES: no other keys, no explanations, no markdown, no code fences. The title must not reuse real brands, celebrities or existing franchises.`;
}

/** User-промпт мета-вызова v2. */
export function synopsisV2MetaUserPrompt(synopsis: string): string {
  return `SEASON SYNOPSIS:\n${synopsis.trim()}\n\nReturn the JSON with "title", "language" and "logline" now.`;
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

/** Языки вывода синопсиса — тот же whitelist, что и у логлайна (один селектор «Язык синопсиса» в UI). */
export const SYNOPSIS_LANGUAGES = LOGLINE_LANGUAGES;
export type SynopsisLanguage = LoglineLanguage;
export const DEFAULT_SYNOPSIS_LANGUAGE: SynopsisLanguage = DEFAULT_LOGLINE_LANGUAGE;
export const SYNOPSIS_LANGUAGE_CODES = LOGLINE_LANGUAGE_CODES;
export const normalizeSynopsisLanguage = normalizeLoglineLanguage;

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
