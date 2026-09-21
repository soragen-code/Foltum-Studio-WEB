/**
 * PAID acceptance driver for the Stage 167 shot pipeline (NOT product code — untracked, never committed).
 *
 * Replicates the exact server logic of POST app/api/ai/episodes/[id]/generate-all/route.ts WITHOUT HTTP/auth,
 * calling the real workers directly against the prod DB on this VM. It charges the first shot, starts it, and
 * then KEEPS THE PROCESS ALIVE with a poll loop while the shot chain (continueShotChain → per-shot runVideoJob
 * → runAssemblyJob) drives itself to Episode.videoUrl. Because runInBackground() outside a request scope is a
 * plain fire-and-forget run(), the poll loop is what holds the Node event loop open until the chain finishes.
 *
 * Run (prod env, detached):
 *   set -a; source /home/ubuntu/.prod.env; export DATABASE_URL="$DATABASE_URL_UNPOOLED";
 *   npx tsx --tsconfig tsconfig.json scripts/paid-run.ts
 * WAVESPEED_API_KEY must be exported in the environment before running (see the runner shell).
 */
import { prisma } from "@/lib/db";
import { runVideoJob } from "@/lib/workers/video-job";
import { resolvePowerTier } from "@/lib/power-tier";
import { sceneClipSeconds, sceneClipCost } from "@/lib/season";
import { nextSequentialShot } from "@/lib/chain-run";
import { normalizeVideoModel } from "@/lib/ai-models";

const EPISODE_ID = "cmu3d6g3s0016js04muo4kalv";
const USER_ID = "cmtrng9rf0000la04ke2i64tp";

/** Poll cadence and safety bounds. */
const POLL_MS = 25_000;
const HARD_CAP_MS = 130 * 60_000; // absolute ceiling; the run should finish well before this
const NO_PROGRESS_GRACE_TICKS = 6; // ~2.5 min: all shots terminal but no episode.videoUrl and chain idle → give up

function ts(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}
function log(msg: string): void {
  console.log(`[${ts()}] ${msg}`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function loadEpisode() {
  return prisma.episode.findFirst({
    where: { id: EPISODE_ID },
    include: { season: { include: { project: true } }, scenes: { orderBy: { number: "asc" } } },
  });
}

async function loadShots() {
  return prisma.shot.findMany({
    where: { scene: { episodeId: EPISODE_ID } },
    select: { id: true, index: true, sceneId: true, videoUrl: true, status: true, duration: true },
  });
}

async function main(): Promise<void> {
  log(`PAID-RUN start — episode=${EPISODE_ID} user=${USER_ID}`);

  // Sanity: the WaveSpeed key must be present or every shot fails immediately (we still verify here so the
  // failure, if any, is loud and cheap).
  if (!process.env.WAVESPEED_API_KEY) {
    log("ABORT: WAVESPEED_API_KEY is not set in the environment — refusing to start (would fail instantly).");
    process.exit(2);
  }

  const episode = await loadEpisode();
  if (!episode) {
    log("ABORT: episode not found.");
    process.exit(2);
  }
  if (episode.status === "shot_plan_failed") {
    log(`ABORT: episode.status=shot_plan_failed (chainRunNote=${episode.chainRunNote ?? "-"}). Regenerate the shot plan first.`);
    process.exit(2);
  }

  const project = episode.season.project;
  const tier = resolvePowerTier(project);
  log(`Episode #${episode.number} "${episode.title}" status=${episode.status} chainRunActive=${episode.chainRunActive} videoUrl=${episode.videoUrl ? "SET" : "null"}`);
  log(`Project "${project.name}" powerTier=${project.powerTier} → tier=${tier.id} resolution=${tier.resolution}`);
  log(`Scenes=${episode.scenes.length}`);

  let episodeShots = await loadShots();
  if (episodeShots.length === 0) {
    log("ABORT: episode has no Shot rows. Regenerate the shot plan first.");
    process.exit(2);
  }
  const totalShots = episodeShots.length;
  log(`Shots=${totalShots} (pending=${episodeShots.filter((s) => s.status === "pending").length}, withVideo=${episodeShots.filter((s) => s.videoUrl).length})`);

  // Pick the first ungenerated shot exactly like the route (global order by sceneNumber, then index).
  const sceneNumberById = new Map(episode.scenes.map((s) => [s.id, s.number]));
  const orderKey = (s: (typeof episodeShots)[number]) => ({
    id: s.id,
    sceneNumber: sceneNumberById.get(s.sceneId) ?? 0,
    index: s.index,
    videoUrl: s.videoUrl,
    status: s.status,
  });
  const firstShot = nextSequentialShot(episodeShots.map(orderKey));
  if (!firstShot) {
    log("ABORT: all episode shots already have a clip (nothing to generate).");
    process.exit(2);
  }
  const shotRow = episodeShots.find((s) => s.id === firstShot.id)!;
  const duration = sceneClipSeconds(tier.id, Math.max(1, Math.round(Number(shotRow.duration ?? 3))));
  const cost = sceneClipCost(tier.id, duration);
  const provider = normalizeVideoModel(undefined);
  log(`First shot: id=${firstShot.id} scene#${firstShot.sceneNumber} index=${firstShot.index} → duration=${duration}s cost=${cost} provider=${provider}`);

  // Charge the first shot atomically, exactly like the route.
  const charged = await prisma.user.updateMany({ where: { id: USER_ID, credits: { gte: cost } }, data: { credits: { decrement: cost } } });
  if (charged.count !== 1) {
    const u = await prisma.user.findUnique({ where: { id: USER_ID }, select: { credits: true } });
    log(`ABORT: insufficient credits — need ${cost}, balance ${u?.credits ?? "?"}.`);
    process.exit(2);
  }
  await prisma.creditTransaction.create({
    data: { userId: USER_ID, amount: -cost, description: `Episode ${episode.number}, scene ${firstShot.sceneNumber}, shot ${firstShot.index + 1} — video generation via chain (${tier.id}) [paid-run driver]` },
  });
  await prisma.shot.update({ where: { id: firstShot.id }, data: { status: "generating", error: null } });
  await prisma.episode.update({ where: { id: episode.id }, data: { chainRunActive: true, chainRunNote: null } });
  const job = await prisma.generationJob.create({
    data: { type: "video", status: "processing", progress: 2, message: "Chain: starting first shot... [paid-run]", projectId: project.id, sceneId: shotRow.sceneId },
  });
  const freshUser = await prisma.user.findUnique({ where: { id: USER_ID }, select: { credits: true } });
  log(`CHARGED ${cost} credit(s) for first shot; jobId=${job.id}; balance now=${freshUser?.credits ?? "?"}`);

  // Fire the first shot WITHOUT awaiting it, so the poll loop starts immediately and logs progress from t=0.
  // The chain continues on its own (finalizeShotVideoJob → continueShotChain → next runVideoJob / assembly).
  let firstShotSettled = false;
  let firstShotError: string | null = null;
  runVideoJob({ jobId: job.id, sceneId: shotRow.sceneId, shotId: firstShot.id, projectId: project.id, userId: USER_ID, cost, duration, resolution: tier.resolution, provider })
    .then(() => { firstShotSettled = true; log(`first-shot runVideoJob resolved (chain continues in background)`); })
    .catch((e) => { firstShotSettled = true; firstShotError = e instanceof Error ? e.message : String(e); log(`first-shot runVideoJob REJECTED: ${firstShotError}`); });

  // Poll loop — keeps the event loop alive until the chain reaches Episode.videoUrl or stops.
  const startedAt = Date.now();
  let idleTicks = 0;
  let lastLine = "";
  for (;;) {
    await sleep(POLL_MS);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);

    const ep = await prisma.episode.findUnique({ where: { id: EPISODE_ID }, select: { status: true, chainRunActive: true, chainRunNote: true, videoUrl: true } });
    episodeShots = await loadShots();
    const pending = episodeShots.filter((s) => s.status === "pending").length;
    const generating = episodeShots.filter((s) => s.status === "generating").length;
    const completed = episodeShots.filter((s) => s.status === "completed").length;
    const failed = episodeShots.filter((s) => s.status === "failed").length;
    const withVideo = episodeShots.filter((s) => s.videoUrl).length;

    // Fetch the active/most-recent video job progress for a compact heartbeat.
    const activeJob = await prisma.generationJob.findFirst({
      where: { sceneId: { in: episode.scenes.map((s) => s.id) }, type: "video" },
      orderBy: { updatedAt: "desc" },
      select: { status: true, progress: true, message: true },
    });

    const line = `t+${elapsed}s | shots ${withVideo}/${totalShots} video | pending=${pending} gen=${generating} done=${completed} fail=${failed} | ep.status=${ep?.status} chainActive=${ep?.chainRunActive} epVideo=${ep?.videoUrl ? "SET" : "null"} | job=${activeJob?.status}:${activeJob?.progress ?? "-"}% "${(activeJob?.message ?? "").slice(0, 60)}"${ep?.chainRunNote ? ` | NOTE=${ep.chainRunNote}` : ""}`;
    if (line !== lastLine) { log(line); lastLine = line; } else { log(`(unchanged) ${line}`); }

    // (a) SUCCESS — the terminal artifact exists.
    if (ep?.videoUrl) {
      log(`SUCCESS: episode.videoUrl is set. Shots with video: ${withVideo}/${totalShots}.`);
      break;
    }
    // (b) Chain stopped by an error (chainRunActive cleared AND a note written).
    if (ep && ep.chainRunActive === false && ep.chainRunNote) {
      log(`CHAIN STOPPED: chainRunActive=false, note="${ep.chainRunNote}". Shots with video: ${withVideo}/${totalShots}.`);
      break;
    }
    // (c) All shots terminal but no episode.videoUrl and chain idle → assembly didn't produce output.
    if (pending === 0 && generating === 0) {
      idleTicks += 1;
      if (idleTicks >= NO_PROGRESS_GRACE_TICKS) {
        log(`GIVE UP: all shots terminal (${completed} done / ${failed} failed) but episode.videoUrl still null after grace. Assembly did not complete.`);
        break;
      }
    } else {
      idleTicks = 0;
    }
    // Safety: also stop if the first shot rejected and nothing is in flight.
    if (firstShotError && generating === 0 && pending > 0) {
      log(`GIVE UP: first shot errored (${firstShotError}) and no shot is in flight.`);
      break;
    }
    if (Date.now() - startedAt > HARD_CAP_MS) {
      log(`GIVE UP: hard time cap reached.`);
      break;
    }
  }

  // Final summary.
  const finalEp = await prisma.episode.findUnique({ where: { id: EPISODE_ID }, select: { status: true, chainRunActive: true, chainRunNote: true, videoUrl: true } });
  const finalShots = await loadShots();
  const finalWithVideo = finalShots.filter((s) => s.videoUrl).length;
  log("================ FINAL REPORT ================");
  log(`shots with videoUrl: ${finalWithVideo}/${totalShots}`);
  log(`episode.status=${finalEp?.status} chainRunActive=${finalEp?.chainRunActive}`);
  log(`episode.videoUrl=${finalEp?.videoUrl ?? "null"}`);
  log(`episode.chainRunNote=${finalEp?.chainRunNote ?? "null"}`);
  log(`first-shot settled=${firstShotSettled} error=${firstShotError ?? "none"}`);
  log(`RESULT: ${finalEp?.videoUrl ? "PASS (episode.videoUrl set)" : finalWithVideo >= 15 ? "PARTIAL (>=15 shots but no episode.videoUrl)" : "FAIL"}`);
  log("=============================================");

  await prisma.$disconnect().catch(() => {});
  process.exit(finalEp?.videoUrl ? 0 : 1);
}

main().catch(async (e) => {
  console.error(`[${ts()}] FATAL:`, e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
