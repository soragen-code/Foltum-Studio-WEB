/**
 * Stage 96 — continuity fixes:
 *   BUG A: episode location geometry (roof/ceiling, openings, background landmarks,
 *          object set) must stay locked across every shot of the one fixed place.
 *   BUG B: a scene's opening WORLD must equal the previous scene's endState WORLD
 *          (same char pose/position/motion/action, same instant) — only camera differs.
 *
 * Static assertions on the NON-protected directive text (lib/prompt-seam.ts LOCATION_ANCHOR_LINE
 * and lib/season.ts START_STATE_RULE / END_STATE_RULE region). No protected file is read for content.
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";

let pass = 0;
const ok = (c: unknown, m: string) => {
  assert(c, m);
  console.log("ok:", m);
  pass++;
};

const root = process.cwd();
const seam = readFileSync(`${root}/lib/prompt-seam.ts`, "utf8");
const season = readFileSync(`${root}/lib/season.ts`, "utf8");

// ---- BUG A: extract LOCATION_ANCHOR_LINE and assert explicit geometry-lock language ----
const anchorMatch = seam.match(/export const LOCATION_ANCHOR_LINE\s*=\s*([\s\S]*?);\n/);
ok(anchorMatch, "LOCATION_ANCHOR_LINE constant is present in lib/prompt-seam.ts");
const anchor = anchorMatch![1];

ok(
  /same (roof|ceiling|building|geography|structure)/i.test(anchor),
  "BUG A: anchor locks same roof/ceiling/building/geography/structure"
);
ok(
  /do not (add|remove)/i.test(anchor),
  "BUG A: anchor forbids adding/removing structural elements or objects"
);
ok(
  /background landmarks|same openings|same objects/i.test(anchor),
  "BUG A: anchor locks background landmarks / openings / object set"
);
// Extra concept checks (adapted to exact wording)
ok(/open[- ]sky|open to the sky/i.test(anchor), "BUG A: anchor addresses the intact-vs-open-sky roof toggle");
ok(/doorway|opening/i.test(anchor), "BUG A: anchor locks the shape/width of openings (doorway)");
ok(/bag/i.test(anchor), "BUG A: anchor locks the bag (logo/shape/placement) among floor objects");

// ---- BUG B: extract START_STATE_RULE (+ END_STATE_RULE) region and assert carry-over ----
const startIdx = season.indexOf("export const START_STATE_RULE");
ok(startIdx >= 0, "START_STATE_RULE constant is present in lib/season.ts");
const endIdx = season.indexOf("const PROMPT_LINES", startIdx);
const stateRules = season.slice(startIdx, endIdx > startIdx ? endIdx : startIdx + 4000);

ok(
  /previous .*end.?state/i.test(stateRules),
  "BUG B: opening WORLD must equal the PREVIOUS scene's endState WORLD"
);
ok(
  /(pose|position|motion|action)/i.test(stateRules),
  "BUG B: carry-over is stated in terms of char pose/position/motion/action"
);
ok(
  /same (instant|moment)/i.test(stateRules),
  "BUG B: the two frames are the SAME instant/moment"
);
// Extra concept checks (the exact drift the user reported: walking -> sitting)
ok(/walk/i.test(stateRules), "BUG B: rule uses the walking example (no jump to sitting)");
ok(/chain mode|parallel mode/i.test(stateRules), "BUG B: rule states it holds in BOTH chain and parallel modes");
ok(/only .*camera .*differ|only the camera/i.test(stateRules), "BUG B: only the camera setup may differ across the seam");

console.log(`\nStage 96: ${pass} checks passed.`);
