/**
 * Фоновый воркер потока v2 (вкладка «Сцены», кнопка «Собрать эпизод»): склеивает видео всех сцен серии
 * в порядке index в один финальный mp4 (H.264 + AAC, 1080×1920, 24 fps) через ffmpeg-static и грузит в S3.
 * Клипы перекодируются единообразно (scale/pad + fps + stereo 44.1k; клип без звука получает тишину),
 * звук каждого клипа подгоняется точно под длину его видео (apad+atrim) и получает короткие фейды на стыках.
 * Двухэтапно (низкая пиковая память, короткие процессы): каждый клип нормализуется отдельным ffmpeg, затем
 * склейка concat demuxer'ом с -c copy; музыка — финальным проходом только по аудио (видео копируется).
 * Музыка: клипы Seedance генерируются БЕЗ музыки (блок AUDIO в sceneVideoV2Prompt), а при склейке под всю серию
 * подкладывается ОДИН фоновый трек ACE-Step 1.5 (теги настроения — LLM по сценарию серии): тихо (MUSIC_VOLUME),
 * с приглушением под реплики/звук сцены (sidechaincompress) и фейдами в начале/конце. Если музыка не сгенерировалась —
 * серия собирается без неё (ошибка в лог и в episodeFinalV2.musicError, не в статус).
 * Обрезка тишины: у ДИАЛОГОВЫХ клипов (sceneHasDialogueV2) по карте тишины (ffmpeg silencedetect) срезается мёртвый хвост
 * после последней реплики, а если и предыдущий клип диалоговый — ещё и тихий вход, чтобы ответ начинался сразу после
 * стыка (computeClipTrim: запас 0.15/0.2 с, не короче 2 с). Шоты без реплик не трогаются. Оригиналы клипов в S3 не меняются.
 * Результат — Project.episodeFinalV2["<n>"] (+ musicUrl / musicError).
 */
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { prisma } from "@/lib/db";
import { uploadBufferToS3 } from "@/lib/s3-upload";
import { completeJob, failJob, heartbeatJob, updateJob } from "@/lib/jobs";
import { computeClipTrim, detectSilence, downloadToFile, mapWithConcurrency, probeMedia, runFfmpegPlain, runFfmpegWithProgress, type ClipTrim } from "@/lib/ffmpeg";
import {
  allSceneVideosReady, episodeScenesV2From, episodeScriptV2From, sceneHasDialogueV2,
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
const MUSIC_VOLUME = 0.32;
/**
 * Ducking музыки под звук сцен. Прежние threshold=0.04/ratio=4 при непрерывном звуке клипов (эмбиент, речь) давили
 * трек почти постоянно — музыки в финале было не слышно. Мягче порог и степень: музыка слышна, под реплики приглушается.
 */
const MUSIC_DUCK = "threshold=0.1:ratio=2.5:attack=150:release=800:makeup=1";
/** Детекция тишины для обрезки диалоговых клипов. */
const SILENCE_NOISE_DB = -35;
const SILENCE_MIN_SEC = 0.3;
/** Фейды музыки в начале и в конце серии (с). */
const MUSIC_FADE_IN_SEC = 1.5;
const MUSIC_FADE_OUT_SEC = 2.5;
/** Сколько клипов нормализуется параллельно (каждый — отдельный процесс ffmpeg). */
const NORMALIZE_CONCURRENCY = 2;

/**
 * ЭТАП 1: аргументы ffmpeg для нормализации ОДНОГО клипа в единый формат (1080×1920, 24 fps, yuv420p, H.264 crf 20,
 * AAC 192k stereo 44.1k, одинаковый timescale) — чтобы склейка шла concat demuxer'ом с -c copy.
 * Видео обрезается до длины видео клипа; звук подгоняется ТОЧНО под неё (apad + atrim) — иначе склейка сдвигает весь
 * дальнейший звук относительно видео. Короткие fade-in/out на стыках (без них звук клипа обрывается щелчком);
 * клип без звука получает тишину (anullsrc) без фейдов.
 */
export function normalizeClipArgs(input: string, inf: { videoDuration?: number; duration?: number; hasAudio?: boolean }, dest: string, trim?: ClipTrim): string[] {
  const full = inf.videoDuration || inf.duration || 0;
  // Диапазон клипа после обрезки тишины (trim) — по умолчанию весь клип [0, full].
  const t0 = trim && trim.end > trim.start && trim.start >= 0 ? trim.start : 0;
  const t1 = trim && trim.end > trim.start ? Math.min(trim.end, full > 0 ? full : trim.end) : full;
  const d = t1 - t0;
  const silent = !inf.hasAudio;
  const args = ["-i", input];
  if (silent) args.push("-f", "lavfi", "-t", String(Math.max(0.1, d || 5)), "-i", "anullsrc=r=44100:cl=stereo");
  const vTrim = d > 0 ? `trim=${t0.toFixed(3)}:${t1.toFixed(3)},setpts=PTS-STARTPTS,` : "";
  const aTrim = d > 0 ? (silent ? `apad,atrim=0:${d.toFixed(3)},asetpts=PTS-STARTPTS,` : `apad,atrim=${t0.toFixed(3)}:${t1.toFixed(3)},asetpts=PTS-STARTPTS,`) : "";
  const fadeD = Math.min(AUDIO_FADE_SEC, d > 0 ? d / 2 : AUDIO_FADE_SEC);
  const aFade = d > 0 && !silent
    ? `afade=t=in:st=0:d=${fadeD.toFixed(3)}:curve=qsin,afade=t=out:st=${Math.max(0, d - fadeD).toFixed(3)}:d=${fadeD.toFixed(3)}:curve=qsin,`
    : "";
  const graph =
    `[0:v]${vTrim}scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[v];` +
    `[${silent ? "1:a" : "0:a:0"}]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,${aTrim}${aFade}asetpts=PTS-STARTPTS[a]`;
  args.push(
    "-filter_complex", graph, "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS), "-video_track_timescale", "12288",
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2", "-movflags", "+faststart", dest,
  );
  return args;
}

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
async function prepareEpisodeMusic(projectId: string, episode: number, totalSec: number, dir: string): Promise<{ file: string; url: string } | { error: string }> {
  try {
    const tags = await episodeMusicTags(projectId, episode);
    console.log(`[episode-assemble-v2] music tags: ${tags}`);
    const durationSec = Math.min(ACE_STEP_MAX_DURATION, Math.ceil(totalSec) + 2);
    let srcUrl: string;
    try {
      srcUrl = await generateAceStepMusic({ tags, durationSec });
    } catch (first: any) {
      // Одна повторная попытка: ACE-Step изредка падает/таймаутится разово, а серия без музыки — заметная потеря.
      console.warn("[episode-assemble-v2] music attempt 1 failed, retrying:", String(first?.message ?? first).slice(0, 200));
      await new Promise((r) => setTimeout(r, 3000));
      srcUrl = await generateAceStepMusic({ tags, durationSec });
    }
    const file = path.join(dir, "music.audio");
    await downloadToFile(srcUrl, file);
    const ext = (srcUrl.split("?")[0].match(/\.(mp3|wav|m4a|flac|ogg)$/i)?.[1] ?? "mp3").toLowerCase();
    const mime = ext === "wav" ? "audio/wav" : ext === "flac" ? "audio/flac" : ext === "ogg" ? "audio/ogg" : ext === "m4a" ? "audio/mp4" : "audio/mpeg";
    const url = await uploadBufferToS3(await fs.readFile(file), `media/public/episode-music-${projectId}-${episode}-${Date.now()}.${ext}`, mime).catch(() => srcUrl);
    return { file, url };
  } catch (err: any) {
    const error = String(err?.message ?? err).slice(0, 300);
    console.error("[episode-assemble-v2] music failed, assembling without music:", error);
    return { error };
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

    // Обрезка тишины: карта тишины каждого клипа → диапазон [start,end] (диалоговые клипы: мёртвый хвост; вход — если
    // предыдущий клип тоже диалоговый или был обрезан по хвосту). totalSec считается по ОБРЕЗАННЫМ длинам — под них
    // генерируется музыка.
    await updateJob(jobId, { progress: 20, message: "Detecting silence..." });
    const silences = await mapWithConcurrency(files, 3, (f, i) =>
      infos[i].hasAudio ? detectSilence(f, { noiseDb: SILENCE_NOISE_DB, minSec: SILENCE_MIN_SEC, totalSec: infos[i].duration }) : Promise.resolve([]),
    );
    const trims: ClipTrim[] = [];
    for (let i = 0; i < files.length; i++) {
      const full = infos[i].videoDuration || infos[i].duration || 0;
      const dialogue = sceneHasDialogueV2(scenes[i]);
      const prevDialogue = i > 0 && sceneHasDialogueV2(scenes[i - 1]);
      const prevTrimmedTail = i > 0 && trims[i - 1].end < (infos[i - 1].videoDuration || infos[i - 1].duration || 0) - 0.01;
      const tr = computeClipTrim(infos[i], silences[i], { dialogue, trimLead: dialogue && (prevDialogue || prevTrimmedTail) });
      trims.push(tr);
      const cutTail = full - tr.end, cutLead = tr.start;
      console.log(
        `[episode-assemble-v2] clip ${i + 1}: ${full.toFixed(2)}s → keep ${tr.start.toFixed(2)}–${tr.end.toFixed(2)}s` +
        ` (${dialogue ? "dialogue" : "no dialogue"}${cutLead > 0.005 ? `, lead -${cutLead.toFixed(2)}s` : ""}${cutTail > 0.005 ? `, tail -${cutTail.toFixed(2)}s` : ""})`,
      );
    }
    const totalSec = trims.reduce((acc, t) => acc + Math.max(0, t.end - t.start), 0);

    // Один фоновый трек на всю серию (ACE-Step 1.5). Ошибка музыки не валит склейку.
    await updateJob(jobId, { progress: 25, message: "Generating episode music..." });
    const musicRes = totalSec > 0 ? await prepareEpisodeMusic(projectId, episode, totalSec, dir) : { error: "empty episode" };
    const music = "file" in musicRes ? musicRes : null;
    const musicError = "error" in musicRes ? musicRes.error : "";
    await updateJob(jobId, { progress: 30, message: "Normalizing clips..." });

    // Двухэтапный конвейер (вместо одного гигантского filter_complex, который декодировал ВСЕ клипы 1080p разом
    // и падал по OOM / SIGKILL 600с-таймера): ЭТАП 1 — каждый клип нормализуется ОТДЕЛЬНЫМ коротким процессом
    // (память на один клип); ЭТАП 2 — склейка concat demuxer -c copy, музыка — финальным проходом только по аудио.
    const out = path.join(dir, "episode.mp4");
    const joined = music ? path.join(dir, "joined.mp4") : out;
    const single = files.length === 1;
    let done = 0;
    const normFiles = await mapWithConcurrency(files, NORMALIZE_CONCURRENCY, async (f, i) => {
      const dest = single ? joined : path.join(dir, `clip_norm_${String(i).padStart(3, "0")}.mp4`);
      await runFfmpegPlain(normalizeClipArgs(f, infos[i], dest, trims[i]), `v2 normalize clip ${i + 1}/${files.length}`);
      done++;
      void updateJob(jobId, { progress: 30 + Math.round((done / files.length) * 50), message: `Normalizing clips ${done}/${files.length}...` });
      return dest;
    });

    if (!single) {
      await updateJob(jobId, { progress: 85, message: "Stitching clips..." });
      const listPath = path.join(dir, "concat.txt");
      const escape = (p: string) => p.replace(/'/g, "'\\''");
      await fs.writeFile(listPath, normFiles.map((c) => `file '${escape(c)}'`).join("\n") + "\n");
      await runFfmpegPlain(
        ["-f", "concat", "-safe", "0", "-i", listPath, "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart", joined],
        "v2 episode concat (copy)",
      );
    }

    if (music) {
      // Музыка: трек подгоняется под длину серии (-stream_loop на случай короткого трека + apad/atrim), приглушается
      // (MUSIC_VOLUME), фейды на входе/выходе и ducking под звук клипов (sidechaincompress: сайдчейн — склеенная дорожка
      // сцен [0:a] joined.mp4), затем amix без нормализации, длина — по дорожке сцен. Видео копируется без перекодирования.
      const T = totalSec.toFixed(3);
      const fadeIn = Math.min(MUSIC_FADE_IN_SEC, totalSec / 2);
      const fadeOut = Math.min(MUSIC_FADE_OUT_SEC, totalSec / 2);
      const graph = [
        `[0:a]asplit=2[acat1][acat2]`,
        `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=0:${T},asetpts=PTS-STARTPTS,` +
          `volume=${MUSIC_VOLUME},afade=t=in:st=0:d=${fadeIn.toFixed(3)}:curve=qsin,afade=t=out:st=${Math.max(0, totalSec - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}:curve=qsin[mus]`,
        `[mus][acat1]sidechaincompress=${MUSIC_DUCK}[musd]`,
        `[acat2][musd]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`,
      ].join(";");
      let lastPct = -1;
      await runFfmpegWithProgress(
        [
          "-i", joined, "-stream_loop", "-1", "-i", music.file,
          "-filter_complex", graph, "-map", "0:v:0", "-map", "[aout]",
          "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2", "-movflags", "+faststart", out,
        ],
        "v2 episode music mix",
        totalSec,
        (pct) => {
          const p = 85 + Math.round(pct * 0.07);
          if (p !== lastPct) { lastPct = p; void updateJob(jobId, { progress: p, message: `Mixing music ${pct}%...` }); }
        },
      );
    }

    await updateJob(jobId, { progress: 92, message: "Uploading final video..." });
    const url = await uploadBufferToS3(await fs.readFile(out), `media/public/episode-${projectId}-${episode}-${Date.now()}.mp4`, "video/mp4");
    await setEpisodeFinalV2(projectId, episode, { videoUrl: url, musicUrl: music?.url ?? "", musicError, status: "done", error: "" });
    await completeJob(
      jobId,
      { episode, videoUrl: url, musicUrl: music?.url ?? null, musicError: musicError || null, clips: files.length, trims },
      music ? "Episode assembled with music" : `Episode assembled (no music: ${musicError || "unknown"})`,
    );
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
