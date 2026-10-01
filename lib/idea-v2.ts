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

// ─────────────────────────────────────────────────────────────────────────────
// Шаг 3 потока v2: «Сюжет сезона по сериям» — посерийный пересказ утверждённого синопсиса.
// ─────────────────────────────────────────────────────────────────────────────

/** Project.stage после генерации сюжета сезона v2 (конечная стадия v2 до перехода в structure). */
export const SEASON_PLOT_V2_STAGE = "season_plot_v2";

/** Сюжет сезона утверждён (стадия season_plot_v2 + непустой seasonPlotV2) → шаги 1–3 только для чтения;
 *  редактируются лишь сценарии серий. Используется фронтом и роутами v2 (synopsis/plot/logline/reset). */
export function isSeasonPlotV2Locked(p: { stage?: string | null; seasonPlotV2?: unknown } | null | undefined): boolean {
  return !!p && p.stage === SEASON_PLOT_V2_STAGE && String(p.seasonPlotV2 ?? "").trim().length > 0;
}
export const SEASON_PLOT_V2_LOCKED_ERROR = "Season plot is approved — only episode scripts can be edited";

/** Правила (system) сюжета сезона v2. `<N>` — количество эпизодов, `<Language>` — язык синопсиса. Текст — дословно по ТЗ. */
export const SEASON_PLOT_V2_RULES = `You are a development executive breaking an approved season synopsis into an episode-by-episode season plot for a vertical micro-series (60–100 second episodes, cliffhanger-driven). This season has exactly <N> episodes.

INPUT HANDLING
The user message contains the approved season synopsis; later messages may contain change requests. Keep the synopsis's protagonist, world, goal, antagonistic force, main hook and ending exactly as established — invent only the connective tissue between them. Apply the newest change request while keeping everything that already works and without reverting earlier changes.

SEASON STRUCTURE RULES
- Exactly <N> episodes, numbered 1 to <N>, in order. No episode skipped, merged or added.
- Each episode is a compact retelling of 2–4 sentences, present tense — not a detailed treatment. Keep it brief.
- Every episode ENDS on an intriguing moment: a cliffhanger, reveal, reversal or unanswered question that forces the viewer into the next episode. The last sentence of each episode IS that moment.
- Every episode advances the plot; no filler, no recaps.
- Escalate across the season: stakes rise, the antagonistic force tightens, the main hook of the synopsis pays off near the END of the season, the ending/twist lands in the final episode(s).
- Use the character names from the synopsis. Any new character gets an English first name + surname in Latin letters (A-Z). No real people, brands, landmarks or existing franchises.

OUTPUT FORMAT
Plain text only. For each episode: a line containing only "#<n>" (e.g. "#1"), then the episode summary on the following line(s). One blank line between episodes. No titles, no headings, no preamble, no commentary, no markdown other than the "#<n>" markers.
OUTPUT LANGUAGE: write the plot in <Language>.`;

export interface SeasonPlotV2Input {
  /** Утверждённый синопсис — первый user как есть, на своём языке (без перевода). */
  synopsis?: string | null;
  /** Количество эпизодов (10–100) → <N>. */
  episodesCount?: number | null;
  /** Язык синопсиса (английское название) → <Language>. */
  synopsisLanguage?: string | null;
  /** Текущий сюжет (для fallback-правки без транскрипта). */
  plot?: string | null;
  /** Правка (уже на английском). */
  refine?: string | null;
  /** Базовый сюжет P0 (без правок) и применённые пары «правка → сюжет». */
  plotBase?: string | null;
  plotTurns?: { refine: string; plot: string }[] | null;
}

/** System-промпт сюжета сезона v2 с подставленными <N> и <Language>. */
export function seasonPlotV2SystemPrompt(input: SeasonPlotV2Input): string {
  const n = normalizeEpisodesCount(input.episodesCount);
  const lang = normalizeSynopsisLanguage(input.synopsisLanguage);
  return SEASON_PLOT_V2_RULES.replace(/<N>/g, String(n)).replace(/<Language>/g, lang);
}

/** Первый user сюжета — синопсис как есть. */
export function seasonPlotV2Source(input: SeasonPlotV2Input): string {
  return (input.synopsis ?? "").trim();
}

/** User-промпт (legacy-вид): синопсис; fallback-правка без транскрипта — синопсис + текущий сюжет + правка. */
export function seasonPlotV2UserPrompt(input: SeasonPlotV2Input): string {
  const source = seasonPlotV2Source(input);
  const refine = (input.refine ?? "").trim();
  const prev = (input.plot ?? "").trim();
  if (refine && prev) return `${source}\n\nCurrent plot: "${prev}"\n\n${refine}`;
  return source;
}

export const SEASON_PLOT_V2_CONTEXT_NOTE =
  "Контекст проекта не передаётся — сюжет сезона строится только из утверждённого синопсиса.";

/**
 * Собрать system / user и реальную цепочку messages сюжета сезона v2 (единый источник для превью и воркера):
 * system → user (синопсис) → assistant (P0) → user (правка 1) → assistant (сюжет 1) → … → крайний user (правка).
 */
export function buildSeasonPlotV2Parts(input: SeasonPlotV2Input): {
  system: string;
  user: string;
  assistant: string;
  model: string;
  contextIncluded: boolean;
  contextNote: string;
  messages: V2Msg[];
} {
  const system = seasonPlotV2SystemPrompt(input);
  const user = seasonPlotV2UserPrompt(input);
  const refine = (input.refine ?? "").trim();
  const base = (input.plotBase ?? "").trim() || (input.plot ?? "").trim();
  const turns = (input.plotTurns ?? []).filter((t) => t && (t.refine ?? "").trim() && (t.plot ?? "").trim());

  let messages: V2Msg[];
  if (refine && base) {
    messages = [
      { role: "system", content: system },
      { role: "user", content: seasonPlotV2Source(input) },
      { role: "assistant", content: base },
    ];
    for (const t of turns) {
      messages.push({ role: "user", content: (t.refine ?? "").trim() });
      messages.push({ role: "assistant", content: (t.plot ?? "").trim() });
    }
    messages.push({ role: "user", content: refine });
  } else {
    messages = legacyPartsToMessages(system, user, "");
  }
  return { system, user, assistant: "", messages, model: FABLE_MODEL_LABEL, contextIncluded: false, contextNote: SEASON_PLOT_V2_CONTEXT_NOTE };
}

export type SeasonPlotEpisode = { n: number; text: string };

/**
 * Разбор сюжета сезона по маркерам "#<n>" (строка, содержащая только маркер; допускаются "# 3", "#3.", "#3:").
 * Возвращает null, если маркеров нет (клиент показывает сырой текст).
 */
export function parseSeasonPlotV2(text: string | null | undefined): SeasonPlotEpisode[] | null {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: SeasonPlotEpisode[] = [];
  let cur: SeasonPlotEpisode | null = null;
  for (const raw of lines) {
    const m = /^\s*#\s*(\d{1,3})\s*[.:)]?\s*$/.exec(raw);
    if (m) {
      if (cur) out.push(cur);
      cur = { n: Number(m[1]), text: "" };
      continue;
    }
    if (cur) cur.text += (cur.text ? "\n" : "") + raw;
  }
  if (cur) out.push(cur);
  if (!out.length) return null;
  return out.map((e) => ({ n: e.n, text: e.text.trim() }));
}

/** Язык синопсиса по коду Project.language ("ru" → "Russian"); неизвестный код → дефолт (Russian). */
export function synopsisLanguageFromCode(code: string | null | undefined): SynopsisLanguage {
  const found = SYNOPSIS_LANGUAGES.find((name) => SYNOPSIS_LANGUAGE_CODES[name] === code);
  return normalizeSynopsisLanguage(found);
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 · уровень эпизода: вкладка «Сценарий» (диалоговый сценарий под вертикаль, слаглайны INT./EXT.)
// ─────────────────────────────────────────────────────────────────────────────

/** Правила (system) сценария эпизода v2. `<Language>` — язык синопсиса. Текст — дословно по ТЗ. */
export const EPISODE_SCRIPT_V2_RULES = `You are a screenwriter writing the shooting script for a single episode of a vertical micro-series (one 60–100 second episode, cliffhanger-driven).

INPUT HANDLING
The user message contains the short plot summary of THIS episode; later messages may contain change requests. Dramatize exactly what the summary describes — do not add new plot beats, do not resolve the episode's ending cliffhanger. Apply the newest change request while keeping everything that already works.

SCRIPT RULES
- Standard screenplay form in plain text.
- Every scene starts with a slugline beginning with INT. or EXT. (interior/exterior), then the LOCATION, then time of day — e.g. "INT. POLICE STATION — NIGHT" or "EXT. ROOFTOP — DAY". An episode may have one or more scenes; start a new slugline at every location or time change.
- Under each slugline: brief action/description lines in present tense, then character cues (CHARACTER NAME in caps) with their dialogue. Parentheticals for delivery only when needed.
- Keep it tight — this is 60–100 seconds of screen time. Lean on visual action and sharp dialogue.
- The episode ENDS on its intriguing moment / cliffhanger exactly as implied by the summary; the final beat is that hook.
- Use the character names already present in the summary. Any new minor character gets an English first name + surname in Latin letters (A-Z). No real people, brands, landmarks or existing franchises.

OUTPUT
Return only the screenplay (sluglines, action, dialogue). No title page, no episode number, no preamble, no commentary, no markdown.
OUTPUT LANGUAGE: write all action and dialogue in <Language>. Keep the INT./EXT. slugline prefixes in English (INT./EXT.) regardless of language.`;

export interface EpisodeScriptV2Input {
  /** Краткий сюжет серии (из Project.seasonPlotV2 по "#<n>") — первый user как есть. */
  summary?: string | null;
  /** Язык синопсиса (английское название) → <Language>. */
  synopsisLanguage?: string | null;
  /** Текущий сценарий (fallback-правка без транскрипта). */
  script?: string | null;
  /** Правка (уже на английском). */
  refine?: string | null;
  /** Базовый сценарий S0 и применённые пары «правка → сценарий». */
  scriptBase?: string | null;
  scriptTurns?: { refine: string; script: string }[] | null;
}

export function episodeScriptV2SystemPrompt(input: EpisodeScriptV2Input): string {
  return EPISODE_SCRIPT_V2_RULES.replace(/<Language>/g, normalizeSynopsisLanguage(input.synopsisLanguage));
}

export const EPISODE_SCRIPT_V2_CONTEXT_NOTE =
  "Контекст сезона не передаётся — сценарий пишется только по краткому сюжету этой серии.";

/**
 * Единый источник для превью и воркера сценария эпизода v2:
 * system → user (краткий сюжет серии как есть) → assistant (S0) → user (правка EN) → assistant → ... → крайний user.
 */
export function buildEpisodeScriptV2Parts(input: EpisodeScriptV2Input): {
  system: string;
  user: string;
  assistant: string;
  model: string;
  contextIncluded: boolean;
  contextNote: string;
  messages: V2Msg[];
} {
  const system = episodeScriptV2SystemPrompt(input);
  const source = (input.summary ?? "").trim();
  const refine = (input.refine ?? "").trim();
  const prev = (input.script ?? "").trim();
  const base = (input.scriptBase ?? "").trim() || prev;
  const turns = (input.scriptTurns ?? []).filter((t) => t && (t.refine ?? "").trim() && (t.script ?? "").trim());
  let messages: V2Msg[];
  if (refine && base) {
    messages = [
      { role: "system", content: system },
      { role: "user", content: source },
      { role: "assistant", content: base },
    ];
    for (const t of turns) {
      messages.push({ role: "user", content: (t.refine ?? "").trim() });
      messages.push({ role: "assistant", content: (t.script ?? "").trim() });
    }
    messages.push({ role: "user", content: refine });
  } else {
    messages = legacyPartsToMessages(system, source, "");
  }
  return { system, user: source, assistant: "", messages, model: FABLE_MODEL_LABEL, contextIncluded: false, contextNote: EPISODE_SCRIPT_V2_CONTEXT_NOTE };
}

/** Краткий сюжет серии n из Project.seasonPlotV2 (null — серии нет). */
export function seasonPlotEpisodeSummary(plot: string | null | undefined, n: number): string | null {
  const ep = (parseSeasonPlotV2(plot) ?? []).find((e) => e.n === n);
  return ep && ep.text.trim() ? ep.text.trim() : null;
}

/** Сценарий серии n из Project.episodeScriptsV2 ({ "<n>": { script } }). */
export function episodeScriptV2From(map: unknown, n: number): string {
  const v = map && typeof map === "object" ? (map as Record<string, any>)[String(n)] : null;
  return v && typeof v.script === "string" ? v.script : "";
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 · уровень эпизода: вкладка «Референсы» (персонажи / локации / реквизит из сценария серии)
// ─────────────────────────────────────────────────────────────────────────────

export type EpisodeRefKindV2 = "character" | "location" | "prop";
export const EPISODE_REF_KINDS_V2: EpisodeRefKindV2[] = ["character", "location", "prop"];
export type EpisodeRefImageStatusV2 = "generating" | "done" | "failed";
/** Элемент рефа серии (Project.episodeRefsV2["<n>"].items[]). prompt — EN, label — на языке синопсиса. */
export interface EpisodeRefV2 {
  id: string;
  kind: EpisodeRefKindV2;
  label: string;
  prompt: string;
  /** Для локаций: признак INT./EXT. из слаглайна. */
  setting?: "INT" | "EXT" | null;
  /** Роль/функция в истории (для персонажей: «Протагонист», «Антагонист», …) на языке синопсиса; для локаций/реквизита null. */
  role?: string | null;
  /** Промпт правился вручную — повторное извлечение его не перезатирает. */
  edited?: boolean;
  /** Промпт изменён, но изображение ещё не перегенерировано (бейдж «new» на кнопке промпта). */
  promptDirty?: boolean;
  imageUrl?: string | null;
  imageStatus?: EpisodeRefImageStatusV2 | null;
  imageError?: string | null;
}

/** Срезать ведущий префикс типа из метки рефа («Персонаж: Анна» → «Анна»); INT./EXT. не трогается. */
const REF_KIND_PREFIX_RE = /^\s*(?:персонаж|персонажи|локация|локации|место|реквизит|предмет|character|characters|location|locations|prop|props|object)\s*[:：—–-]\s*/i;
export function stripRefKindPrefixV2(label: string): string {
  const s = String(label ?? "").trim();
  const out = s.replace(REF_KIND_PREFIX_RE, "").trim();
  return out || s;
}

/** Правила (system) извлечения рефов серии. `<Language>` — язык синопсиса (для label). */
export const EPISODE_REFS_V2_RULES = `You are a visual development lead preparing the reference sheet for ONE episode of a photorealistic live-action vertical micro-series. The user message is the episode's shooting script (sluglines INT./EXT.).

TASK
List every visual reference the storyboard artist needs to draw this episode consistently:
- character — every character who appears on screen (named or a clearly recurring/important unnamed one). One entry per character.
- location — every distinct location from the sluglines. Keep the INT./EXT. marker and time of day exactly as in the slugline. One entry per distinct location + time of day.
- prop — only story-important objects that are shown, handled or referenced visually (weapons, documents, phones with key messages, vehicles, jewellery, etc.). Skip trivial set dressing.

FOR EACH ENTRY
- "kind": "character" | "location" | "prop".
- "key": short stable English identifier in snake_case (e.g. "anna", "police_station_night", "bloody_knife"). The same thing must always get the same key.
- "label": short human label in <Language> containing ONLY the designation itself — the character's name, the location name with its slugline, or the prop name. NEVER prefix it with the type word (no "Персонаж:", "Локация:", "Реквизит:", "Character:", "Location:", "Prop:" or similar) — the type is shown separately from "kind". E.g. for Russian "Анна", "INT. Полицейский участок — ночь", "Окровавленный нож"; for English "Anna", "INT. Police station — night", "Bloody knife". Keep "INT."/"EXT." untranslated in location labels (they are part of the location name, not a type prefix).
- "setting": "INT" or "EXT" for locations, null otherwise.
- "role": for kind "character" — the character's short role/function in the story in <Language>, inferred from the script (e.g. for Russian "Протагонист", "Антагонист", "Наставник", "Союзник", "Второстепенный"; for English "Protagonist", "Antagonist", "Mentor", "Ally", "Supporting"), 1–3 words, no name; for "location" and "prop" — null.
- "prompt": a detailed ENGLISH prompt for a photorealistic image model that produces a consistent reference image:
  - character: gender, apparent age, ethnicity/skin tone, build, face, hair (colour, length, style), distinctive features, the exact wardrobe worn in this episode (garments, colours, materials), full-length standing figure on a plain neutral background. Infer plausible details from the script; never leave appearance vague.
  - location: INT. or EXT., type of place, architecture and materials, key furniture and objects the scenes use, time of day, lighting (sources, colour temperature), weather and atmosphere, wide establishing view with no people.
  - prop: what it is, material, size, colour, condition/wear, distinctive markings, isolated on a plain neutral background, no hands, no people.
  - No camera brand names, no real people or celebrities, no logos, no text overlays.

OUTPUT
Return ONLY a JSON object, no markdown fences, no commentary:
{"refs":[{"kind":"character","key":"...","label":"...","setting":null,"role":"...","prompt":"..."},{"kind":"location","key":"...","label":"...","setting":"INT","role":null,"prompt":"..."}]}
Order: characters first, then locations, then props.`;

export function episodeRefsV2SystemPrompt(language: SynopsisLanguage | string): string {
  return EPISODE_REFS_V2_RULES.replace(/<Language>/g, String(language || DEFAULT_SYNOPSIS_LANGUAGE));
}

const refSlug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);

/** Разбор ответа модели в список рефов со стабильными id `<kind>-<key>` (дубликаты → суффикс). */
export function parseEpisodeRefsV2(data: unknown): EpisodeRefV2[] {
  const list: any[] = Array.isArray((data as any)?.refs) ? (data as any).refs : Array.isArray(data) ? (data as any[]) : [];
  const seen = new Set<string>();
  const out: EpisodeRefV2[] = [];
  for (const r of list) {
    const kind = EPISODE_REF_KINDS_V2.includes(r?.kind) ? (r.kind as EpisodeRefKindV2) : null;
    const label = stripRefKindPrefixV2(String(r?.label ?? ""));
    const prompt = String(r?.prompt ?? "").trim();
    if (!kind || !label || !prompt) continue;
    const base = `${kind}-${refSlug(String(r?.key ?? "")) || refSlug(prompt.split(/[,.]/)[0]) || "ref"}`;
    let id = base;
    for (let i = 2; seen.has(id); i++) id = `${base}-${i}`;
    seen.add(id);
    const st = String(r?.setting ?? "").toUpperCase();
    const setting = kind === "location" ? (st === "INT" || st === "EXT" ? st : /\bEXT\./i.test(label) ? "EXT" : /\bINT\./i.test(label) ? "INT" : null) : null;
    const roleRaw = kind === "character" && typeof r?.role === "string" ? r.role.trim() : "";
    const role = roleRaw ? roleRaw.slice(0, 80) : null;
    out.push({ id, kind, label: label.slice(0, 200), prompt: prompt.slice(0, 4000), setting, role });
  }
  return out;
}

/**
 * Повторное извлечение: новый список из сценария, но для совпавших id сохраняются вручную
 * отредактированный промпт (edited) и уже сгенерированная картинка (если промпт не поменялся или был ручным).
 */
export function mergeEpisodeRefsV2(prev: EpisodeRefV2[], fresh: EpisodeRefV2[]): EpisodeRefV2[] {
  const byId = new Map(prev.map((r) => [r.id, r]));
  return fresh.map((f) => {
    const p = byId.get(f.id);
    if (!p) return f;
    const keepPrompt = !!p.edited;
    const prompt = keepPrompt ? p.prompt : f.prompt;
    const keepImage = p.imageUrl && (keepPrompt || p.prompt.trim() === f.prompt.trim());
    return { ...f, prompt, edited: keepPrompt || undefined, ...(keepImage ? { imageUrl: p.imageUrl, imageStatus: "done" as const } : {}) };
  });
}

/** Рефы серии n из Project.episodeRefsV2 ({ "<n>": { items, updatedAt } }). */
export function episodeRefsV2From(map: unknown, n: number): EpisodeRefV2[] {
  const v = map && typeof map === "object" ? (map as Record<string, any>)[String(n)] : null;
  return Array.isArray(v?.items) ? (v.items as EpisodeRefV2[]).filter((r) => r && typeof r.id === "string" && typeof r.prompt === "string") : [];
}
