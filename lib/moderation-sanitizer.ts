import { chat } from "@/lib/ai";

/**
 * LLM-based prompt sanitizer for video-model moderation (Seedance E005 "input or output was
 * flagged as sensitive"). Rewrites a video prompt so it passes automatic content moderation
 * WITHOUT losing the meaning of the scene: it keeps the plot, characters, spoken dialogue lines,
 * emotions, staging and camera work, and only removes/replaces the wording a filter reacts to.
 *
 * Two escalating strictness passes:
 *   pass 1 — neutralise trigger nouns and explicit action wording;
 *   pass 2 — stricter: also strip any physical contact, threat or intensifier, leaving calm
 *            conversation, faces and static blocking.
 *
 * The instruction is written in Russian (the project's working language); the prompt content
 * itself is NOT translated — the model is told to answer in the prompt's own language (English),
 * so the video model receives directions in the language it expects.
 */

export interface LlmSanitizeResult {
  prompt: string;
  changed: boolean;
}

const BASE_SYSTEM = `Ты — редактор-корректор промптов для генерации видео. Видео-модель отклонила промпт из-за автоматической модерации контента (пометка «чувствительный контент»). Твоя задача — переписать промпт так, чтобы он гарантированно прошёл модерацию, СОХРАНИВ смысл сцены.

ОБЯЗАТЕЛЬНО СОХРАНИ без изменений:
- сюжет и логику сцены;
- персонажей, их имена и внешность;
- реплики и произносимый текст (всё, что персонажи говорят вслух) — копируй дословно, НЕ перефразируй и НЕ сокращай;
- эмоции, мизансцену, ракурсы камеры, освещение, темп;
- строки-пометки в квадратных скобках ([ACTION], [NON-VERBAL], [BLOCKING], [ImageN] и т.п.) — сохрани их формат.

УБЕРИ или ЗАМЕНИ нейтральными эквивалентами всё, что может триггерить фильтр:
- «зелья», «колбы», «запретная секция» → «старинные фолианты», «древние книги», «светящийся кристалл», «закрытый архив»;
- агрессию, драки, физический контакт, насилие → выражай конфликт через реплики, взгляды, выражения лиц и мизансцену;
- оружие, кровь, раны, смерть, опасность, огонь, аварии → нейтральные кинематографичные аналоги;
- интимные сцены, обнажённость → полностью одетые персонажи, спокойное общение;
- любые намёки на несовершеннолетних в опасности → убрать;
- наркотики, алкоголь → убрать или заменить.

Язык промпта НЕ меняй: если он на английском — вывод тоже на английском.
Верни ТОЛЬКО переписанный промпт — без пояснений, без markdown, без кавычек вокруг текста.`;

const STRICTER_SUFFIX = `

Это ВТОРАЯ, более строгая попытка — предыдущий смягчённый вариант всё равно не прошёл модерацию. Будь максимально осторожен: полностью убери любой физический контакт, любые угрозы, любые резкие действия и физические интенсификаторы. Оставь спокойное общение персонажей, их реплики, выражения лиц и статичную мизансцену. Любое сомнительное слово — удаляй.`;

/**
 * Rewrite `prompt` through the LLM to pass video moderation. Never throws: on any LLM error it
 * returns the original prompt unchanged so the caller's cascade (rule-based softening + model
 * fallback) still runs. `max_tokens` is capped at 16000 (gpt-4o output limit is 16384).
 */
export async function sanitizePromptWithLlm(prompt: string, pass: 1 | 2): Promise<LlmSanitizeResult> {
  const source = (prompt ?? "").trim();
  if (!source) return { prompt, changed: false };
  const system = pass >= 2 ? BASE_SYSTEM + STRICTER_SUFFIX : BASE_SYSTEM;
  try {
    const rewritten = (await chat(system, source, {
      temperature: 0.4,
      maxTokens: 16000,
      timeoutMs: 120_000,
      maxRetries: 1,
    })).trim();
    // A blank or suspiciously short answer is not usable — keep the original prompt.
    if (!rewritten || rewritten.length < Math.min(40, source.length / 2)) {
      return { prompt, changed: false };
    }
    return { prompt: rewritten, changed: rewritten !== source };
  } catch (error) {
    console.warn("[moderation-sanitizer] LLM rewrite failed; using original prompt:", (error as Error)?.message);
    return { prompt, changed: false };
  }
}
