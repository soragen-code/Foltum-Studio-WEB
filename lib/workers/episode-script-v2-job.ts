/**
 * Фоновый воркер потока v2, уровень эпизода (вкладка «Сценарий»): краткий сюжет серии N → диалоговый сценарий
 * под вертикаль со слаглайнами INT./EXT. Многоходовые правки:
 * system → user (краткий сюжет серии как есть) → assistant (S0) → user (правка EN) → assistant → ... → крайний user.
 *
 * Паттерн — season-plot-v2-job.ts: FABLE_MODEL, messages через lib/idea-v2.ts (общие с превью-роутом) или
 * overrideMessages из модалки; авто-лог промпта kind "episode_script_v2"; результат пишется атомарно в
 * Project.episodeScriptsV2["<n>"] (стадию проекта НЕ меняет — остаёмся на season_plot_v2).
 */
import { prisma } from "@/lib/db";
import { updateJob, completeJob, failJob, heartbeatJob, markCanceled, isCancelRequested } from "@/lib/jobs";
import { makeJobStreamWriter, flushStreamedText } from "@/lib/stream-progress";
import { streamChatText } from "@/lib/ai";
import { runWithPromptContext } from "@/lib/prompt-log";
import { translateScriptRefines, translateNonEnglishLines } from "@/lib/translate-en";
import { FABLE_MODEL, buildEpisodeScriptV2Parts, normalizeSynopsisLanguage, type V2Msg } from "@/lib/idea-v2";
import { resolveV2Messages, trailingAssistantPrefill, splitForLog } from "@/lib/workers/logline-v2-job";

/** GenerationJob.type для задачи «сценарий эпизода v2»; номер серии — в resultData.episode. */
export const EPISODE_SCRIPT_V2_JOB_TYPE = "episode_script_v2";
export const EPISODE_SCRIPT_V2_EXPECTED_SEC = 60;

export interface EpisodeScriptV2JobParams {
  episode: number;
  summary: string;
  synopsisLanguage?: string | null;
  script?: string | null;
  refine?: string | null;
  refineEn?: string | null;
  scriptBase?: string | null;
  scriptTurns?: { refine: string; script: string }[] | null;
  overrideMessages?: V2Msg[] | null;
}

/** Номер серии задачи (resultData.episode), либо null. */
export function episodeOfScriptJob(job: { resultData?: string | null }): number | null {
  try { const n = Number(JSON.parse(job.resultData ?? "null")?.episode); return Number.isInteger(n) ? n : null } catch { return null }
}

async function runEpisodeScriptV2JobImpl(jobId: string, projectId: string, params: EpisodeScriptV2JobParams): Promise<void> {
  let hb: ReturnType<typeof setInterval> | null = null;
  try {
    const { episode, summary, script: prevScript, refine: refineRaw, refineEn, scriptBase, scriptTurns: turnsRaw, overrideMessages } = params;
    const synopsisLanguage = normalizeSynopsisLanguage(params.synopsisLanguage);
    const { refine, scriptTurns } = await translateScriptRefines({ refine: refineRaw, refineEn, scriptTurns: turnsRaw });
    const parts = buildEpisodeScriptV2Parts({ summary, synopsisLanguage, script: prevScript, refine, scriptBase, scriptTurns });
    let messages = resolveV2Messages(parts.messages, { overrideMessages });
    if (overrideMessages?.length && messages.filter((m) => m.role !== "system").length > 1 && messages[messages.length - 1].role === "user") {
      const last = messages[messages.length - 1];
      messages = [...messages.slice(0, -1), { role: "user", content: await translateNonEnglishLines(last.content) }];
    }
    const assistantPrefill = trailingAssistantPrefill(messages);
    const log = splitForLog(messages);

    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { status: "processing", progress: 10, message: "Writing episode script..." });
    hb = setInterval(() => { heartbeatJob(jobId).catch(() => {}); }, 60_000);

    let script = "";
    let lastError = "";
    for (let attempt = 0; attempt < 2 && !script; attempt++) {
      if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
      try {
        const onDelta = makeJobStreamWriter(jobId);
        const raw = await streamChatText(log.system, log.user, { model: FABLE_MODEL, temperature: 0.7, maxTokens: 8000, onDelta, messages });
        const full = (assistantPrefill ? `${assistantPrefill}${raw ?? ""}` : (raw ?? "")).replace(/\r\n?/g, "\n").trim();
        if (full.length < 60) throw new Error("episode script too short / empty");
        script = full;
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        console.warn(`[episode-script-v2] attempt ${attempt + 1} failed:`, lastError);
      }
    }
    if (!script) { await failJob(jobId, "AI returned an invalid result: " + lastError); return; }
    await flushStreamedText(jobId, script);
    if (!/^\s*(INT\.|EXT\.)/m.test(script)) console.warn(`[episode-script-v2] no INT./EXT. slugline in episode ${episode}`);

    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { progress: 90, message: "Saving episode script..." });
    // Атомарное слияние ключа "<n>" (параллельные серии не затирают друг друга).
    const entry = JSON.stringify({ script, updatedAt: new Date().toISOString() });
    await prisma.$executeRaw`UPDATE "Project" SET "episodeScriptsV2" = COALESCE("episodeScriptsV2", '{}'::jsonb) || jsonb_build_object(${String(episode)}::text, ${entry}::jsonb) WHERE "id" = ${projectId}`;
    await completeJob(jobId, { episode, script }, "Episode script ready");
  } catch (err: any) {
    console.error("[episode-script-v2] job error:", err);
    await failJob(jobId, "Generation failed: " + (err?.message ?? "Unknown error"));
  } finally {
    if (hb) clearInterval(hb);
  }
}

export function runEpisodeScriptV2Job(jobId: string, projectId: string, params: EpisodeScriptV2JobParams): Promise<void> {
  return runWithPromptContext({ kind: "episode_script_v2", projectId }, () => runEpisodeScriptV2JobImpl(jobId, projectId, params));
}
