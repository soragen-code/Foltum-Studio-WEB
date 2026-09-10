/**
 * Stage 14 tests — richer episode references (5 character photos, 15–20 location angles,
 * 2-frame artifacts/important objects), parallel batched generation (concurrency 20),
 * within-shot frame continuity rule.
 * Run: npx tsx scripts/test-stage14.ts
 *
 * Pure-logic only (NO LLM / network / Replicate calls). Artifact extraction is LLM-based and
 * non-deterministic, so it is NOT exercised here; image generation (Replicate/Seedance) is
 * expensive and proven at the prompt + unit level exactly as required.
 */
import assert from "node:assert";
import {
  CHARACTER_PHOTO_COUNT,
  ARTIFACT_FRAME_COUNT,
  REF_BATCH_CONCURRENCY,
  CHARACTER_SHOTS,
  runWithConcurrency,
  parseImageArray,
} from "../lib/reference-counts";
import {
  desiredTotalFrames,
  desiredExtraFrames,
  LOCATION_BASE_FRAMES,
  LOCATION_TOTAL_MIN,
  LOCATION_TOTAL_MAX,
} from "../lib/location-scale";
import {
  CHARACTER_EXTRA_VARIANTS,
  characterExtraAnglePrompt,
  ARTIFACT_VARIANTS,
  artifactImagePrompt,
} from "../lib/visual-style";
import { CONTINUITY_RULE } from "../lib/season";

let pass = 0;
const ok = (c: unknown, m: string) => {
  assert(c, m);
  console.log("ok:", m);
  pass++;
};

async function main() {
  // --- (A) reference counts ---------------------------------------------------
  ok(CHARACTER_PHOTO_COUNT === 5, "character reference = 5 photos");
  ok(ARTIFACT_FRAME_COUNT === 3, "artifact/important object = 3 frames (Stage 16)");
  ok(REF_BATCH_CONCURRENCY === 20, "parallel batch concurrency = 20");
  ok(CHARACTER_SHOTS.length === 5, "5 character shot slots defined");
  ok(new Set(CHARACTER_SHOTS).size === 5, "character shot slots are distinct");

  // --- (B) location scale: Stage 16 → FIXED 15 angles for every scale ---------
  ok(LOCATION_BASE_FRAMES === 3, "location base angles = 3");
  ok(LOCATION_TOTAL_MIN === 15 && LOCATION_TOTAL_MAX === 15, "location total fixed at 15 (Stage 16)");
  ok(desiredTotalFrames({ name: "Кабинет" }) === 15, "small location → 15 angles total");
  ok(desiredTotalFrames({ name: "Склад" }) === 15, "big location → 15 angles total (fixed)");
  ok(desiredTotalFrames({ name: "Ночной город" }) === 15, "huge location → 15 angles total (fixed)");
  ok(
    desiredExtraFrames({ name: "Кабинет" }) === desiredTotalFrames({ name: "Кабинет" }) - LOCATION_BASE_FRAMES,
    "extra frames = total − base (base 3 subtracted)",
  );
  ok(desiredExtraFrames({ name: "Ночной город" }) === 12, "every location → 12 extra frames (Stage 16)");

  // --- (C) runWithConcurrency: order preserved + never exceeds limit ----------
  {
    const items = Array.from({ length: 53 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    const out = await runWithConcurrency(items, REF_BATCH_CONCURRENCY, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return n * 2;
    });
    ok(out.every((v, i) => v === i * 2), "runWithConcurrency preserves result order");
    ok(peak <= REF_BATCH_CONCURRENCY, `never more than ${REF_BATCH_CONCURRENCY} in flight (peak ${peak})`);
    ok(peak > 1, "actually runs in parallel (peak > 1)");
  }
  {
    // shared progress fires once per settled item, up to total
    const items = [1, 2, 3, 4, 5];
    let last = 0;
    const seen: number[] = [];
    await runWithConcurrency(items, 20, async (n) => n, (done, total) => { last = done; seen.push(total); });
    ok(last === 5, "onSettled reaches doneCount === total");
    ok(seen.every((t) => t === 5), "onSettled reports the full total each time");
  }
  {
    // limit larger than items still works
    const out = await runWithConcurrency([10, 20], 20, async (n) => n + 1);
    ok(out.length === 2 && out[0] === 11 && out[1] === 21, "handles fewer items than the limit");
    const empty = await runWithConcurrency<number, number>([], 20, async (n) => n);
    ok(empty.length === 0, "handles an empty batch without hanging");
  }

  // --- (D) parseImageArray (imageExtra JSON) ---------------------------------
  ok(parseImageArray(JSON.stringify(["http://example.com/a", "https://example.com/b"])).length === 2, "parseImageArray reads a JSON array of URLs");
  ok(parseImageArray(null).length === 0, "parseImageArray(null) empty");
  ok(parseImageArray("not json").length === 0, "parseImageArray(garbage) empty");
  ok(parseImageArray(JSON.stringify(["https://example.com/a", "", null, "not-a-url"])).length === 1, "parseImageArray keeps only valid http URLs");

  // --- (E) prompt builders: correct variant counts + key phrasing ------------
  ok(CHARACTER_EXTRA_VARIANTS.length >= CHARACTER_PHOTO_COUNT - 3, "character extra-variant pool covers the 2 extra photos of the 5-photo set");
  ok(ARTIFACT_VARIANTS.length === ARTIFACT_FRAME_COUNT, "artifact variants = 3 frames (Stage 16)");
  const cp = characterExtraAnglePrompt("weathered fisherman, grey beard", "Marco", 0);
  ok(/fisherman|beard/i.test(cp) && cp.length > 40, "characterExtraAnglePrompt embeds the appearance description");
  const ap0 = artifactImagePrompt("an antique brass compass", "Compass", 0);
  const ap1 = artifactImagePrompt("an antique brass compass", "Compass", 1);
  ok(ap0.length > 20 && ap1.length > 20, "artifactImagePrompt builds both frame prompts");
  ok(ap0 !== ap1, "artifact frame 0 (clean) differs from frame 1 (in-context)");

  // --- (F) continuity rule now also covers within-shot / frame-to-frame -------
  ok(/SCENE-TO-SCENE CONTINUITY/i.test(CONTINUITY_RULE), "continuity rule keeps scene-to-scene clause");
  ok(/BETWEEN FRAMES|WITHIN A SINGLE SHOT/i.test(CONTINUITY_RULE), "continuity rule adds within-shot / frame-to-frame clause");
  ok(/NEW LOCATION/i.test(CONTINUITY_RULE), "appearing 'from nowhere' allowed only on a new location");
  ok(/off-camera/i.test(CONTINUITY_RULE), "nothing appears/disappears off-camera");

  console.log(`\nALL STAGE14 CHECKS PASSED (${pass})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
