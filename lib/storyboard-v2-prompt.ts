/**
 * Поток v2 · авто-промпт листа-сториборда с кэшем в Project.episodeStoryboardV2["<n>"].{autoPrompt, autoPromptKey}.
 * Сборка дорогая (перевод «Фрейма» каждого шота + меток рефов на English), поэтому:
 *  - кнопка «Промпт» на клиенте → POST /api/ai/v2/storyboard/prompt → ensureStoryboardV2AutoPrompt():
 *    ключ совпал → сохранённый промпт сразу; иначе строим, сохраняем, отдаём;
 *  - воркер сборки листа использует тот же хелпер (повторно не переводит, если промпт уже построен);
 *  - GET /api/ai/v2/storyboard отдаёт ТОЛЬКО кэш (peekStoryboardV2AutoPrompt), без обращений к LLM.
 */
import {
  buildStoryboardV2Prompt, episodeRefsV2From, episodeShotsV2From, episodeStoryboardV2From, selectStoryboardV2Refs,
  shotFrameText, storyboardV2PromptKey, type EpisodeRefV2Ordered, type EpisodeShotV2,
} from "@/lib/idea-v2";
import { setEpisodeStoryboardV2 } from "@/lib/episode-storyboard-v2-store";
import { WAVESPEED_IMAGE_MAX_REFS } from "@/lib/providers/image-provider";
import { VISUAL_STYLE } from "@/lib/visual-style";
import { translateRefLabelsToEnglish, translateToEnglish } from "@/lib/translate-en";

type Row = { episodeShotsV2: unknown; episodeRefsV2: unknown; episodeStoryboardV2: unknown };

export type StoryboardV2PromptInputs = { shots: EpisodeShotV2[]; refs: EpisodeRefV2Ordered[]; key: string };

export function storyboardV2PromptInputs(row: Row, episode: number): StoryboardV2PromptInputs {
  const shots = episodeShotsV2From(row.episodeShotsV2, episode);
  const refs = selectStoryboardV2Refs(episodeRefsV2From(row.episodeRefsV2, episode), WAVESPEED_IMAGE_MAX_REFS);
  return { shots, refs, key: storyboardV2PromptKey(shots, refs, VISUAL_STYLE) };
}

/** Сохранённый авто-промпт, если он актуален для текущих шотов/рефов; иначе "" (без LLM). */
export function peekStoryboardV2AutoPrompt(row: Row, episode: number, inputs = storyboardV2PromptInputs(row, episode)): string {
  const sb = episodeStoryboardV2From(row.episodeStoryboardV2, episode);
  return sb?.autoPrompt && sb.autoPromptKey === inputs.key ? sb.autoPrompt : "";
}

/** Актуальный авто-промпт: из кэша или построить (перевод + сборка) и сохранить. Пустой шот-лист → "". */
export async function ensureStoryboardV2AutoPrompt(projectId: string, episode: number, row: Row, opts?: { force?: boolean }): Promise<{ autoPrompt: string; cached: boolean; inputs: StoryboardV2PromptInputs }> {
  const inputs = storyboardV2PromptInputs(row, episode);
  if (!inputs.shots.length) return { autoPrompt: "", cached: false, inputs };
  const cached = opts?.force ? "" : peekStoryboardV2AutoPrompt(row, episode, inputs);
  if (cached) return { autoPrompt: cached, cached: true, inputs };

  // Промпт — только English: «Фрейм» шотов (RU) переводится слово в слово; метки рефов — одним пакетом.
  const [shotsEn, refsEn] = await Promise.all([
    Promise.all(inputs.shots.map(async (sh) => { const fr = shotFrameText(sh) || sh.action; return { ...sh, frame: (await translateToEnglish(fr)) || fr }; })),
    translateRefLabelsToEnglish(inputs.refs),
  ]);
  const autoPrompt = buildStoryboardV2Prompt(shotsEn, refsEn, { visualStyle: VISUAL_STYLE });
  await setEpisodeStoryboardV2(projectId, episode, { autoPrompt, autoPromptKey: inputs.key });
  return { autoPrompt, cached: false, inputs };
}
