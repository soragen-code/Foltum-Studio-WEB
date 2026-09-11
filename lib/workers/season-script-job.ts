/**
 * Stage 2 — season script background job (resumable).
 *
 * Step 1: season structure (6–10 episodes) → Season + Episode rows (script = null).
 * Step 2: for every episode without a script, generate the full shooting script
 *         (10–15 scenes) with previous-episodes context → Episode.script + Scene rows
 *         + SceneCharacter / EpisodeCharacter links. Progress is persisted per episode,
 *         so a re-run only fills in what is missing (never regenerates finished episodes).
 * The worker stops before Vercel's maxDuration and reports `remaining`; the client
 * POSTs /api/ai/season again to continue.
 */
import { prisma } from "@/lib/db";
import { chatJSON, SCRIPT_MODEL } from "@/lib/ai";
import { heartbeatJob, updateJob, completeJob, failJob, isCancelRequested, markCanceled } from "@/lib/jobs";
import { toCharacterCard, normalizeLanguage, type CharacterCard, type IdeaLanguage } from "@/lib/idea";
import {
  seasonStructureSchema,
  seasonFullStorySchema,
  seasonFullStorySystemPrompt,
  seasonFullStoryUserPrompt,
  episodeScriptSchema,
  seasonStructureSystemPrompt,
  seasonStructureUserPrompt,
  episodeScriptSystemPrompt,
  episodeScriptUserPrompt,
  validateEpisodeScript,
  hardProblems,
  ensureEnglishDialogue,
  normalizeEpisodeScript,
  renderEpisodeScriptText,
  SEASON_DEFAULT_EPISODES,
  type EpisodeOutline,
  type EpisodeScript,
  type SeasonStructure,
  matchCharacter,
  matchLocation,
} from "@/lib/season";
import { anchorSceneLocation } from "@/lib/location-anchor";
import { episodeCastFromScenes } from "@/lib/episode-cast";

export const SEASON_JOB_TYPE = "season_script";
/**
 * Stop starting new episodes after this many ms (Vercel maxDuration is 800s).
 * gpt-6-astra can spend several minutes on one episode script, so a new episode is only started
 * while there is still time for a long completion; the client re-POSTs to continue (resumable job).
 */
const TIME_BUDGET_MS = 240_000;

/** Run an LLM call while keeping the job alive (heartbeat every 45s). */
async function withHeartbeat<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
  const t = setInterval(() => void heartbeatJob(jobId), 45_000);
  try {
    return await fn();
  } finally {
    clearInterval(t);
  }
}

async function generateWithRetry<T>(jobId: string, attempts: number, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await withHeartbeat(jobId, fn);
    } catch (err) {
      last = err;
      console.warn(`[season] attempt ${i + 1}/${attempts} failed:`, err);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export async function generateEpisodeScript(input: {
  jobId: string;
  language: IdeaLanguage;
  synopsis: string;
  season: SeasonStructure;
  episode: EpisodeOutline;
  characters: CharacterCard[];
  previous: { number: number; title: string; logline: string; cliffhanger: string }[];
  instruction?: string;
}): Promise<EpisodeScript> {
  return generateWithRetry(input.jobId, 2, async () => {
    // gpt-6-astra: reasoning tokens share the completion budget → large budget + long timeout; temperature is not sent.
    const raw = await chatJSON(episodeScriptSystemPrompt(input.language, input.episode.number), episodeScriptUserPrompt(input), {
      model: SCRIPT_MODEL,
      maxTokens: 32000,
      timeoutMs: 600_000,
    });
    const script = normalizeEpisodeScript(episodeScriptSchema.parse(raw), input.characters);
    const problems = validateEpisodeScript(script);
    // Word-count drift is tolerated (logged); hard problems (count, missing prompt lines, no dialogue) fail → retry.
    const hard = hardProblems(problems); // density / sentence / camera-wording drift is soft (logged), see lib/season.ts
    if (hard.length) throw new Error(`episode ${input.episode.number} script invalid: ${hard.slice(0, 3).join("; ")}`);
    if (problems.length) console.warn(`[season] ep ${input.episode.number} soft issues:`, problems);
    // Seedance voices `dialogue` → it must be English; swap swapped fields / translate leftovers.
    return ensureEnglishDialogue(script, chatJSON);
  });
}

/** Generate the whole-season prose story (the "Сюжет" screen) from the fixed structure. */
export async function generateFullStory(input: {
  jobId: string;
  language: IdeaLanguage;
  synopsis: string;
  structure: SeasonStructure;
  characters: CharacterCard[];
  locations: { name: string; description?: string | null; visualPrompt?: string | null }[];
}): Promise<string> {
  return generateWithRetry(input.jobId, 2, async () => {
    const raw = await chatJSON(
      seasonFullStorySystemPrompt(input.language, input.structure.episodes.length),
      seasonFullStoryUserPrompt({ synopsis: input.synopsis, structure: input.structure, characters: input.characters, locations: input.locations }),
      { model: SCRIPT_MODEL, maxTokens: 32000, timeoutMs: 600_000 }
    );
    const parsed = seasonFullStorySchema.parse(raw);
    const text = parsed.fullStory.trim();
    if (text.length < 200) throw new Error("full story too short");
    return text;
  });
}

/** Replace an episode's Scene rows with the given script (keeps the episode row / id). */
export async function persistEpisodeScript(
  episodeId: string,
  outline: EpisodeOutline,
  script: EpisodeScript,
  characters: { id: string; name: string }[],
  language: string
) {
  const idOf = (n: string) => matchCharacter(characters, n)?.id;
  const text = renderEpisodeScriptText(outline, script);
  // Stage 20 (D1): the accurate episode cast is the UNION of characters that actually appear in the
  // generated scenes — collected here per scene, deduped below (not the declared outline.characters).
  const sceneCastIds: string[][] = [];
  await prisma.$transaction(async (tx) => {
    await tx.scene.deleteMany({ where: { episodeId } });
    for (const s of script.scenes) {
      const scene = await tx.scene.create({
        data: {
          episodeId,
          number: s.number,
          // `dialogue` = story-language text (UI + burned-in subtitles); `dialogueEn` = the English lines the model voices.
          dialogue: s.dialogueLocal ?? s.dialogue,
          dialogueEn: s.dialogue,
          // Stage 20 (A2): lock every non-location-change scene to the episode's single canonical location
          // (Episode.locationDesc) so the place never drifts scene-to-scene and frame-chaining stays reliable.
          locationDesc: anchorSceneLocation(s.locationDesc, outline.locationDesc, s.continuesFrom),
          videoPrompt: s.videoPrompt,
          shotType: s.shotType,
          action: s.action,
          durationSec: s.durationSec,
          // Stage 11 — scene-to-scene continuity metadata (who is present, entrances/exits, link to prev scene).
          presence: s.presence ?? null,
          entrances: s.entrances ?? null,
          continuesFrom: s.continuesFrom ?? null,
          // Stage 40 — scripted end state of the final frame (next scene's OPENING STATE in parallel mode).
          endState: (s.endState ?? "").trim() || null,
          // Stage 41 — scripted start state of the first frame (this scene's OPENING STATE).
          startState: (s.startState ?? "").trim() || null,
          endStateActual: null,
          // Stage 12 (Commit D) — off-screen narration: `voiceover` = English narration voiced by the model,
          // `voiceoverLocal` = the same narration translated for the UI. `sceneKind` distinguishes narration from dialogue.
          sceneKind: s.sceneKind ?? "dialogue",
          voiceover: s.voiceover ?? null,
          voiceoverLocal: s.voiceoverLocal ?? s.voiceover ?? null,
          language: "en", // speech is always English (Stage 4)
          subtitled: false,
          status: "pending",
        },
      });
      const ids = Array.from(new Set(s.characters.map(idOf).filter((x): x is string => !!x)));
      sceneCastIds.push(ids);
      if (ids.length) await tx.sceneCharacter.createMany({ data: ids.map((characterId) => ({ sceneId: scene.id, characterId })), skipDuplicates: true });
    }
    // Stage 20 (D1/D2): EpisodeCharacter = the UNION of characters actually used across the scenes
    // (so the References tab + readiness gate only require characters that really appear). If somehow
    // no scene names any character, fall back to the declared outline cast so the episode is never empty.
    const declaredIds = Array.from(new Set(outline.characters.map(idOf).filter((x): x is string => !!x)));
    const epIds = episodeCastFromScenes(sceneCastIds, declaredIds);
    await tx.episodeCharacter.deleteMany({ where: { episodeId } });
    if (epIds.length) await tx.episodeCharacter.createMany({ data: epIds.map((characterId) => ({ episodeId, characterId })), skipDuplicates: true });
    await tx.episode.update({
      where: { id: episodeId },
      data: { script: text, description: outline.logline, logline: outline.logline, cliffhanger: outline.cliffhanger, locationName: outline.locationName, locationDesc: outline.locationDesc, arcRole: outline.arcRole, status: "script_ready", title: outline.title },
    });
  }, { timeout: 60_000, maxWait: 15_000 }); // 15 scenes × (create + characters) over Neon exceed Prisma's default 5 s interactive-transaction timeout (seen on prod: "Transaction not found")
}

export function outlineFromEpisode(e: { number: number; title: string; logline: string | null; description: string | null; locationName: string | null; locationDesc: string | null; cliffhanger: string | null; arcRole: string | null; characters: { character: { name: string } }[] }): EpisodeOutline {
  const role = (["завязка", "развитие", "поворот", "финал"] as const).find((r) => r === e.arcRole) ?? "развитие";
  return {
    number: e.number,
    title: e.title,
    logline: e.logline ?? e.description ?? "",
    locationName: e.locationName ?? "",
    locationDesc: e.locationDesc ?? "",
    characters: e.characters.map((c) => c.character.name),
    arcRole: role,
    cliffhanger: e.cliffhanger ?? "",
  };
}

export async function runSeasonScriptJob(jobId: string, projectId: string, episodeCount = SEASON_DEFAULT_EPISODES): Promise<void> {
  const started = Date.now();
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId }, include: { characters: true, locations: { orderBy: { createdAt: "asc" } } } });
    if (!project?.synopsis) throw new Error("Project synopsis missing");
    const language = normalizeLanguage(project.language, project.synopsis);
    const cards = project.characters.map(toCharacterCard);

    // Cancellation checkpoint before any heavy LLM work.
    if (await isCancelRequested(jobId)) { await markCanceled(jobId, "Генерация сценария отменена"); return; }

    // Step 1 — structure (skipped when the season already exists).
    let season = await prisma.season.findFirst({ where: { projectId, number: 1 }, include: { episodes: { orderBy: { number: "asc" }, include: { characters: { include: { character: true } } } } } });
    if (!season || season.episodes.length === 0) {
      await updateJob(jobId, { status: "processing", progress: 3, message: "Строю структуру сезона…" });
      const structure = await generateWithRetry(jobId, 2, async () => {
        const raw = await chatJSON(seasonStructureSystemPrompt(language, episodeCount), seasonStructureUserPrompt(project.synopsis!, cards, project.locations), { model: SCRIPT_MODEL, maxTokens: 12000, timeoutMs: 600_000 });
        const parsed = seasonStructureSchema.parse(raw);
        // Stage 14 (B2): the producer sets the episode count — enforce it exactly (retry if the model drifts).
        if (parsed.episodes.length !== episodeCount)
          throw new Error(`structure returned ${parsed.episodes.length} episodes, expected exactly ${episodeCount}`);
        return { ...parsed, episodes: parsed.episodes.map((e, i) => ({ ...e, number: i + 1 })) };
      });
      const byName = new Map(project.characters.map((c) => [c.name.toLowerCase(), c.id]));
      season = await prisma.$transaction(async (tx) => {
        const s = season
          ? await tx.season.update({ where: { id: season.id }, data: { title: structure.title, logline: structure.logline } })
          : await tx.season.create({ data: { projectId, number: 1, title: structure.title, logline: structure.logline } });
        const locs: { id: string; name: string }[] = project.locations.map((l) => ({ id: l.id, name: l.name }));
        for (const e of structure.episodes) {
          // Bind the episode to an existing project Location (reference image); unknown names become new Locations without an image.
          let loc = matchLocation(locs, e.locationName);
          if (!loc) {
            const created = await tx.location.create({ data: { projectId, name: e.locationName, description: e.locationName, visualPrompt: e.locationDesc } });
            loc = { id: created.id, name: created.name };
            locs.push(loc);
          }
          const ep = await tx.episode.create({ data: { seasonId: s.id, number: e.number, title: e.title, description: e.logline, logline: e.logline, cliffhanger: e.cliffhanger, locationName: loc.name, locationDesc: e.locationDesc, locationId: loc.id, arcRole: e.arcRole, status: "draft" } });
          const ids = Array.from(new Set(e.characters.map((n) => byName.get(n.toLowerCase())).filter((x): x is string => !!x)));
          if (ids.length) await tx.episodeCharacter.createMany({ data: ids.map((characterId) => ({ episodeId: ep.id, characterId })) });
        }
        return tx.season.findUniqueOrThrow({ where: { id: s.id }, include: { episodes: { orderBy: { number: "asc" }, include: { characters: { include: { character: true } } } } } });
      }, { timeout: 30_000 });
      await prisma.project.update({ where: { id: projectId }, data: { stage: "structure" } });
    }

    const seasonStruct: SeasonStructure = { title: season.title ?? "", logline: season.logline ?? "", episodes: season.episodes.map(outlineFromEpisode) };
    const total = season.episodes.length;
    const chars = project.characters.map((c) => ({ id: c.id, name: c.name }));

    // Step 1b — whole-season prose story ("Сюжет" screen). Generated once; resumable (only if missing).
    if (!season.fullStory) {
      if (await isCancelRequested(jobId)) { await markCanceled(jobId, "Генерация отменена"); return; }
      await updateJob(jobId, { status: "processing", progress: 4, message: "Пишу сюжет сезона..." });
      try {
        const fullStory = await generateFullStory({ jobId, language, synopsis: project.synopsis, structure: seasonStruct, characters: cards, locations: project.locations });
        await prisma.season.update({ where: { id: season.id }, data: { fullStory } });
        season.fullStory = fullStory;
      } catch (err) {
        // Never block episode scripts on the prose story — the author can regenerate it from the story screen.
        console.warn("[season] full story generation failed:", err);
      }
    }

    // Step 2 — episode scripts, one at a time, only for episodes still missing a script.
    for (const ep of season.episodes) {
      if (ep.script) continue;
      // Cancellation checkpoint: stop BEFORE starting the next episode. Episodes already
      // written are kept (their scripts stay in the DB); the author can resume later.
      if (await isCancelRequested(jobId)) {
        const remaining = season.episodes.filter((e) => !e.script).length;
        await markCanceled(jobId, `Генерация отменена. Готово эпизодов: ${total - remaining} из ${total}.`);
        return;
      }
      if (Date.now() - started > TIME_BUDGET_MS) {
        const remaining = season.episodes.filter((e) => !e.script).length;
        await completeJob(jobId, { done: false, remaining, total }, `Пауза: осталось эпизодов — ${remaining}. Продолжаю…`);
        return;
      }
      const done = season.episodes.filter((e) => e.script).length;
      await updateJob(jobId, { status: "processing", progress: 5 + Math.round((done / total) * 90), message: `Пишу сценарий эпизода ${ep.number} из ${total}…` });
      const outline = outlineFromEpisode(ep);
      const script = await generateEpisodeScript({
        jobId,
        language,
        synopsis: project.synopsis,
        season: seasonStruct,
        episode: outline,
        characters: cards,
        previous: season.episodes.filter((p) => p.number < ep.number).map((p) => ({ number: p.number, title: p.title, logline: p.logline ?? "", cliffhanger: p.cliffhanger ?? "" })),
      });
      await persistEpisodeScript(ep.id, outline, script, chars, language);
      ep.script = "done";
    }
    await prisma.season.update({ where: { id: season.id }, data: { status: "script_ready" } });
    await completeJob(jobId, { done: true, remaining: 0, total }, "Сценарий сезона готов");
  } catch (err) {
    await failJob(jobId, err instanceof Error ? err.message : String(err));
  }
}
