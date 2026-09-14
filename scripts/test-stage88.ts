/**
 * Stage 88 — three deliverables:
 *
 *  (1) POST-PURCHASE REDIRECT TO THE MAIN SCREEN. After a successful WayForPay purchase the browser
 *      returns to the dashboard (the main screen), NOT the pricing/return page. The create route's
 *      returnUrl points at /dashboard?order=<ref>; the dashboard client polls the payment status and,
 *      once the server-to-server callback has granted the credits (status === 'approved'), shows an
 *      English success toast and cleans the URL. The server-to-server credit callback (serviceUrl) is
 *      UNTOUCHED and still grants credits idempotently.
 *
 *  (2) HARD LOCATION CONSISTENCY. A single fixed geography is held byte-identically across every shot
 *      of a location via a constant LOCATION ANCHOR directive (applyLocationConsistency): same
 *      landmarks / distances / materials / weather / light direction relative to terrain; the master
 *      establishing view / top-down layout is a REFERENCE ONLY (explicitly NOT a camera angle); the
 *      camera is positioned RELATIVE to fixed landmarks (only the camera moves, geography stays fixed);
 *      no object appears or disappears between shots; persistent state (footprints, marks, moved props,
 *      character positions) carries over. Applied in BOTH the worker and the preview route. The
 *      protected lib/scene-prompt.ts is never touched; it fires retroactively for old projects.
 *
 *  (3) CROSS-EPISODE CONTINUITY. Each episode continues the previous one: the immediately-preceding
 *      episode's concrete ENDING context (last scene end state + closing beats) is threaded into the
 *      next episode's brief (episodeScriptUserPrompt.previousEnding, fed by loadPreviousEnding), and
 *      the ep2+ opening-narration rule (season.ts R7) recaps / continues the previous episode instead
 *      of restarting the story.
 *
 * No protected files are touched; no destructive DB migration.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyLocationConsistency,
  LOCATION_ANCHOR_LINE,
  applyLocationBaseLayer,
  LOCATION_BASE_LAYER_LINE,
  applySeriesIntro,
  SERIES_INTRO_LINE,
} from "../lib/prompt-seam";
import { episodeScriptSystemPrompt, episodeScriptUserPrompt } from "../lib/season";

let passed = 0;
function ok(label: string, cond: boolean) {
  if (!cond) { console.error("FAIL: " + label); process.exit(1); }
  console.log("ok: " + label);
  passed++;
}

const ROOT = join(__dirname, "..");
const seam = readFileSync(join(ROOT, "lib/prompt-seam.ts"), "utf8");
const worker = readFileSync(join(ROOT, "lib/workers/video-job.ts"), "utf8");
const previewRoute = readFileSync(join(ROOT, "app/api/ai/scenes/[id]/prompt/route.ts"), "utf8");
const createRoute = readFileSync(join(ROOT, "app/api/payment/wayforpay/create/route.ts"), "utf8");
const callbackRoute = readFileSync(join(ROOT, "app/api/payment/wayforpay/callback/route.ts"), "utf8");
const dashClient = readFileSync(join(ROOT, "app/dashboard/_components/dashboard-client.tsx"), "utf8");
const seasonJob = readFileSync(join(ROOT, "lib/workers/season-script-job.ts"), "utf8");

const base = "A cinematic vertical shot of a lighthouse at dawn.";

/* ── (1) POST-PURCHASE REDIRECT TO THE MAIN SCREEN ──────────────────────────── */
// 1a: create route redirects the browser to the dashboard, not the pricing page.
ok("1: create route returnUrl points at /dashboard", /returnUrl:\s*`\$\{base\}\/dashboard\?order=/.test(createRoute));
ok("1: create route returnUrl carries the order ref", /returnUrl:[^\n]*order=\$\{encodeURIComponent\(orderReference\)\}/.test(createRoute));
ok("1: create route returnUrl no longer targets the pricing page", !/returnUrl:\s*`\$\{base\}\/pricing/.test(createRoute));
// 1b: the server-to-server credit callback (serviceUrl) is untouched.
ok("1: serviceUrl still points at the callback webhook", /serviceUrl:\s*`\$\{base\}\/api\/payment\/wayforpay\/callback`/.test(createRoute));
// 1c: dashboard client polls the status route and reacts to the outcome.
ok("1: dashboard imports the toast", /import \{ toast \} from ['"]sonner['"]/.test(dashClient));
ok("1: dashboard reads the ?order= param", /params\.get\(['"]order['"]\)/.test(dashClient));
ok("1: dashboard polls the payment status route", /\/api\/payment\/wayforpay\/status\?order=/.test(dashClient));
ok("1: dashboard shows an English success toast with the credits added", /toast\.success\(`Payment successful! \+\$\{[^}]*credits\} credits added\.`\)/.test(dashClient));
ok("1: dashboard shows an English declined toast", /toast\.error\(['"]Payment was declined\.['"]\)/.test(dashClient));
ok("1: dashboard cleans the URL back to /dashboard after handling", /window\.history\.replaceState\(\{\}, ['"]['"], ['"]\/dashboard['"]\)/.test(dashClient));
ok("1: dashboard success toast text is English (no Cyrillic)", !/toast\.success\(`Payment successful[^`]*[\u0400-\u04FF]/.test(dashClient));
// 1d: the callback route STILL grants credits idempotently (untouched).
ok("1: callback only grants on approved + not-yet-processed", /txStatus === "Approved" && !payment\.processed/.test(callbackRoute));
ok("1: callback increments the balance by the purchased credits", /credits:\s*\{\s*increment:\s*payment\.credits\s*\}/.test(callbackRoute));
ok("1: callback marks the payment processed (idempotent)", /data:\s*\{\s*processed:\s*true\s*\}/.test(callbackRoute) && /\$transaction/.test(callbackRoute));

/* ── (2) HARD LOCATION CONSISTENCY ──────────────────────────────────────────── */
// 2a: the anchor directive content covers every required facet.
ok("2: anchor keeps the same landmarks at the same distances", /SAME landmarks at the SAME relative distances/i.test(LOCATION_ANCHOR_LINE));
ok("2: anchor keeps the same materials", /SAME materials/i.test(LOCATION_ANCHOR_LINE));
ok("2: anchor keeps the same weather", /SAME weather/i.test(LOCATION_ANCHOR_LINE));
ok("2: anchor keeps the light direction relative to the terrain", /direction[^.]*light[^.]*relative to the terrain/i.test(LOCATION_ANCHOR_LINE));
ok("2: anchor names the elevated LAYOUT view as a REFERENCE only (Stage 111)", /elevated LAYOUT view/i.test(LOCATION_ANCHOR_LINE) && /REFERENCE[^.]*ONLY/i.test(LOCATION_ANCHOR_LINE));
ok("2: anchor states the layout is NOT a camera angle to shoot from", /NOT a camera angle/i.test(LOCATION_ANCHOR_LINE));
ok("2: anchor positions the camera RELATIVE to fixed landmarks", /camera RELATIVE to those fixed landmarks/i.test(LOCATION_ANCHOR_LINE));
ok("2: anchor fixes the world geography (only the camera moves)", /only the camera moves[^.]*geography never/i.test(LOCATION_ANCHOR_LINE));
ok("2: anchor forbids objects appearing or disappearing", /Nothing appears that was not there and nothing vanishes/i.test(LOCATION_ANCHOR_LINE));
ok("2: anchor carries persistent state between shots", /Persistent state carries over/i.test(LOCATION_ANCHOR_LINE) && /footprints/i.test(LOCATION_ANCHOR_LINE) && /where each character was last left/i.test(LOCATION_ANCHOR_LINE));
ok("2: anchor is English (no Cyrillic)", !/[\u0400-\u04FF]/.test(LOCATION_ANCHOR_LINE));

// 2b: applyLocationConsistency gating — only with a location ref, idempotent, respects override.
ok("2: appended when the scene has a location reference", applyLocationConsistency(base, { hasOverride: false, hasLocationRef: true }).includes(LOCATION_ANCHOR_LINE));
ok("2: base prompt kept on top, directive appended at the end", applyLocationConsistency(base, { hasOverride: false, hasLocationRef: true }).startsWith(base));
ok("2: NOT appended without a location reference", applyLocationConsistency(base, { hasOverride: false, hasLocationRef: false }) === base);
ok("2: manual override is returned unchanged", applyLocationConsistency(base, { hasOverride: true, hasLocationRef: true }) === base);
ok("2: idempotent (applied twice = once)", applyLocationConsistency(applyLocationConsistency(base, { hasOverride: false, hasLocationRef: true }), { hasOverride: false, hasLocationRef: true }).split(LOCATION_ANCHOR_LINE).length === 2);

// 2c: the anchor block is a CONSTANT — byte-identical in every prompt (the "same anchor everywhere" requirement).
{
  const a = applyLocationConsistency("Prompt A about a market square.", { hasOverride: false, hasLocationRef: true });
  const b = applyLocationConsistency("Prompt B, a different shot of the market.", { hasOverride: false, hasLocationRef: true });
  const anchorA = a.slice(a.indexOf(LOCATION_ANCHOR_LINE));
  const anchorB = b.slice(b.indexOf(LOCATION_ANCHOR_LINE));
  ok("2: the anchor block is byte-identical across two different prompts", anchorA === anchorB && anchorA === LOCATION_ANCHOR_LINE);
}

// 2d: applied in BOTH the worker and the preview route, on top of the base-layer directive.
ok("2: worker imports applyLocationConsistency", /applyLocationConsistency/.test(worker) && /from "@\/lib\/prompt-seam"/.test(worker));
ok("2: worker calls applyLocationConsistency with hasLocationRef", /applyLocationConsistency\(prompt, \{ hasOverride: built\.hasOverride, hasLocationRef \}\)/.test(worker));
ok("2: preview route imports applyLocationConsistency", /applyLocationConsistency/.test(previewRoute));
ok("2: preview route nests applyLocationConsistency over applyLocationBaseLayer", /applyLocationConsistency\(\s*applyLocationBaseLayer\(/.test(previewRoute));
ok("2: preview applies location consistency (series intro dropped in Stage 110)", /applyLocationConsistency\(/.test(previewRoute) && !/applySeriesIntro/.test(previewRoute));

// 2e: end-to-end order — anchor sits after the base-layer line and before the series-intro line.
{
  let p = applyLocationBaseLayer(base, { hasOverride: false, hasLocationRef: true });
  p = applyLocationConsistency(p, { hasOverride: false, hasLocationRef: true });
  p = applySeriesIntro(p, 1, { hasOverride: false });
  ok("2: anchor is appended after LOCATION-BASE-LAYER", p.indexOf(LOCATION_ANCHOR_LINE) > p.indexOf(LOCATION_BASE_LAYER_LINE));
  ok("2: series intro stays outermost (after the anchor)", p.indexOf(SERIES_INTRO_LINE) > p.indexOf(LOCATION_ANCHOR_LINE));
}

/* ── (3) CROSS-EPISODE CONTINUITY ───────────────────────────────────────────── */
// 3a: episodeScriptUserPrompt accepts and renders the previous-episode ending context.
{
  const withEnding = episodeScriptUserPrompt({
    synopsis: "A drama.",
    season: { title: "S", logline: "L", episodes: [] },
    episode: { number: 2, title: "Ep Two", arcRole: "rising", logline: "It continues.", cliffhanger: "A door opens.", locationName: "Temple", locationDesc: "INT — temple — night", characters: [] } as any,
    characters: [],
    previous: [{ number: 1, title: "Ep One", logline: "It began.", cliffhanger: "A figure appears." }],
    previousEnding: { number: 1, title: "Ep One", cliffhanger: "A figure appears.", endState: "WORLD: the hero stands frozen at the altar as a shadow fills the doorway.", tail: "- Scene 8: the hero turns as the door slams." },
  });
  ok("3: user prompt includes a 'previous episode ended' block", /HOW THE PREVIOUS EPISODE .* ENDED/.test(withEnding));
  ok("3: user prompt carries the previous episode's end state", /the hero stands frozen at the altar/.test(withEnding));
  ok("3: user prompt carries the previous episode's closing beats", /the hero turns as the door slams/.test(withEnding));
  ok("3: user prompt instructs to CONTINUE DIRECTLY FROM the previous ending", /CONTINUES DIRECTLY FROM HERE/.test(withEnding) && /never restart the story from scratch/i.test(withEnding));

  const first = episodeScriptUserPrompt({
    synopsis: "A drama.",
    season: { title: "S", logline: "L", episodes: [] },
    episode: { number: 1, title: "Ep One", arcRole: "setup", logline: "It began.", cliffhanger: "A figure appears.", locationName: "Temple", locationDesc: "INT — temple — night", characters: [] } as any,
    characters: [],
    previous: [],
    previousEnding: null,
  });
  ok("3: the first episode has NO previous-ending block", !/HOW THE PREVIOUS EPISODE .* ENDED/.test(first) && /this is the first episode/.test(first));
}

// 3b: Stage 110/111 — the ep2+ opening-narration recap rule (R7) is gone with narration scenes; the continuation
// is carried by the episode brief (previous-ending block, 3a/3c) and by the shot-1 set-up sentence.
const ep1 = episodeScriptSystemPrompt("en", 1);
const ep2 = episodeScriptSystemPrompt("en", 2);
const ep3 = episodeScriptSystemPrompt("en", 3);
ok("3: ep2 shot 1 continues the previous episode's cliffhanger", /Shot 1 = the set-up that continues the previous episode's cliffhanger/.test(ep2));
ok("3: ep2 has no narration recap scene (Stage 110)", !/"sceneKind": "narration"/.test(ep2) && !/DIRECT CONTINUATION of the previous episode/.test(ep2));
ok("3: ep3 shot 1 also continues the previous cliffhanger", /Shot 1 = the set-up that continues the previous episode's cliffhanger/.test(ep3));
ok("3: ep1 is the series premiere (pure exposition)", /As EPISODE 1 it is pure exposition/.test(ep1) && !/As EPISODE 1 it is pure exposition/.test(ep2));

// 3c: season-script-job threads the previous-episode ending into the episode brief.
ok("3: season job defines loadPreviousEnding", /export async function loadPreviousEnding/.test(seasonJob));
ok("3: loadPreviousEnding reads the previous episode's scenes", /prisma\.scene\.findMany/.test(seasonJob) && /episodeId: previous\.id/.test(seasonJob));
ok("3: loadPreviousEnding prefers the actual end state over the scripted one", /endStateActual \?\? ""[^\n]*\|\|[^\n]*endState/.test(seasonJob));
ok("3: episode step computes the previous episode and its ending", /const prevEp = season!\.episodes\.find\(\(e\) => e\.number === ep\.number - 1\)/.test(seasonJob) && /loadPreviousEnding\(/.test(seasonJob));
ok("3: episode step passes previousEnding into the user prompt", /previousEnding,/.test(seasonJob));

/* ── (4) Stage 84/87 preserved ──────────────────────────────────────────────── */
ok("4: LOCATION-AS-BASE-LAYER directive still present in the seam", /LOCATION IS THE BASE LAYER/.test(seam));
ok("4: worker still applies applyLocationBaseLayer", /applyLocationBaseLayer\(prompt/.test(worker));
ok("4: SERIES INTRO directive still present in the seam", /SERIES INTRO \(opening scene\)/.test(seam));
ok("4: worker no longer applies applySeriesIntro (Stage 110)", !/applySeriesIntro\(/.test(worker));

console.log(`\nStage 88: ${passed} checks passed`);
