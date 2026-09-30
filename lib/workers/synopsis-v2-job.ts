/**
 * Фоновый воркер потока «Новый проект v2.0»: идея / жанры → синопсис (7–10 предложений).
 *
 * Повторяет паттерн synopsis-job.ts (idea → synopsis), но:
 *   • использует ТОЛЬКО модель FABLE_MODEL («Claude Fable 5.1»);
 *   • собирает РАЗДЕЛЬНО system и user через lib/idea-v2.ts (единый с превью-роутом) ИЛИ берёт
 *     присланные пользователем отредактированные тексты (overrideSystem / overrideUser); они уходят
 *     в модель двумя messages в одном вызове streamChatText;
 *   • логирует реально отправленный промпт (в т.ч. отредактированный) с kind "synopsis_v2"
 *     — за счёт runWithPromptContext + авто-лога в streamChatText (lib/ai.ts);
 *   • мета-вызов {title, language} — на СОБСТВЕННЫХ промптах v2 (lib/idea-v2.ts), без шаблонов v1;
 *   • сохраняет синопсис в Project и ставит stage=SYNOPSIS_V2_STAGE ("synopsis_v2") — отдельную
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
import {
  FABLE_MODEL,
  SYNOPSIS_V2_STAGE,
  buildSynopsisV2Parts,
  resolveV2Language,
  synopsisV2MetaSchema,
  synopsisV2MetaSystemPrompt,
  synopsisV2MetaUserPrompt,
} from "@/lib/idea-v2";

/** GenerationJob.type для задачи «идея v2 → синопсис» (новое строковое значение, без миграции схемы). */
export const SYNOPSIS_V2_JOB_TYPE = "synopsis_v2";

/** Примерная длительность шага — управляет плавным баром 0→100 % на клиенте. */
export const SYNOPSIS_V2_EXPECTED_SEC = 45;

export interface SynopsisV2JobParams {
  idea?: string | null;
  genres?: string[];
  /** Утверждённый логлайн проекта — синопсис разворачивает его. */
  logline?: string | null;
  /** Отредактированный пользователем system-промпт (если он смотрел/правил превью). */
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
    const { idea, genres = [], logline, overrideSystem, overrideUser, overrideAssistant } = params;
    const parts = buildSynopsisV2Parts({ idea, genres, logline });
    // Реально отправляемый промпт: правки пользователя имеют приоритет над сгенерированными.
    // system и user уходят в модель двумя messages; assistant-prefill — третьим (если задан).
    const system = overrideSystem && overrideSystem.trim() ? overrideSystem : parts.system;
    const user = overrideUser && overrideUser.trim() ? overrideUser : parts.user;
    const assistantPrefill = (overrideAssistant ?? parts.assistant ?? "").trim();
    const defaultLanguage = resolveV2Language({ idea, genres });
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
        const raw = await streamChatText(system, user, { model: FABLE_MODEL, temperature: 0.8, maxTokens: 6000, onDelta, assistantPrefill });
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

    // ── 2. Короткий metadata-вызов на готовой прозе: {title, language}. Никогда не фатален. ──
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { progress: 70, message: "Naming the series…" });
    let title = "";
    let language: IdeaLanguage | null = null;
    try {
      await heartbeatJob(jobId);
      const metaRaw = await streamChatJSON(synopsisV2MetaSystemPrompt(), synopsisV2MetaUserPrompt(synopsis), { model: FABLE_MODEL, temperature: 0.4, maxTokens: 2000 });
      const meta = synopsisV2MetaSchema.parse(metaRaw);
      title = stripMarkup(meta.title ?? "").replace(/\s+/g, " ").trim();
      if (meta.language) language = normalizeLanguage(meta.language, languageHintText || synopsis);
    } catch (e) {
      console.warn(`[synopsis-v2] metadata call failed, using fallbacks: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!title) title = titleFromFirstLine(synopsis);
    if (!language) language = defaultLanguage;

    // ── 3. Сохранение + завершение. stage="synopsis_v2" — конечная стадия v2: пайплайн v1 НЕ продолжается. ──
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { progress: 80, message: "Saving synopsis…" });
    await prisma.project.update({
      where: { id: projectId },
      data: {
        idea: ideaForStore,
        synopsis,
        language,
        synopsisApproved: false,
        stage: SYNOPSIS_V2_STAGE,
        name: resolveProjectName(title, idea && idea.trim() ? idea : synopsis),
      },
    });
    const renamed = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    await completeJob(jobId, { synopsis, language, projectName: renamed?.name ?? null }, "Synopsis ready");
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
