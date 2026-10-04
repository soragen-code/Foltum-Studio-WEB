/**
 * Фоновый воркер потока v2 (вкладка «Сцены», кнопка «Собрать эпизод»): склеивает видео всех сцен серии
 * в порядке index в один финальный mp4 (H.264 + AAC, 1080×1920, 24 fps) через ffmpeg-static и грузит в S3.
 * Клипы перекодируются единообразно (scale/pad + fps + stereo 44.1k; клип без звука получает тишину),
 * звук каждого клипа подгоняется точно под длину его видео (apad+atrim) и получает короткие фейды на стыках,
 * затем concat-фильтр — надёжно для клипов с разными параметрами.
 * Музыка: клипы Seedance генерируются БЕЗ музыки (блок AUDIO в sceneVideoV2Prompt), а при склейке под всю серию
 * подкладывается ОДИН фоновый трек ACE-Step 1.5 (теги настроения — LLM по сценарию серии): тихо (MUSIC_VOLUME),
 * с приглушением под реплики/звук сцены (sidechaincompress) и фейдами в начале/конце. Если музыка не сгенерировалась —
 * серия собирается без неё (ошибка в лог, не в статус). Результат — Project.episodeFinalV2["<n>"] (+ musicUrl).
 */
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { prisma } from "@/lib/db";
import { uploadBufferToS3 } from "@/lib/s3-upload";
import { completeJob, failJob, heartbeatJob, updateJob } from "@/lib/jobs";
import { downloadToFile, mapWithConcurrency, probeMedia, runFfmpegWithProgress } from "@/lib/ffmpeg";
import {
  allSceneVideosReady, episodeScenesV2From, episodeScriptV2From,
  EPISODE_MUSIC_FALLBACK_TAGS_V2, episodeMusicTagsV2SystemPrompt, episodeMusicTagsV2UserPrompt, normalizeEpisodeMusicTagsV2,
} from "@/lib/idea-v2";
import { setEpisodeFinalV2 } from "@/lib/episode-scenes-v2-store";
import { chatJSON } from "@/lib/ai";
import { ACE_STEP_MAX_DURATION, generateAceStepMusic } from "@/lib/wavespeed";

export const EPISODE_ASSEMBLE_V2_JOB_TYPE = "episode_assemble_v2";
export const EPISODE_ASSEMBLE_V2_EXPECTED_SEC = 90;

const W = 1080;
const H = 1920;
const FPS = 24;
/** Длительность fade-in/fade-out звука на границах клипов (с). */
const AUDIO_FADE_SEC = 0.4;
/** Громкость фоновой музыки относительно звука клипов (до приглушения под реплики). */
const MUSIC_VOLUME = 0.25;
/** Фейды музыки в начале и в конце серии (с). */
const MUSIC_FADE_IN_SEC = 1.5;
const MUSIC_FADE_OUT_SEC = 2.5;

/** Теги настроения для ACE-Step по сценарию серии (LLM); при любой ошибке — нейтральный кинематографичный fallback. */
async function episodeMusicTags(projectId: string, episode: number): Promise<string> {
  try {
    const row = await prisma.project.findUnique({ where: { id: projectId }, select: { episodeScriptsV2: true, synopsis: true } });
    const script = episodeScriptV2From(row?.episodeScriptsV2, episode);
    if (!script.trim()) return EPISODE_MUSIC_FALLBACK_TAGS_V2;
    const res = await chatJSON<{ tags?: unknown }>(episodeMusicTagsV2SystemPrompt(), episodeMusicTagsV2UserPrompt(script, row?.synopsis), { maxTokens: 400, temperature: 0.4 });
    return normalizeEpisodeMusicTagsV2(res?.tags);
  } catch (err: any) {
    console.warn("[episode-assemble-v2] music tags LLM failed, using fallback:", String(err?.message ?? err).slice(0, 200));
    return EPISODE_MUSIC_FALLBACK_TAGS_V2;
  }
}

/**
 * Один фоновый трек на серию: генерирует ACE-Step (длина = длина серии, не больше ACE_STEP_MAX_DURATION — короче
 * трек зацикливается через -stream_loop), скачивает во временный файл и копирует в S3 (musicUrl для финала).
 * Возвращает null, если музыку получить не удалось — склейка идёт без неё.
 */
async function prepareEpisodeMusic(projectId: string, episode: number, totalSec: number, dir: string): Promise<{ file: string; url: string } | null> {
  try {
    const tags = await episodeMusicTags(projectId, episode);
    console.log(`[episode-assemble-v2] music tags: ${tags}`);
    const srcUrl = await generateAceStepMusic({ tags, durationSec: Math.min(ACE_STEP_MAX_DURATION, Math.ceil(totalSec) + 2) });
    const file = path.join(dir, "music.audio");
    await downloadToFile(srcUrl, file);
    const ext = (srcUrl.split("?")[0].match(/\.(mp3|wav|m4a|flac|ogg)$/i)?.[1] ?? "mp3").toLowerCase();
    const mime = ext === "wav" ? "audio/wav" : ext === "flac" ? "audio/flac" : ext === "ogg" ? "audio/ogg" : ext === "m4a" ? "audio/mp4" : "audio/mpeg";
    const url = await uploadBufferToS3(await fs.readFile(file), `media/public/episode-music-${projectId}-${episode}-${Date.now()}.${ext}`, mime).catch(() => srcUrl);
    return { file, url };
  } catch (err: any) {
    console.error("[episode-assemble-v2] music failed, assembling without music:", String(err?.message ?? err).slice(0, 300));
    return null;
  }
}

export interface EpisodeAssembleV2JobParams { episode: number }

export async function runEpisodeAssembleV2Job(jobId: string, projectId: string, { episode }: EpisodeAssembleV2JobParams): Promise<void> {
  const hb = setInterval(() => void heartbeatJob(jobId), 30_000);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `v2-assemble-${projectId}-${episode}-`));
  try {
    const row = await prisma.project.findUnique({ where: { id: projectId }, select: { episodeScenesV2: true } });
    const scenes = episodeScenesV2From(row?.episodeScenesV2, episode); // уже отсортированы по index
    if (!allSceneVideosReady(scenes)) throw new Error("Not all scene videos are ready");
    await setEpisodeFinalV2(projectId, episode, { status: "running", error: "" });
    await updateJob(jobId, { status: "processing", progress: 5, message: `Downloading ${scenes.length} clip(s)...` });

    const files = await mapWithConcurrency(scenes, 4, async (s, i) => {
      const f = path.join(dir, `clip-${String(i).padStart(3, "0")}.mp4`);
      await downloadToFile(s.videoUrl!, f);
      return f;
    });
    const infos = await Promise.all(files.map((f) => probeMedia(f)));
    const totalSec = infos.reduce((acc, inf) => acc + (inf.videoDuration || inf.duration || 0), 0);

    // Один фоновый трек на всю серию (ACE-Step 1.5). Ошибка музыки не валит склейку.
    await updateJob(jobId, { progress: 25, message: "Generating episode music..." });
    const music = totalSec > 0 ? await prepareEpisodeMusic(projectId, episode, totalSec, dir) : null;
    await updateJob(jobId, { progress: 30, message: "Stitching clips..." });

    // Входы: клипы, затем по одному anullsrc на клип без звука.
    const args: string[] = [];
    for (const f of files) args.push("-i", f);
    const silentIdx = new Map<number, number>();
    infos.forEach((inf, i) => {
      if (!inf.hasAudio) {
        silentIdx.set(i, files.length + silentIdx.size);
        args.push("-f", "lavfi", "-t", String(Math.max(0.1, inf.videoDuration || inf.duration || 5)), "-i", "anullsrc=r=44100:cl=stereo");
      }
    });
    const parts: string[] = [];
    const concatIn: string[] = [];
    infos.forEach((inf, i) => {
      const d = inf.videoDuration || inf.duration;
      const vTrim = d > 0 ? `trim=0:${d.toFixed(3)},setpts=PTS-STARTPTS,` : "";
      parts.push(`[${i}:v]${vTrim}scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[v${i}]`);
      const aSrc = silentIdx.has(i) ? `${silentIdx.get(i)}:a` : `${i}:a:0`;
      // Звук выравнивается ТОЧНО по длине видео клипа (apad + atrim): если дорожка короче/длиннее картинки,
      // concat без этого сдвигает весь дальнейший звук относительно видео («музыка не совпадает»).
      const aTrim = d > 0 ? `apad,atrim=0:${d.toFixed(3)},asetpts=PTS-STARTPTS,` : "";
      // Короткий fade-in/out на стыках: музыка/атмосфера каждого клипа генерируется отдельно, без фейдов
      // на монтажной склейке она обрывается щелчком. Клипы с тишиной фейды не меняют.
      const fadeD = Math.min(AUDIO_FADE_SEC, d > 0 ? d / 2 : AUDIO_FADE_SEC);
      const aFade = d > 0 && !silentIdx.has(i)
        ? `afade=t=in:st=0:d=${fadeD.toFixed(3)}:curve=qsin,afade=t=out:st=${Math.max(0, d - fadeD).toFixed(3)}:d=${fadeD.toFixed(3)}:curve=qsin,`
        : "";
      parts.push(`[${aSrc}]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,${aTrim}${aFade}asetpts=PTS-STARTPTS[a${i}]`);
      concatIn.push(`[v${i}][a${i}]`);
    });
    if (music) {
      // Музыка — последний вход (после anullsrc). Трек подгоняется под длину серии (-stream_loop на случай короткого трека +
      // apad/atrim), приглушается (MUSIC_VOLUME), фейды на входе/выходе и ducking под звук клипов (sidechaincompress:
      // сайдчейн — склеенная дорожка сцен), затем amix без нормализации, длина — по дорожке сцен.
      const musicIdx = files.length + silentIdx.size;
      args.push("-stream_loop", "-1", "-i", music.file);
      const T = totalSec.toFixed(3);
      const fadeIn = Math.min(MUSIC_FADE_IN_SEC, totalSec / 2);
      const fadeOut = Math.min(MUSIC_FADE_OUT_SEC, totalSec / 2);
      parts.push(`${concatIn.join("")}concat=n=${files.length}:v=1:a=1[vout][acat]`);
      parts.push(`[acat]asplit=2[acat1][acat2]`);
      parts.push(
        `[${musicIdx}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${T},asetpts=PTS-STARTPTS,` +
        `volume=${MUSIC_VOLUME},afade=t=in:st=0:d=${fadeIn.toFixed(3)}:curve=qsin,afade=t=out:st=${Math.max(0, totalSec - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}:curve=qsin[mus]`,
      );
      parts.push(`[mus][acat1]sidechaincompress=threshold=0.04:ratio=4:attack=120:release=600:makeup=1[musd]`);
      parts.push(`[acat2][musd]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`);
    } else {
      parts.push(`${concatIn.join("")}concat=n=${files.length}:v=1:a=1[vout][aout]`);
    }
    const out = path.join(dir, "episode.mp4");
    args.push(
      "-filter_complex", parts.join(";"), "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out,
    );
    let lastPct = -1;
    await runFfmpegWithProgress(args, "v2 episode assemble", totalSec, (pct) => {
      const p = 30 + Math.round(pct * 0.6);
      if (p !== lastPct) { lastPct = p; void updateJob(jobId, { progress: p, message: `Stitching ${pct}%...` }); }
    });

    await updateJob(jobId, { progress: 92, message: "Uploading final video..." });
    const url = await uploadBufferToS3(await fs.readFile(out), `media/public/episode-${projectId}-${episode}-${Date.now()}.mp4`, "video/mp4");
    await setEpisodeFinalV2(projectId, episode, { videoUrl: url, musicUrl: music?.url ?? "", status: "done", error: "" });
    await completeJob(jobId, { episode, videoUrl: url, musicUrl: music?.url ?? null, clips: files.length }, music ? "Episode assembled with music" : "Episode assembled (no music)");
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 500);
    console.error("[episode-assemble-v2] failed:", msg);
    await setEpisodeFinalV2(projectId, episode, { status: "error", error: msg }).catch(() => {});
    await failJob(jobId, msg);
  } finally {
    clearInterval(hb);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
