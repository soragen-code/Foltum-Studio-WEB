/**
 * Фоновый воркер потока v2 (вкладка «Сцены», кнопка «Собрать эпизод»): склеивает видео всех сцен серии
 * в порядке index в один финальный mp4 (H.264 + AAC, 1080×1920, 24 fps) через ffmpeg-static и грузит в S3.
 * Клипы перекодируются единообразно (scale/pad + fps + stereo 44.1k; клип без звука получает тишину),
 * звук каждого клипа подгоняется точно под длину его видео (apad+atrim) и получает короткие фейды на стыках,
 * затем concat-фильтр — надёжно для клипов с разными параметрами. Результат — Project.episodeFinalV2["<n>"].
 */
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { prisma } from "@/lib/db";
import { uploadBufferToS3 } from "@/lib/s3-upload";
import { completeJob, failJob, heartbeatJob, updateJob } from "@/lib/jobs";
import { downloadToFile, mapWithConcurrency, probeMedia, runFfmpegWithProgress } from "@/lib/ffmpeg";
import { allSceneVideosReady, episodeScenesV2From } from "@/lib/idea-v2";
import { setEpisodeFinalV2 } from "@/lib/episode-scenes-v2-store";

export const EPISODE_ASSEMBLE_V2_JOB_TYPE = "episode_assemble_v2";
export const EPISODE_ASSEMBLE_V2_EXPECTED_SEC = 90;

const W = 1080;
const H = 1920;
const FPS = 24;
/** Длительность fade-in/fade-out звука на границах клипов (с). */
const AUDIO_FADE_SEC = 0.4;

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
    parts.push(`${concatIn.join("")}concat=n=${files.length}:v=1:a=1[vout][aout]`);
    const out = path.join(dir, "episode.mp4");
    args.push(
      "-filter_complex", parts.join(";"), "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out,
    );
    const totalSec = infos.reduce((acc, inf) => acc + (inf.videoDuration || inf.duration || 0), 0);
    let lastPct = -1;
    await runFfmpegWithProgress(args, "v2 episode assemble", totalSec, (pct) => {
      const p = 30 + Math.round(pct * 0.6);
      if (p !== lastPct) { lastPct = p; void updateJob(jobId, { progress: p, message: `Stitching ${pct}%...` }); }
    });

    await updateJob(jobId, { progress: 92, message: "Uploading final video..." });
    const url = await uploadBufferToS3(await fs.readFile(out), `media/public/episode-${projectId}-${episode}-${Date.now()}.mp4`, "video/mp4");
    await setEpisodeFinalV2(projectId, episode, { videoUrl: url, status: "done", error: "" });
    await completeJob(jobId, { episode, videoUrl: url, clips: files.length }, "Episode assembled");
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
