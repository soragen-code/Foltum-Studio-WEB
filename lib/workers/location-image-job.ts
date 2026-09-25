import { prisma } from "@/lib/db";
import { generateImage, GenerationCanceledError } from "@/lib/providers/image-provider";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { updateJob, completeJob, failJob, isCancelRequested, markCanceled } from "@/lib/jobs";
import { locationAnglePrompt, locationAccentAnglePrompt, LOCATION_SHOT_PLAN, setInventoryEntries, MAX_INVENTORY_IN_PROMPT, VISUAL_STYLE_ID, REFERENCE_ASPECT_RATIO } from "@/lib/visual-style";
import { LOCATION_MASTER_FRAMES } from "@/lib/location-scale";
import { detectC2paFromUrl } from "@/lib/c2pa";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Background job: photoreal 9:16 PNG references per location (GPT Image 2.0, C2PA kept).
 * 4-ANGLE REFERENCES: each location now gets FOUR different camera positions of the SAME place, generated as
 * an edit chain so the light, weather and palette stay identical:
 *   1. wide establishing master   → Location.imageUrl   (text-to-image, the anchor)
 *   2. elevated LAYOUT view        → Location.imageReverse (floor-plan authority, always present)
 *   3. accent angle #1 / detail    → Location.imageDetail
 *   4. accent angle #2 / shot-plan → Location.imageExtra[0]
 * Slots 3-4 use the accent camera angles the season script wrote per scene (season.ts S17 "cameraAngle")
 * when present, otherwise sensible defaults. More angles are still added on demand by the
 * location_extra_image job. Job type "location_image". Charged LOCATION_MASTER_FRAMES frame(s) per location;
 * the caller refunds the frame if the master did not change.
 */
export async function runLocationImagesJob({ jobId, projectId, locationIds, imageModel }: { jobId: string; projectId: string; locationIds: string[]; imageModel?: string }): Promise<void> {
  // User cancel: checked before every provider call (inside generateImage, which also cancels the running
  // prediction) and again before any result is written. Location data is left untouched; the caller's
  // refund pass returns the credits for every location whose master frame did not change.
  const canceled = () => isCancelRequested(jobId);
  const gen = (input: Parameters<typeof generateImage>[0]) => generateImage(input, { jobId, imageModel, shouldCancel: canceled});
  const CANCEL_MSG = "Generation canceled by the user";
  try {
    if (await canceled()) { await markCanceled(jobId, CANCEL_MSG); return; }
    const locations = await prisma.location.findMany({ where: { id: { in: locationIds }, projectId }, orderBy: { createdAt: "asc" } });
    const total = locations.length;
    let done = 0;
    let failed = 0;
    let layoutFailed = 0; // wide frame saved, elevated layout view missing
    // Non-blocking C2PA diagnostic across every stored angle.
    let c2paMissing = 0;
    const c2paChecks: { locationId: string; angle: string; ok: boolean; signatures: string[]; bytes: number }[] = [];
    // Stage 113 diagnostics: how many set-inventory entries reached the prompts per location (and whether they were trimmed).
    const inventory: { locationId: string; items: number; truncated: boolean }[] = [];
    const checkC2pa = async (locationId: string, angle: string, url: string) => {
      const r = await detectC2paFromUrl(url);
      c2paChecks.push({ locationId, angle, ok: r.ok, signatures: r.signatures, bytes: r.bytes });
      if (!r.ok) {
        c2paMissing += 1;
        console.warn(`[location-images] C2PA metadata MISSING on stored ${angle} angle (${url}) — Seedance moderation may drop it.`);
      }
    };
    const pct = () => 5 + Math.round((done / Math.max(total, 1)) * 95);
    await updateJob(jobId, { status: "processing", progress: pct(), message: `Generating ${total} location references…` });
    for (const loc of locations) {
      // Stage 11: stop before starting the next location. Finished references stay saved.
      if (await isCancelRequested(jobId)) {
        await markCanceled(jobId, `Canceled — done ${done} of ${total} locations`);
        return;
      }
      await updateJob(jobId, { progress: pct(), message: `Location reference "${loc.name}» (${done + 1}/${total})…` });
      try {
        const visual = loc.visualPrompt ?? loc.description ?? loc.name;
        // Stage 113: the full set inventory (written at the idea stage) goes into BOTH mandatory frames so every
        // object the season's scripts may use is drawn on the references. Legacy rows without it → old prompt.
        const inventoryCount = setInventoryEntries(loc.setInventory).length;
        inventory.push({ locationId: loc.id, items: inventoryCount, truncated: inventoryCount > MAX_INVENTORY_IN_PROMPT });
        if (inventoryCount > MAX_INVENTORY_IN_PROMPT) console.warn(`[location-images] set inventory of "${loc.name}" trimmed in prompt: ${inventoryCount} → ${MAX_INVENTORY_IN_PROMPT} entries`);
        // 4-ANGLE REFERENCES — FOUR different camera positions of the SAME location, generated as a chain so
        // the place, time of day, weather, light direction and palette stay identical and only the camera
        // moves. The first (wide) is text-to-image and becomes the anchor; each later angle is an EDIT
        // generated FROM the angles already shot (attached as image_input), so the model re-photographs the
        // same place from a new position instead of inventing a new one.
        // 1) wide establishing angle — the anchor for the light and the place
        const wideRemote = await gen({ prompt: locationAnglePrompt(visual, loc.name, "wide", loc.setInventory), aspect_ratio: REFERENCE_ASPECT_RATIO });
        if (await canceled()) throw new GenerationCanceledError(); // discard the result, keep the old master
        const stamp = Date.now();
        const wideUrl = await uploadRemoteToS3(wideRemote, `media/public/locations/${projectId}/${loc.id}/${VISUAL_STYLE_ID}/ref-${stamp}-wide.png`, "image/png");
        await prisma.location.update({ where: { id: loc.id }, data: { imageUrl: wideUrl, imageReverse: null, imageDetail: null, imageExtra: null } }); // new master → the old angles no longer match; re-shot from this frame
        await checkC2pa(loc.id, "wide", wideUrl);

        // 2) accent camera angles the script wrote for scenes shot at THIS location (season.ts S17
        // "cameraAngle"): distinct, non-empty, in scene order. They drive the extra location plates so the
        // references cover the vantages the episode actually uses. Legacy DBs without the column → defaults.
        const accentAngles: string[] = [];
        try {
          const scenesForLoc = await prisma.scene.findMany({ where: { locationId: loc.id }, orderBy: { number: "asc" }, select: { cameraAngle: true } });
          const seen = new Set<string>();
          for (const s of scenesForLoc) {
            const a = ((s as { cameraAngle?: string | null }).cameraAngle ?? "").replace(/\s+/g, " ").trim();
            if (!a) continue;
            const k = a.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            accentAngles.push(a);
          }
        } catch { /* cameraAngle column may be absent on legacy rows — fall back to defaults */ }

        // The three extra angles beyond the wide master. Slot 0 is ALWAYS the elevated LAYOUT view (the
        // floor-plan authority every location must carry). Slots 1-2 use the script's accent angles when it
        // wrote them; otherwise a medium "detail" shot and the first default shot-plan vantage.
        const REF_INPUT_CAP = 6; // master + angles attached to one edit request
        const extraPlan: { angle: string; prompt: string; store: "imageReverse" | "imageDetail" | "extra" }[] = [
          { angle: "layout", prompt: locationAnglePrompt(visual, loc.name, "layout", loc.setInventory), store: "imageReverse" },
          accentAngles[0]
            ? { angle: `accent-1`, prompt: locationAccentAnglePrompt(visual, loc.name, accentAngles[0]), store: "imageDetail" }
            : { angle: "detail", prompt: locationAnglePrompt(visual, loc.name, "detail", loc.setInventory), store: "imageDetail" },
          accentAngles[1]
            ? { angle: `accent-2`, prompt: locationAccentAnglePrompt(visual, loc.name, accentAngles[1]), store: "extra" }
            : { angle: LOCATION_SHOT_PLAN[0].key, prompt: locationAccentAnglePrompt(visual, loc.name, LOCATION_SHOT_PLAN[0].prompt), store: "extra" },
        ];

        // Chain: every extra angle is edited FROM the angles already shot (cap REF_INPUT_CAP image_inputs), so
        // all four frames are unmistakably the SAME photographed place from four different camera positions.
        const chain: string[] = [wideUrl];
        const extraUrls: string[] = [];
        for (const plan of extraPlan) {
          if (await isCancelRequested(jobId)) { await markCanceled(jobId, CANCEL_MSG); return; }
          try {
            const remote = await gen({ prompt: plan.prompt, aspect_ratio: REFERENCE_ASPECT_RATIO, image_input: chain.slice(0, REF_INPUT_CAP) });
            if (await canceled()) throw new GenerationCanceledError();
            const url = await uploadRemoteToS3(remote, `media/public/locations/${projectId}/${loc.id}/${VISUAL_STYLE_ID}/ref-${stamp}-${plan.angle}.png`, "image/png");
            if (plan.store === "imageReverse") await prisma.location.update({ where: { id: loc.id }, data: { imageReverse: url } });
            else if (plan.store === "imageDetail") await prisma.location.update({ where: { id: loc.id }, data: { imageDetail: url } });
            else { extraUrls.push(url); await prisma.location.update({ where: { id: loc.id }, data: { imageExtra: JSON.stringify(extraUrls) } }); }
            chain.push(url);
            await checkC2pa(loc.id, plan.angle, url);
          } catch (e: any) {
            if (e instanceof GenerationCanceledError) { await markCanceled(jobId, CANCEL_MSG); return; }
            if (plan.store === "imageReverse") layoutFailed += 1; // wide saved, elevated layout view missing
            console.error(`[location-images] extra angle "${plan.angle}" failed for ${loc.name}:`, e?.message ?? e);
          }
          await sleep(1200);
        }
      } catch (e: any) {
        if (e instanceof GenerationCanceledError) { await markCanceled(jobId, CANCEL_MSG); return; }
        failed += 1;
        console.error(`[location-images] failed for ${loc.name}:`, e?.message ?? e);
      }
      done += 1;
      await sleep(1500);
    }
    const summary = failed > 0 ? `Done — ${failed} of ${total} failed` : layoutFailed > 0 ? `Done — layout view missing for ${layoutFailed} location(s)` : "Location references are ready";
    await completeJob(jobId, { total, failed, layoutFailed, framesPerLocation: LOCATION_MASTER_FRAMES, locationIds, c2paOk: c2paMissing === 0, c2paMissing, c2paChecks, inventory }, summary);
  } catch (err: any) {
    console.error("[location-images] failed:", err);
    await failJob(jobId, err?.message ?? "Location image generation failed");
  }
}
