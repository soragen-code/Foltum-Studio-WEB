/**
 * Фоновый воркер потока v2 (вкладка «Шот-лист»): сценарий серии N → упорядоченный список кадров/клипов
 * (каждый кадр 4–6 сек, 1 кадр = 1 клип) с описанием действия на языке синопсиса. FABLE_MODEL.
 * Результат пишется атомарно в Project.episodeShotsV2["<n>"]; вручную отредактированные кадры сохраняются
 * (mergeEpisodeShotsV2). Стадию проекта не меняет. К v1-стадиям/воркерам не подключён.
 * systemOverride — отредактированный пользователем системный промпт (из модалки); пусто → авто-промпт.
 */
import { prisma } from "@/lib/db";
import { updateJob, completeJob, failJob, heartbeatJob, markCanceled, isCancelRequested } from "@/lib/jobs";
import { chat, safeJsonParse } from "@/lib/ai";
import { runWithPromptContext } from "@/lib/prompt-log";
import { FABLE_MODEL, episodeShotsV2SystemPrompt, parseEpisodeShotsV2, mergeEpisodeShotsV2, episodeShotsV2From, normalizeSynopsisLanguage, type EpisodeShotV2 } from "@/lib/idea-v2";
import { setEpisodeShotsV2 } from "@/lib/episode-shots-v2-store";

export const EPISODE_SHOTS_V2_JOB_TYPE = "episode_shots_v2";
export const EPISODE_SHOTS_V2_EXPECTED_SEC = 45;

export interface EpisodeShotsV2JobParams { episode: number; script: string; synopsisLanguage?: string | null; systemOverride?: string | null }

async function runImpl(jobId: string, projectId: string, { episode, script, synopsisLanguage, systemOverride }: EpisodeShotsV2JobParams): Promise<void> {
  let hb: ReturnType<typeof setInterval> | null = null;
  try {
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { status: "processing", progress: 10, message: "Breaking the script into shots..." });
    hb = setInterval(() => { heartbeatJob(jobId).catch(() => {}); }, 60_000);
    const system = systemOverride?.trim() || episodeShotsV2SystemPrompt(normalizeSynopsisLanguage(synopsisLanguage));
    let items: EpisodeShotV2[] = [];
    let lastError = "";
    for (let attempt = 0; attempt < 2 && !items.length; attempt++) {
      if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
      try {
        const raw = await chat(system, script, { model: FABLE_MODEL, temperature: 0.3, maxTokens: 16000 });
        items = parseEpisodeShotsV2(safeJsonParse(raw));
        if (!items.length) throw new Error("no shots in model output");
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        console.warn(`[episode-shots-v2] attempt ${attempt + 1} failed:`, lastError);
      }
    }
    if (!items.length) { await failJob(jobId, "AI returned an invalid result: " + lastError); return; }
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { progress: 90, message: "Saving the shot list..." });
    const prevRow = await prisma.project.findUnique({ where: { id: projectId }, select: { episodeShotsV2: true } });
    const merged = mergeEpisodeShotsV2(episodeShotsV2From(prevRow?.episodeShotsV2, episode), items);
    await setEpisodeShotsV2(projectId, episode, merged);
    await completeJob(jobId, { episode, count: merged.length }, "Shot list ready");
  } catch (err: any) {
    console.error("[episode-shots-v2] job error:", err);
    await failJob(jobId, "Shot split failed: " + (err?.message ?? "Unknown error"));
  } finally {
    if (hb) clearInterval(hb);
  }
}

export function runEpisodeShotsV2Job(jobId: string, projectId: string, params: EpisodeShotsV2JobParams): Promise<void> {
  return runWithPromptContext({ kind: "episode_shots_v2", projectId }, () => runImpl(jobId, projectId, params));
}
