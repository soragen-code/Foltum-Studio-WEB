/**
 * Фоновый воркер потока «Новый проект v2.0»: идея / жанры → ЛОГЛАЙН (1 предложение по формуле
 * "When [event], [hero] must [goal], or else [stakes].").
 *
 *   • модель — только FABLE_MODEL («Claude Fable 5.1»);
 *   • промпт — buildLoglineV2Parts (lib/idea-v2.ts) или присланные пользователем override-тексты;
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
import { runWithPromptContext } from "@/lib/prompt-log";
import { FABLE_MODEL, LOGLINE_V2_STAGE, buildLoglineV2Parts } from "@/lib/idea-v2";

/** GenerationJob.type для задачи «идея v2 → логлайн». */
export const LOGLINE_V2_JOB_TYPE = "logline_v2";

/** Примерная длительность шага (секунды). */
export const LOGLINE_V2_EXPECTED_SEC = 15;

export interface LoglineV2JobParams {
  idea?: string | null;
  genres?: string[];
  /** Пожелания продюсера (режим жанров). */
  wishes?: string | null;
  /** Текущий логлайн — база для режима уточнения (см. refine). */
  logline?: string | null;
  /** Правка: что изменить в текущем логлайне (режим уточнения, контекст сохраняется). */
  refine?: string | null;
  overrideSystem?: string | null;
  overrideUser?: string | null;
  overrideAssistant?: string | null;
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
    const { idea, genres = [], wishes, logline: prevLogline, refine, overrideSystem, overrideUser, overrideAssistant } = params;
    const parts = buildLoglineV2Parts({ idea, genres, wishes, logline: prevLogline, refine });
    const system = overrideSystem && overrideSystem.trim() ? overrideSystem : parts.system;
    const user = overrideUser && overrideUser.trim() ? overrideUser : parts.user;
    const assistantPrefill = (overrideAssistant ?? parts.assistant ?? "").trim();
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
        const raw = await streamChatText(system, user, { model: FABLE_MODEL, temperature: 0.8, maxTokens: 2048, onDelta, assistantPrefill });
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
