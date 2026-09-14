/**
 * Stage 87 — three deliverables:
 *
 *  (1) FIRST scene = series intro. The FIRST scene of EVERY episode opens the story like the intro of a
 *      TV series: ONLY wide / establishing shots + an OFF-SCREEN VOICEOVER backstory, and NO dialogue
 *      close-ups / lip-sync. Implemented at the prompt-seam level (applySeriesIntro) so it is applied
 *      retroactively to old projects too, and reinforced in the episode-script prompt (season.ts R7,
 *      MANDATORY narration scene 1 for ep1 AND ep2+). The protected lib/scene-prompt.ts is never touched.
 *      applySeriesIntro is the OUTERMOST wrapper in both the worker and the preview route.
 *
 *  (2) Prices in USD. The display prices (pricing-client) and the amounts actually charged
 *      (WFP_PRODUCTS + WFP_CURRENCY) are in US dollars, not UAH ₴. Credit grants are unchanged.
 *
 *  (3) English UI. User-facing strings across the app are in English (AI prompts stay English as before;
 *      story-content render scaffolding stays as-is). A representative sample is asserted here.
 *
 * No protected files are touched; no destructive DB migration.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applySeriesIntro, SERIES_INTRO_LINE, applyLocationBaseLayer } from "../lib/prompt-seam";
import { WFP_PRODUCTS, WFP_CURRENCY } from "../lib/wayforpay";
import { episodeScriptSystemPrompt } from "../lib/season";
import { TIER_LABELS } from "../lib/idea";
import { SCENE_RESET_CONFIRM_MESSAGE } from "../lib/scene-reset-confirm";
import { POWER_TIER_CONFIG } from "../lib/power-tier";
import { MOOD_LABELS } from "../lib/music";
import { locationDetailLabel } from "../lib/location-scale";
import { summarizePlan } from "../lib/music-plan";

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
const pricing = readFileSync(join(ROOT, "app/pricing/_components/pricing-client.tsx"), "utf8");

const base = "A cinematic vertical shot of a lighthouse at dawn.";

/* ── (1) FIRST scene = series intro ─────────────────────────────────────────── */
// 1a: the directive content — wide/establishing + off-screen voiceover + NO dialogue close-ups.
ok("1: SERIES_INTRO_LINE demands wide/establishing shots only", /wide, establishing shots/i.test(SERIES_INTRO_LINE));
ok("1: SERIES_INTRO_LINE forbids dialogue close-ups / lip-sync", /Do NOT use dialogue close-ups/i.test(SERIES_INTRO_LINE) && /no lip-synced/i.test(SERIES_INTRO_LINE));
ok("1: SERIES_INTRO_LINE mandates an OFF-SCREEN VOICEOVER narrator", /OFF-SCREEN VOICEOVER/.test(SERIES_INTRO_LINE) && /unseen narrator/i.test(SERIES_INTRO_LINE));
ok("1: SERIES_INTRO_LINE mentions the backstory / event that led here", /backstory/i.test(SERIES_INTRO_LINE) && /(aftermath|disaster|event)/i.test(SERIES_INTRO_LINE));

// 1b: applySeriesIntro gating — scene 1 only, idempotent, respects a manual override.
ok("1: appended for scene 1", applySeriesIntro(base, 1, { hasOverride: false }).includes(SERIES_INTRO_LINE));
ok("1: base prompt kept on top, directive appended at the end", applySeriesIntro(base, 1, { hasOverride: false }).startsWith(base));
ok("1: NOT appended for scene 2", applySeriesIntro(base, 2, { hasOverride: false }) === base);
ok("1: NOT appended for a later scene", applySeriesIntro(base, 7, { hasOverride: false }) === base);
ok("1: manual override is returned unchanged", applySeriesIntro(base, 1, { hasOverride: true }) === base);
ok("1: idempotent (applied twice = once)", applySeriesIntro(applySeriesIntro(base, 1, { hasOverride: false }), 1, { hasOverride: false }).split(SERIES_INTRO_LINE).length === 2);
// keyed on the scene number only → works retroactively for old projects (integer floor of 1.x is still 1).
ok("1: fires for a fractional scene 1.x (retroactive/legacy numbering)", applySeriesIntro(base, 1.5, { hasOverride: false }).includes(SERIES_INTRO_LINE));

// 1c: applied as the OUTERMOST wrapper in both worker and preview route.
ok("1: worker imports applySeriesIntro", /applySeriesIntro/.test(worker) && /from "@\/lib\/prompt-seam"/.test(worker));
ok("1: worker calls applySeriesIntro with the scene number", /applySeriesIntro\(prompt, scene\.number/.test(worker));
ok("1: preview route imports applySeriesIntro", /applySeriesIntro/.test(previewRoute));
ok("1: preview route applies applySeriesIntro as the OUTERMOST wrapper", /const prompt = applySeriesIntro\(\s*applyLocationBaseLayer\(/.test(previewRoute));
// end-to-end order: the series-intro line sits after the location-base-layer line.
{
  let p = applyLocationBaseLayer(base, { hasOverride: false, hasLocationRef: true });
  p = applySeriesIntro(p, 1, { hasOverride: false });
  ok("1: SERIES INTRO is outermost (appended after LOCATION-BASE-LAYER)", p.indexOf(SERIES_INTRO_LINE) > p.indexOf("LOCATION"));
}

// 1d: season.ts R7 — MANDATORY narration scene 1 for EVERY episode (ep1 AND ep2/ep3+).
const ep1 = episodeScriptSystemPrompt("en", 1);
const ep2 = episodeScriptSystemPrompt("en", 2);
const ep3 = episodeScriptSystemPrompt("en", 3);
ok("1: ep1 forces a MANDATORY opening narration scene", /MANDATORY/.test(ep1) && /"sceneKind": "narration"/.test(ep1) && /off-screen NARRATOR/i.test(ep1));
ok("1: ep2 ALSO forces a MANDATORY opening narration scene (Stage 87)", /MANDATORY/.test(ep2) && /"sceneKind": "narration"/.test(ep2) && /off-screen NARRATOR/i.test(ep2));
ok("1: ep3 ALSO forces a MANDATORY opening narration scene (Stage 87)", /MANDATORY/.test(ep3) && /"sceneKind": "narration"/.test(ep3));
ok("1: opening narration is wide b-roll with no lip-sync (all episodes)", /no lip-sync/i.test(ep1) && /no lip-sync/i.test(ep2) && /no lip-sync/i.test(ep3));

/* ── (2) Prices in USD ──────────────────────────────────────────────────────── */
ok("2: charge currency is USD", WFP_CURRENCY === "USD");
ok("2: subscription amounts in USD (9.99 / 29.99 / 79.99)", WFP_PRODUCTS.basic.amount === 9.99 && WFP_PRODUCTS.pro.amount === 29.99 && WFP_PRODUCTS.studio.amount === 79.99);
ok("2: credit-pack amounts in USD (4.99 / 14.99 / 29.99)", WFP_PRODUCTS.pack50.amount === 4.99 && WFP_PRODUCTS.pack200.amount === 14.99 && WFP_PRODUCTS.pack500.amount === 29.99);
ok("2: credit grants unchanged (100 / 400 / 1500)", WFP_PRODUCTS.basic.credits === 100 && WFP_PRODUCTS.pro.credits === 400 && WFP_PRODUCTS.studio.credits === 1500);
ok("2: pricing page shows $ prices, no ₴", /\$9\.99/.test(pricing) && /\$29\.99/.test(pricing) && /\$79\.99/.test(pricing) && !/₴/.test(pricing));

/* ── (3) English UI (representative sample) ──────────────────────────────────── */
ok("3: character tier labels English", TIER_LABELS.MAIN === "Main" && TIER_LABELS.SUPPORTING === "Supporting");
ok("3: scene-reset confirm message English", /reset all current scenes/i.test(SCENE_RESET_CONFIRM_MESSAGE) && !/[\u0400-\u04FF]/.test(SCENE_RESET_CONFIRM_MESSAGE));
ok("3: power-tier descriptions English", /Draft quality/i.test(POWER_TIER_CONFIG.LOW.description) && !/[\u0400-\u04FF]/.test(POWER_TIER_CONFIG.HIGH.description));
ok("3: mood labels English", MOOD_LABELS.tense === "tense" && MOOD_LABELS.mysterious === "mysterious");
ok("3: locationDetailLabel English", locationDetailLabel("high") === "high" && locationDetailLabel("low") === "low" && locationDetailLabel("medium") === "medium");
ok("3: music-plan summary English", summarizePlan([], 2) === "no music" && !/[\u0400-\u04FF]/.test(summarizePlan([{ mood: "tense", startSceneIndex: 0, endSceneIndex: 1, intensity: 0.5 }], 0)));
// none of the AI prompts / seam directives are left with app-chrome Cyrillic (SERIES_INTRO_LINE is English).
ok("3: SERIES_INTRO_LINE is English (no Cyrillic)", !/[\u0400-\u04FF]/.test(SERIES_INTRO_LINE));

/* ── (4) Stage 84/85/86 preserved ───────────────────────────────────────────── */
ok("4: LOCATION-AS-BASE-LAYER directive still present in the seam", /LOCATION IS THE BASE LAYER/.test(seam));
ok("4: worker still applies applyLocationBaseLayer", /applyLocationBaseLayer\(prompt/.test(worker));

console.log(`\nStage 87: ${passed} checks passed`);
