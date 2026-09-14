export const dynamic = "force-dynamic";
export const maxDuration = 800; // the single-frame regeneration runs inside this invocation via after()

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { rateLimitByUser, RATE_LIMITS } from "@/lib/rate-limit";
import { parseBody, locationShotSchema } from "@/lib/validations";
import { normalizeImageModel } from "@/lib/ai-models";
import { runInBackground, completeJob, failJob } from "@/lib/jobs";
import { generateImage } from "@/lib/replicate";
import { uploadRemoteToS3 } from "@/lib/s3-upload";
import { locationAnglePrompt, locationExtraAnglePrompt, parseLocationExtra, VISUAL_STYLE_ID } from "@/lib/visual-style";
import { extraJobImageInputs } from "@/lib/workers/location-extra-image-job";
import { CHARACTER_REFERENCE_COST } from "@/lib/power-tier";
import { loadProjectImageProvider } from "@/lib/providers/project-provider";

/** Job type of a single-frame regeneration — distinct from the location set jobs so their polling ignores it. */
export const LOCATION_SHOT_JOB_TYPE = "location_shot";

const FIELD: Record<"master" | "reverse" | "detail", "imageUrl" | "imageReverse" | "imageDetail"> = {
  master: "imageUrl",
  reverse: "imageReverse",
  detail: "imageDetail",
};

/**
 * POST /api/ai/locations/[id]/shot  { slot: "master"|"reverse"|"detail"|"extra", index?, imageModel? }
 *
 * Stage 46B-2: "Regenerate" on ONE location frame. Charges one frame (CHARACTER_REFERENCE_COST),
 * regenerates only that slot (master = text-to-image wide plate; reverse/detail chained on the master;
 * extra chained on the existing set) and writes ONLY that column — the other angles are kept.
 * Returns { jobId } — the UI polls /api/jobs/[id] and refreshes the references when done.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limited = rateLimitByUser(request, "ai:location-shot", session.user.email, RATE_LIMITS.ai);
    if (limited) return limited;

    const { id: locationId } = await params;
    const parsed = await parseBody(request, locationShotSchema);
    if (!parsed.ok) return parsed.response;
    const { slot, index } = parsed.data;
    const imageModel = normalizeImageModel(parsed.data.imageModel);
    if (slot === "extra" && index === undefined) return NextResponse.json({ error: "index is required for extra slots" }, { status: 400 });

    const user = await prisma.user.findUnique({ where: { email: session.user.email } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const loc = await prisma.location.findFirst({ where: { id: locationId, project: { userId: user.id } } });
    if (!loc) return NextResponse.json({ error: "Location not found" }, { status: 404 });
    const projectId = loc.projectId;

    const extras = parseLocationExtra(loc.imageExtra);
    if (slot === "extra" && index! >= extras.length) return NextResponse.json({ error: "Extra angle not found" }, { status: 404 });
    if (slot !== "master" && !loc.imageUrl) return NextResponse.json({ error: "Master frame is missing — generate it first" }, { status: 400 });

    const slotKey = slot === "extra" ? `extra-${index}` : slot;
    const active = await prisma.generationJob.findFirst({
      where: { projectId, type: LOCATION_SHOT_JOB_TYPE, status: { in: ["pending", "processing"] } },
      orderBy: { createdAt: "desc" },
    });
    if (active) {
      let rd: { locationId?: string; slot?: string } = {};
      try { rd = active.resultData ? JSON.parse(active.resultData) : {}; } catch { rd = {}; }
      if (rd.locationId === locationId && rd.slot === slotKey) return NextResponse.json({ jobId: active.id, resumed: true });
    }

    if ((user.credits ?? 0) < CHARACTER_REFERENCE_COST)
      return NextResponse.json({ error: `Insufficient credits: need ${CHARACTER_REFERENCE_COST}, balance ${user.credits ?? 0}` }, { status: 402 });

    await prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: CHARACTER_REFERENCE_COST } } });
    await prisma.creditTransaction.create({
      data: { userId: user.id, amount: -CHARACTER_REFERENCE_COST, description: `Reference shot regeneration: ${loc.name}/${slotKey}` },
    });

    const job = await prisma.generationJob.create({
      data: {
        type: LOCATION_SHOT_JOB_TYPE,
        status: "processing",
        progress: 10,
        message: `Regenerating frame "${loc.name}» (${slotKey})...`,
        projectId,
        resultData: JSON.stringify({ locationId, slot: slotKey }),
      },
    });

    runInBackground(async () => {
      try {
        const visual = loc.visualPrompt ?? loc.description ?? loc.name;
        const ctx = { jobId: job.id, imageModel, provider: await loadProjectImageProvider(loc.projectId) }; // Stage 73
        let remote: string;
        if (slot === "master") {
          remote = await generateImage({ prompt: locationAnglePrompt(visual, loc.name, "wide"), aspect_ratio: "9:16" }, ctx);
        } else if (slot === "extra") {
          remote = await generateImage(
            { prompt: locationExtraAnglePrompt(visual, loc.name, index!), aspect_ratio: "9:16", image_input: extraJobImageInputs(loc, extras) },
            ctx
          );
        } else {
          remote = await generateImage({ prompt: locationAnglePrompt(visual, loc.name, slot), aspect_ratio: "9:16", image_input: [loc.imageUrl!] }, ctx);
        }
        const url = await uploadRemoteToS3(remote, `media/public/locations/${projectId}/${loc.id}/${VISUAL_STYLE_ID}/ref-${Date.now()}-${slotKey}.png`, "image/png");

        // Write ONLY the regenerated slot — unlike a full master regeneration the other angles stay.
        if (slot === "extra") {
          const fresh = await prisma.location.findUnique({ where: { id: locationId }, select: { imageExtra: true } });
          const arr = parseLocationExtra(fresh?.imageExtra);
          if (index! < arr.length) arr[index!] = url; else arr.push(url);
          await prisma.location.update({ where: { id: locationId }, data: { imageExtra: JSON.stringify(arr) } });
        } else {
          await prisma.location.update({ where: { id: locationId }, data: { [FIELD[slot]]: url } });
        }
        await completeJob(job.id, { locationId, slot: slotKey, url }, "Frame is ready");
      } catch (e: any) {
        console.error(`[locations/shot] ${slotKey} failed for ${loc.name}:`, e?.message ?? e);
        await failJob(job.id, e?.message ?? "Shot regeneration failed");
        try {
          await prisma.user.update({ where: { id: user.id }, data: { credits: { increment: CHARACTER_REFERENCE_COST } } });
          await prisma.creditTransaction.create({
            data: { userId: user.id, amount: CHARACTER_REFERENCE_COST, description: `Refund: shot regeneration failed for ${loc.name}/${slotKey}` },
          });
        } catch (re) {
          console.error("[locations/shot] refund failed:", re);
        }
      }
    });

    return NextResponse.json({ jobId: job.id, creditsRemaining: (user.credits ?? 0) - CHARACTER_REFERENCE_COST });
  } catch (err: any) {
    console.error("[locations/shot] error:", err);
    return NextResponse.json({ error: "Failed: " + (err?.message ?? "Unknown error") }, { status: 500 });
  }
}
