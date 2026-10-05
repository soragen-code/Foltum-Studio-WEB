/**
 * Фоновый воркер потока «Новый проект v2.0», шаг 3: утверждённый синопсис → посерийный сюжет сезона
 * (ровно N эпизодов, "#<n>" маркеры, 2–4 предложения на серию). Поддерживает многоходовые правки:
 * system → user (синопсис как есть) → assistant (P0) → user (правка EN) → assistant → … → крайний user.
 *
 * Паттерн — synopsis-v2-job.ts: только FABLE_MODEL, messages через lib/idea-v2.ts (единые с превью-роутом)
 * или overrideMessages из модалки; авто-лог промпта с kind "season_plot_v2"; сохраняет сырой текст в
 * Project.seasonPlotV2 и ставит stage=SEASON_PLOT_V2_STAGE.
 */
import { prisma } from "@/lib/db";
import { updateJob, completeJob, failJob, heartbeatJob, markCanceled, isCancelRequested } from "@/lib/jobs";
import { makeJobStreamWriter, flushStreamedText } from "@/lib/stream-progress";
import { streamChatText } from "@/lib/ai";
import { runWithPromptContext } from "@/lib/prompt-log";
import { translatePlotRefines, translateNonEnglishLines } from "@/lib/translate-en";
import {
  FABLE_MODEL,
  SEASON_PLOT_V2_STAGE,
  buildSeasonPlotV2Parts,
  normalizeSynopsisLanguage,
  normalizeEpisodesCount,
  parseSeasonPlotV2,
  SYNOPSIS_LANGUAGE_CODES,
  type V2Msg,
} from "@/lib/idea-v2";
import { resolveV2Messages, trailingAssistantPrefill, splitForLog } from "@/lib/workers/logline-v2-job";

/** GenerationJob.type для задачи «синопсис v2 → сюжет сезона». */
export const SEASON_PLOT_V2_JOB_TYPE = "season_plot_v2";

/** Примерная длительность шага (до 100 серий) — для плавного бара на клиенте. */
export const SEASON_PLOT_V2_EXPECTED_SEC = 120;

export interface SeasonPlotV2JobParams {
  synopsis?: string | null;
  synopsisLanguage?: string | null;
  episodesCount?: number | null;
  plot?: string | null;
  refine?: string | null;
  refineEn?: string | null;
  plotBase?: string | null;
  plotTurns?: { refine: string; plot: string }[] | null;
  overrideMessages?: V2Msg[] | null;
  overrideSystem?: string | null;
  overrideUser?: string | null;
  overrideAssistant?: string | null;
}

async function runSeasonPlotV2JobImpl(jobId: string, projectId: string, params: SeasonPlotV2JobParams): Promise<void> {
  let hb: ReturnType<typeof setInterval> | null = null;
  try {
    const { synopsis, synopsisLanguage: langRaw, episodesCount: epRaw, plot: prevPlot, refine: refineRaw, refineEn, plotBase, plotTurns: turnsRaw, overrideMessages, overrideSystem, overrideUser, overrideAssistant } = params;
    const synopsisLanguage = normalizeSynopsisLanguage(langRaw);
    const episodesCount = normalizeEpisodesCount(epRaw);
    const { refine, plotTurns } = await translatePlotRefines({ refine: refineRaw, refineEn, plotTurns: turnsRaw });
    const parts = buildSeasonPlotV2Parts({ synopsis, synopsisLanguage, episodesCount, plot: prevPlot, refine, plotBase, plotTurns });
    let messages = resolveV2Messages(parts.messages, { overrideMessages, overrideSystem, overrideUser, overrideAssistant });
    if (overrideMessages?.length && messages.filter((m) => m.role !== "system").length > 1 && messages[messages.length - 1].role === "user") {
      const last = messages[messages.length - 1];
      messages = [...messages.slice(0, -1), { role: "user", content: await translateNonEnglishLines(last.content) }];
    }
    const assistantPrefill = trailingAssistantPrefill(messages);
    const log = splitForLog(messages);

    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { status: "processing", progress: 10, message: "Writing season plot..." });
    hb = setInterval(() => { heartbeatJob(jobId).catch(() => {}); }, 60_000);

    // Бюджет: до 100 серий × ~60 слов ≈ 8–10k токенов (+ язык с дорогой токенизацией) → 16k.
    let plot = "";
    let lastError = "";
    for (let attempt = 0; attempt < 2 && !plot; attempt++) {
      if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
      try {
        const onDelta = makeJobStreamWriter(jobId);
        const raw = await streamChatText(log.system, log.user, { model: FABLE_MODEL, temperature: 0.7, maxTokens: 16000, onDelta, messages });
        const full = (assistantPrefill ? `${assistantPrefill}${raw ?? ""}` : (raw ?? "")).replace(/\r\n?/g, "\n").trim();
        if (full.length < 60) throw new Error("season plot too short / empty");
        plot = full;
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        console.warn(`[season-plot-v2] attempt ${attempt + 1} failed:`, lastError);
      }
    }
    if (!plot) { await failJob(jobId, "AI returned an invalid result: " + lastError); return; }
    await flushStreamedText(jobId, plot);
    const episodes = parseSeasonPlotV2(plot);
    if (episodes && episodes.length !== episodesCount)
      console.warn(`[season-plot-v2] expected ${episodesCount} episodes, parsed ${episodes.length}`);

    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { progress: 90, message: "Saving season plot..." });
    await prisma.project.update({
      where: { id: projectId },
      // language — язык, выбранный на странице идеи (пришёл с клиента): сценарии/референсы/шот-листы
      // читают Project.language, поэтому фиксируем его здесь, чтобы сюжет и сценарий были на одном языке.
      data: { seasonPlotV2: plot, episodeCount: episodesCount, synopsisApproved: true, stage: SEASON_PLOT_V2_STAGE, language: SYNOPSIS_LANGUAGE_CODES[synopsisLanguage] },
    });
    await completeJob(jobId, { plot, episodeCount: episodesCount, parsedEpisodes: episodes?.length ?? 0 }, "Season plot ready");
  } catch (err: any) {
    console.error("[season-plot-v2] job error:", err);
    await failJob(jobId, "Generation failed: " + (err?.message ?? "Unknown error"));
  } finally {
    if (hb) clearInterval(hb);
  }
}

/** Обёртка prompt-log: kind "season_plot_v2" + projectId для авто-лога LLM-вызовов воркера. */
export function runSeasonPlotV2Job(jobId: string, projectId: string, params: SeasonPlotV2JobParams): Promise<void> {
  return runWithPromptContext({ kind: "season_plot_v2", projectId }, () => runSeasonPlotV2JobImpl(jobId, projectId, params));
}
