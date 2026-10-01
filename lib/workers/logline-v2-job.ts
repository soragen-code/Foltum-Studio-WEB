/**
 * Фоновый воркер потока «Новый проект v2.0»: идея / жанры → ЛОГЛАЙН (1 предложение по формуле
 * "When [event], [hero] must [goal], or else [stakes].").
 *
 *   • модель — только FABLE_MODEL («Claude Fable 5.1»);
 *   • промпт — messages БЕЗ system (правила в первом user) из buildLoglineV2Parts (lib/idea-v2.ts)
 *     или присланный из модалки диалог overrideMessages (история + отредактированный крайний user);
 *   • логируется с kind "logline_v2" (runWithPromptContext + авто-лог streamChatText);
 *   • сохраняет логлайн в Project (logline, loglineApproved=false) и ставит stage="logline_v2" —
 *     экран логлайна ждёт аппрува, после которого генерируется синопсис. Синопсис прошлой итерации
 *     сбрасывается (downstream обнуляется).
 */
import { prisma } from "@/lib/db";
import { updateJob, completeJob, failJob, heartbeatJob, markCanceled, isCancelRequested } from "@/lib/jobs";
import { makeJobStreamWriter, flushStreamedText } from "@/lib/stream-progress";
import { streamChatText } from "@/lib/ai";
import { genresToEnglish, stripMarkup } from "@/lib/idea";
import { translateToEnglish } from "@/lib/translate-en";
import { runWithPromptContext } from "@/lib/prompt-log";
import { FABLE_MODEL, LOGLINE_V2_STAGE, buildLoglineV2Parts, legacyPartsToMessages, flattenV2Messages, type V2Msg } from "@/lib/idea-v2";

/** GenerationJob.type для задачи «идея v2 → логлайн». */
export const LOGLINE_V2_JOB_TYPE = "logline_v2";

/** Примерная длительность шага (секунды). */
export const LOGLINE_V2_EXPECTED_SEC = 15;

export interface LoglineV2JobParams {
  idea?: string | null;
  genres?: string[];
  /** Пожелания продюсера (режим жанров), как ввёл пользователь (обычно по-русски). */
  wishes?: string | null;
  /** Английский перевод пожеланий из preview. Если не передан — переводим здесь. */
  wishesEn?: string | null;
  /** Текущий логлайн — база для режима уточнения (см. refine). */
  logline?: string | null;
  /** Правка: что изменить в текущем логлайне (режим уточнения, контекст сохраняется). */
  refine?: string | null;
  /** Базовый логлайн L0 — для сборки реального диалога messages. */
  loglineBase?: string | null;
  /** Применённые пары «правка → логлайн» по порядку — становятся ходами диалога. */
  loglineTurns?: { refine: string; logline: string }[] | null;
  /**
   * Ручное переопределение из модалки: ВЕСЬ диалог (user/assistant, без system) — история хронологически
   * + отредактированный крайний user. Если задан — уходит как есть вместо собранного диалога.
   */
  overrideMessages?: V2Msg[] | null;
  /** Legacy-переопределение (system/user/assistant) — маппится в один первый user на лету. */
  overrideSystem?: string | null;
  overrideUser?: string | null;
  overrideAssistant?: string | null;
}

/** Выбрать реально отправляемый диалог: override из модалки → legacy-override → собранный диалог. */
export function resolveV2Messages(
  built: V2Msg[],
  o: { overrideMessages?: V2Msg[] | null; overrideSystem?: string | null; overrideUser?: string | null; overrideAssistant?: string | null },
): V2Msg[] {
  const manual = (o.overrideMessages ?? []).filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim());
  if (manual.length) return manual;
  const sys = (o.overrideSystem ?? "").trim();
  const usr = (o.overrideUser ?? "").trim();
  const asst = (o.overrideAssistant ?? "").trim();
  if (sys || usr || asst) {
    // Legacy: один user (system-текст первым, затем user-текст); пустые поля берём из собранного первого user.
    const first = built[0]?.content ?? "";
    return legacyPartsToMessages(sys, usr || (sys ? "" : first), asst);
  }
  return built;
}

/** Если диалог заканчивается assistant (prefill-зачин) — модель продолжит с него; вернём этот зачин. */
export function trailingAssistantPrefill(messages: V2Msg[]): string {
  const last = messages[messages.length - 1];
  return last && last.role === "assistant" ? last.content : "";
}

/** Снять обёрточные кавычки и оставить первое непустое «предложение-абзац». */
function cleanLogline(raw: string): string {
  const text = stripMarkup(raw ?? "").trim();
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  return line.replace(/^[\s"'«»“”]+/, "").replace(/[\s"'«»“”]+$/, "").trim();
}

async function runLoglineV2JobImpl(jobId: string, projectId: string, params: LoglineV2JobParams): Promise<void> {
  let hb: ReturnType<typeof setInterval> | null = null;
  try {
    const { idea, genres = [], wishes, wishesEn, logline: prevLogline, refine, loglineBase, loglineTurns, overrideMessages, overrideSystem, overrideUser, overrideAssistant } = params;
    // В промпт — английские пожелания: перевод из preview (совпадает с модалкой) либо переводим сейчас.
    const wishesForPrompt = (wishesEn ?? "").trim() || (await translateToEnglish(wishes));
    const parts = buildLoglineV2Parts({ idea, genres, wishes: wishesForPrompt, logline: prevLogline, refine, loglineBase, loglineTurns });
    // Без роли system: правила в первом user. Ручные правки из модалки (overrideMessages) имеют приоритет.
    const messages = resolveV2Messages(parts.messages, { overrideMessages, overrideSystem, overrideUser, overrideAssistant });
    const assistantPrefill = trailingAssistantPrefill(messages);
    // Для prompt-log: system пуст, в user — весь плоский диалог.
    const logUser = flattenV2Messages(messages);
    const ideaForStore = idea && idea.trim()
      ? idea.trim()
      : `[v2 · genres] ${genresToEnglish(genres).join(", ") || "—"}`;

    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { status: "processing", progress: 15, message: "Writing logline..." });
    hb = setInterval(() => { heartbeatJob(jobId).catch(() => {}); }, 60_000);

    let logline = "";
    let lastError = "";
    for (let attempt = 0; attempt < 2 && !logline; attempt++) {
      if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
      try {
        const onDelta = makeJobStreamWriter(jobId);
        const raw = await streamChatText("", logUser, { model: FABLE_MODEL, temperature: 0.8, maxTokens: 2048, onDelta, messages });
        const full = assistantPrefill ? `${assistantPrefill}${raw ?? ""}` : (raw ?? "");
        const cleaned = cleanLogline(full);
        if (cleaned.length < 20) throw new Error("logline too short / empty");
        logline = cleaned;
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        console.warn(`[logline-v2] attempt ${attempt + 1} failed:`, lastError);
      }
    }
    if (!logline) { await failJob(jobId, "AI returned an invalid result: " + lastError); return; }
    await flushStreamedText(jobId, logline);

    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { progress: 85, message: "Saving logline..." });
    await prisma.project.update({
      where: { id: projectId },
      data: {
        idea: ideaForStore,
        logline,
        loglineApproved: false,
        // Новый логлайн обнуляет синопсис прошлой итерации.
        synopsis: null,
        synopsisApproved: false,
        stage: LOGLINE_V2_STAGE,
      },
    });
    await completeJob(jobId, { logline }, "Logline ready");
  } catch (err: any) {
    console.error("[logline-v2] job error:", err);
    await failJob(jobId, "Generation failed: " + (err?.message ?? "Unknown error"));
  } finally {
    if (hb) clearInterval(hb);
  }
}

/** Обёртка prompt-log: kind "logline_v2" + projectId. */
export function runLoglineV2Job(jobId: string, projectId: string, params: LoglineV2JobParams): Promise<void> {
  return runWithPromptContext({ kind: "logline_v2", projectId }, () => runLoglineV2JobImpl(jobId, projectId, params));
}
