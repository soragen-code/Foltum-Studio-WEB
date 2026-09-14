/**
 * Stage 111 — back to text-to-video with references (the Seedream keyframe = [Image1] "opening frame"),
 * a second MANDATORY location frame (elevated LAYOUT view in `imageReverse`), no bird's-eye extra slot.
 * Run: timeout 120 npx tsx --tsconfig tsconfig.json scripts/test-stage111.ts
 */
import fs from "node:fs";
import path from "node:path";
import { buildScenePrompt, type ScenePromptCharacterLink, type ScenePromptLocation, type ScenePromptScene } from "../lib/scene-prompt";
import {
  LOCATION_ANGLES, LOCATION_REQUIRED_ANGLES, LOCATION_SHOT_PLAN, VISUAL_STYLE_ID,
  locationAnglePrompt, locationBaseReady, locationLayoutNote,
} from "../lib/visual-style";
import { LOCATION_FRAMES_BY_DETAIL, LOCATION_TOTAL_MAX, LOCATION_MASTER_FRAMES } from "../lib/location-scale";
import { CHARACTER_REFERENCE_COST, LOCATION_SET_COST } from "../lib/power-tier";
import { LOCATION_ANCHOR_LINE } from "../lib/prompt-seam";
import { removeLocationFrame, LAYOUT_LOCKED_ERROR } from "../lib/location-frames";
import * as kf from "../lib/keyframe";

let passed = 0;
function ok(cond: unknown, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
  passed++; console.log(`ok: ${msg}`);
}
const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

/* Stage112 supersedes the old keyframe/reference path; its executable mock tests are in test-stage112.ts. */
const worker = read("lib/workers/video-job.ts");
const previewRoute = read("app/api/ai/scenes/[id]/prompt/route.ts");
const styled = (n: string) => "https" + "://media.invalid/" + VISUAL_STYLE_ID + "/" + n + ".webp";
ok(!/startImageToVideoGeneration|ensureKeyframe/.test(worker), "Stage112: T2V only, old still generation removed");

/* ---------------------------------------------------------------- B. mandatory elevated layout location frame */
ok(LOCATION_ANGLES.length === 3 && LOCATION_ANGLES[0].angle === "wide" && LOCATION_ANGLES[1].angle === "layout" && LOCATION_ANGLES[1].key === "imageReverse" && LOCATION_ANGLES[2].angle === "detail", "LOCATION_ANGLES: wide / layout(imageReverse) / detail");
ok(!(LOCATION_ANGLES as readonly { angle: string }[]).some((a) => a.angle === "reverse"), "LOCATION_ANGLES: no 'reverse' angle left");
ok(LOCATION_REQUIRED_ANGLES.join(",") === "wide,layout", "LOCATION_REQUIRED_ANGLES = wide + layout");
ok(LOCATION_ANGLES[1].label === "Ракурс сверху (планировка)", "layout label");
const layoutPrompt = locationAnglePrompt("a harbour office with a desk and a map wall", "Harbour office", "layout");
ok(/ELEVATED/i.test(layoutPrompt) && /2\.5–3 m/.test(layoutPrompt) && /30–40°/.test(layoutPrompt), "layout prompt: camera raised 2.5–3 m, tilted 30–40°");
ok(/NOT top-down and NOT a bird's-eye/i.test(layoutPrompt), "layout prompt: explicitly NOT top-down / bird's-eye");
ok(/reference image IS this location/i.test(layoutPrompt), "layout prompt: chained on the wide frame (same photographed place)");
ok(/no people/i.test(layoutPrompt) || /NO people/.test(layoutPrompt) || /people-free/i.test(layoutPrompt) || /without people/i.test(layoutPrompt), "layout prompt: people-free");
ok(locationBaseReady({ imageUrl: styled("w"), imageReverse: styled("l") }), "locationBaseReady: wide + layout → ready");
ok(!locationBaseReady({ imageUrl: styled("w"), imageReverse: null }), "locationBaseReady: wide only → NOT ready (legacy location)");
ok(!locationBaseReady({ imageUrl: null, imageReverse: styled("l") }), "locationBaseReady: layout only → NOT ready");
ok(LOCATION_SHOT_PLAN.length === 5 && !(LOCATION_SHOT_PLAN as readonly { key: string }[]).some((s) => s.key === "top"), "LOCATION_SHOT_PLAN: 5 slots, bird's-eye 'top' removed");
ok(LOCATION_FRAMES_BY_DETAIL.low === 4 && LOCATION_FRAMES_BY_DETAIL.medium === 6 && LOCATION_FRAMES_BY_DETAIL.high === 8 && LOCATION_TOTAL_MAX === 8, "LOCATION_FRAMES_BY_DETAIL: 4 / 6 / 8");
ok(LOCATION_MASTER_FRAMES === 2 && LOCATION_SET_COST === 2 * CHARACTER_REFERENCE_COST, "one location master set = 2 frames = 2 × CHARACTER_REFERENCE_COST");

const locJob = read("lib/workers/location-image-job.ts");
ok(/locationAnglePrompt\(visual, loc\.name, "wide"(, loc\.setInventory)?\)/.test(locJob) && /locationAnglePrompt\(visual, loc\.name, "layout"(, loc\.setInventory)?\), aspect_ratio: "9:16", image_input: \[wideUrl\]/.test(locJob), "location-image-job: renders wide, then layout chained on the wide frame");
ok(/ref-\$\{stamp\}-layout\.png/.test(locJob) && /data: \{ imageReverse: layoutUrl \}/.test(locJob), "location-image-job: the layout frame is written to imageReverse");
ok(/layoutFailed/.test(locJob), "location-image-job: a layout failure keeps the wide frame and is counted");
const locRefs = read("lib/location-refs.ts");
ok(/locationIds\.length \* LOCATION_SET_COST/.test(locRefs), "location-refs: charges LOCATION_SET_COST per location");
ok(/layoutMissing/.test(locRefs) && /failed\.length \* LOCATION_SET_COST \+ layoutMissing\.length \* CHARACTER_REFERENCE_COST/.test(locRefs), "location-refs: refunds 2 for a failed master, 1 for a missing layout view");
const shotRoute = read("app/api/ai/locations/[id]/shot/route.ts");
ok(/layout: "imageReverse"/.test(shotRoute) && /parsed\.data\.slot === "reverse" \? "layout"/.test(shotRoute), "shot route: slot 'layout' → imageReverse ('reverse' kept as alias)");
ok(/slot: z\.enum\(\["master", "layout", "reverse", "detail", "extra"\]\)/.test(read("lib/validations.ts")), "validations: locationShotSchema accepts 'layout'");
const locked = removeLocationFrame({ imageUrl: styled("w"), imageReverse: styled("l"), imageDetail: styled("d"), extras: [] }, "reverse");
ok(!locked.ok && locked.error === LAYOUT_LOCKED_ERROR, "location-frames: the layout view cannot be deleted");
ok(/slot === "layout" \? "reverse" : slot/.test(read("app/api/ai/locations/[id]/frame/route.ts")), "frame route: maps 'layout' onto the locked reverse slot");
ok(/elevated LAYOUT view/.test(LOCATION_ANCHOR_LINE) && /NOT a camera angle to copy or shoot from/.test(LOCATION_ANCHOR_LINE) && !/top-down layout/.test(LOCATION_ANCHOR_LINE), "LOCATION ANCHOR: names the elevated layout view as geography reference only");

/* ---------------------------------------------------------------- C. UI */
const view = read("app/project/[id]/episode/[episodeId]/episode-view.tsx");
ok(/const locBaseReady = \(l: any\) => validUrl\(l\?\.imageUrl\) && validUrl\(l\?\.imageReverse\)/.test(view), "episode-view: locBaseReady requires wide + layout");
ok(/label: 'Layout \(mandatory\)', slot: 'layout'/.test(view) && !/Reverse angle/.test(view), "episode-view: layout tile label, no 'Reverse angle'");
ok(/data-testid="ref-location-add-layout"/.test(view) && /regenShot\('location', l\.id, 'layout'\)/.test(view), "episode-view: 'Layout view' button adds only the layout frame for legacy locations");
ok(/master frames \(\$\{LOCATION_SET_COST\} cr\.\)/.test(view), "episode-view: master button shows the 2-frame cost");
ok(/a\.slot === 'layout' \? 'The layout view is mandatory/.test(view), "episode-view: delete disabled on the layout tile");
ok(!/keyframe/i.test(view), "Stage112: no old scene keyframe controls");
const refs = read("app/project/[id]/_components/references-stage.tsx");
ok(/validUrl\(l\.imageUrl\) && validUrl\(l\.imageReverse\)/.test(refs) && /data-testid="location-add-layout"/.test(refs) && /label: 'Layout \(mandatory\)', slot: 'layout'/.test(refs), "references-stage: ready count, add-layout button and label");
ok(/LOCATION_SET_COST/.test(refs) && !/Reverse angle/.test(refs), "references-stage: 2-frame cost, no 'Reverse angle'");

/* ---------------------------------------------------------------- D. Stage 110 pieces kept */
ok(!/applySeriesIntro/.test(worker) && !/applySeriesIntro/.test(previewRoute), "series intro not applied anywhere");
ok(/const MAX_SILENT_SCENES = 0/.test(read("lib/workers/scenes-job.ts")), "scenes-job: zero silent scenes");
ok(!/Regenerate script/.test(view), "episode-view: no 'Regenerate script' button");

console.log(`\nStage 111: all ${passed} checks passed.`);
