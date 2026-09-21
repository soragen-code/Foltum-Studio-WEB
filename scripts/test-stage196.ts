/**
 * Stage 196 — SCENE generation restored as the DEFAULT path + «Шоты» as an OPTIONAL mode.
 *
 * Two coordinated changes are covered here:
 *   CHANGE 1 — scene generation is the default again (1 scene = 1 prompt = 1 clip):
 *     (a) the standard generate endpoints, in the default SCENE mode, enqueue ONE SCENE-ONLY video job
 *         (runVideoJob WITHOUT a shotId) and the terminal assembly stitches the per-SCENE clips;
 *     (c) the video worker ACCEPTS a scene-only job — the "Legacy scene video generation has been
 *         removed" / "Legacy scene finalize has been removed" rejections are gone; runVideoJob
 *         dispatches a no-shotId job to runSceneVideoJob and finalizeVideoJob has a scene branch.
 *   CHANGE 2 — «Шоты» is an OPTIONAL per-episode mode reachable after the storyboard:
 *     (b) in «Шоты» mode the endpoints enqueue per-SHOT jobs and the assembly stitches per-SHOT clips;
 *         the mode is persisted on Episode.generationMode and entering it only builds the (free) shot
 *         plan — it never starts paid rendering.
 *
 * Pure/synthetic only — NO network, NO LLM, NO DB, NO paid generations. Source-inspection assertions
 * plus a unit test of the pure scene-chain selector.
 * Run: timeout 180 npx tsx --tsconfig tsconfig.json scripts/test-stage196.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

import { nextSequentialChainScene } from "../lib/chain-run";

let passed = 0;
function ok(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL: " + msg);
    process.exit(1);
  }
  passed++;
  console.log("ok: " + msg);
}

const REPO_ROOT = join(__dirname, "..");
function readSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

/* ───────────────────────── (c) video worker accepts a SCENE-only job ───────────────────────── */

const videoJob = readSource("lib/workers/video-job.ts");

ok(
  !videoJob.includes("Legacy scene video generation has been removed"),
  "(c) video-job no longer throws 'Legacy scene video generation has been removed'"
);
ok(
  !videoJob.includes("Legacy scene finalize has been removed"),
  "(c) video-job no longer throws 'Legacy scene finalize has been removed'"
);
// runVideoJob dispatches: shotId → shot path, otherwise → scene path.
ok(
  /if \(params\.shotId\) return runShotVideoJob\(params\);\s*\n\s*return runSceneVideoJob\(params\);/.test(videoJob),
  "(c) runVideoJob dispatches a no-shotId job to runSceneVideoJob"
);
ok(
  /async function runSceneVideoJob\(/.test(videoJob),
  "(c) runSceneVideoJob (whole-scene render) exists"
);
// finalizeVideoJob routes shot→shot else→scene (no unconditional scene rejection).
ok(
  /if \(state\.shotId\) return finalizeShotVideoJob\(jobId, state, source\);/.test(videoJob),
  "(c) finalizeVideoJob finalizes a shot job onto the Shot row"
);
ok(
  /async function continueChainRun\(/.test(videoJob),
  "(a) continueChainRun (per-scene chain) is restored"
);
// The per-scene chain ends by triggering the terminal assembly of the per-scene clips.
ok(
  /nextSequentialChainScene\(episode\.scenes\)/.test(videoJob) &&
    /runAssemblyJob\(episodeId\)/.test(videoJob),
  "(a) continueChainRun assembles the episode once the last scene is rendered"
);

/* ─────────────────── (a) default SCENE mode: endpoints enqueue SCENE-only jobs ─────────────────── */

const genVideo = readSource("app/api/ai/generate-video/route.ts");
ok(
  /generationMode === "scene"/.test(genVideo),
  "(a) generate-video branches on the default SCENE mode"
);
// The scene branch enqueues runVideoJob WITHOUT a shotId (whole-scene clip).
const genVideoSceneStart = genVideo.indexOf('if (generationMode === "scene")');
const genVideoSceneBlock = genVideo.slice(genVideoSceneStart, genVideo.indexOf("«Шоты» mode", genVideoSceneStart));
// Extract the runVideoJob({...}) call arguments and confirm no shotId is passed.
const genVideoRunCall = (genVideoSceneBlock.match(/runVideoJob\(\{([\s\S]*?)\}\)/) || [, ""])[1];
ok(
  genVideoRunCall.length > 0 && !/shotId/.test(genVideoRunCall),
  "(a) generate-video scene branch enqueues a SCENE-only job (no shotId)"
);
ok(
  /videoUrl: null, lastFrameUrl: null/.test(genVideoSceneBlock),
  "(a) generate-video regenerate clears the scene's videoUrl + lastFrameUrl"
);

const genEpisode = readSource("app/api/ai/generate-episode-videos/route.ts");
ok(
  /generationMode === "scene"/.test(genEpisode) && /nextSequentialChainScene\(scenes\)/.test(genEpisode),
  "(a) generate-episode-videos scene branch starts the per-scene chain"
);
const genEpisodeSceneStart = genEpisode.indexOf('if (generationMode === "scene")');
const genEpisodeSceneBlock = genEpisode.slice(genEpisodeSceneStart, genEpisode.indexOf("«Шоты» mode", genEpisodeSceneStart));
const genEpisodeRunCall = (genEpisodeSceneBlock.match(/runVideoJob\(\{([\s\S]*?)\}\)/) || [, ""])[1];
ok(
  genEpisodeRunCall.length > 0 && !/shotId/.test(genEpisodeRunCall),
  "(a) generate-episode-videos scene branch enqueues SCENE-only jobs (no shotId)"
);

const genAll = readSource("app/api/ai/episodes/[id]/generate-all/route.ts");
ok(
  /generationMode === "scene"/.test(genAll) && /nextSequentialChainScene\(episode\.scenes\)/.test(genAll),
  "(a) generate-all scene branch starts the per-scene chain"
);

/* ─────────────────── (a) default assembly stitches per-SCENE clips ─────────────────── */

const assembly = readSource("lib/workers/assembly-job.ts");
ok(
  /assembleEpisodeVideo\(episodeId\)/.test(assembly),
  "(a) runAssemblyJob delegates to the per-SCENE assembler in scene mode"
);
ok(
  /generationMode.*!== "shots"/.test(assembly),
  "(a) runAssemblyJob branches: non-shots mode → per-scene assembly"
);

/* ─────────────────── (b) «Шоты» mode: per-SHOT jobs + per-SHOT assembly ─────────────────── */

ok(
  /import \{\s*buildConcatPlan[\s\S]*?\} from "@\/lib\/shot-pipeline"/.test(assembly) &&
    /buildConcatPlan\(ordered\)/.test(assembly),
  "(b) runAssemblyJob assembles per-SHOT clips (buildConcatPlan) in «Шоты» mode"
);
// In «Шоты» mode the endpoints keep the per-shot chain (shotId present).
ok(
  /shotId: firstShot\.id/.test(genAll) && /shotId: targetShot!\.id/.test(genVideo),
  "(b) endpoints still enqueue per-SHOT jobs in «Шоты» mode"
);

/* ─────────────────── (b) «Шоты» mode is persisted + entered without paid rendering ─────────────────── */

const schema = readSource("prisma/schema.prisma");
ok(
  /generationMode\s+String\s+@default\("scene"\)/.test(schema),
  "(b) Episode.generationMode column exists (default \"scene\", backward-compatible)"
);
const patch = readSource("prisma/patch.sql");
ok(
  /ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "generationMode" TEXT NOT NULL DEFAULT 'scene'/.test(patch),
  "(b) patch.sql adds generationMode with IF NOT EXISTS + default (safe migration)"
);

const modeRoute = readSource("app/api/ai/episodes/[id]/generation-mode/route.ts");
ok(
  /generationModeSchema/.test(modeRoute) && /generationMode: mode/.test(modeRoute),
  "(b) generation-mode route persists Episode.generationMode"
);
ok(
  /persistShotPlanForApprovedEpisode\(id\)/.test(modeRoute),
  "(b) entering «Шоты» builds the shot plan (free text-only LLM planning)"
);
ok(
  !/runVideoJob\(/.test(modeRoute),
  "(b) entering «Шоты» never starts paid video rendering (no runVideoJob call)"
);

const validations = readSource("lib/validations.ts");
ok(
  /export const generationModeSchema = z\.object\(\{[\s\S]*?mode: z\.enum\(\["scene", "shots"\]\)/.test(validations),
  "(b) generationModeSchema accepts exactly \"scene\" | \"shots\""
);

/* ─────────────────── (b) UI exposes the «Шоты» mode after the storyboard ─────────────────── */

const view = readSource("app/project/[id]/episode/[episodeId]/episode-view.tsx");
ok(
  /\[\['scene', 'Сцены'\], \['shots', 'Шоты'\]\]/.test(view),
  "(b) UI offers a Сцены (default) / Шоты toggle with the exact Russian name «Шоты»"
);
ok(
  /chooseGenerationMode/.test(view) && /generation-mode/.test(view),
  "(b) UI toggle calls the generation-mode endpoint"
);

/* ─────────────────── pure unit: the scene-chain selector ─────────────────── */

// Strict prefix growth: earliest prompted scene without a video, never skipping ahead.
const scenes = [
  { id: "s1", number: 1, videoPrompt: "p1", videoUrl: "http://x/1.mp4" },
  { id: "s2", number: 2, videoPrompt: "p2", videoUrl: null },
  { id: "s3", number: 3, videoPrompt: "p3", videoUrl: null },
];
ok(nextSequentialChainScene(scenes)?.id === "s2", "scene selector returns the earliest ungenerated scene (s2)");
ok(
  nextSequentialChainScene([{ id: "a", number: 1, videoPrompt: "p", videoUrl: "http://x/a.mp4" }]) === null,
  "scene selector returns null when every prompted scene has a clip (chain complete → assemble)"
);
ok(
  nextSequentialChainScene([{ id: "g", number: 1, videoPrompt: "p", videoUrl: null, status: "generating" }]) === null,
  "scene selector waits (null) while the earliest gap is already generating — never skips ahead"
);

console.log(`\nAll ${passed} assertions passed (Stage 196).`);
