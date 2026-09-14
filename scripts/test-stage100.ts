/**
 * Stage 100 — parallel generation mode was REMOVED entirely. Generation is ALWAYS sequential
 * (chain): scenes run strictly one after another and each scene opens on the real last frame of the
 * previous scene. The mode choice is gone from the UI.
 *
 *   (a) normalizeChainMode is a pure, DB-free helper — it now collapses EVERY input (including the
 *       legacy "parallel" literal) to "chain" and never returns "parallel".
 *   (b) the episode UI no longer renders the generation-order (chain/parallel) toggle, and the
 *       chain-mode PATCH route is gone.
 *   (c) resolveContinuity (pure) keeps the chain continuity: scene > 1 with a previous frame →
 *       "last_frame"; scene > 1 without a frame yet → "text_only"; scene 1 → "none".
 *
 * Only NON-protected source text is read. No protected file is read for content.
 */
import assert from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { normalizeChainMode } from "../lib/chain-run";
import { resolveContinuity } from "../lib/prompt-seam";

let pass = 0;
const ok = (c: unknown, m: string) => {
  assert(c, m);
  console.log("ok:", m);
  pass++;
};

const root = process.cwd();
const read = (p: string) => readFileSync(`${root}/${p}`, "utf8");

// ── (a) normalizeChainMode always → "chain" ──────────────────────────────────────────────────────
for (const input of ["parallel", "chain", "nope", undefined, null, "", 0, {}] as const) {
  ok(normalizeChainMode(input as unknown) === "chain", `a: normalizeChainMode(${JSON.stringify(input)}) → chain`);
}
ok(normalizeChainMode("parallel") !== "parallel", "a: legacy 'parallel' is never returned anymore");

// ── (b) the generation-order toggle is gone from the episode UI ────────────────────────────────────
const episodeView = read("app/project/[id]/episode/[episodeId]/episode-view.tsx");
ok(!episodeView.includes("data-testid=\"chain-mode-picker\""), "b: episode UI no longer has the chain-mode picker");
ok(!/label:\s*'In parallel'/.test(episodeView), "b: episode UI no longer offers the 'In parallel' option");
ok(!/setChainMode/.test(episodeView), "b: setChainMode handler removed from the episode UI");
ok(!/\/api\/ai\/episodes\/\$\{episode\.id\}\/chain-mode/.test(episodeView), "b: episode UI no longer PATCHes the chain-mode route");
ok(!existsSync(`${root}/app/api/ai/episodes/[id]/chain-mode/route.ts`), "b: the chain-mode PATCH route is deleted");

// The confirmation modal wording no longer mentions the parallel path.
ok(!/scenes in parallel/i.test(episodeView), "b: the 'Generate all' modal no longer describes a parallel start");

// ── (b2) generate-all route: no parallel fan-out branch left ───────────────────────────────────────
const genAll = read("app/api/ai/episodes/[id]/generate-all/route.ts");
ok(!/fanOutAll/.test(genAll), "b2: generate-all route no longer fans out scenes in parallel");
ok(!/if \(episode\.chainMode === "chain"\)/.test(genAll), "b2: generate-all no longer branches on chainMode (always chain)");

// ── (b3) generate-episode-videos route starts one scene and arms the chain ─────────────────────────
const genEp = read("app/api/ai/generate-episode-videos/route.ts");
ok(/chainRunActive: true/.test(genEp), "b3: generate-episode-videos arms the chain run");
ok(!/all scenes generate in parallel/i.test(genEp), "b3: generate-episode-videos no longer fires every scene in parallel");

// ── (c) resolveContinuity keeps the chain continuity channel ───────────────────────────────────────
ok(resolveContinuity({ chainMode: "chain", sceneNumber: 2, previousFrameSceneId: "abc", refs: [] }) === "last_frame",
  "c: scene 2 with a previous frame id → last_frame");
ok(resolveContinuity({ chainMode: "chain", sceneNumber: 3, previousFrameSceneId: null, refs: [{ kind: "previous_frame" }] }) === "last_frame",
  "c: scene 3 with a previous_frame ref → last_frame");
ok(resolveContinuity({ chainMode: "chain", sceneNumber: 2, previousFrameSceneId: null, refs: [{ kind: "character" }] }) === "text_only",
  "c: scene 2 without a frame yet → text_only (never a parallel-only 'none')");
ok(resolveContinuity({ chainMode: "chain", sceneNumber: 1, previousFrameSceneId: null, refs: [] }) === "none",
  "c: scene 1 → none (no prior shot to carry from)");

// ── (d) worker + prompt route always pass chainMode: "chain" ───────────────────────────────────────
const worker = read("lib/workers/video-job.ts");
ok(!/chainMode:\s*episodeLoc\?\.chainMode === "chain" \? "chain" : "parallel"/.test(worker),
  "d: video worker no longer resolves chainMode from the stored value");
ok((worker.match(/chainMode:\s*"chain"/g) || []).length >= 2, "d: video worker passes literal chainMode: 'chain'");
const promptRoute = read("app/api/ai/scenes/[id]/prompt/route.ts");
ok((promptRoute.match(/chainMode:\s*"chain"/g) || []).length >= 2, "d: scene prompt route passes literal chainMode: 'chain'");

console.log(`\nPASS — ${pass} assertions`);
