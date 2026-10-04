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

/**
 * Черновик v2: проект создан, но сюжет сезона ещё не утверждён (stage idea / logline_v2 / synopsis_v2,
 * seasonPlotV2 пуст). Такой проект НЕ сохраняется: он скрыт на дашборде и удаляется, когда пользователь
 * уходит со страницы проекта (POST /api/projects/[id]/discard) или при сборке мусора в GET /api/projects.
 * Legacy-проекты (newFlow=false, стадии v1) черновиками не считаются.
 */
export const DRAFT_V2_STAGES = ["idea", LOGLINE_V2_STAGE, SYNOPSIS_V2_STAGE] as const;
export function isDraftProjectV2(
  p: { stage?: string | null; newFlow?: boolean | null; seasonPlotV2?: unknown } | null | undefined,
): boolean {
  return !!p && p.newFlow === true && !isSeasonPlotV2Locked(p) && (DRAFT_V2_STAGES as readonly string[]).includes(p.stage ?? "");
}

/** Правила (system) сюжета сезона v2. `<N>` — количество эпизодов, `<Language>` — язык синопсиса. Текст — по ТЗ; 05.10.2026 добавлен блок PACING (плотность действия на эпизод). */
export const SEASON_PLOT_V2_RULES = `You are a development executive breaking an approved season synopsis into an episode-by-episode season plot for a vertical micro-series (60–100 second episodes, cliffhanger-driven). This season has exactly <N> episodes.

INPUT HANDLING
The user message contains the approved season synopsis; later messages may contain change requests. Keep the synopsis's protagonist, world, goal, antagonistic force, main hook and ending exactly as established — invent only the connective tissue between them. Apply the newest change request while keeping everything that already works and without reverting earlier changes.

SEASON STRUCTURE RULES
- Exactly <N> episodes, numbered 1 to <N>, in order. No episode skipped, merged or added.
- Each episode is a compact retelling of 3–5 sentences, present tense — not a detailed treatment. Keep it brief, but every sentence must carry an EVENT (something happens / changes), not description or mood.
- Every episode ENDS on an intriguing moment: a cliffhanger, reveal, reversal or unanswered question that forces the viewer into the next episode. The last sentence of each episode IS that moment.
- Every episode advances the plot; no filler, no recaps.

PACING / DENSITY (critical — vertical viewers quit within seconds)
- Each episode packs at least 3 distinct plot beats: an event → a complication/turn → a reversal, reveal or cliffhanger. One beat stretched over an episode is NOT acceptable.
- Every episode starts IN MOTION — mid-action, mid-conflict or on an immediate problem. No setup-only, "getting to know", travel, waiting or reflection episodes; backstory is revealed in passing while something is happening.
- Episode 1 opens on the inciting incident or a direct collision with the antagonistic force — the viewer must be hooked within the first episode, not by episode 3–5.
- Compress ruthlessly: what a conventional series spreads over 3 episodes must happen in 1. Prefer decisions, confrontations, discoveries and consequences over conversations about them.
- No two consecutive episodes may have the same situation/location/status quo — the ground must shift every episode (new information, new danger, new ally/enemy, changed goal).
- Sub-plots and emotional beats exist only where they create a new turn; they never pause the main line.
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

/** Правила (system) сценария эпизода v2. `<Language>` — язык синопсиса. Текст — по ТЗ; 05.10.2026 добавлен блок PACING (плотность действия / темп). */
export const EPISODE_SCRIPT_V2_RULES = `You are a screenwriter writing the shooting script for a single episode of a vertical micro-series (one 60–100 second episode, cliffhanger-driven).

INPUT HANDLING
The user message contains the short plot summary of THIS episode; later messages may contain change requests. Dramatize EVERY beat the summary describes at speed — do not add new plot beats, do not drop or merge any, do not stretch one beat over the whole episode, do not resolve the episode's ending cliffhanger. Apply the newest change request while keeping everything that already works.

SCRIPT RULES
- Standard screenplay form in plain text.
- Every scene starts with a slugline beginning with INT. or EXT. (interior/exterior), then the LOCATION, then time of day — e.g. "INT. POLICE STATION — NIGHT" or "EXT. ROOFTOP — DAY". An episode may have one or more scenes; start a new slugline at every location or time change.
- Under each slugline: brief action/description lines in present tense, then character cues (CHARACTER NAME in caps) with their dialogue. Parentheticals for delivery only when needed.
- Keep it tight — this is 60–100 seconds of screen time. Lean on visual action and sharp dialogue.

PACING / DENSITY (critical — the viewer decides within the first seconds whether to keep watching)
- COLD OPEN: the first action line or first line of dialogue (first 3–5 seconds) is already action, conflict or a problem. No establishing shots, no arriving, waking up, walking in, sitting down, greeting or small talk before the story starts.
- Every scene TURNS: something changes between its first and last line (new information, decision, threat, reversal). A scene with no turn is cut.
- Minimum 3 beats per episode, rising in intensity; momentum builds straight into the cliffhanger. Nothing slows down after the midpoint.
- No scene longer than ~20–25 seconds of screen time; cut into the scene late, out of it early.
- Dialogue is short and pointed — typically one sentence (up to ~12 words) per line, 2–3 exchanges per scene at most. Characters do not explain what the viewer already saw, do not recap, do not announce feelings — they act.
- Zero pleasantries, greetings, farewells, filler reactions ("What?", "Really?"), weather or logistics talk.
- Show, don't tell: exposition only inside conflict (an accusation, a threat, a discovery), never as a calm explanation.
- Action lines are terse (one or two lines) and describe only what the camera sees; no inner states, no descriptions of mood or atmosphere.
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
  /** Блок SERIES CONTINUITY (имена персонажей/локаций из ранних серий) — см. seriesContinuityBlockV2; дописывается в system. */
  continuity?: string | null;
}

export function episodeScriptV2SystemPrompt(input: EpisodeScriptV2Input): string {
  const base = EPISODE_SCRIPT_V2_RULES.replace(/<Language>/g, normalizeSynopsisLanguage(input.synopsisLanguage));
  const cont = (input.continuity ?? "").trim();
  return cont ? `${base}\n\n${cont}` : base;
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
  /** Пользовательское фото-референс (только для персонажей): публичный S3 URL. Подаётся первым в image_input генерации. */
  userRefUrl?: string | null;
  imageUrl?: string | null;
  imageStatus?: EpisodeRefImageStatusV2 | null;
  imageError?: string | null;
  /** Реф унаследован из более ранней серии (номер серии-источника): картинка/промпт те же, заново не генерируется. */
  inheritedFrom?: number | null;
}

/** Срезать ведущий префикс типа из метки рефа («Персонаж: Анна» → «Анна»); INT./EXT. не трогается. */
const REF_KIND_PREFIX_RE = /^\s*(?:персонаж|персонажи|локация|локации|место|реквизит|предмет|character|characters|location|locations|prop|props|object)\s*[:：—–-]\s*/i;
export function stripRefKindPrefixV2(label: string): string {
  const s = String(label ?? "").trim();
  const out = s.replace(REF_KIND_PREFIX_RE, "").trim();
  return out || s;
}

/** Правила (system) извлечения рефов серии. ВСЁ — только на английском (label, role, prompt). */
export const EPISODE_REFS_V2_RULES = `You are a visual development lead preparing the reference sheet for ONE episode of a photorealistic live-action vertical micro-series. The user message is the episode's shooting script (sluglines INT./EXT.).

LANGUAGE: EVERYTHING you output — "label", "role" and "prompt" — MUST be in ENGLISH, regardless of the script's language. Translate names and places into English; never output Russian or any non-English text.

TASK
List every visual reference the storyboard artist needs to draw this episode consistently:
- character — every character who appears on screen (named or a clearly recurring/important unnamed one). One entry per character.
- location — every distinct physical place from the sluglines. One entry per distinct place (do NOT create separate entries for different times of day of the same place).
- prop — only story-important objects that are shown, handled or referenced visually (weapons, documents, phones with key messages, vehicles, jewellery, etc.). Skip trivial set dressing.

FOR EACH ENTRY
- "kind": "character" | "location" | "prop".
- "key": short stable English identifier in snake_case (e.g. "anna", "third_horizon_mine", "bloody_knife"). The same thing must always get the same key.
- "label": short ENGLISH human label containing ONLY the designation itself — the character's name, the SHORT location name, or the prop name. NEVER prefix it with the type word (no "Character:", "Location:", "Prop:" or similar) — the type is shown separately from "kind".
  - character: just the English name, e.g. "Anna".
  - location: the SHORT place name ONLY, in English. Do NOT include the "INT."/"EXT." marker and do NOT include the time of day. Keep it to a couple of words naming the venue, e.g. 'Mine "THIRD HORIZON"', "Police station", "Anna's kitchen".
  - prop: the short English name, e.g. "Bloody knife".
- "setting": "INT" or "EXT" for locations, null otherwise.
- "role": for kind "character" — the character's short role/function in the story in ENGLISH, inferred from the script (e.g. "Protagonist", "Antagonist", "Mentor", "Ally", "Supporting"), 1–3 words, no name; for "location" and "prop" — null.
- "prompt": a detailed ENGLISH prompt for a photorealistic image model that produces a consistent reference image:
  - character: gender, apparent age, ethnicity/skin tone, build, face, hair (colour, length, style), distinctive features, the exact wardrobe worn in this episode (garments, colours, materials), full-length standing figure on a plain neutral background. Infer plausible details from the script; never leave appearance vague.
  - location: INT. or EXT., type of place, architecture and materials, key furniture and objects the scenes use, time of day, lighting (sources, colour temperature), weather and atmosphere, wide establishing view with no people.
  - prop: what it is, material, size, colour, condition/wear, distinctive markings, isolated on a plain neutral background, no hands, no people.
  - No camera brand names, no real people or celebrities, no logos, no text overlays.

OUTPUT
Return ONLY a JSON object, no markdown fences, no commentary:
{"refs":[{"kind":"character","key":"...","label":"...","setting":null,"role":"...","prompt":"..."},{"kind":"location","key":"...","label":"...","setting":"INT","role":null,"prompt":"..."}]}
Order: characters first, then locations, then props.`;

export function episodeRefsV2SystemPrompt(language: SynopsisLanguage | string, continuity?: string | null): string {
  const base = EPISODE_REFS_V2_RULES.replace(/<Language>/g, String(language || DEFAULT_SYNOPSIS_LANGUAGE));
  const cont = (continuity ?? "").trim();
  return cont ? `${base}\n\n${cont}` : base;
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
    // Сохраняем прикреплённое пользователем фото-референс внешности (userRefUrl) при повторном извлечении.
    const keepFace = f.kind === "character" && p.userRefUrl?.trim() ? { userRefUrl: p.userRefUrl } : {};
    return { ...f, prompt, edited: keepPrompt || undefined, ...keepFace, ...(keepImage ? { imageUrl: p.imageUrl, imageStatus: "done" as const, ...(p.inheritedFrom ? { inheritedFrom: p.inheritedFrom } : {}) } : {}) };
  });
}

/** Рефы серии n из Project.episodeRefsV2 ({ "<n>": { items, updatedAt } }). */
export function episodeRefsV2From(map: unknown, n: number): EpisodeRefV2[] {
  const v = map && typeof map === "object" ? (map as Record<string, any>)[String(n)] : null;
  return Array.isArray(v?.items) ? (v.items as EpisodeRefV2[]).filter((r) => r && typeof r.id === "string" && typeof r.prompt === "string") : [];
}

const refMatchKey = (s: string) => stripRefKindPrefixV2(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9\u0430-\u044f\u0451]+/g, "");
const refFirstName = (label: string) => refMatchKey((stripRefKindPrefixV2(label).trim().split(/\s+/)[0] ?? ""));
/** Персонаж по имени без фамилии («Grace» ↔ «Grace Harper»): единственное совпадение по первому слову, иначе null. */
function uniqueFirstNameHit(items: EpisodeRefV2[], label: string): EpisodeRefV2 | undefined {
  const fn = refFirstName(label);
  if (!fn || fn.length < 2) return undefined;
  const hits = items.filter((r) => refFirstName(r.label) === fn);
  return hits.length === 1 ? hits[0] : undefined;
}
const refIdKey = (id: string) => id.replace(/^(character|location|prop)-/, "").replace(/-\d+$/, "").replace(/[^a-z0-9]+/g, "");

/**
 * Найти тот же персонаж/локацию/реквизит в более ранних сериях (самая ранняя серия с готовой картинкой — канон, она первой):
 * совпадение по id (`<kind>-<key>`), иначе по типу + нормализованной метке, иначе метка ↔ ключ id.
 * Возвращает реф-источник с готовой картинкой и номер его серии, либо null.
 */
export function findEarlierEpisodeRefV2(map: unknown, episode: number, ref: Pick<EpisodeRefV2, "id" | "kind" | "label">): { ref: EpisodeRefV2; episode: number } | null {
  const episodes = (map && typeof map === "object" ? Object.keys(map as object) : [])
    .map(Number).filter((k) => Number.isInteger(k) && k >= 1 && k < episode).sort((a, b) => a - b);
  const lk = refMatchKey(ref.label);
  const ik = refIdKey(ref.id);
  for (const n0 of episodes) {
    const items = episodeRefsV2From(map, n0).filter((r) => r.kind === ref.kind && r.imageUrl && r.imageStatus !== "generating");
    const hit = items.find((r) => r.id === ref.id)
      ?? (lk ? items.find((r) => refMatchKey(r.label) === lk) : undefined)
      ?? (ik ? items.find((r) => refIdKey(r.id) === ik) : undefined)
      ?? (lk ? items.find((r) => refIdKey(r.id) === lk) : undefined)
      ?? (ik ? items.find((r) => refMatchKey(r.label) === ik) : undefined)
      ?? (ref.kind === "character" ? uniqueFirstNameHit(items, ref.label) : undefined);
    if (hit) return { ref: hit, episode: hit.inheritedFrom && hit.inheritedFrom < n0 ? hit.inheritedFrom : n0 };
  }
  return null;
}

/**
 * Наследование рефов из ранних серий: то, что уже есть в сериях 1..n-1, не генерируется заново —
 * в серию n копируются картинка, промпт (внешность/гардероб) и пользовательское фото источника, проставляется inheritedFrom.
 * force=false — свои (сгенерированные именно в серии n) картинки не трогаем, подтягиваем только рефы без картинки
 * или уже унаследованные; force=true — источник из ранней серии побеждает всегда.
 */
export function inheritEpisodeRefsV2(map: unknown, episode: number, items: EpisodeRefV2[], force = false): { items: EpisodeRefV2[]; inherited: number } {
  if (episode <= 1) return { items, inherited: 0 };
  let inherited = 0;
  const out = items.map((r) => {
    const own = !!r.imageUrl && !r.inheritedFrom;
    if (own && !force) return r;
    const src = findEarlierEpisodeRefV2(map, episode, r);
    if (!src) return r;
    inherited++;
    const face = r.kind === "character" ? { userRefUrl: r.userRefUrl?.trim() || src.ref.userRefUrl || null } : {};
    // Имя/название — как в ранней серии (полное имя с фамилией), роль — если своей нет.
    return { ...r, label: src.ref.label || r.label, role: r.role?.trim() || src.ref.role || r.role, prompt: src.ref.prompt, imageUrl: src.ref.imageUrl, imageStatus: "done" as const, imageError: null, promptDirty: false, ...face, inheritedFrom: src.episode };
  });
  return { items: out, inherited };
}

/** Реплики-cue из сценария: строки ЦЕЛИКОМ в верхнем регистре (1–4 слова), не слаглайны. "GRACE HARPER (V.O.)" → "GRACE HARPER". */
export function scriptCharacterCuesV2(script: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of String(script ?? "").split(/\r?\n/)) {
    const line = raw.trim().replace(/\s*\((?:V\.O\.|O\.S\.|CONT'D|ЗК|ВПЗ|[^)]{0,20})\)\s*$/i, "").trim();
    if (!line || /^(INT|EXT)\b/i.test(line) || line.length > 40) continue;
    if (line !== line.toUpperCase() || !/[A-ZА-ЯЁ]/.test(line)) continue;
    const words = line.split(/\s+/);
    if (words.length > 4 || /[.!?:,]$/.test(line)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/**
 * Блок SERIES CONTINUITY для system-промптов сценария и рефов серии n: персонажи (полное имя + роль) и локации
 * из рефов серий 1..n-1 плюс cue-имена из их сценариев. Пустая строка — если ранних данных нет.
 */
export function seriesContinuityBlockV2(refsMap: unknown, scriptsMap: unknown, episode: number, shotsMap?: unknown): string {
  if (episode <= 1) return "";
  const handoff = shotsMap === undefined ? "" : episodeHandoffBlockV2(shotsMap, scriptsMap, episode);
  const chars = new Map<string, { label: string; role: string | null; key: string }>();
  const locs = new Map<string, { label: string; key: string }>();
  const cues: string[] = [];
  const cueSeen = new Set<string>();
  for (let n0 = 1; n0 < episode; n0++) {
    for (const r of episodeRefsV2From(refsMap, n0)) {
      const label = stripRefKindPrefixV2(r.label).trim();
      if (!label) continue;
      const k = refMatchKey(label);
      const key = r.id.replace(/^(character|location|prop)-/, "").replace(/-\d+$/, "");
      if (r.kind === "character" && !chars.has(k)) chars.set(k, { label, role: r.role?.trim() || null, key });
      if (r.kind === "location" && !locs.has(k)) locs.set(k, { label, key });
    }
    for (const c of scriptCharacterCuesV2(episodeScriptV2From(scriptsMap, n0))) {
      const k = refMatchKey(c);
      if (chars.has(k) || cueSeen.has(k)) continue;
      cueSeen.add(k);
      cues.push(c);
    }
  }
  if (!chars.size && !locs.size && !cues.length) return handoff;
  const lines: string[] = ["SERIES CONTINUITY (established in earlier episodes — this is the SAME series)"];
  if (chars.size || cues.length) {
    lines.push("Characters already established. Use EXACTLY these full names (first name + surname, same spelling) in every cue and action line — never shorten, rename or re-spell them, even if the summary/script uses only the first name:");
    for (const c of chars.values()) lines.push(`- ${c.label}${c.role ? ` — ${c.role}` : ""} (key: ${c.key})`);
    for (const c of cues) lines.push(`- ${c}`);
  }
  if (locs.size) {
    lines.push("Locations already established — reuse the same names when the story returns to them:");
    for (const l of locs.values()) lines.push(`- ${l.label} (key: ${l.key})`);
  }
  lines.push("For references: the same person/place MUST get the same key and label as listed above (e.g. a character mentioned only by first name is the established character with that first name). Only genuinely new characters/places get new keys.");
  if (handoff) lines.push("", handoff);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 · уровень эпизода: вкладка «Шот-лист» (разбивка сценария серии на кадры/клипы)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Элемент шот-листа серии (Project.episodeShotsV2["<n>"].items[]). Шот = ДВА абзаца на языке синопсиса:
 * frame («Фрейм» — статичное визуальное описание кадра) + action («Действие» — что делают персонажи).
 * Остальные текстовые поля — legacy (старые сохранённые шоты): больше не генерируются и не показываются,
 * но читаются для обратной совместимости (из них синтезируется frame, см. legacyShotFrame).
 */
export interface EpisodeShotV2 {
  id: string;
  /** Порядковый номер кадра (с 1). */
  index: number;
  /** Длительность клипа, сек (4–6). */
  durationSec: number;
  /** Фрейм — полное статичное описание кадра одним абзацем (кто/где, реквизит, композиция, план, ракурс, камера, свет, локация+время). */
  frame?: string;
  /** Действие — что делают персонажи (видимое движение/бит клипа). Обязательное. */
  action: string;
  /** Концовка — чем заканчивается кадр/сцена (финальный бит, итоговое состояние на последнем кадре клипа). */
  ending?: string;
  /** @deprecated legacy: локация + время суток. */
  sceneHeading?: string;
  /** @deprecated legacy: крупность/кадрирование/ракурс. */
  shotType?: string;
  /** @deprecated legacy: движение камеры. */
  camera?: string;
  /** @deprecated legacy: кто в кадре. */
  inFrame?: string;
  /** @deprecated legacy: реплика. */
  dialogue?: string;
  /** @deprecated legacy: эмоция. */
  emotion?: string;
  /** @deprecated legacy: свет. */
  light?: string;
  /** @deprecated legacy: звук. */
  sound?: string;
  /** @deprecated legacy: переход. */
  transition?: string;
  /** @deprecated legacy: заметки. */
  notes?: string;
  /** Правился вручную — повторная разбивка его не перезатирает. */
  edited?: boolean;
}

/** Legacy-визуальные поля старых шотов, из которых синтезируется frame (в порядке чтения). */
const LEGACY_FRAME_FIELDS: Array<keyof EpisodeShotV2> = ["sceneHeading", "shotType", "camera", "inFrame", "light", "emotion"];

const oneLine = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim();

/**
 * Фрейм старого шота без поля frame: склейка legacy-визуальных полей одним абзацем (скобки «(реф N)» вырезаются).
 * Пусто, если legacy-полей нет.
 */
export function legacyShotFrame(shot: Partial<EpisodeShotV2>): string {
  return LEGACY_FRAME_FIELDS
    .map((k) => oneLine((shot as any)[k]).replace(/\s*\(\s*реф\s*\d+\s*\)/gi, "").replace(/[.;,\s]+$/, ""))
    .filter(Boolean)
    .join(". ");
}

/** Фрейм шота для показа/правки: frame (если поле задано, даже пустое — явная правка), иначе синтез из legacy-полей. */
export function shotFrameText(shot: Partial<EpisodeShotV2>): string {
  return typeof shot.frame === "string" ? oneLine(shot.frame) : legacyShotFrame(shot);
}

/**
 * Визуальное описание кадра для downstream (сториборд, первый кадр сцены, видео):
 * «Frame: <frame> | Action: <action> | Ending: <ending>» (пустые части опускаются).
 * Старые шоты без frame — frame синтезируется из legacy-полей. Нет ни frame, ни legacy-полей → action (+ending).
 */
export function shotVisualText(shot: Partial<EpisodeShotV2>): string {
  const frame = shotFrameText(shot);
  const action = oneLine(shot.action);
  const ending = oneLine(shot.ending);
  const parts: string[] = [];
  if (frame) parts.push(`Frame: ${frame}`);
  if (action) parts.push(`Action: ${action}`);
  if (ending) parts.push(`Ending: ${ending}`);
  return parts.join(" | ");
}

/** Правила (system) разбивки сценария серии на кадры (текст — ТЗ пользователя 1:1, slideshow-версия; значения полей всегда на русском). */
export const EPISODE_SHOTS_V2_RULES = `You are a first assistant director breaking ONE episode of a photorealistic live-action vertical micro-series (9:16) into a SHOT LIST that plays like a continuous SLIDESHOW: every shot's first frame must look like the very next photo after the previous shot's last frame. The user message is the episode's shooting script (sluglines INT./EXT., action, dialogue). It may start with a target duration.

HOW THE OUTPUT IS USED
Each shot becomes one generated video clip, produced in two steps:
1. "frame" is rendered as a single still image by an image model. That model sees no other shots and no script. Base character appearance (face, hair, base outfit) is supplied to it separately.
2. The still is animated by a video model using "action" and "ending".
Every field must therefore be self-contained, concrete and visual. Anything not written in "frame" does not exist for the image model.

SHOT RULES
  - Each shot lasts 4–6 seconds (integer). Prefer 5s.
  - Target length: the target duration if given, otherwise 60–100 seconds. CONTINUITY IS MORE IMPORTANT THAN LENGTH: if smooth continuity requires extra shots, add them and exceed the target rather than skip a step.
  - Cover the ENTIRE script from first to last beat, in reading order, with no gaps and no overlaps. Never invent story events that are not in the script. You may make implied physical actions explicit and add bridging shots (a character walking from one spot to another, turning, putting something on or taking it off) whenever the script skips them.
  - One shot = one camera setup = one continuous action, one line of dialogue, or one reaction. Max 1–2 physical events per shot.
  - Close-ups: max 2 characters in frame. Wide shots: max 4.

SLIDESHOW RULES (small steps between shots)
  - Between consecutive shots the camera changes by ONE step only: either one shot size step (wide → medium-wide → medium → close-up → detail, or back), OR an angle change of up to about 45° around the same subject. Never both at once, never a jump to the opposite side of the location.
  - A character never appears in a new place without a shot showing them walking there.
  - A character who was in frame and is still in the scene stays where they were left until a shot shows them moving.
  - Every new location starts with a wide establishing shot.
  - After a close-up or detail shot, the next shot returns to the same subject or to the person reacting to it — no unmotivated jumps to another part of the space.

CHARACTER STATE (critical)
Separate base appearance from VARIABLE STATE.
  - Base appearance (face, hair, body type, base outfit) is never described.
  - VARIABLE STATE is restated in EVERY "frame" and "ending" for every visible character, even if unchanged: mask / respirator / goggles / helmet / hood (on, off, pulled down to neck, hanging on belt), gloves on or off, bags and weapons (on which shoulder, in which hand), dirt, ash, blood, wounds, wet or torn clothing, anything held.
  - A variable state changes ONLY in a shot whose "action" shows the change happening. If the script implies a change without showing it, add a bridging shot for it.
  - Once a state has changed, it persists in all following shots until another shot shows it changing back.

FIELD 1 — "frame" (static first moment, rendered as a photo)
ONE paragraph describing the exact first moment of "action", frozen. No verbs of motion, no camera movement, no dialogue. Include, in this order:
  - shot size (wide / medium-wide / medium / close-up / extreme close-up detail), camera angle and height, which side of the location the camera faces;
  - location and time of day from the slugline, its key landmarks and where they are in the frame;
  - every visible character by name: position in the frame (screen-left / center / screen-right, foreground / midground / background), pose, gaze direction (always at a person, object or sound), full VARIABLE STATE;
  - props and their current state;
  - light: key source, colour, quality, what stays in shadow.
Mention only characters who are visible; never mention off-screen characters.
Write each frame so it can stand on its own. Never refer to other shots ("the same yard", "as before"): repeat the location description in full.

FIELD 2 — "action" (motion during the clip)
ONE paragraph. Start with the camera movement (static / slow push-in / pull-out / pan / tracking / handheld with subtle micro-shake). Then describe what each character does, in chronological order, as one continuous movement starting from "frame". Every change of position is a visible walk. Every change of VARIABLE STATE is shown explicitly (e.g. pulls the respirator down to her neck). Every glance is aimed at a person, object or sound. If someone speaks, name the speaker, describe how they say it, and quote the line verbatim in the script's original language. Never leave it empty.

FIELD 3 — "ending" (last frame of the clip)
ONE paragraph. The resulting state on the last frame: shot size at the end, final pose and position of each visible character, gaze, full VARIABLE STATE, prop states, and what has changed since "frame". Describe only the outcome of "action" — no new events. Never leave it empty.

CONTINUITY
  - The "frame" of shot N+1 must be the "ending" of shot N viewed with the one-step camera change allowed above: same positions, poses, VARIABLE STATES and prop states.
  - A prop changes state only in the shot whose "action" shows it happening.
  - Within one scene, describe the location, its landmarks and the light with the SAME wording in every shot.
  - Keep screen direction and the 180° line.
  - Keep lighting continuous unless the script motivates a change.

NAMING AND STYLE
  - Name characters only by their ordinary names from the script, always in the same form. Never use synonyms ("the girl", "the old man"), reference numbers, brackets or IDs.
  - No camera brand names, no lens millimetres, no meta commentary, no shot numbers inside field values.
  - Write all field values in Russian. Quoted dialogue stays in its original language.

SELF-CHECK BEFORE OUTPUT
Walk through the shots in order and verify for every pair N → N+1: same positions, same VARIABLE STATE for every character (masks, hoods, held items), same prop states, camera change of one step only. Fix any violation by editing the shot or inserting a bridging shot.

OUTPUT
Return ONLY a JSON object, no markdown fences, no commentary:
{"shots":[{"index":1,"durationSec":5,"frame":"...","action":"...","ending":"..."}]}
Index starts at 1, shots strictly in script order.`;

export function episodeShotsV2SystemPrompt(language: SynopsisLanguage | string): string {
  return EPISODE_SHOTS_V2_RULES.replace(/<Language>/g, String(language || DEFAULT_SYNOPSIS_LANGUAGE));
}

/** Привести длительность кадра к целым 4–6 сек. */
const clampShotDuration = (v: unknown): number => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 5;
  return Math.min(6, Math.max(4, n));
};

/** Необязательное текстовое поле кадра: обрезка пробелов + лимит длины; пусто → undefined. */
const optField = (v: unknown, cap = 1000): string | undefined => {
  const s = String(v ?? "").trim().slice(0, cap);
  return s || undefined;
};

/** Разбор ответа модели в список шотов со стабильными id `shot-<index>` (перенумерация с 1). */
export function parseEpisodeShotsV2(data: unknown): EpisodeShotV2[] {
  const list: any[] = Array.isArray((data as any)?.shots) ? (data as any).shots : Array.isArray(data) ? (data as any[]) : [];
  const out: EpisodeShotV2[] = [];
  for (const s of list) {
    const action = String(s?.action ?? "").trim();
    if (!action) continue;
    const index = out.length + 1;
    // Обратная совместимость: нет frame, но пришли старые визуальные поля → синтезируем frame из них.
    const frame = optField(s?.frame, 2000) ?? optField(legacyShotFrame(s ?? {}), 2000);
    out.push({
      id: `shot-${index}`,
      index,
      durationSec: clampShotDuration(s?.durationSec),
      frame,
      action: action.slice(0, 2000),
      ending: optField(s?.ending, 2000),
    });
  }
  return out;
}

/** Поля-содержимое кадра (кроме id/index/edited) — переносятся при сохранении ручной правки. */
const SHOT_CONTENT_KEYS: Array<keyof EpisodeShotV2> = [
  "durationSec", "frame", "action", "ending",
  // legacy — чтобы правки старых шотов не терялись при повторной разбивке
  "sceneHeading", "shotType", "camera", "inFrame", "dialogue", "emotion", "light", "sound", "transition", "notes",
];

/**
 * Повторная разбивка: новый список из сценария, но для совпавших id сохраняются вручную
 * отредактированные кадры (edited: длительность и описание).
 */
export function mergeEpisodeShotsV2(prev: EpisodeShotV2[], fresh: EpisodeShotV2[]): EpisodeShotV2[] {
  const byId = new Map(prev.map((s) => [s.id, s]));
  return fresh.map((f) => {
    const p = byId.get(f.id);
    if (!p || !p.edited) return f;
    const kept: Partial<EpisodeShotV2> = {};
    for (const k of SHOT_CONTENT_KEYS) (kept as any)[k] = (p as any)[k];
    return { ...f, ...kept, edited: true };
  });
}

/** Шот-лист серии n из Project.episodeShotsV2 ({ "<n>": { items, updatedAt } }). */
export function episodeShotsV2From(map: unknown, n: number): EpisodeShotV2[] {
  const v = map && typeof map === "object" ? (map as Record<string, any>)[String(n)] : null;
  return Array.isArray(v?.items)
    ? (v.items as EpisodeShotV2[]).filter((s) => s && typeof s.id === "string" && typeof s.action === "string")
    : [];
}

/**
 * Финальный момент серии n-1 (для стыковки серий): последний шот её шот-листа (frame/action/ending);
 * если шот-листа ещё нет — хвост сценария серии n-1. null — для серии 1 или без данных.
 */
export function previousEpisodeEndingV2(shotsMap: unknown, scriptsMap: unknown, episode: number): { episode: number; frame: string; action: string; ending: string; scriptTail: string } | null {
  if (!Number.isInteger(episode) || episode <= 1) return null;
  const prev = episode - 1;
  const shots = episodeShotsV2From(shotsMap, prev);
  const last = shots.length ? shots[shots.length - 1] : null;
  const frame = last ? oneLine(shotFrameText(last) || last.action) : "";
  const action = last ? oneLine(last.action) : "";
  const ending = last ? oneLine(last.ending) : "";
  let scriptTail = "";
  if (!frame) {
    const lines = episodeScriptV2From(scriptsMap, prev).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    scriptTail = lines.slice(-12).join("\n");
  }
  if (!frame && !scriptTail) return null;
  return { episode: prev, frame, action, ending, scriptTail };
}

/**
 * Блок «PREVIOUS EPISODE ENDING» для промптов сценария/шот-листа серии n: серия начинается РОВНО с того момента,
 * которым закончилась серия n-1 (первый кадр = последний кадр предыдущей серии с другого ракурса). "" — если нечего стыковать.
 */
export function episodeHandoffBlockV2(shotsMap: unknown, scriptsMap: unknown, episode: number): string {
  const e = previousEpisodeEndingV2(shotsMap, scriptsMap, episode);
  if (!e) return "";
  const lines: string[] = [`PREVIOUS EPISODE ENDING (episode ${e.episode}) — episode ${episode} starts at this EXACT moment`];
  if (e.frame) lines.push(`Final frame of episode ${e.episode}: ${e.frame}`);
  if (e.action) lines.push(`Final action of episode ${e.episode}: ${e.action}`);
  if (e.ending) lines.push(`State on the very last frame of episode ${e.episode}: ${e.ending}`);
  if (e.scriptTail) lines.push(`Last lines of the episode ${e.episode} script:`, e.scriptTail);
  lines.push(
    `HARD RULE: episode ${episode} begins exactly where episode ${e.episode} ended — same location, same moment in time (no time skip, no "later", no new day, no recap, no title card), the same characters present in the same positions, same wardrobe, same prop and variable state (held items, masks, hoods, doors, lights). ` +
    `The first scene / shot 1 / storyboard panel 1 of episode ${episode} shows this SAME final moment from a DIFFERENT camera angle or shot size (it is the same instant seen anew, not a new scene), and only then does the action move forward.`,
  );
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 · уровень эпизода: вкладка «Сториборд» (все кадры шот-листа одним листом)
// ─────────────────────────────────────────────────────────────────────────────

/** Сториборд серии (Project.episodeStoryboardV2["<n>"]): один сводный лист всех кадров шот-листа. */
export interface EpisodeStoryboardV2 {
  /** URL готового листа-сториборда (S3). */
  imageUrl?: string;
  /** Промпт, которым лист был собран (для справки/отладки). */
  prompt?: string;
  /** Правка промпта пользователем (переопределяет авто-промпт при сборке). */
  promptOverride?: string | null;
  /** Кэш собранного авто-промпта (EN, с переводом фреймов/меток) — строится по кнопке «Промпт» или при сборке листа. */
  autoPrompt?: string | null;
  /** Ключ кэша авто-промпта (отпечаток шотов + рефов + стиля): не совпал → промпт устарел и строится заново. */
  autoPromptKey?: string | null;
  /** Состояние генерации. */
  status?: "generating" | "done" | "failed" | null;
  /** Текст ошибки, если генерация упала. */
  error?: string | null;
  /** Пользователь утвердил лист → нарезка первых кадров сцен (вкладка «Сцены»). */
  approved?: boolean;
  updatedAt?: string;
}

/** Сториборд серии n из Project.episodeStoryboardV2 ({ "<n>": { imageUrl?, ... } }). */
export function episodeStoryboardV2From(map: unknown, n: number): EpisodeStoryboardV2 | null {
  const v = map && typeof map === "object" ? (map as Record<string, any>)[String(n)] : null;
  if (!v || typeof v !== "object") return null;
  return {
    imageUrl: typeof v.imageUrl === "string" ? v.imageUrl : undefined,
    prompt: typeof v.prompt === "string" ? v.prompt : undefined,
    promptOverride: typeof v.promptOverride === "string" ? v.promptOverride : null,
    autoPrompt: typeof v.autoPrompt === "string" ? v.autoPrompt : null,
    autoPromptKey: typeof v.autoPromptKey === "string" ? v.autoPromptKey : null,
    status: v.status === "generating" || v.status === "done" || v.status === "failed" ? v.status : null,
    error: typeof v.error === "string" ? v.error : null,
    approved: v.approved === true,
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : undefined,
  };
}

/**
 * Тело промпта сборки единого листа-сториборда по всему шот-листу серии (без строки [VISUAL STYLE] —
 * её добавляет воркер, где доступен VISUAL_STYLE). Модель рисует ВСЕ кадры шот-листа как пронумерованные
 * панели и раскладывает их в один контактный лист (grid), в порядке кадров. action'ы кадров — на языке
 * синопсиса; инструкции композиции — на английском (как во всех image-промптах).
 */
/**
 * Референсы серии для сборки сториборда: только те, у кого есть готовое изображение (imageUrl),
 * упорядоченные персонажи → локации → реквизит, обрезанные до cap (лимит image_input провайдера).
 * Один источник истины для воркера (image_input) и роута (превью + описание в промпте).
 */
const REF_KIND_ORDER: Record<EpisodeRefKindV2, number> = { character: 0, location: 1, prop: 2 };

/** Реф серии с присвоенным стабильным порядковым номером «(реф N)» (нумерация по порядку, не по имени). */
export type EpisodeRefV2Ordered = EpisodeRefV2 & { ord: number };

/**
 * Канонический порядок рефов серии (персонажи → локации → реквизит) со стабильным 1-based номером.
 * ЕДИНАЯ база нумерации «(реф N)» для шот-листа, листа-сториборда и кадров сцен — так референсы
 * привязываются ПО ПОРЯДКУ (номеру), а не по названию. Нумерация считается по ПОЛНОМУ списку рефов
 * (включая те, у кого ещё нет картинки), чтобы номер персонажа совпадал в шотах и в генерации.
 */
export function orderEpisodeRefsV2(refs: EpisodeRefV2[]): EpisodeRefV2Ordered[] {
  return (refs ?? [])
    .slice()
    .sort((a, b) => (REF_KIND_ORDER[a.kind] ?? 9) - (REF_KIND_ORDER[b.kind] ?? 9))
    .map((r, i) => ({ ...r, ord: i + 1 }));
}

export function selectStoryboardV2Refs(refs: EpisodeRefV2[], cap: number): EpisodeRefV2Ordered[] {
  const ordered = orderEpisodeRefsV2(refs); // стабильный номер по полному списку
  return ordered
    .filter((r) => r && typeof r.imageUrl === "string" && r.imageUrl)
    .slice(0, Math.max(0, cap));
}

/**
 * Референсы для ВИДЕО сцены (первый кадр сцены добавляется отдельно, image 1): ТОЛЬКО персонажи и реквизит
 * ЭТОЙ сцены (scene.refIds, назначаются при нарезке), персонажи первыми. Без сториборда и локаций.
 * Сцена без refIds (нарезана до этого правила) → все персонажи серии, как раньше.
 */
export function selectSceneVideoV2Refs(refs: EpisodeRefV2[], cap: number, scene?: Pick<EpisodeSceneV2, "refIds"> | null): EpisodeRefV2[] {
  const withImage = refs.filter((r) => r && typeof r.imageUrl === "string" && r.imageUrl);
  const ids = Array.isArray(scene?.refIds) ? new Set(scene!.refIds) : null;
  const pool = ids
    ? withImage.filter((r) => (r.kind === "character" || r.kind === "prop") && ids.has(r.id))
    : withImage.filter((r) => r.kind === "character");
  return pool
    .filter((r) => r.kind !== "location") // локации в видео сцены не передаются никогда (явный гард)
    .map((r, i) => [r, i] as const)
    .sort((a, b) => (REF_KIND_ORDER[a[0].kind] - REF_KIND_ORDER[b[0].kind]) || a[1] - b[1])
    .map(([r]) => r)
    .slice(0, Math.max(0, cap));
}

/**
 * Какие референсы (персонажи/реквизит) присутствуют в каждом шоте — детерминированный разбор по тексту шота
 * (имена персонажей латиницей / метка реквизита как подстрока). Используется как fallback, когда LLM-назначение не удалось.
 */
export function matchSceneRefsByText(shot: Partial<EpisodeShotV2>, refs: EpisodeRefV2[]): string[] {
  const text = `${shotFrameText(shot)} ${oneLine(shot.action)} ${oneLine(shot.ending)}`.toLowerCase();
  const out: string[] = [];
  for (const r of refs) {
    if (!r || (r.kind !== "character" && r.kind !== "prop")) continue;
    const label = stripRefKindPrefixV2(r.label).toLowerCase().trim();
    if (!label) continue;
    const tokens = label.split(/[\s,]+/).filter((w) => w.length >= 3);
    const hit = r.kind === "character" ? tokens.some((w) => text.includes(w)) : text.includes(label);
    if (hit) out.push(r.id);
  }
  return out;
}

/**
 * Отпечаток входов авто-промпта сториборда (шоты: index+фрейм/действие; рефы с картинками: id+label+imageUrl; стиль).
 * Используется как ключ кэша EpisodeStoryboardV2.autoPromptKey: совпал → показываем сохранённый промпт сразу,
 * не совпал (шот-лист или рефы изменились) → промпт строится заново. Без node:crypto — модуль импортируется клиентом.
 */
export function storyboardV2PromptKey(shots: EpisodeShotV2[], refs?: EpisodeRefV2[], visualStyle?: string, previousEnding?: string): string {
  const refList = (refs ?? []).filter((r) => r && typeof r.imageUrl === "string" && r.imageUrl);
  const src = JSON.stringify([
    "v7", // bump: REFERENCE LOCK — панели не источник внешности/одежды, только референс
    visualStyle ?? "",
    previousEnding ?? "",
    shots.map((s) => [s.index, shotFrameText(s) || s.action || ""]),
    refList.map((r) => [r.id, r.kind, r.label, r.imageUrl]),
  ]);
  let h1 = 0x811c9dc5, h2 = 0x1000193;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 + c, 0x9e3779b1) ^ (h2 >>> 13);
  }
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}:${src.length}`;
}

/**
 * Промпт листа-сториборда. Структура (по ТЗ):
 *  1) СПИСОК РЕФЕРЕНСОВ — САМЫМ ПЕРВЫМ блоком: «References:» + «Image N - <имя/название>» (N = позиция
 *     прикреплённой картинки в image_input; метки — English, без префикса типа; перевод делает вызывающий код).
 *     Без пояснительной сноски (по ТЗ) — привязка «Image N = N-я картинка» упомянута одной фразой в шапке;
 *  2) [VISUAL STYLE] (если передан) + ШАПКА — формат листа: ФИКСИРОВАННАЯ сетка 5×5 на листе 9:16 (каждая ячейка 9:16, одного размера), явная карта строк, сквозная нумерация, без текста;
 *  3) ПАНЕЛИ — «Panel N:» + описание «Фрейм» из шот-листа СЛОВО В СЛОВО (English — перевод делает вызывающий код).
 */
/** Ведущий блок «References:\nImage N - ...\n\n» промпта листа (или ""). */
const STORYBOARD_V2_REFS_BLOCK_RE = /^\s*References:\n(?:Image \d+ - [^\n]*\n)*(?:\nREFERENCE LOCK[^\n]*\n(?:- [^\n]*\n)*)?\n*/;
export function storyboardV2RefsBlock(prompt: string): string {
  const m = String(prompt ?? "").match(STORYBOARD_V2_REFS_BLOCK_RE);
  return m ? m[0] : "";
}

/**
 * Подменить в промпте (в т.ч. отредактированном вручную / сохранённом ранее) блок «References:» на актуальный
 * из свежего авто-промпта: референсы ВСЕГДА берутся актуальные со страницы «Референсы», даже если текст правили.
 * Остальной текст не трогается. Без блока в авто-промпте (рефов с картинками нет) — старый блок удаляется.
 */
export function syncStoryboardV2RefsBlock(prompt: string, autoPrompt: string): string {
  const src = String(prompt ?? "");
  if (!src.trim()) return src;
  const fresh = storyboardV2RefsBlock(autoPrompt);
  const cur = storyboardV2RefsBlock(src);
  if (!fresh && !cur) return src;
  if (fresh === cur) return src;
  return fresh + src.slice(cur.length).replace(/^\n+/, "");
}

/**
 * Блок REFERENCE LOCK: внешность И ОДЕЖДА персонажей, вид локаций и реквизита — ТОЛЬКО из референсов.
 * Текст панели/кадра может лишь ДОБАВИТЬ съёмное снаряжение поверх одежды из рефа (каска, респиратор, перчатки,
 * сумка) и состояние (грязь, пыль, мокрая/рваная ткань); заменить или перекрасить одежду он не может — слова вроде
 * "overalls/uniform/jacket" в тексте игнорируются в пользу рефа. Если персонаж перегенерирован в другой одежде,
 * кадры автоматически следуют новому рефу. `first` — номер первого референса в image_input (1 — сториборд,
 * 2 — первый кадр, где Image 1 = лист). `unit` — "panel" или "frame" (как называть текст-источник).
 */
export function buildReferenceLockV2(refList: EpisodeRefV2[], first: number, unit: "panel" | "frame"): string {
  if (!refList.length) return "";
  const refLabel = (r: EpisodeRefV2) => stripRefKindPrefixV2(r.label).replace(/\s+/g, " ").trim();
  const numbered = refList.map((r, i) => [r, i + first] as const);
  const chars = numbered.filter(([r]) => r.kind === "character");
  const locs = numbered.filter(([r]) => r.kind === "location");
  const props = numbered.filter(([r]) => r.kind === "prop");
  const every = unit === "panel" ? "in every panel" : "in the frame";
  const text = `the ${unit} text`;
  return (
    `\nREFERENCE LOCK (mandatory, overrides any ${unit} text):\n` +
    (chars.length
      ? `- Character appearance comes ONLY from the reference images: ${chars.map(([r, n]) => `${refLabel(r)} = Image ${n}`).join("; ")}. ` +
        `Reproduce each character's face, facial features, skin tone, hair color/length/style, age, body type and build EXACTLY as in their reference image ${every} they appear in — the same recognizable person each time. ` +
        `Do not invent, replace, age, restyle or "cast" a different person.\n` +
        `- WARDROBE LOCK: each character's clothing (every garment, its cut, color, material, footwear) comes ONLY from the reference image and is reproduced EXACTLY ${every} — the same outfit as in the reference, no redesign, no recolor, no substitution. ` +
        `${text[0].toUpperCase()}${text.slice(1)} may only ADD removable gear worn ON TOP of the reference outfit (helmet, respirator/mask, goggles, gloves, bag, belt, weapon) and surface state (dust, dirt, blood, wet or torn fabric). ` +
        `If ${text} names a garment itself (overalls, uniform, jacket, coat, dress, suit, etc.), IGNORE that word and keep the reference wardrobe. ` +
        (unit === "frame"
          ? `If the storyboard panel shows different clothing, hair or a different-looking person than the reference image, the REFERENCE IMAGE WINS — the panel is a layout sketch only, never a source of appearance or wardrobe. `
          : `Panels are never a source of appearance or wardrobe for later panels — go back to the reference image for every panel. `) +
        `Never cover the face unless ${text} explicitly says so.\n`
      : "") +
    (locs.length
      ? `- Locations come ONLY from the reference images: ${locs.map(([r, n]) => `${refLabel(r)} = Image ${n}`).join("; ")}. ` +
        `Every ${unit} set in a location must match its reference image exactly — same architecture, layout, materials, colors, fixtures, props placement and lighting mood; ${text} only chooses the camera angle and what happens inside that same place. ` +
        `Do not redesign, redecorate or substitute the location.\n`
      : "") +
    (props.length
      ? `- Props come ONLY from the reference images: ${props.map(([r, n]) => `${refLabel(r)} = Image ${n}`).join("; ")}. Same shape, size, material, color and markings ${every}.\n`
      : "")
  );
}

export function buildStoryboardV2Prompt(shots: EpisodeShotV2[], refs?: EpisodeRefV2[], opts?: { visualStyle?: string; previousEnding?: string }): string {
  const n = shots.length;
  const cols = 5;
  const rows = Math.max(5, Math.ceil(n / cols));

  const refList = (refs ?? []).filter((r) => r && typeof r.imageUrl === "string" && r.imageUrl);
  const refLabel = (r: EpisodeRefV2) => stripRefKindPrefixV2(r.label).replace(/\s+/g, " ").trim();
  const lockBlock = buildReferenceLockV2(refList, 1, "panel");
  const refsBlock = refList.length
    ? `References:\n` +
      refList.map((r, i) => `Image ${i + 1} - ${refLabel(r)}`).join("\n") +
      `\n` + lockBlock +
      `\n`
    : "";

  const style = (opts?.visualStyle ?? "").trim();
  const styleLine = style ? `[VISUAL STYLE]: ${style}\n` : "";

  // Жёсткая раскладка: ВСЕГДА 5 колонок × 5 строк на листе 9:16 → каждая ячейка ровно 9:16 и одного размера.
  // Явная карта «строка → номера панелей» + сквозная нумерация без пропусков: модель раньше рисовала 4 колонки
  // и теряла номера (5, 9, 12), из-за чего сбивался порядок кадров.
  const rowMap = Array.from({ length: rows }, (_, r) => {
    const from = r * cols + 1, to = Math.min((r + 1) * cols, cols * rows);
    const nums = Array.from({ length: to - from + 1 }, (_, k) => from + k);
    const shown = nums.filter((k) => k <= n);
    return `Row ${r + 1} (top to bottom): cells ${nums.join(", ")}` + (shown.length ? ` → panels ${shown.join(", ")}` : ` → EMPTY`) + (shown.length && shown.length < nums.length ? ` (cells ${nums.filter((k) => k > n).join(", ")} EMPTY)` : "");
  }).join("\n");

  const header =
    `STORYBOARD SHEET FORMAT\n` +
    `Create ONE single storyboard sheet on a vertical 9:16 canvas. The sheet is a FIXED grid of EXACTLY ${cols} columns x ${rows} rows = ${cols * rows} cells. ` +
    `All ${cols * rows} cells are IDENTICAL in size and each cell is a vertical 9:16 frame (the canvas is split into ${cols} equal columns and ${rows} equal rows; thin uniform gutters). ` +
    `Never use ${cols - 1} or ${cols + 1} columns, never make a cell wider, taller or larger than another, never merge cells, never leave a cell shape other than 9:16.\n` +
    `GRID LAYOUT (cells are numbered 1..${cols * rows} left-to-right, then top-to-bottom; cell 1 is top-left, cell ${cols} is top-right, cell ${cols * rows} is bottom-right):\n${rowMap}\n` +
    `Draw ALL ${n} shots of this episode, one shot per cell, in shot order: panel N goes into cell N. ` +
    (n < cols * rows ? `Cells ${n + 1}..${cols * rows} stay empty (plain dark background, no frame content, but keep their number badge). ` : "") +
    `Numbering is consecutive 1, 2, 3, ... ${cols * rows} with NO skipped numbers and NO repeated numbers; every cell shows its own number. No shot skipped, none merged, none repeated. ` +
    `Every cell has a thin frame and a small clearly legible number badge in its top-left corner equal to the cell number (= shot number). ` +
    `Each panel is a photorealistic cinematic still depicting exactly the described static frame — same characters, wardrobe, props and environments across all panels` +
    (refList.length ? `, matching the attached reference images (Image N = the N-th attached image). ` : `. `) +
    `Only the small panel number labels may contain text; no captions, no other writing on the sheet.`;

  const panels = shots
    .map((s) => {
      const frame = (shotFrameText(s) || s.action || "").replace(/\s+/g, " ").trim();
      return `Panel ${s.index}: ${frame}`;
    })
    // Панели разделены пустой строкой (по ТЗ) — читаемее и для человека, и для модели.
    .join("\n\n");

  const prevEnding = (opts?.previousEnding ?? "").replace(/\s+/g, " ").trim();
  const handoff = prevEnding
    ? `\n\nCONTINUITY WITH THE PREVIOUS EPISODE: Panel 1 depicts the SAME moment as the final panel of the previous episode — "${prevEnding}" — same place, same characters in the same positions, same wardrobe, same prop state, but seen from a DIFFERENT camera angle / shot size. It is a direct continuation of that frame, not a new scene.`
    : "";

  return `${refsBlock}${styleLine}${header}${handoff}\n\nPANELS:\n${panels}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 · уровень эпизода: вкладка «Сцены» (по сцене на кадр шот-листа; первый кадр 9:16 → видео Seedance i2v)
// ─────────────────────────────────────────────────────────────────────────────

export type EpisodeSceneStatusV2 = "idle" | "pending" | "running" | "done" | "error";

/** Сцена серии (Project.episodeScenesV2["<n>"].items[]): одна на кадр шот-листа. */
export interface EpisodeSceneV2 {
  id: string;
  index: number;
  shotId: string;
  /** Блок «Action» шота на English (переведено при нарезке) — единственное, что уходит в ACTIONS промпта видео. */
  action: string;
  /** Блок «Frame» шота на English — статичный первый кадр; только для генерации первого кадра, в промпт видео НЕ попадает. */
  frame?: string;
  /** Блок «Ending» шота на English — отдельный абзац END промпта видео (если шот без ending — генерируется при нарезке). */
  endFrame?: string;
  /** id референсов (персонажи и реквизит), присутствующих именно в этой сцене — только они уходят в видео сцены. */
  refIds?: string[];
  /** Длительность видео сцены (из шота). */
  durationSec?: number;
  firstFrameUrl?: string;
  firstFrameStatus?: EpisodeSceneStatusV2;
  firstFrameError?: string;
  videoUrl?: string;
  videoStatus?: EpisodeSceneStatusV2;
  videoError?: string;
  /** id задачи Seedance (WaveSpeed) запущенного видео — чтобы возобновлённый воркер опрашивал её, а не запускал новую. */
  videoTaskId?: string;
  /** ISO-время запуска задачи видео (таймаут считается через возобновления). */
  videoStartedAt?: string;
  /** Ручной промпт сцены (приоритетнее авто-промпта первого кадра и видео). */
  promptOverride?: string | null;
}

const SCENE_STATUSES: EpisodeSceneStatusV2[] = ["idle", "pending", "running", "done", "error"];
const sceneStatus = (v: unknown): EpisodeSceneStatusV2 | undefined => (SCENE_STATUSES.includes(v as EpisodeSceneStatusV2) ? (v as EpisodeSceneStatusV2) : undefined);
const optStr = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Сцены серии n из Project.episodeScenesV2 ({ "<n>": { items, updatedAt } }). */
export function episodeScenesV2From(map: unknown, n: number): EpisodeSceneV2[] {
  const v = map && typeof map === "object" ? (map as Record<string, any>)[String(n)] : null;
  if (!Array.isArray(v?.items)) return [];
  return (v.items as any[])
    .filter((s) => s && typeof s.id === "string" && typeof s.action === "string")
    .map((s) => ({
      id: s.id,
      index: Number(s.index) || 0,
      shotId: String(s.shotId ?? ""),
      action: s.action,
      frame: optStr(s.frame),
      endFrame: optStr(s.endFrame),
      refIds: Array.isArray(s.refIds) ? (s.refIds as unknown[]).filter((x): x is string => typeof x === "string" && !!x) : undefined,
      durationSec: Number.isFinite(Number(s.durationSec)) ? Number(s.durationSec) : undefined,
      firstFrameUrl: optStr(s.firstFrameUrl),
      firstFrameStatus: sceneStatus(s.firstFrameStatus),
      firstFrameError: optStr(s.firstFrameError),
      videoUrl: optStr(s.videoUrl),
      videoStatus: sceneStatus(s.videoStatus),
      videoError: optStr(s.videoError),
      videoTaskId: optStr(s.videoTaskId),
      videoStartedAt: optStr(s.videoStartedAt),
      promptOverride: typeof s.promptOverride === "string" && s.promptOverride.trim() ? s.promptOverride : null,
    }))
    .sort((a, b) => a.index - b.index);
}

/**
 * Авто-промпт первого кадра сцены: standalone 9:16 кадр, воссозданный по панели #index листа-сториборда
 * (лист — первое изображение в image_input), плюс описание референсов (идут следом). style — VISUAL_STYLE.
 */
export function buildSceneFrameV2Prompt(scene: Pick<EpisodeSceneV2, "index" | "action" | "frame">, refs: EpisodeRefV2[], style: string): string {
  const refList = refs.filter((r) => r && typeof r.imageUrl === "string" && r.imageUrl);
  const frame = typeof scene.frame === "string" && scene.frame.trim() ? scene.frame : "";
  const head =
    `[VISUAL STYLE]: ${style}\n` +
    `Standalone vertical 9:16 cinematic frame. Recreate panel #${scene.index} from the provided storyboard sheet as a full standalone shot.\n` +
    (frame ? `FRAME: ${frame.replace(/\s+/g, " ").trim()}\n` : `ACTION: ${scene.action.replace(/\s+/g, " ").trim()}\n`) +
    `Image 1 is the storyboard sheet — use ONLY panel #${scene.index} as the composition guide (framing, blocking, camera angle). Take NOTHING else from it: faces, hair and wardrobe come from the reference images below, not from the panel. ` +
    `Output ONE full-bleed photorealistic frame: no grid, no panel borders, no number badges, no captions or any text.`;
  const refsBlock = refList.length
    ? `\n\nREFERENCES: the next ${refList.length} attached image(s) are the canonical look of the recurring characters, locations and props — keep them identical. Bind each one BY POSITION (the Nth attached image = the Nth list item), never by name. The shot cites references as "(реф N)"; match that number to the "(реф N)" marker below:\n` +
      refList
        .map((r, i) => `Image ${i + 2} = реф ${(r as any).ord ?? i + 1} (${r.kind === "character" ? "character" : r.kind === "location" ? "location" : "prop"}): ${r.label.replace(/\s+/g, " ").trim()}`)
        .join("\n") +
      buildReferenceLockV2(refList, 2, "frame")
    : "";
  return `${head}${refsBlock}`;
}

/** Сколько референсов персонажей (кроме первого кадра) уходит в видео сцены; общий cap image_input = 4. */
export const MAX_SCENE_VIDEO_REF_IMAGES = 4;

/**
 * Промпт видео сцены (Seedance I2V/T2V с референсами). Ручной промпт заменяет всё. Иначе фиксированная
 * English-структура без негативов:
 *   REFERENCES: image 1 — первый кадр сцены (единственный источник пространства/раскладки), image 2..N — персонажи
 *   (только внешность, по порядку приложенных картинок — тот же порядок, что selectSceneVideoV2Refs);
 *   ACTIONS: движение сцены; END: к чему приходит кадр.
 * `characters` — метки персонажей-референсов в том порядке, в каком их картинки приложены после первого кадра.
 */
export function sceneVideoV2Prompt(
  scene: Pick<EpisodeSceneV2, "action" | "promptOverride" | "endFrame">,
  refs: Array<string | Pick<EpisodeRefV2, "label" | "kind">> = [],
): string {
  const ov = typeof scene.promptOverride === "string" ? scene.promptOverride.trim() : "";
  if (ov) return ov;
  const end = typeof scene.endFrame === "string" ? scene.endFrame.trim() : "";
  const refLines = [
    "image 1 — the first frame of this shot: the space, the characters' positions in it, their poses, the action they are in the middle of, the shot size and camera angle. This is the only source of the layout — do not add, remove or move anything in the space. Do not take appearance or wardrobe from it.",
    ...refs.map((r, i) => {
      const label = (typeof r === "string" ? r : stripRefKindPrefixV2(r.label)).replace(/\s+/g, " ").trim();
      const kind = typeof r === "string" ? "character" : r.kind;
      return kind === "prop"
        ? `image ${i + 2} — ${label} (prop, appearance only).`
        : `image ${i + 2} — ${label} (character: face, hair and the EXACT wardrobe — every garment, its cut, color, material and footwear — come from this image only and stay unchanged for the whole clip; no redesign, no recolor, no substitution).`;
    }),
  ];
  const hasChars = refs.some((r) => (typeof r === "string" ? "character" : r.kind) !== "prop");
  const blocks = [
    `REFERENCES:\n${refLines.join("\n")}` +
      (hasChars ? `\nWARDROBE LOCK: if image 1 shows a character in clothing that differs from that character's reference image, the reference image wins — render the reference wardrobe from the first frame to the last.` : ""),
    `ACTIONS:\n${scene.action.trim()}`,
  ];
  if (end) blocks.push(`END:\n${end}`);
  blocks.push(SCENE_VIDEO_AUDIO_BLOCK_V2);
  return blocks.join("\n\n");
}

/**
 * Звук клипа Seedance: только диегетический звук сцены и реплики — БЕЗ музыки. Фоновая музыка серии —
 * один трек на всю серию (ACE-Step), который подмешивается при склейке (episode-assemble-v2-job);
 * музыка внутри отдельных клипов при склейке рвалась бы на стыках и спорила бы с общим треком.
 */
export const SCENE_VIDEO_AUDIO_BLOCK_V2 =
  "AUDIO:\nOnly the natural, diegetic sound of the scene (room tone and ambience, footsteps, cloth, props, breathing) and the characters' spoken lines exactly as written in ACTIONS. NO background music, NO soundtrack, NO score, NO musical stingers or jingles of any kind — the episode's music is added separately in the edit.";

/** Финальный ролик серии (Project.episodeFinalV2["<n>"]): склейка видео всех сцен по index + фоновая музыка. */
export interface EpisodeFinalV2 {
  videoUrl?: string;
  /** Фоновый музыкальный трек серии (ACE-Step 1.5), подмешанный в videoUrl; пусто — склейка без музыки. */
  musicUrl?: string;
  status?: EpisodeSceneStatusV2;
  error?: string;
  updatedAt?: string;
}

export function episodeFinalV2From(map: unknown, n: number): EpisodeFinalV2 | null {
  const v = map && typeof map === "object" ? (map as Record<string, any>)[String(n)] : null;
  if (!v || typeof v !== "object") return null;
  return { videoUrl: optStr(v.videoUrl), musicUrl: optStr(v.musicUrl), status: sceneStatus(v.status), error: optStr(v.error), updatedAt: optStr(v.updatedAt) };
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 · музыка серии: один фоновый трек (ACE-Step 1.5) на всю серию, подмешивается при склейке
// ─────────────────────────────────────────────────────────────────────────────

/** Теги по умолчанию, если LLM не вернула своих (или сценария ещё нет): нейтральный кинематографичный эмбиент. */
export const EPISODE_MUSIC_FALLBACK_TAGS_V2 =
  "cinematic score, ambient, atmospheric, subtle, emotional, soft piano, strings, film soundtrack, instrumental, no vocals, slow tempo";

/** Теги, которые ДОЛЖНЫ быть в любом ответе: трек фоновый и без вокала (иначе он спорит с репликами). */
const EPISODE_MUSIC_REQUIRED_TAGS_V2 = ["cinematic score", "film soundtrack", "instrumental", "no vocals", "background music"];

export function episodeMusicTagsV2SystemPrompt(): string {
  return [
    "You are a film composer picking the mood of a background score for ONE episode of a vertical (9:16) drama series.",
    "Given the episode script, return the music generation tags for ONE continuous instrumental track that will play UNDER the whole episode (dialogue is on top of it, so it must stay subtle and unobtrusive).",
    "Reply with STRICT JSON: {\"tags\": \"<comma-separated tags>\"} — 8 to 14 tags in English only: genre, mood (match the dominant emotion of the episode), 2–4 instruments, tempo. No lyrics, no vocals, no song structure words.",
  ].join("\n");
}

export function episodeMusicTagsV2UserPrompt(script: string, synopsis?: string | null): string {
  const parts: string[] = [];
  const syn = typeof synopsis === "string" ? synopsis.trim() : "";
  if (syn) parts.push(`SERIES SYNOPSIS:\n${syn.slice(0, 3000)}`);
  parts.push(`EPISODE SCRIPT:\n${script.trim().slice(0, 12000)}`);
  return parts.join("\n\n");
}

/** Нормализует теги из ответа LLM: чистит, дедуплицирует, обрезает до 16 и дописывает обязательные. Пусто → fallback. */
export function normalizeEpisodeMusicTagsV2(raw: unknown): string {
  const src = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.filter((x) => typeof x === "string").join(",") : "";
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of src.split(/[,\n;]+/)) {
    const c = t.replace(/[^\p{L}\p{N}\s&'-]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
    if (!c || c.length > 40 || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    if (out.length >= 16) break;
  }
  if (!out.length) return EPISODE_MUSIC_FALLBACK_TAGS_V2;
  for (const req of EPISODE_MUSIC_REQUIRED_TAGS_V2) if (!seen.has(req)) { out.push(req); seen.add(req); }
  return out.join(", ");
}

/** Все сцены серии готовы к склейке: есть хотя бы одна, и у каждой videoStatus=done + videoUrl. */
export function allSceneVideosReady(scenes: Pick<EpisodeSceneV2, "videoStatus" | "videoUrl">[]): boolean {
  return scenes.length > 0 && scenes.every((s) => s.videoStatus === "done" && !!s.videoUrl);
}
