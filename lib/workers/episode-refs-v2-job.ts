/**
 * Фоновый воркер потока v2 (вкладка «Референсы»): сценарий серии N → структурированный список рефов
 * (персонажи / локации INT.-EXT. / реквизит) с EN-промптами для image-модели. FABLE_MODEL.
 * Результат пишется атомарно в Project.episodeRefsV2["<n>"]; вручную отредактированные промпты сохраняются
 * (mergeEpisodeRefsV2). Стадию проекта не меняет. К v1-стадиям/воркерам не подключён.
 */
import { prisma } from "@/lib/db";
import { updateJob, completeJob, failJob, heartbeatJob, markCanceled, isCancelRequested } from "@/lib/jobs";
import { chat, safeJsonParse } from "@/lib/ai";
import { runWithPromptContext } from "@/lib/prompt-log";
import { FABLE_MODEL, episodeRefsV2SystemPrompt, parseEpisodeRefsV2, mergeEpisodeRefsV2, inheritEpisodeRefsV2, episodeRefsV2From, seriesContinuityBlockV2, normalizeSynopsisLanguage, type EpisodeRefV2 } from "@/lib/idea-v2";
import { setEpisodeRefsV2 } from "@/lib/episode-refs-v2-store";

export const EPISODE_REFS_V2_JOB_TYPE = "episode_refs_v2";
export const EPISODE_REFS_V2_EXPECTED_SEC = 45;

export interface EpisodeRefsV2JobParams { episode: number; script: string; synopsisLanguage?: string | null }

async function runImpl(jobId: string, projectId: string, { episode, script, synopsisLanguage }: EpisodeRefsV2JobParams): Promise<void> {
  let hb: ReturnType<typeof setInterval> | null = null;
  try {
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { status: "processing", progress: 10, message: "Extracting references from the script..." });
    hb = setInterval(() => { heartbeatJob(jobId).catch(() => {}); }, 60_000);
    // Имена/ключи из ранних серий — тот же персонаж («Grace» = «Grace Harper») получает тот же key/label.
    const ctxRow = await prisma.project.findUnique({ where: { id: projectId }, select: { episodeRefsV2: true, episodeScriptsV2: true } });
    const system = episodeRefsV2SystemPrompt(normalizeSynopsisLanguage(synopsisLanguage), seriesContinuityBlockV2(ctxRow?.episodeRefsV2, ctxRow?.episodeScriptsV2, episode));
    let items: EpisodeRefV2[] = [];
    let lastError = "";
    for (let attempt = 0; attempt < 2 && !items.length; attempt++) {
      if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
      try {
        const raw = await chat(system, script, { model: FABLE_MODEL, temperature: 0.3, maxTokens: 8000 });
        items = parseEpisodeRefsV2(safeJsonParse(raw));
        if (!items.length) throw new Error("no references in model output");
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        console.warn(`[episode-refs-v2] attempt ${attempt + 1} failed:`, lastError);
      }
    }
    if (!items.length) { await failJob(jobId, "AI returned an invalid result: " + lastError); return; }
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { progress: 90, message: "Saving references..." });
    const prevRow = await prisma.project.findUnique({ where: { id: projectId }, select: { episodeRefsV2: true } });
    // Персонажи/локации/реквизит, уже имеющиеся в ранних сериях, не генерируются заново — берём тот же реф (картинка + промпт).
    const merged = inheritEpisodeRefsV2(prevRow?.episodeRefsV2, episode, mergeEpisodeRefsV2(episodeRefsV2From(prevRow?.episodeRefsV2, episode), items)).items;
    await setEpisodeRefsV2(projectId, episode, merged);
    await completeJob(jobId, { episode, count: merged.length }, "References ready");
  } catch (err: any) {
    console.error("[episode-refs-v2] job error:", err);
    await failJob(jobId, "Extraction failed: " + (err?.message ?? "Unknown error"));
  } finally {
    if (hb) clearInterval(hb);
  }
}

export function runEpisodeRefsV2Job(jobId: string, projectId: string, params: EpisodeRefsV2JobParams): Promise<void> {
  return runWithPromptContext({ kind: "episode_refs_v2", projectId }, () => runImpl(jobId, projectId, params));
}
