/**
 * Test mode worker: writes the one-minute mini-trailer script and stores it as Season number 0
 * («Мини-трейлер (тест)») with a single episode, so the existing episode page (scene generation,
 * cost plan, assembly) works unchanged. Re-running replaces the previous trailer script
 * (scene videos of the old trailer are dropped with the scenes; nothing else is touched).
 */
import { prisma } from "@/lib/db";
import { chatJSON } from "@/lib/ai";
import { updateJob, completeJob, failJob, isCancelRequested, markCanceled } from "@/lib/jobs";
import { toCharacterCard, normalizeLanguage } from "@/lib/idea";
import { normalizeEpisodeScript, validateEpisodeScript, isSoftProblem, ensureEnglishDialogue, matchLocation, type EpisodeOutline } from "@/lib/season";
import { trailerScriptSchema, trailerSystemPrompt, trailerUserPrompt, TRAILER_SEASON_NUMBER, TRAILER_MIN_SCENES, TRAILER_MAX_SCENES } from "@/lib/trailer";
import { persistEpisodeScript } from "@/lib/workers/season-script-job";

export const TRAILER_TITLE = "Мини-трейлер (тест)";

/** Typical wall time of the trailer LLM call (gpt-4o, ~18–25 s); used only to pace the progress bar. */
const TRAILER_LLM_EXPECTED_MS = 22_000;
/** Hard cap for the single trailer script call: 3 scenes never legitimately need longer; on a stall we fail fast with a clear message. */
const TRAILER_LLM_TIMEOUT_MS = 90_000;

/**
 * Awaits `work` while advancing the job progress from `from` toward `to` on a time basis
 * (every 3 s), so the UI shows movement during a single long LLM call instead of freezing at one value.
 */
async function withLiveProgress<T>(jobId: string, work: Promise<T>, from: number, to: number, expectedMs: number, message: string): Promise<T> {
  const started = Date.now();
  let pending: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    const frac = Math.min(1, (Date.now() - started) / expectedMs);
    const progress = Math.round(from + (to - from) * (1 - Math.pow(1 - frac, 2))); // ease-out: fast start, slows near `to`
    pending = updateJob(jobId, { progress, message });
  }, 3000);
  try {
    return await work;
  } finally {
    clearInterval(timer);
    await pending; // never let a late progress write overtake the next stage
  }
}

export async function runTrailerJob(jobId: string, projectId: string): Promise<void> {
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId }, include: { characters: true, locations: { orderBy: { createdAt: "asc" } } } });
    if (!project?.synopsis) throw new Error("Project synopsis missing");
    const language = normalizeLanguage(project.language, project.synopsis);
    const cards = project.characters.map(toCharacterCard);
    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { status: "processing", progress: 10, message: "Пишу сценарий мини-трейлера..." });

    // ONE LLM call writes all 3 scenes with BOTH the English `dialogue` (voiced by the video model)
    // and the project-language `dialogueLocal` (shown to the author). A bounded timeout + single
    // retry turns a stalled generation into a fast, clear failure instead of a ~10-min hang.
    let raw: unknown;
    try {
      raw = await withLiveProgress(
        jobId,
        chatJSON(trailerSystemPrompt(language), trailerUserPrompt(project.synopsis, cards, project.locations), { temperature: 0.7, maxTokens: 4000, timeoutMs: TRAILER_LLM_TIMEOUT_MS, maxRetries: 1 }),
        10, 80, TRAILER_LLM_EXPECTED_MS, "Пишу сценарий мини-трейлера (3 сцены, диалоги на EN + перевод)...",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timeout|timed out|abort|ETIMEDOUT|ECONNRESET/i.test(msg)) throw new Error("Модель отвечала слишком долго. Попробуйте запустить мини-трейлер ещё раз.");
      throw err;
    }
    let script = trailerScriptSchema.parse(raw);
    await updateJob(jobId, { progress: 84, message: "Проверяю сценарий и английскую озвучку..." });
    // Local-only fixes + a single BATCHED translation call ONLY if some scene's dialogue is not English
    // (the main prompt already returns English, so this normally adds zero LLM calls).
    const normalized = await ensureEnglishDialogue(normalizeEpisodeScript({ visualIdentity: script.visualIdentity, scenes: script.scenes }, cards), chatJSON);
    script = { ...script, scenes: normalized.scenes.slice(0, TRAILER_MAX_SCENES) };
    if (script.scenes.length < TRAILER_MIN_SCENES) throw new Error("trailer script too short");
    const hard = validateEpisodeScript({ visualIdentity: script.visualIdentity, scenes: script.scenes }).filter((p) => !isSoftProblem(p) && !/scene count/.test(p));
    if (hard.length) throw new Error(`trailer script invalid: ${hard.slice(0, 3).join("; ")}`);

    if (await isCancelRequested(jobId)) { await markCanceled(jobId); return; }
    await updateJob(jobId, { progress: 90, message: "Сохраняю трейлер..." });
    const firstLoc = matchLocation(project.locations, script.locationNames[0] ?? "") ?? project.locations[0] ?? null;
    const names = Array.from(new Set(script.scenes.flatMap((s) => s.characters)));
    const outline: EpisodeOutline = {
      number: 1,
      title: script.title,
      logline: script.logline,
      locationName: firstLoc?.name ?? script.locationNames[0] ?? "",
      locationDesc: firstLoc?.visualPrompt ?? firstLoc?.description ?? script.scenes[0].locationDesc.padEnd(20, " "),
      characters: names.length ? names : cards.map((c) => c.name),
      arcRole: "завязка",
      cliffhanger: script.scenes[script.scenes.length - 1].action,
    };
    const episodeId = await prisma.$transaction(async (tx) => {
      let season = await tx.season.findFirst({ where: { projectId, number: TRAILER_SEASON_NUMBER } });
      season = season
        ? await tx.season.update({ where: { id: season.id }, data: { title: TRAILER_TITLE, logline: script.logline, status: "script_ready" } })
        : await tx.season.create({ data: { projectId, number: TRAILER_SEASON_NUMBER, title: TRAILER_TITLE, logline: script.logline, status: "script_ready" } });
      const existing = await tx.episode.findFirst({ where: { seasonId: season.id }, orderBy: { number: "asc" } });
      const ep = existing
        ? await tx.episode.update({ where: { id: existing.id }, data: { title: script.title, locationId: firstLoc?.id ?? null, videoUrl: null, status: "draft" } })
        : await tx.episode.create({ data: { seasonId: season.id, number: 1, title: script.title, description: script.logline, locationId: firstLoc?.id ?? null, status: "draft" } });
      return ep.id;
    }, { timeout: 30_000 });
    await persistEpisodeScript(episodeId, outline, { visualIdentity: script.visualIdentity, scenes: script.scenes }, project.characters.map((c) => ({ id: c.id, name: c.name })), language);
    await completeJob(jobId, { episodeId, scenes: script.scenes.length, totalSeconds: script.scenes.reduce((a, s) => a + s.durationSec, 0) }, "Мини-трейлер готов");
  } catch (err) {
    await failJob(jobId, err instanceof Error ? err.message : String(err));
  }
}
