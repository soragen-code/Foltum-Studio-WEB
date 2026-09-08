/**
 * Test mode worker: writes the one-minute mini-trailer script and stores it as Season number 0
 * («Мини-трейлер (тест)») with a single episode, so the existing episode page (scene generation,
 * cost plan, assembly) works unchanged. Re-running replaces the previous trailer script
 * (scene videos of the old trailer are dropped with the scenes; nothing else is touched).
 */
import { prisma } from "@/lib/db";
import { chatJSON } from "@/lib/ai";
import { updateJob, completeJob, failJob } from "@/lib/jobs";
import { toCharacterCard, normalizeLanguage } from "@/lib/idea";
import { normalizeEpisodeScript, validateEpisodeScript, matchLocation, type EpisodeOutline } from "@/lib/season";
import { trailerScriptSchema, trailerSystemPrompt, trailerUserPrompt, TRAILER_SEASON_NUMBER, TRAILER_MIN_SCENES, TRAILER_MAX_SCENES } from "@/lib/trailer";
import { persistEpisodeScript } from "@/lib/workers/season-script-job";

export const TRAILER_TITLE = "Мини-трейлер (тест)";

export async function runTrailerJob(jobId: string, projectId: string): Promise<void> {
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId }, include: { characters: true, locations: { orderBy: { createdAt: "asc" } } } });
    if (!project?.synopsis) throw new Error("Project synopsis missing");
    const language = normalizeLanguage(project.language, project.synopsis);
    const cards = project.characters.map(toCharacterCard);
    await updateJob(jobId, { status: "processing", progress: 10, message: "Пишу сценарий мини-трейлера..." });

    let script = trailerScriptSchema.parse(await chatJSON(trailerSystemPrompt(language), trailerUserPrompt(project.synopsis, cards, project.locations), { temperature: 0.7, maxTokens: 8000 }));
    const normalized = normalizeEpisodeScript({ visualIdentity: script.visualIdentity, scenes: script.scenes }, cards);
    script = { ...script, scenes: normalized.scenes.slice(0, TRAILER_MAX_SCENES) };
    if (script.scenes.length < TRAILER_MIN_SCENES) throw new Error("trailer script too short");
    const hard = validateEpisodeScript({ visualIdentity: script.visualIdentity, scenes: script.scenes }).filter((p) => !/dialogue sentences|too many silent|scene count/.test(p));
    if (hard.length) throw new Error(`trailer script invalid: ${hard.slice(0, 3).join("; ")}`);

    await updateJob(jobId, { progress: 70, message: "Сохраняю трейлер..." });
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
