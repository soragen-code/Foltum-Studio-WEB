import { assembleEpisodeLocally, extractLastFrameBuffer } from "../lib/ffmpeg";
import { promises as fs } from "fs";

async function main() {
  const base =
    "https://foltum-studio-web-media.s3.us-east-1.amazonaws.com/media/public/videos/cmtrxdacp0001ju04pxde9s4v/cmtrxdur80003i904cjous5bg";
  const scenes = [
    { videoUrl: `${base}/scene-1-1788827437614.mp4`, subtitle: "" },
    { videoUrl: `${base}/scene-2-1788827454039.mp4`, subtitle: "" },
    { videoUrl: `${base}/scene-3-1788827452127.mp4`, subtitle: "This can't be right..." },
  ];

  console.log("== extractLastFrameBuffer test ==");
  const frame = await extractLastFrameBuffer(scenes[0].videoUrl);
  console.log("last frame bytes:", frame.length, "jpeg?", frame.slice(0, 3).toString("hex"));

  console.log("== assembleEpisodeLocally test (with subtitle burn) ==");
  const res = await assembleEpisodeLocally(scenes as any);
  console.log("audioSources:", res.audioSources);
  console.log("info:", res.info);
  const out = "/home/ubuntu/test_episode_out.mp4";
  await fs.copyFile(res.outputPath, out);
  await fs.rm(res.workDir, { recursive: true, force: true });
  console.log("wrote", out);
}

main().catch((e) => {
  console.error("TEST FAILED:", e);
  process.exit(1);
});
