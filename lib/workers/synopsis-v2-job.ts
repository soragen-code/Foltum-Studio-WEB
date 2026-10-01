/**
 * Фоновый воркер потока «Новый проект v2.0»: идея / жанры (+ пожелания) → синопсис (7–10 предложений),
 * напрямую, без шага логлайна. Поддерживает многоходовые правки: system → user (ввод) → assistant (S0) →
 * user (правка) → assistant → ... → крайний user (текущая правка). Язык вывода и количество эпизодов —
 * выбор пользователя (synopsisLanguage, episodesCount) → подставляются в system.
 *
 * Повторяет паттерн synopsis-job.ts (idea → synopsis), но:
 *   • использует ТОЛЬКО модель FABLE_MODEL («Claude Fable 5.1»);
 *   • собирает messages system → user → (assistant) через lib/idea-v2.ts (единый с превью-роутом)
 *     ИЛИ берёт присланный из модалки диалог overrideMessages (system/user/assistant, нормализуется);
 *   • логирует реально отправленный промпт (в т.ч. отредактированный) с kind "synopsis_v2"
 *     — за счёт runWithPromptContext + авто-лога в streamChatText (lib/ai.ts);
 *   • мета-вызов {title, language, logline} — на СОБСТВЕННЫХ промптах v2 (lib/idea-v2.ts), без шаблонов v1;
 *     logline из меты пишется в Project.logline (для совместимости с этапами, читающими логлайн);
 *   • сохраняет синопсис, язык и episodeCount в Project и ставит stage=SYNOPSIS_V2_STAGE ("synopsis_v2") — отдельную
 *     конечную стадию v2, НЕ входящую в пайплайн v1: поток v2 пока завершается показом синопсиса.
 */
import { prisma } from "@/lib/db";
import { updateJob, completeJob, failJob, heartbeatJob, markCanceled, isCancelRequested } from "@/lib/jobs";
import { makeJobStreamWriter, flushStreamedText } from "@/lib/stream-progress";
import { streamChatText, streamChatJSON } from "@/lib/ai";
import {
  genresToEnglish,
  normalizeLanguage,
  stripMarkup,
  type IdeaLanguage,
} from "@/lib/idea";
import { resolveProjectName } from "@/lib/project-name";
import { runWithPromptContext } from "@/lib/prompt-log";
import { translateToEnglish, translateSynopsisRefines, translateNonEnglishLines } from "@/lib/translate-en";
import {
  FABLE_MODEL,
  SYNOPSIS_V2_STAGE,
  buildSynopsisV2Parts,
  normalizeSynopsisLanguage,
  normalizeEpisodesCount,
  SYNOPSIS_LANGUAGE_CODES,
  synopsisV2MetaSchema,
  synopsisV2MetaSystemPrompt,
  synopsisV2MetaUserPrompt,
  type V2Msg,
} from "@/lib/idea-v2";
import { resolveV2Messages, trailingAssistantPrefill, splitForLog } from "@/lib/workers/logline-v2-job";

/** GenerationJob.type для задачи «идея v2 → синопсис» (новое строковое значение, без миграции схемы). */
export const SYNOPSIS_V2_JOB_TYPE = "synopsis_v2";

/** Примерная длительность шага — управляет плавным баром 0→100 % на клиенте. */
export const SYNOPSIS_V2_EXPECTED_SEC = 45;

export interface SynopsisV2JobParams {
  idea?: string | null;
  /** Английский перевод идеи из preview (совпадает с модалкой); если нет — переводим здесь. */
  ideaEn?: string | null;
  genres?: string[];
  /** Пожелания продюсера (по-русски) и их английский перевод из preview. */
  wishes?: string | null;
  wishesEn?: string | null;
  /** Язык вывода синопсиса ("Russian", "English", ...) — whitelist, дефолт Russian. */
  synopsisLanguage?: string | null;
  /** Количество эпизодов сезона (10–100, дефолт 50) → system <N> и Project.episodeCount. */
  episodesCount?: number | null;
  /** Текущий синопсис (для правки) + правка (по-русски) и её перевод; история правок — для транскрипта. */
  synopsis?: string | null;
  refine?: string | null;
  refineEn?: string | null;
  synopsisBase?: string | null;
  synopsisTurns?: { refine: string; synopsis: string }[] | null;
  /** Ручное переопределение из модалки: весь диалог system + user/assistant (нормализуется, system первым). */
  overrideMessages?: V2Msg[] | null;
  /** Legacy: отредактированный system-промпт — маппится в первый user на лету. */
  overrideSystem?: string | null;
  /** Отредактированный пользователем user-промпт. */
  overrideUser?: string | null;
  /** Заданный пользователем assistant «prefill» — зачин ответа модели (по умолчанию пуст). */
  overrideAssistant?: string | null;
}

/** Запасной заголовок из первой строки прозы, если metadata-вызов не удался. */
function titleFromFirstLine(prose: string): string {
  const line = prose.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  const words = line.replace(/^[\s"'«»“”\-—–*#]+/, "").split(/\s+/).filter(Boolean).slice(0, 5);
  return words.join(" ").replace(/[\s,;:.!?…"'«»“”\-—–]+$/g, "");
}

async function runSynopsisV2JobImpl(jobId: string, projectId: string, params: SynopsisV2JobParams): Promise<void> {
  let hb: ReturnType<typeof setInterval> | null = null;
  try {
    const { idea, ideaEn, genres = [], wishes, wishesEn, synopsisLanguage: langRaw, episodesCount: epRaw, synopsis: prevSynopsis, refine: refineRaw, refineEn, synopsisBase, synopsisTurns: turnsRaw, overrideMessages, overrideSystem, overrideUser, overrideAssistant } = params;
    // В промпт — английские идея/пожелания/правки: перевод из preview (совпадает с модалкой) либо переводим сейчас.
    const ideaForPrompt = (ideaEn ?? "").trim() || (await translateToEnglish(idea));
    const wishesForPrompt = (wishesEn ?? "").trim() || (await translateToEnglish(wishes));
    const synopsisLanguage = normalizeSynopsisLanguage(langRaw);
    const episodesCount = normalizeEpisodesCount(epRaw);
    const { refine, synopsisTurns } = await translateSynopsisRefines({ refine: refineRaw, refineEn, synopsisTurns: turnsRaw });
    const parts = buildSynopsisV2Parts({ idea: ideaForPrompt, genres, wishes: wishesForPrompt, synopsisLanguage, episodesCount, synopsis: prevSynopsis, refine, synopsisBase, synopsisTurns });
    // system (правила) первым. Ручные правки из модалки (overrideMessages) имеют приоритет.
    let messages = resolveV2Messages(parts.messages, { overrideMessages, overrideSystem, overrideUser, overrideAssistant });
    // Ручная правка крайнего user в модалке могла быть дописана по-русски → переводим не-английские строки (только ход правки).
    if (overrideMessages?.length && messages.filter((m) => m.role !== "system").length > 1 && messages[messages.length - 1].role === "user") {
      const last = messages[messages.length - 1];
      messages = [...messages.slice(0, -1), { role: "user", content: await translateNonEnglishLines(last.content) }];
    }
    const assistantPrefill = trailingAssistantPrefill(messages);
    const log = splitForLog(messages);
    const defaultLanguage: IdeaLanguage = SYNOPSIS_LANGUAGE_CODES[synopsisLanguage];
    const ideaForStore = idea && idea.trim()
      ? idea.trim()
      : `[v2 · genres] ${genresToEnglish(genres).join(", ") || "—"}`;
    const languageHintText = idea && idea.trim() ? idea : "";

    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { status: "processing", progress: 15, message: "Writing synopsis…" });
    hb = setInterval(() => { heartbeatJob(jobId).catch(() => {}); }, 60_000);

    // ── 1. Генерация прозы синопсиса потоком (стрим прямо в streamedText). ──
    let synopsis = "";
    let lastError = "";
    for (let attempt = 0; attempt < 2 && !synopsis; attempt++) {
      if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
      try {
        const onDelta = makeJobStreamWriter(jobId);
        const raw = await streamChatText(log.system, log.user, { model: FABLE_MODEL, temperature: 0.8, maxTokens: 6000, onDelta, messages });
        // Если задан assistant-prefill, модель вернёт только продолжение — восстановим полный текст.
        const full = assistantPrefill ? `${assistantPrefill}${raw ?? ""}` : (raw ?? "");
        const cleaned = stripMarkup(full).trim();
        if (cleaned.length < 60) throw new Error("synopsis prose too short / empty");
        synopsis = cleaned;
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        console.warn(`[synopsis-v2] prose attempt ${attempt + 1} failed:`, lastError);
      }
    }
    if (!synopsis) { await failJob(jobId, "AI returned an invalid result: " + lastError); return; }
    await flushStreamedText(jobId, synopsis);

    // ── 2. Короткий metadata-вызов на готовой прозе: {title, language, logline}. Никогда не фатален. ──
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { progress: 70, message: "Naming the series…" });
    let title = "";
    let language: IdeaLanguage | null = null;
    let metaLogline = "";
    try {
      await heartbeatJob(jobId);
      // Мета-вызов: system (правила) + user (синопсис).
      const metaRaw = await streamChatJSON(synopsisV2MetaSystemPrompt(), synopsisV2MetaUserPrompt(synopsis), { model: FABLE_MODEL, temperature: 0.4, maxTokens: 2000 });
      const meta = synopsisV2MetaSchema.parse(metaRaw);
      title = stripMarkup(meta.title ?? "").replace(/\s+/g, " ").trim();
      if (meta.language) language = normalizeLanguage(meta.language, languageHintText || synopsis);
      metaLogline = stripMarkup(meta.logline ?? "").replace(/\s+/g, " ").trim();
    } catch (e) {
      console.warn(`[synopsis-v2] metadata call failed, using fallbacks: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!title) title = titleFromFirstLine(synopsis);
    // Язык проекта — выбранный пользователем язык синопсиса (детекция меты — только запасной вариант).
    language = defaultLanguage ?? language;

    // ── 3. Сохранение + завершение. stage="synopsis_v2" — конечная стадия v2: пайплайн v1 НЕ продолжается. ──
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { progress: 80, message: "Saving synopsis…" });
    await prisma.project.update({
      where: { id: projectId },
      data: {
        idea: ideaForStore,
        synopsis,
        language,
        episodeCount: episodesCount,
        // Логлайн из меты — для совместимости с этапами/экранами, читающими Project.logline (шаг логлайна в v2 убран).
        ...(metaLogline ? { logline: metaLogline } : {}),
        synopsisApproved: false,
        stage: SYNOPSIS_V2_STAGE,
        name: resolveProjectName(title, idea && idea.trim() ? idea : synopsis),
      },
    });
    const renamed = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    await completeJob(jobId, { synopsis, language, episodeCount: episodesCount, logline: metaLogline || null, projectName: renamed?.name ?? null }, "Synopsis ready");
  } catch (err: any) {
    console.error("[synopsis-v2] job error:", err);
    await failJob(jobId, "Generation failed: " + (err?.message ?? "Unknown error"));
  } finally {
    if (hb) clearInterval(hb);
  }
}

/** Обёртка prompt-log: задаёт kind "synopsis_v2" + projectId для авто-лога всех LLM-вызовов воркера. */
export function runSynopsisV2Job(jobId: string, projectId: string, params: SynopsisV2JobParams): Promise<void> {
  return runWithPromptContext({ kind: "synopsis_v2", projectId }, () => runSynopsisV2JobImpl(jobId, projectId, params));
}
